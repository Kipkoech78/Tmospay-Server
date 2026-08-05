const express = require('express');
const Service = require('../models/Service');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// GET /api/services  (public - only active services)
router.get('/', async (req, res) => {
  const services = await Service.find({ isActive: true }).sort({ createdAt: -1 });
  res.json({ services });
});

// GET /api/services/all  (admin - includes inactive)
router.get('/all', protect, authorize('admin'), async (req, res) => {
  const services = await Service.find().sort({ createdAt: -1 });
  res.json({ services });
});

// GET /api/services/:slug (public)
router.get('/:slug', async (req, res) => {
  const service = await Service.findOne({ slug: req.params.slug, isActive: true });
  if (!service) return res.status(404).json({ message: 'Service not found' });
  res.json({ service });
});

// POST /api/services (admin)
router.post('/', protect, authorize('admin'), async (req, res) => {
  try {
    const { title, description, category, price, currency, deliveryTime, icon } = req.body;
    if (!title || !description || price === undefined) {
      return res.status(400).json({ message: 'Title, description and price are required' });
    }
    let slug = slugify(title);
    const existing = await Service.findOne({ slug });
    if (existing) slug = `${slug}-${Date.now().toString().slice(-5)}`;

    const service = await Service.create({
      title, slug, description, category, price, currency, deliveryTime, icon,
    });
    res.status(201).json({ service });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create service', error: err.message });
  }
});

// PUT /api/services/:id (admin)
router.put('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.title) updates.slug = slugify(updates.title);
    const service = await Service.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!service) return res.status(404).json({ message: 'Service not found' });
    res.json({ service });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update service', error: err.message });
  }
});

// DELETE /api/services/:id (admin) - soft delete (deactivate)
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  const service = await Service.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!service) return res.status(404).json({ message: 'Service not found' });
  res.json({ message: 'Service deactivated', service });
});

module.exports = router;
