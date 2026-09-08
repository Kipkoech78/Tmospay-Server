const express = require('express');
const Order = require('../models/Order');
const Refund = require('../models/Refund');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const Invoice = require('../models/Invoice');
const mongoose = require('mongoose');
const { protect, authorize } = require('../middleware/auth');
const {upload, ImageUploadUtils } = require('../middleware/claudinary');

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

// ============================================================
// ADMIN — manual review, verification, and full invoice table
// ============================================================

// function adminOnly(req, res, next) {
//   if (!req.user || req.user.role !== 'admin') {
//     return res.status(403).json({ error: 'Admins only.' });
//   }
//   next();
// }

// GET /api/admin/invoices — table with search + filters + pagination
router.get('/admin/invoices', async (req, res) => {
  console.log("called, called")
  const { q, status, step, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (step) filter.step = Number(step);
  if (q) {
    filter.$or = [
      { invoiceNumber: { $regex: q, $options: 'i' } },
      { payoutNumber: { $regex: q, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [invoices, total] = await Promise.all([
    Invoice.find(filter)
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Invoice.countDocuments(filter),
  ]);

  res.json({ invoices, total, page: Number(page), pages: Math.ceil(total / Number(limit)) || 1 });
});

// GET /api/admin/invoices/:id — full detail for the review drawer
router.get('/admin/invoices/:id', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findById(req.params.id).populate('userId', 'name email phone');
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  res.json({ invoice, stepLabels: STEP_LABELS });
});

// POST /api/admin/invoices/:id/verify-payment — step 3 -> 4
// Accepts EITHER an uploaded screenshot OR a pasted M-Pesa code.
router.post('/admin/invoices/:id/verify-payment',   upload.single('screenshot'), async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step !== 3) {
    return res.status(400).json({ error: `Invoice is on step ${invoice.step}, not awaiting payment verification.` });
  }

  const { mpesaCode } = req.body;
  if (!req.file && !mpesaCode) {
    return res.status(400).json({ error: 'Attach a screenshot or paste the M-Pesa transaction code.' });
  }

  try {
    if (req.file) {
      const result = await uploadWithRetry(req.file.buffer, req.file.mimetype);
      invoice.confirmationScreenshot = result.secure_url;
    }
    if (mpesaCode) {
      invoice.mpesaCode = mpesaCode.trim().toUpperCase();
    }
    invoice.verifiedBy = req.userId;
    invoice.step = 4;
    invoice.status = invoice.step === invoice.totalSteps ? 'complete' : 'in_progress';
    invoice.history.push({ step: 4, label: STEP_LABELS[3] });
    await invoice.save();
    res.json({ invoice, stepLabels: STEP_LABELS });
  } catch (err) {
    console.log('Admin verify-payment error:', err);
    res.status(502).json({ error: 'Could not save verification. Please try again.' });
  }
});

// POST /api/admin/invoices/:id/verify-receipt — step 7 -> 8 (complete)
// Same idea: file OR a pasted reference code.
router.post('/admin/invoices/:id/verify-receipt', upload.single('receipt'), async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step !== 7) {
    return res.status(400).json({ error: `Invoice is on step ${invoice.step}, not awaiting receipt verification.` });
  }

  const { receiptCode } = req.body;
  if (!req.file && !receiptCode) {
    return res.status(400).json({ error: 'Attach a receipt file or paste the reference code.' });
  }

  try {
    if (req.file) {
      const result = await uploadWithRetry(req.file.buffer, req.file.mimetype);
      invoice.receiptFile = result.secure_url;
    }
    if (receiptCode) {
      invoice.receiptCode = receiptCode.trim().toUpperCase();
    }
    invoice.verifiedBy = req.userId;
    invoice.step = 8;
    invoice.status = 'complete';
    invoice.history.push({ step: 8, label: STEP_LABELS[7] });
    await invoice.save();
    res.json({ invoice, stepLabels: STEP_LABELS });
  } catch (err) {
    console.log('Admin verify-receipt error:', err);
    res.status(502).json({ error: 'Could not save verification. Please try again.' });
  }
});

// POST /api/admin/invoices/:id/advance — manual advance for steps 2, 4, 5, 6
router.post('/admin/invoices/:id/advance',  async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step >= invoice.totalSteps) {
    return res.status(400).json({ error: 'This invoice is already complete.' });
  }
  if (invoice.step === 3) return res.status(400).json({ error: 'Use verify-payment for this step.' });
  if (invoice.step === 7) return res.status(400).json({ error: 'Use verify-receipt for this step.' });

  invoice.step += 1;
  invoice.status = invoice.step === invoice.totalSteps ? 'complete' : 'in_progress';
  invoice.history.push({ step: invoice.step, label: STEP_LABELS[invoice.step - 1] });
  await invoice.save();
  res.json({ invoice, stepLabels: STEP_LABELS });
});

// admin refund actions — NOT scoped to req.userId (unlike the client routes above)
router.post('/admin/invoices/:id/refund/process',  async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.refund.status !== 'requested') {
    return res.status(400).json({ error: 'Refund must be requested before it can be processed.' });
  }
  invoice.refund.status = 'processing';
  invoice.refund.processingAt = new Date();
  await invoice.save();
  res.json({ invoice });
});

router.post('/admin/invoices/:id/refund/complete', async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.refund.status !== 'processing') {
    return res.status(400).json({ error: 'Refund must be processing before it can be completed.' });
  }
  invoice.refund.status = 'completed';
  invoice.refund.completedAt = new Date();
  invoice.feeRefunded = true;
  await invoice.save();
  res.json({ invoice });
});

// GET /api/admin/stats — powers the AdminDashboard cards
router.get('/admin/stats',  async (req, res) => {
  const [totalClients, invoices] = await Promise.all([
    User.countDocuments({ role: 'client' }),
    Invoice.find(),
  ]);
  const totalOrders = invoices.length;
  const awaitingVerification = invoices.filter((i) => i.step === 3 || i.step === 7).length;
  const completed = invoices.filter((i) => i.status === 'complete').length;
  const pendingRefunds = invoices.filter(
    (i) => i.refund?.status && i.refund.status !== 'none' && i.refund.status !== 'completed'
  ).length;
  const totalRevenue = invoices.filter((i) => i.status === 'complete').reduce((sum, i) => sum + i.amount, 0);

  res.json({ stats: { totalClients, totalOrders, awaitingVerification, completed, pendingRefunds, totalRevenue } });
});
// GET /api/admin/refunds — refunds grouped by status, for the approvals queue
router.get('/admin/refunds',  async (req, res) => {
  const { status } = req.query; // optional filter: requested | processing | completed
  const filter = { 'refund.status': { $ne: 'none' } };
  if (status) filter['refund.status'] = status;

  const invoices = await Invoice.find(filter)
    .populate('userId', 'name email phone')
    .sort({ 'refund.requestedAt': -1 });

  const counts = {
    requested: invoices.filter((i) => i.refund.status === 'requested').length,
    processing: invoices.filter((i) => i.refund.status === 'processing').length,
    completed: invoices.filter((i) => i.refund.status === 'completed').length,
  };

  res.json({ invoices, counts });
});
module.exports = router;
