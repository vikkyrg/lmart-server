/**
 * migrate-images.js
 *
 * Migration script: Reads all product and poster records from Firebase Firestore,
 * downloads the original images via Firebase Admin SDK (bypasses billing restrictions),
 * stores them in MongoDB Atlas, and updates Firestore documents with new MongoDB image URLs.
 *
 * Run: node migrate-images.js
 */

require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const { getStorage }          = require('firebase-admin/storage');
const mongoose = require('mongoose');
const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');

// ─── 1. Initialize Firebase Admin ─────────────────────────────────────────────
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount),
  storageBucket: 'emart-ecommerce.firebasestorage.app',
});

const db     = getFirestore();
const bucket = getStorage().bucket();

// ─── 2. Initialize MongoDB ─────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
const API_BASE = `http://localhost:${process.env.PORT || 5000}/api`;

// Mongoose model (inline here to avoid import issues)
const productImageSchema = new mongoose.Schema(
  {
    productId:    { type: String, default: '', index: true },
    data:         { type: String, required: true },          // base64 image data
    contentType:  { type: String, required: true },
    originalName: { type: String, default: '' },
    size:         { type: Number, default: 0 },
    isMain:       { type: Boolean, default: false },
    color:        { type: String, default: '' },
    originalFirebaseUrl: { type: String, default: '' },     // for traceability
    migratedAt:   { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

let ProductImage;

// ─── 3. Stats ─────────────────────────────────────────────────────────────────
const stats = {
  products: { found: 0, withImages: 0, migrated: 0, failed: 0, alreadyMigrated: 0 },
  posters:  { found: 0, withImages: 0, migrated: 0, failed: 0, alreadyMigrated: 0 },
  images:   { total: 0, downloaded: 0, stored: 0, failed: 0 },
};
const failureLog = [];

// ─── 4. Helper: Download image from a signed URL or public URL ─────────────────
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https://') ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for URL: ${url.substring(0, 80)}`));
      }
      const contentType = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── 5. Helper: Get a signed download URL from Firebase Storage path ──────────
async function getSignedUrl(storagePath) {
  try {
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });
    return signedUrl;
  } catch (err) {
    return null;
  }
}

