const express = require('express');
const Refund = require('../models/Refund');
const Order = require('../models/Order');
const { nextSequence } = require('../models/Counter');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// POST /api/refunds (client) - request a refund for a paid order
router.post('/', protect, async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId || !reason) return res.status(400).json({ message: 'orderId and reason are required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.client.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized for this order' });
    }
    if (!['paid', 'in_progress'].includes(order.status)) {
      return res.status(400).json({ message: 'Only paid orders are eligible for a refund' });
    }

    const existing = await Refund.findOne({ order: order._id, status: { $in: ['pending', 'approved'] } });
    if (existing) return res.status(409).json({ message: 'A refund request is already in progress for this order' });

    const seq = await nextSequence('refund');
    const refundRef = `RF-${String(seq).padStart(6, '0')}`;

    const refund = await Refund.create({
      refundRef,
      order: order._id,
      client: req.user._id,
      amount: order.amount,
      reason,
    });

    order.status = 'refund_requested';
    await order.save();

    res.status(201).json({ refund });
  } catch (err) {
    res.status(500).json({ message: 'Failed to request refund', error: err.message });
  }
});

// GET /api/refunds/mine (client)
router.get('/mine', protect, async (req, res) => {
  const refunds = await Refund.find({ client: req.user._id })
    .populate('order', 'orderRef serviceTitle amount')
    .sort({ createdAt: -1 });
  res.json({ refunds });
});

// GET /api/refunds (admin) - list all, optional ?status=
router.get('/', protect, authorize('admin'), async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const refunds = await Refund.find(filter)
    .populate('order', 'orderRef serviceTitle amount')
    .populate('client', 'name email phone')
    .sort({ createdAt: -1 });
  res.json({ refunds });
});

// PATCH /api/refunds/:id (admin) - approve, reject, or mark as refunded (manual for now)
router.patch('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const { action, adminNote, refundMethod, refundTransactionRef } = req.body;
    const allowed = ['approve', 'reject', 'mark_refunded'];
    if (!allowed.includes(action)) {
      return res.status(400).json({ message: `action must be one of: ${allowed.join(', ')}` });
    }

    const refund = await Refund.findById(req.params.id);
    if (!refund) return res.status(404).json({ message: 'Refund request not found' });

    const order = await Order.findById(refund.order);

    if (action === 'approve') {
      refund.status = 'approved';
    } else if (action === 'reject') {
      refund.status = 'rejected';
      if (order) order.status = 'paid'; // revert order back to paid state
    } else if (action === 'mark_refunded') {
      // Manual step: admin has physically sent the money back (e.g. M-Pesa send money / bank transfer)
      refund.status = 'refunded';
      refund.refundMethod = refundMethod || 'Manual (M-Pesa / Bank)';
      refund.refundTransactionRef = refundTransactionRef;
      if (order) order.status = 'refunded';
    }

    if (adminNote) refund.adminNote = adminNote;
    refund.processedBy = req.user._id;
    refund.processedAt = new Date();

    await refund.save();
    if (order) await order.save();

    res.json({ refund, order });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update refund', error: err.message });
  }
});

module.exports = router;
