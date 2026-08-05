const express = require('express');
const Order = require('../models/Order');
const { stkPush } = require('../config/mpesa');
const { protect, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

// POST /api/payments/mpesa/initiate  (client) - trigger STK push prompt on their phone
router.post('/mpesa/initiate', protect, async (req, res) => {
  try {
    const { orderId, phone } = req.body;
    if (!orderId || !phone) return res.status(400).json({ message: 'orderId and phone are required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to pay for this order' });
    }
    if (!['pending_payment', 'payment_processing'].includes(order.status)) {
      return res.status(400).json({ message: `Order is already ${order.status}` });
    }

    const stkResponse = await stkPush({
      phone,
      amount: order.amount,
      accountReference: order.orderRef,
      transactionDesc: `Payment for ${order.serviceTitle}`,
    });

    order.status = 'payment_processing';
    order.payment.method = 'mpesa_stk';
    order.payment.phoneNumber = phone;
    order.payment.mpesaCheckoutRequestID = stkResponse.CheckoutRequestID;
    order.payment.mpesaMerchantRequestID = stkResponse.MerchantRequestID;
    await order.save();

    res.json({
      message: 'STK push sent. Check your phone to complete payment.',
      checkoutRequestID: stkResponse.CheckoutRequestID,
      order,
    });
  } catch (err) {
    const daraja = err.response?.data;
    res.status(500).json({
      message: 'Failed to initiate M-Pesa payment. You can still upload a payment receipt manually.',
      error: daraja || err.message,
    });
  }
});

// POST /api/payments/mpesa/callback (public - called by Safaricom Daraja)
router.post('/mpesa/callback', async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.status(400).json({ message: 'Invalid callback payload' });

    const order = await Order.findOne({ 'payment.mpesaCheckoutRequestID': callback.CheckoutRequestID });
    if (!order) {
      // Always ack Safaricom even if we can't match the order, per Daraja spec
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    if (callback.ResultCode === 0) {
      const items = callback.CallbackMetadata?.Item || [];
      const get = (name) => items.find((i) => i.Name === name)?.Value;

      order.status = 'paid';
      order.payment.mpesaReceiptNumber = get('MpesaReceiptNumber');
      order.payment.paidAt = new Date();
      order.payment.verifiedByAdmin = true; // M-Pesa confirmation is authoritative
      order.payment.verifiedAt = new Date();
    } else {
      // Payment failed, cancelled, or timed out on the customer's phone
      order.status = 'pending_payment';
    }
    await order.save();

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('M-Pesa callback error:', err.message);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' }); // still ack to avoid retries storm
  }
});

// GET /api/payments/mpesa/status/:orderId (client) - poll payment result after STK push
router.get('/mpesa/status/:orderId', protect, async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.client.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Not authorized' });
  }
  res.json({ status: order.status, payment: order.payment });
});

// POST /api/payments/:orderId/upload-receipt (client) - manual proof of payment
router.post('/:orderId/upload-receipt', protect, upload.single('receipt'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to upload for this order' });
    }
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    order.payment.receiptFile = `/uploads/receipts/${req.file.filename}`;
    if (order.payment.method !== 'mpesa_stk') order.payment.method = 'manual_upload';
    order.status = 'payment_review';
    await order.save();

    res.json({ message: 'Receipt uploaded. Awaiting admin verification.', order });
  } catch (err) {
    res.status(500).json({ message: 'Failed to upload receipt', error: err.message });
  }
});

// PATCH /api/payments/:orderId/verify (admin) - manually verify a payment_review order
router.patch('/:orderId/verify', protect, authorize('admin'), async (req, res) => {
  const { approve, note } = req.body;
  const order = await Order.findById(req.params.orderId);
  if (!order) return res.status(404).json({ message: 'Order not found' });

  if (approve) {
    order.status = 'paid';
    order.payment.verifiedByAdmin = true;
    order.payment.verifiedAt = new Date();
    order.payment.verifiedBy = req.user._id;
    order.payment.paidAt = order.payment.paidAt || new Date();
  } else {
    order.status = 'pending_payment';
    order.payment.verifiedByAdmin = false;
  }
  if (note) order.notes = `${order.notes ? order.notes + ' | ' : ''}Admin: ${note}`;
  await order.save();

  res.json({ message: approve ? 'Payment verified' : 'Payment rejected', order });
});

module.exports = router;
