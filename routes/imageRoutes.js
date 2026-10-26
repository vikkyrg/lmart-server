const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/upload');
const {
  uploadImage,
  getImageById,
  getImagesByProduct,
  replaceImage,
  deleteImage,
} = require('../controllers/imageController');

// Upload an image
router.post('/upload', upload.single('image'), uploadImage);

// Retrieve all images for a specific product
router.get('/product/:productId', getImagesByProduct);

// Retrieve an image by ID (renders binary image or returns JSON if ?format=json)
router.get('/:id', getImageById);

// Replace an existing image
router.put('/:id', upload.single('image'), replaceImage);

// Delete an image
router.delete('/:id', deleteImage);

module.exports = router;
