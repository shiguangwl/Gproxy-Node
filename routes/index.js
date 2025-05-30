const express = require('express');
const adminRoutes = require('./adminRoutes');
const proxyRoutes = require('./proxyRoutes');
// Import health check route if it will be separated
// const healthRoutes = require('./healthRoutes'); 

const router = express.Router();

// Health check can be a separate file or remain in server.js/app.js if simple
// For now, assume health check might be added here or kept in main server file.
// router.use('/health', healthRoutes);

router.use('/admin', adminRoutes);
router.use('/', proxyRoutes); // This should generally be last if it has wildcard paths

module.exports = router; 