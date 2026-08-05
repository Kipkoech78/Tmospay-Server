require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDNAME,
  api_key: process.env.APIKEY,
  api_secret: process.env.APISECRET,
});

// memory storage — file stays in RAM as a buffer, never touches disk
const storage = new multer.memoryStorage();

async function ImageUploadUtils(file) {
  const result = await cloudinary.uploader.upload(file, {
    resource_type: 'auto',
    folder: 'tmospay-invoices', // keeps uploads organized in your Cloudinary dashboard
  });
  return result;
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpe?g|png|webp|pdf)$/i;
    if (!allowed.test(file.originalname)) {
      return cb(new Error('Only JPG, PNG, WEBP, or PDF files are allowed.'));
    }
    cb(null, true);
  },
});

module.exports = { upload, ImageUploadUtils };