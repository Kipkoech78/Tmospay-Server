const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, required: true },
    category: { type: String, trim: true, default: 'General' },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'KES' },
    deliveryTime: { type: String, default: '3-5 days' },
    icon: { type: String, default: '💼' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Service', serviceSchema);
