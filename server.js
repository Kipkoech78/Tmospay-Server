require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const multer = require('multer');
const connectDB = require('./config/db');
const User = require('./models/User');

const authRoutes = require('./routes/auth');
const serviceRoutes = require('./routes/services');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const refundRoutes = require('./routes/refunds');
const adminRoutes = require('./routes/admin');
const { upload } = require('./middleware/claudinary');

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
app.use(express.json());
app.use(morgan('dev'));
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
//app.use('/api/refunds', refundRoutes);
app.use('/api', adminRoutes);
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large. Max size is 5MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
  next();
});
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// Central error handler (e.g. multer file errors)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

async function bootstrapAdmin() {
  const existingAdmin = await User.findOne({ role: 'admin' });
  if (existingAdmin) return;
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;

  await User.create({
    name: process.env.ADMIN_NAME || 'Admin',
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    role: 'admin',
  });
  console.log(`Bootstrap admin created: ${process.env.ADMIN_EMAIL}`);
}

(async () => {
  await connectDB();
  await bootstrapAdmin();
  app.listen(PORT, () => console.log(`Fellan Studio API running on port ${PORT}`));
})();
