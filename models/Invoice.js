const mongoose = require('mongoose');

const STEP_LABELS = [
  'Register Details',
  'Make Payment',
  'Submit Confirmation',
  'Invoice Initiated',
  'Fund Disbursed',
  'Mpesa Confirmation',
  'Upload Receipt',
  'Complete',
];

const historySchema = new mongoose.Schema(
  { step: Number, label: String, at: { type: Date, default: Date.now } },
  { _id: false }
);

const refundSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['none', 'requested', 'processing', 'completed'], default: 'none' },
    requestedAt: Date,
    processingAt: Date,
    completedAt: Date,
    note: String,
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'GBP' },
    payoutNumber: String,
    step: { type: Number, default: 1 },
    totalSteps: { type: Number, default: STEP_LABELS.length },
    status: { type: String, enum: ['in_progress', 'complete'], default: 'in_progress' },
    confirmationScreenshot: String, // /uploads path — set at step 3
    receiptFile: String,            // /uploads path — set at step 7
    feeAmount: Number,
    feeCurrency: { type: String, default: 'KES' },
    feeRefunded: { type: Boolean, default: false }, // kept for backwards compat
    refund: { type: refundSchema, default: () => ({}) },
    history: [historySchema],
  },
  { timestamps: true }
);

invoiceSchema.statics.STEP_LABELS = STEP_LABELS;

module.exports = mongoose.model('Invoice', invoiceSchema);