const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema(
  {
    refundRef: { type: String, required: true, unique: true }, // e.g. RF-000045
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    reason: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'refunded'],
      default: 'pending',
    },

    // Admin processes refunds manually for now (no automated gateway reversal yet)
    adminNote: { type: String, trim: true },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    processedAt: { type: Date },
    refundMethod: { type: String, trim: true }, // e.g. "M-Pesa manual send", "Bank transfer"
    refundTransactionRef: { type: String, trim: true }, // manual entry once admin sends it
  },
  { timestamps: true }
);

module.exports = mongoose.model('Refund', refundSchema);
