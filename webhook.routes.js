/**
 * webhook.routes.js
 * 
 * Express Router cho Webhook cổng thanh toán:
 * POST /api/webhooks/payment
 * 
 * ĐẶC BIỆT QUAN TRỌNG:
 * - Cấu hình middleware express.raw({ type: 'application/json', limit: '256kb' })
 *   cho riêng route này nhằm bảo toàn nguyên vẹn từng byte của Raw Buffer.
 * - Tuyệt đối không dùng express.json() trước bước verify chữ ký vì việc format lại JSON
 *   sẽ làm thay đổi khoảng trắng/ký tự đặc biệt dẫn đến sai lệch HMAC-SHA256 signature!
 */

const express = require('express');
const router = express.Router();
const { handlePaymentWebhook } = require('./webhook.controller');

// Route Webhook tiếp nhận thanh toán với middleware raw body buffer chuyên biệt
router.post(
  '/payment',
  express.raw({
    type: 'application/json',
    limit: '256kb', // Giới hạn kích thước payload webhook chống DoS
  }),
  handlePaymentWebhook
);

module.exports = router;
