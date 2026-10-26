const multer = require('multer');

// Store file in memory buffer so we can easily validate and convert to Base64
const storage = multer.memoryStorage();

// Allowed image MIME types and magic byte signatures
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype.toLowerCase())) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed types: JPEG, PNG, WEBP, GIF, SVG.`), false);
  }
};

// Validate magic bytes for common image formats
const validateMagicBytes = (buffer) => {
  if (!buffer || buffer.length < 4) return false;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;

  // GIF: 47 49 46 38 ('GIF8')
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true;

  // WEBP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return true;
  }

  // SVG / XML text
  const textStart = buffer.slice(0, 100).toString('utf8').trim().toLowerCase();
  if (textStart.includes('<svg') || textStart.includes('<?xml')) {
    return true;
  }

  return false;
};

const getImageMimeType = (buffer) => {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  const textStart = buffer.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (textStart.includes('<svg') || (textStart.includes('<?xml') && textStart.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
};

// Base64 expands a 10 MiB file to about 13.34 MiB, leaving room for BSON metadata.
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    fields: 10,
    fieldSize: 1024,
    fieldNameSize: 100,
  },
  fileFilter,
});

module.exports = {
  upload,
  validateMagicBytes,
  getImageMimeType,
};
