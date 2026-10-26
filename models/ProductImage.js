const mongoose = require('mongoose');

const productImageSchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      default: '',
      index: true,
    },
    data: {
      type: String,
      required: true,
    },
    contentType: {
      type: String,
      required: true,
    },
    originalName: {
      type: String,
      default: '',
    },
    size: {
      type: Number,
      default: 0,
    },
    isMain: {
      type: Boolean,
      default: false,
    },
    color: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      default: 'product',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ProductImage', productImageSchema);
