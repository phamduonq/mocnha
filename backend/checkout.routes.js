/**
 * checkout.routes.js
 * 
 * Express Router cho Đặt hàng & Thanh toán Nguyên tử (Atomic Checkout):
 * POST /api/checkout
 * Bắt buộc:
 * - Middleware requireAuth (xác thực Bearer token).
 * - Header Idempotency-Key (chuẩn UUID v4).
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./requireAuth.middleware');
const { checkoutHandler } = require('./checkout.controller');

// Tuyến đường đặt hàng nguyên tử
router.post('/checkout', requireAuth, checkoutHandler);

module.exports = router;