// ─── 6. Helper: Parse Firebase Storage path from a download URL ───────────────
function parseFirebasePath(imageUrl) {
  if (!imageUrl) return null;
  try {
    // Format: https://firebasestorage.googleapis.com/v0/b/BUCKET/o/ENCODED_PATH?...
    const match = imageUrl.match(/\/o\/([^?]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch (_) {}
  return null;
}

// ─── 7. Helper: Check if image already migrated (by originalFirebaseUrl) ──────
async function findExistingMigration(firebaseUrl) {
  if (!firebaseUrl) return null;
  const existing = await ProductImage.findOne({ originalFirebaseUrl: firebaseUrl }).select('_id').lean();
  return existing ? existing._id.toString() : null;
}

// ─── 8. Core: Download one Firebase image and store in MongoDB ─────────────────
async function migrateOneImage({ firebaseUrl, productId, isMain, color, originalName }) {
  stats.images.total++;

  // Check if already migrated
  const existingId = await findExistingMigration(firebaseUrl);
  if (existingId) {
    console.log(`  ↩ Already migrated: ${existingId} (${firebaseUrl.substring(0, 60)}...)`);
    stats.images.stored++;
    return { mongoId: existingId, alreadyExisted: true };
  }

  // Try to get the image bytes
  let buffer, contentType;
  let downloadError = null;

  // Method A: Parse path from URL, get signed URL via Admin SDK
  const storagePath = parseFirebasePath(firebaseUrl);
  if (storagePath) {
    try {
      console.log(`  ↓ Downloading via Admin SDK: ${storagePath}`);
      const signedUrl = await getSignedUrl(storagePath);
      if (signedUrl) {
        const result = await downloadUrl(signedUrl);
        buffer = result.buffer;
        contentType = result.contentType;
        console.log(`  ✓ Downloaded ${(buffer.length / 1024).toFixed(1)} KB (${contentType})`);
      } else {
        downloadError = `File not found in Storage: ${storagePath}`;
      }
    } catch (err) {
      downloadError = `Admin SDK download failed: ${err.message}`;
    }
  }

  // Method B: Fallback – try direct URL (works if storage happens to be accessible)
  if (!buffer && !downloadError) {
    try {
      console.log(`  ↓ Fallback: direct download from public URL`);
      const result = await downloadUrl(firebaseUrl);
      buffer = result.buffer;
      contentType = result.contentType;
      console.log(`  ✓ Downloaded ${(buffer.length / 1024).toFixed(1)} KB (${contentType})`);
    } catch (err) {
      downloadError = `Direct download also failed: ${err.message}`;
    }
  }

  if (!buffer) {
    stats.images.failed++;
    const msg = `  ✗ Cannot download image: ${downloadError}`;
    console.log(msg);
    failureLog.push({ firebaseUrl, productId, error: downloadError });
    return null;
  }

  stats.images.downloaded++;

  // Store in MongoDB
  try {
    const base64Data = buffer.toString('base64');
    const doc = await ProductImage.create({
      productId: productId || '',
      data: base64Data,
      contentType: contentType.split(';')[0].trim(),
      originalName: originalName || path.basename(storagePath || firebaseUrl.split('?')[0]),
      size: buffer.length,
      isMain: isMain || false,
      color: color || '',
      originalFirebaseUrl: firebaseUrl,
    });
    stats.images.stored++;
    console.log(`  ✓ Stored in MongoDB: ${doc._id}`);
    return { mongoId: doc._id.toString(), alreadyExisted: false };
  } catch (err) {
    stats.images.failed++;
    console.log(`  ✗ MongoDB save failed: ${err.message}`);
    failureLog.push({ firebaseUrl, productId, error: `MongoDB save: ${err.message}` });
    return null;
  }
}

// ─── 9. Build MongoDB image URL ────────────────────────────────────────────────
function buildMongoImageUrl(mongoId) {
  return `${API_BASE}/images/${mongoId}`;
}

// ─── 10. Migrate products ──────────────────────────────────────────────────────
async function migrateProducts() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  MIGRATING PRODUCTS');
  console.log('═══════════════════════════════════════════');

  const snapshot = await db.collection('products').get();
  stats.products.found = snapshot.size;
  console.log(`Found ${snapshot.size} products in Firestore.\n`);

  for (const docSnap of snapshot.docs) {
    const productId = docSnap.id;
    const product = docSnap.data();
    console.log(`\n▶ Product [${productId}]: ${product.name || '(no name)'}`);

    let hasImages = false;
    const firestoreUpdates = {};

    // ── A. Main image (product.imageUrl or product.image or product.mainImageUrl) ──
    const mainImageCandidates = [
      { field: 'mainImageUrl', url: product.mainImageUrl },
      { field: 'imageUrl',    url: product.imageUrl },
      { field: 'image',       url: product.image },
    ].filter(c => c.url && c.url.startsWith('http'));

    for (const candidate of mainImageCandidates) {
      if (!candidate.url.includes('firebasestorage') && !candidate.url.includes('firebase')) continue;
      hasImages = true;
      console.log(`  Main image (${candidate.field}): ${candidate.url.substring(0, 70)}...`);
      const result = await migrateOneImage({
        firebaseUrl: candidate.url,
        productId,
        isMain: true,
        originalName: `${productId}-main`,
      });
      if (result) {
        firestoreUpdates[candidate.field] = buildMongoImageUrl(result.mongoId);
        if (!result.alreadyExisted) stats.products.migrated++;
        else stats.products.alreadyMigrated++;
      } else {
        stats.products.failed++;
      }
      break; // only migrate the first valid main image
    }

    // ── B. imageUrls array (gallery) ──────────────────────────────────────────
    if (Array.isArray(product.imageUrls) && product.imageUrls.length > 0) {
      const updatedImageUrls = [];
      for (let i = 0; i < product.imageUrls.length; i++) {
        const entry = product.imageUrls[i];
        const url = typeof entry === 'string' ? entry : (entry?.url || entry?.src || '');

        if (!url || (!url.includes('firebasestorage') && !url.includes('firebase'))) {
          updatedImageUrls.push(entry); // keep as-is if not firebase
          continue;
        }

        hasImages = true;
        const isMain = typeof entry === 'object' ? (entry.isMain === true || entry.isMain === 'true') : false;
        const color  = typeof entry === 'object' ? (entry.color || '') : '';
        console.log(`  Gallery[${i}] (isMain=${isMain}): ${url.substring(0, 70)}...`);

        const result = await migrateOneImage({
          firebaseUrl: url,
          productId,
          isMain,
          color,
          originalName: `${productId}-gallery-${i}`,
        });

        if (result) {
          const newUrl = buildMongoImageUrl(result.mongoId);
          if (typeof entry === 'string') {
            updatedImageUrls.push(newUrl);
          } else {
            updatedImageUrls.push({ ...entry, url: newUrl });
          }
        } else {
          updatedImageUrls.push(entry); // keep original if migration failed
        }
      }
      if (JSON.stringify(updatedImageUrls) !== JSON.stringify(product.imageUrls)) {
        firestoreUpdates.imageUrls = updatedImageUrls;
      }
    }

    // ── C. sourceImages (some products use this structure) ─────────────────────
    if (product.sourceImages && typeof product.sourceImages === 'object') {
      const si = product.sourceImages;
      const updatedSI = { ...si };

      // sourceImages.main
      if (si.main && si.main.includes('firebasestorage')) {
        hasImages = true;
        console.log(`  sourceImages.main: ${si.main.substring(0, 70)}...`);
        const result = await migrateOneImage({
          firebaseUrl: si.main,
          productId,
          isMain: true,
          originalName: `${productId}-si-main`,
        });
        if (result) updatedSI.main = buildMongoImageUrl(result.mongoId);
      }

      // sourceImages.gallery[]
      if (Array.isArray(si.gallery)) {
        const updatedGallery = [];
        for (let i = 0; i < si.gallery.length; i++) {
          const g = si.gallery[i];
          const url = typeof g === 'string' ? g : (g?.url || '');
          if (!url || !url.includes('firebasestorage')) {
            updatedGallery.push(g);
            continue;
          }
          hasImages = true;
          const result = await migrateOneImage({
            firebaseUrl: url,
            productId,
            originalName: `${productId}-si-gallery-${i}`,
          });
          if (result) {
            updatedGallery.push(typeof g === 'string' ? buildMongoImageUrl(result.mongoId) : { ...g, url: buildMongoImageUrl(result.mongoId) });
          } else {
            updatedGallery.push(g);
          }
        }
        updatedSI.gallery = updatedGallery;
      }

      if (JSON.stringify(updatedSI) !== JSON.stringify(si)) {
        firestoreUpdates.sourceImages = updatedSI;
      }
    }

    // ── D. Variants with images ────────────────────────────────────────────────
    if (Array.isArray(product.variants)) {
      const updatedVariants = [];
      let variantsChanged = false;
      for (let vi = 0; vi < product.variants.length; vi++) {
        const v = product.variants[vi];
        const vImage = v?.image || v?.imageUrl || '';
        if (vImage && vImage.includes('firebasestorage')) {
          hasImages = true;
          console.log(`  Variant[${vi}] image: ${vImage.substring(0, 70)}...`);
          const result = await migrateOneImage({
            firebaseUrl: vImage,
            productId,
            color: v?.color || v?.name || '',
            originalName: `${productId}-variant-${vi}`,
          });
          if (result) {
            const newUrl = buildMongoImageUrl(result.mongoId);
            const updatedV = { ...v };
            if (v.image)    updatedV.image    = newUrl;
            if (v.imageUrl) updatedV.imageUrl = newUrl;
            updatedVariants.push(updatedV);
            variantsChanged = true;
            continue;
          }
        }
        updatedVariants.push(v);
      }
      if (variantsChanged) {
        firestoreUpdates.variants = updatedVariants;
      }
    }

    if (!hasImages) {
      console.log('  (no Firebase images found)');
    } else {
      stats.products.withImages++;
    }

    // ── Update Firestore document if anything changed ──────────────────────────
    if (Object.keys(firestoreUpdates).length > 0) {
      try {
        await db.collection('products').doc(productId).update(firestoreUpdates);
        console.log(`  ✓ Firestore updated for product ${productId} (fields: ${Object.keys(firestoreUpdates).join(', ')})`);
      } catch (err) {
        console.log(`  ✗ Firestore update failed for product ${productId}: ${err.message}`);
      }
    }
  }
}

// ─── 11. Migrate posters ──────────────────────────────────────────────────────
async function migratePosters() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  MIGRATING POSTERS');
  console.log('═══════════════════════════════════════════');

  const snapshot = await db.collection('posters').get();
  stats.posters.found = snapshot.size;
  console.log(`Found ${snapshot.size} posters in Firestore.\n`);

  for (const docSnap of snapshot.docs) {
    const posterId = docSnap.id;
    const poster = docSnap.data();
    console.log(`\n▶ Poster [${posterId}]: ${poster.title || '(no title)'}`);

    const imageUrl = poster.imageUrl || poster.image || '';
    if (!imageUrl || (!imageUrl.includes('firebasestorage') && !imageUrl.includes('firebase'))) {
      console.log('  (no Firebase image URL found)');
      continue;
    }

    stats.posters.withImages++;
    console.log(`  Image URL: ${imageUrl.substring(0, 70)}...`);

    const result = await migrateOneImage({
      firebaseUrl: imageUrl,
      productId: `poster_${posterId}`,
      isMain: true,
      originalName: `poster-${posterId}`,
    });

    if (result) {
      const newUrl = buildMongoImageUrl(result.mongoId);
      try {
        await db.collection('posters').doc(posterId).update({ imageUrl: newUrl });
        console.log(`  ✓ Firestore poster updated: imageUrl -> ${newUrl}`);
        if (!result.alreadyExisted) stats.posters.migrated++;
        else stats.posters.alreadyMigrated++;
      } catch (err) {
        console.log(`  ✗ Firestore update failed: ${err.message}`);
        stats.posters.failed++;
      }
    } else {
      stats.posters.failed++;
    }
  }
}

// ─── 12. Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║     L-Mart Firebase → MongoDB Image Migration     ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`Started: ${new Date().toISOString()}`);

  // Connect to MongoDB
  console.log(`\nConnecting to MongoDB...`);
  await mongoose.connect(MONGODB_URI, { dbName: 'lmart' });
  console.log(`MongoDB connected.`);

  // Register model
  ProductImage = mongoose.model('ProductImage', productImageSchema);

  // Run migrations
  await migrateProducts();
  await migratePosters();

  // ─── Print report ──────────────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║                MIGRATION REPORT                  ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`\n📦 PRODUCTS`);
  console.log(`   Total found:           ${stats.products.found}`);
  console.log(`   With Firebase images:  ${stats.products.withImages}`);
  console.log(`   Newly migrated:        ${stats.products.migrated}`);
  console.log(`   Already migrated:      ${stats.products.alreadyMigrated}`);
  console.log(`   Failed:                ${stats.products.failed}`);
  console.log(`\n🖼  POSTERS`);
  console.log(`   Total found:           ${stats.posters.found}`);
  console.log(`   With Firebase images:  ${stats.posters.withImages}`);
  console.log(`   Newly migrated:        ${stats.posters.migrated}`);
  console.log(`   Already migrated:      ${stats.posters.alreadyMigrated}`);
  console.log(`   Failed:                ${stats.posters.failed}`);
  console.log(`\n🔢 IMAGES`);
  console.log(`   Total image URLs:      ${stats.images.total}`);
  console.log(`   Successfully downloaded: ${stats.images.downloaded}`);
  console.log(`   Stored in MongoDB:     ${stats.images.stored}`);
  console.log(`   Failed:                ${stats.images.failed}`);

  if (failureLog.length > 0) {
    console.log('\n⚠  FAILED IMAGES:');
    failureLog.forEach((f, i) => {
      console.log(`\n  [${i + 1}] Product/Context: ${f.productId}`);
      console.log(`       URL: ${(f.firebaseUrl || '').substring(0, 80)}...`);
      console.log(`       Error: ${f.error}`);
    });
  }

  // Write failure log to file
  const reportPath = path.join(__dirname, 'migration-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ stats, failures: failureLog, timestamp: new Date() }, null, 2));
  console.log(`\n📝 Full report written to: ${reportPath}`);

  console.log(`\nCompleted: ${new Date().toISOString()}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Migration crashed:', err);
  process.exit(1);
});
