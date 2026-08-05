const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    orderRef: { type: String, required: true, unique: true }, // e.g. FS-000123
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
    serviceTitle: { type: String, required: true }, // snapshot at order time
    amount: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    notes: { type: String, trim: true },

    status: {
      type: String,
      enum: [
        'pending_payment',   // order created, no payment attempt yet
        'payment_processing',// STK push sent, awaiting result
        'payment_review',    // manual receipt uploaded, awaiting admin verification
        'paid',               // admin verified / mpesa confirmed
        'in_progress',        // work started
        'completed',          // delivered
        'refund_requested',
        'refunded',
        'cancelled',
      ],
      default: 'pending_payment',
    },

    payment: {
      method: { type: String, enum: ['mpesa_stk', 'manual_upload'], default: 'manual_upload' },
      mpesaCheckoutRequestID: { type: String },
      mpesaMerchantRequestID: { type: String },
      mpesaReceiptNumber: { type: String },
      phoneNumber: { type: String },
      paidAt: { type: Date },
      receiptFile: { type: String }, // path to uploaded screenshot/receipt
      verifiedByAdmin: { type: Boolean, default: false },
      verifiedAt: { type: Date },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
