const ProductImage = require('../models/ProductImage');
const { validateMagicBytes } = require('../middleware/upload');

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

    // Validate magic bytes
    if (!validateMagicBytes(req.file.buffer)) {
      return res.status(400).json({ error: 'File content does not match a valid image format' });
    }

    const { productId, isMain, color, role } = req.body;
    const base64Data = req.file.buffer.toString('base64');

    const newImage = new ProductImage({
      productId: productId || '',
      data: base64Data,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
      size: req.file.size,
      isMain: isMain === 'true' || isMain === true,
      color: color || '',
      role: role || (productId ? 'product' : 'banner'),
    });

    const savedImage = await newImage.save();
    const imageUrl = getImageEndpointUrl(req, savedImage._id);

    return res.status(201).json({
      success: true,
      id: savedImage._id,
      url: imageUrl,
      productId: savedImage.productId,
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

    if (!validateMagicBytes(req.file.buffer)) {
      return res.status(400).json({ error: 'File content does not match a valid image format' });
    }

    const image = await ProductImage.findById(id);
    if (!image) {
      return res.status(404).json({ error: 'Image to replace not found' });
    }

    const { productId, isMain, color, role } = req.body;
    const base64Data = req.file.buffer.toString('base64');

    image.data = base64Data;
    image.contentType = req.file.mimetype;
    image.originalName = req.file.originalname;
    image.size = req.file.size;
    if (productId !== undefined) image.productId = productId;
    if (isMain !== undefined) image.isMain = isMain === 'true' || isMain === true;
    if (color !== undefined) image.color = color;
    if (role !== undefined) image.role = role;

    const updatedImage = await image.save();
    const imageUrl = getImageEndpointUrl(req, updatedImage._id);

    return res.json({
      success: true,
      message: 'Image replaced successfully',
      id: updatedImage._id,
      url: imageUrl,
      productId: updatedImage.productId,
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
