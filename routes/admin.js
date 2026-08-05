const express = require('express');
const Order = require('../models/Order');
const Refund = require('../models/Refund');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/admin/stats
router.get('/stats', protect, authorize('admin'), async (req, res) => {
  const [totalClients, orders, refunds] = await Promise.all([
    User.countDocuments({ role: 'client' }),
    Order.find(),
    Refund.find(),
  ]);

  const paidOrders = orders.filter((o) => ['paid', 'in_progress', 'completed'].includes(o.status));
  const totalRevenue = paidOrders.reduce((sum, o) => sum + o.amount, 0);

  const stats = {
    totalClients,
    totalOrders: orders.length,
    pendingPayment: orders.filter((o) => o.status === 'pending_payment').length,
    awaitingVerification: orders.filter((o) => o.status === 'payment_review' || o.status === 'payment_processing').length,
    completed: orders.filter((o) => o.status === 'completed').length,
    totalRevenue,
    pendingRefunds: refunds.filter((r) => r.status === 'pending').length,
    refundedAmount: refunds.filter((r) => r.status === 'refunded').reduce((s, r) => s + r.amount, 0),
  };

  res.json({ stats });
});

module.exports = router;
