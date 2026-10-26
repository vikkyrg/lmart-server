const ProductImage = require('../models/ProductImage');
const { getImageMimeType } = require('../middleware/upload');

// Helper to construct full URL for an image ID
const getImageEndpointUrl = (req, id) => {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/api/images/${id}`;
};

/**
 * 1. Upload an image
 * POST /api/images/upload
 */
const uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const detectedMimeType = getImageMimeType(req.file.buffer);
    if (!detectedMimeType || (req.file.mimetype !== detectedMimeType && !(req.file.mimetype === 'image/jpg' && detectedMimeType === 'image/jpeg'))) {
      return res.status(400).json({ error: 'File content does not match the declared image type' });
    }

    const { productId, associatedRecordId, isMain, color, role } = req.body;
    const imageRole = role || (productId ? 'product' : 'banner');
    const base64Data = req.file.buffer.toString('base64');

    const newImage = new ProductImage({
      productId: (productId || (['product', 'oldee-product', 'product-processed'].includes(imageRole) ? associatedRecordId : '') || '').slice(0, 256),
      associatedRecordId: (associatedRecordId || productId || '').slice(0, 256),
      data: base64Data,
      contentType: detectedMimeType,
      originalName: req.file.originalname.slice(0, 255),
      size: req.file.size,
      isMain: isMain === 'true' || isMain === true,
      color: (color || '').slice(0, 128),
      role: imageRole.slice(0, 64),
    });

    const savedImage = await newImage.save();
    const imageUrl = getImageEndpointUrl(req, savedImage._id);

    return res.status(201).json({
      success: true,
      id: savedImage._id,
      imageId: savedImage._id,
      url: imageUrl,
      productId: savedImage.productId,
      associatedRecordId: savedImage.associatedRecordId,
      contentType: savedImage.contentType,
      originalName: savedImage.originalName,
      size: savedImage.size,
      isMain: savedImage.isMain,
      color: savedImage.color,
      role: savedImage.role,
      createdAt: savedImage.createdAt,
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    return res.status(500).json({ error: 'Failed to upload image', details: error.message });
  }
};

/**
 * 2. Retrieve an image by ID (raw binary with correct Content-Type, or JSON with ?format=json)
 * GET /api/images/:id
 */
const getImageById = async (req, res) => {
  try {
    const { id } = req.params;
    const image = await ProductImage.findById(id);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // If json format requested (e.g. metadata)
    if (req.query.format === 'json') {
      return res.json({
        id: image._id,
        productId: image.productId,
        associatedRecordId: image.associatedRecordId,
        contentType: image.contentType,
        originalName: image.originalName,
        size: image.size,
        isMain: image.isMain,
        color: image.color,
        role: image.role,
        url: getImageEndpointUrl(req, image._id),
        createdAt: image.createdAt,
      });
    }

    const imgBuffer = Buffer.from(image.data, 'base64');
    res.set('Content-Type', image.contentType);
    res.set('Content-Length', imgBuffer.length);
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    return res.send(imgBuffer);
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Invalid image ID format' });
    }
    console.error('Error fetching image:', error);
    return res.status(500).json({ error: 'Failed to fetch image', details: error.message });
  }
};

/**
 * 3. Retrieve all images associated with a product
 * GET /api/images/product/:productId
 */
const getImagesByProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const images = await ProductImage.find({ productId }).sort({ createdAt: -1 });

    const formatted = images.map((img) => ({
      id: img._id,
      productId: img.productId,
      associatedRecordId: img.associatedRecordId,
      contentType: img.contentType,
      originalName: img.originalName,
      size: img.size,
      isMain: img.isMain,
      color: img.color,
      role: img.role,
      url: getImageEndpointUrl(req, img._id),
      createdAt: img.createdAt,
    }));

    return res.json({ success: true, count: formatted.length, images: formatted });
  } catch (error) {
    console.error('Error fetching product images:', error);
    return res.status(500).json({ error: 'Failed to fetch product images', details: error.message });
  }
};

/**
 * 4. Replace a product image (or replace by image ID)
 * PUT /api/images/:id
 */
const replaceImage = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No replacement image file provided' });
    }

    const detectedMimeType = getImageMimeType(req.file.buffer);
    if (!detectedMimeType || (req.file.mimetype !== detectedMimeType && !(req.file.mimetype === 'image/jpg' && detectedMimeType === 'image/jpeg'))) {
      return res.status(400).json({ error: 'File content does not match the declared image type' });
    }

    const image = await ProductImage.findById(id);
    if (!image) {
      return res.status(404).json({ error: 'Image to replace not found' });
    }

    const { productId, associatedRecordId, isMain, color, role } = req.body;
    const base64Data = req.file.buffer.toString('base64');

    image.data = base64Data;
    image.contentType = detectedMimeType;
    image.originalName = req.file.originalname.slice(0, 255);
    image.size = req.file.size;
    if (productId !== undefined) image.productId = productId.slice(0, 256);
    if (associatedRecordId !== undefined) image.associatedRecordId = associatedRecordId.slice(0, 256);
    if (isMain !== undefined) image.isMain = isMain === 'true' || isMain === true;
    if (color !== undefined) image.color = color.slice(0, 128);
    if (role !== undefined) image.role = role.slice(0, 64);

    const updatedImage = await image.save();
    const imageUrl = getImageEndpointUrl(req, updatedImage._id);

    return res.json({
      success: true,
      message: 'Image replaced successfully',
      id: updatedImage._id,
      imageId: updatedImage._id,
      url: imageUrl,
      productId: updatedImage.productId,
      associatedRecordId: updatedImage.associatedRecordId,
      contentType: updatedImage.contentType,
      originalName: updatedImage.originalName,
      size: updatedImage.size,
      isMain: updatedImage.isMain,
      color: updatedImage.color,
      role: updatedImage.role,
      updatedAt: updatedImage.updatedAt,
    });
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Invalid image ID format' });
    }
    console.error('Error replacing image:', error);
    return res.status(500).json({ error: 'Failed to replace image', details: error.message });
  }
};

/**
 * 5. Delete an image by ID
 * DELETE /api/images/:id
 */
const deleteImage = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ProductImage.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Image not found' });
    }

    return res.json({
      success: true,
      message: 'Image deleted successfully',
      id: deleted._id,
      productId: deleted.productId,
    });
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Invalid image ID format' });
    }
    console.error('Error deleting image:', error);
    return res.status(500).json({ error: 'Failed to delete image', details: error.message });
  }
};

module.exports = {
  uploadImage,
  getImageById,
  getImagesByProduct,
  replaceImage,
  deleteImage,
};
