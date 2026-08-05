const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const { protect } = require('../middleware/auth');
const mongoose = require('mongoose');
const {upload, ImageUploadUtils } = require('../middleware/claudinary');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const router = express.Router();
const { STEP_LABELS } = Invoice;

// shared helper: buffer -> base64 data URI -> Cloudinary, with retry
async function uploadWithRetry(fileBuffer, mimetype, maxAttempts = 3) {
  const b64 = Buffer.from(fileBuffer).toString('base64');
  const dataUri = `data:${mimetype};base64,${b64}`;

  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      const result = await ImageUploadUtils(dataUri);
      return result;
    } catch (err) {
      attempts++;
      if (attempts === maxAttempts) {
        throw new Error('Failed to upload image after multiple attempts');
      }
      console.log(`Retrying upload attempt ${attempts}...`);
    }
  }
}

const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
});

const makeInvoiceId = async () => {
  const count = await Invoice.countDocuments();
  return `TMP-${String(count + 1007).padStart(6, '0')}`;
};

// POST /api/auth/register
router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists' });

    const user = await User.create({ name, email, password, phone, role: 'client' });
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ message: 'Registration failed', error: err.message });
  }
});

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ message: 'Login failed', error: err.message });
  }
});

// ---------- dashboard ----------
router.get('/dashboard', protect, async (req, res) => {
  const invoices = await Invoice.find({ userId: req.userId }).sort({ createdAt: -1 });
  const totalInvoiced = invoices.reduce((sum, i) => sum + i.amount, 0);
  const inProgress = invoices.filter((i) => i.status !== 'complete').length;
  const completed = invoices.filter((i) => i.status === 'complete').length;
  const currency = invoices[0]?.currency || 'GBP';
  res.json({ totalInvoiced, currency, inProgress, completed, recent: invoices.slice(0, 10) });
});

// ---------- fetch single invoice ----------
router.get('/invoices/:id', protect, async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  res.json({ invoice, stepLabels: STEP_LABELS });
});

router.post('/invoices', protect, async (req, res) => {
  const { amount, currency, payoutNumber } = req.body || {};
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Enter a valid invoice amount.' });
  }
  const invoice = await Invoice.create({
    invoiceNumber: await makeInvoiceId(),
    userId: req.userId,
    amount: Number(amount),
    currency: currency || 'GBP',
    payoutNumber: payoutNumber || '',
    step: 1,
    totalSteps: STEP_LABELS.length,
    status: 'in_progress',
    feeAmount: Math.round(Number(amount) * 2.74),
    feeCurrency: 'KES',
    feeRefunded: false,
    history: [{ step: 1, label: STEP_LABELS[0] }],
  });
  res.status(201).json({ invoice, stepLabels: STEP_LABELS });
});

// ---------- generic advance (steps 2, 4, 5, 6 only) ----------
router.post('/invoices/:id/advance', protect, async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step >= invoice.totalSteps) {
    return res.status(400).json({ error: 'This invoice is already complete.' });
  }
  if (invoice.step === 3) {
    return res.status(400).json({ error: 'Upload your M-Pesa confirmation screenshot to proceed from this step.' });
  }
  if (invoice.step === 7) {
    return res.status(400).json({ error: 'Upload your receipt to complete this invoice.' });
  }
  invoice.step += 1;
  invoice.status = invoice.step === invoice.totalSteps ? 'complete' : 'in_progress';
  invoice.history.push({ step: invoice.step, label: STEP_LABELS[invoice.step - 1] });
  await invoice.save();
  res.json({ invoice, stepLabels: STEP_LABELS });
});

// ---------- step 3: upload M-Pesa confirmation screenshot (Cloudinary) ----------
router.post('/invoices/:id/confirm-payment', protect, upload.single('screenshot'), async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step !== 3) {
    return res.status(400).json({ error: `This invoice is on step ${invoice.step}, not ready for confirmation upload.` });
  }
  if (!req.file) return res.status(400).json({ error: 'Please attach your M-Pesa confirmation screenshot.' });

  try {
    const result = await uploadWithRetry(req.file.buffer, req.file.mimetype);
    invoice.confirmationScreenshot = result.secure_url;
    invoice.step = 4;
    invoice.status = invoice.step === invoice.totalSteps ? 'complete' : 'in_progress';
    invoice.history.push({ step: 4, label: STEP_LABELS[3] });
    await invoice.save();
    res.json({ invoice, stepLabels: STEP_LABELS });
  } catch (err) {
    console.log('Cloudinary error (confirm-payment):', err);
    res.status(502).json({ error: 'Could not upload your screenshot right now. Please try again.' });
  }
});

// ---------- step 7: upload final receipt (Cloudinary) ----------
router.post('/invoices/:id/upload-receipt', protect, upload.single('receipt'), async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step !== 7) {
    return res.status(400).json({ error: `This invoice is on step ${invoice.step}, not ready for receipt upload.` });
  }
  if (!req.file) return res.status(400).json({ error: 'Please attach your receipt.' });

  try {
    const result = await uploadWithRetry(req.file.buffer, req.file.mimetype);
    invoice.receiptFile = result.secure_url;
    invoice.step = 8;
    invoice.status = 'complete';
    invoice.history.push({ step: 8, label: STEP_LABELS[7] });
    await invoice.save();
    res.json({ invoice, stepLabels: STEP_LABELS });
  } catch (err) {
    console.log('Cloudinary error (upload-receipt):', err);
    res.status(502).json({ error: 'Could not upload your receipt right now. Please try again.' });
  }
});

// ---------- refund lifecycle ----------
router.post('/invoices/:id/refund/request', protect, async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.step < 3) {
    return res.status(400).json({ error: 'Refund requests unlock once payment is confirmed at step 3.' });
  }
  if (invoice.refund.status !== 'none') {
    return res.status(400).json({ error: `A refund is already ${invoice.refund.status}.` });
  }
  invoice.refund = { status: 'requested', requestedAt: new Date() };
  await invoice.save();
  res.json({ invoice });
});

router.post('/invoices/:id/refund/process', protect, async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  if (invoice.refund.status !== 'requested') {
    return res.status(400).json({ error: 'Refund must be requested before it can be processed.' });
  }
  invoice.refund.status = 'processing';
  invoice.refund.processingAt = new Date();
  await invoice.save();
  res.json({ invoice });
});

router.post('/invoices/:id/refund/complete', protect, async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
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

router.get('/invoices/:id/refund', protect, async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid invoice id.' });
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId })
    .select('refund feeAmount feeCurrency invoiceNumber');
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  res.json(invoice);
});

// ---------- support chat ----------
const CANNED_REPLIES = [
  { match: /human|agent|person/i, reply: "Thanks for reaching out — an agent will respond shortly." },
  { match: /refund|need|i/i, reply: 'Refunds for the processing fee unlock automatically after step 3 of your invoice.' },
  { match: /status|track/i, reply: 'You can track every invoice step by step from My Invoices.' },
  { match: /.*/, reply: "Hi! I'm Amina from tmospay support. How can I help today?" },
];

router.post('/support/message', (req, res) => {
  const { message } = req.body || {};
  const found = CANNED_REPLIES.find((r) => r.match.test(message || '')) || CANNED_REPLIES[CANNED_REPLIES.length - 1];
  res.json({ reply: found.reply });
});

router.get('/health', (req, res) => res.json({ ok: true, note: 'tmospay demo API' }));

router.get('/auth/me', protect, async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;