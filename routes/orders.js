const express = require('express');
const Order = require('../models/Order');
const Service = require('../models/Service');
const { nextSequence } = require('../models/Counter');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// POST /api/orders (client) - create a new order for a service
router.post('/',  async (req, res) => {
  try {
    const { serviceId, notes } = req.body;
    const service = await Service.findById(serviceId);
    if (!service || !service.isActive) {
      return res.status(404).json({ message: 'Service not found or unavailable' });
    }

    const seq = await nextSequence('order');
    const orderRef = `FS-${String(seq).padStart(6, '0')}`;

    const order = await Order.create({
      orderRef,
      client: req.user._id,
      service: service._id,
      serviceTitle: service.title,
      amount: service.price,
      currency: service.currency,
      notes,
    });

    res.status(201).json({ order });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create order', error: err.message });
  }
});

// GET /api/orders/mine (client) - list own orders
router.get('/mine', async (req, res) => {
  const orders = await Order.find({ client: req.user._id })
    .populate('service', 'title icon')
    .sort({ createdAt: -1 });
  res.json({ orders });
});

// GET /api/orders (admin) - list all orders, optional ?status=
router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const orders = await Order.find(filter)
    .populate('client', 'name email phone')
    .populate('service', 'title')
    .sort({ createdAt: -1 });
  res.json({ orders });
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('service', 'title icon')
    .populate('client', 'name email phone');
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const isOwner = order.client._id.toString() === req.user._id.toString();
  if (!isOwner && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Not authorized to view this order' });
  }
  res.json({ order });
});

// PATCH /api/orders/:id/status (admin) - move order through fulfillment stages
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['in_progress', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${allowed.join(', ')}` });
  }
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json({ order });
});

module.exports = router;