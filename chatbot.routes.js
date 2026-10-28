/**
 * chatbot.routes.js
 * 
 * Express Router cho AI Chatbot:
 * - Bảo vệ chống tấn công "Đốt ví" (Denial of Wallet Attack).
 * - Middleware Rate Limiter theo cơ chế Sliding Window trên RAM: Giới hạn tối đa 10 requests/phút mỗi IP.
 * - Chống IP Spoofing: Chỉ dựa vào req.ip (tuân thủ app.set('trust proxy', ...)).
 * - Chống tràn bộ nhớ (Out-Of-Memory DoS): Giới hạn cứng MAX_TRACKED_IPS = 10000 với cơ chế LRU/FIFO.
 * - Trả về HTTP 429 kèm fallback JSON chuẩn khi vượt ngưỡng mà không tiêu tốn token của Gemini.
 */

const express = require('express');
const router = express.Router();
const { chatHandler } = require('./chatbot.controller');

// Cấu hình Rate Limiting chống Denial of Wallet
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // Khung trượt 1 phút (60,000ms)
const MAX_REQUESTS_PER_WINDOW = 10;     // Tối đa 10 requests / phút / IP
const MAX_TRACKED_IPS = 10000;          // Giới hạn cứng số lượng IP lưu trong RAM

// Bộ nhớ Sliding Window lưu lịch sử timestamps của các request theo Client IP
const ipRequestsMap = new Map();

// Tự động dọn dẹp các IP không còn hoạt động mỗi 5 phút để tối ưu RAM
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipRequestsMap.entries()) {
    const activeTimestamps = timestamps.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
    if (activeTimestamps.length === 0) {
      ipRequestsMap.delete(ip);
    } else {
      ipRequestsMap.set(ip, activeTimestamps);
    }
  }
}, 5 * 60 * 1000).unref(); // unref() để không chặn Node.js process thoát

/**
 * Middleware Rate Limiter kiểm soát tần suất gọi Chatbot
 */
function chatbotRateLimiter(req, res, next) {
  // CHỐNG IP SPOOFING:
  // Tuyệt đối không tự cắt chuỗi từ req.headers['x-forwarded-for'].
  // Sử dụng req.ip của Express (được bảo vệ bởi cấu hình app.set('trust proxy', 1))
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown_client';

  const now = Date.now();
  const requestHistory = ipRequestsMap.get(clientIp) || [];

  // Lọc chỉ giữ các request trong vòng 60 giây gần nhất (Sliding Window)
  const recentRequests = requestHistory.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);

  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    // Vượt ngưỡng -> Ngắt kết nối ngay lập tức, KHÔNG GỌI GEMINI API
    return res.status(429).json({
      status: 'error',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Bạn đã gửi tin nhắn quá nhanh. Giới hạn tối đa 10 tin nhắn/phút để bảo vệ hệ thống.',
      fallback: {
        reply: 'Bạn đang thao tác quá nhanh. Vui lòng đợi trong giây lát rồi tiếp tục gửi câu hỏi nhé.',
        action: {
          type: 'none',
          payload: {
            product_id: '',
            quantity: 0,
          },
        },
      },
    });
  }

  // CHỐNG TRÀN BỘ NHỚ RAM (Out-Of-Memory DoS):
  // Trước khi thêm một IP mới, nếu Map đã đạt ngưỡng tối đa, loại bỏ phần tử cũ nhất (FIFO/LRU)
  if (!ipRequestsMap.has(clientIp) && ipRequestsMap.size >= MAX_TRACKED_IPS) {
    const oldestKey = ipRequestsMap.keys().next().value;
    ipRequestsMap.delete(oldestKey);
  }

  // Ghi nhận request hợp lệ
  recentRequests.push(now);
  ipRequestsMap.set(clientIp, recentRequests);

  next();
}

// Định tuyến API trò chuyện: Áp dụng Rate Limiter trước khi chuyển vào Controller
router.post('/chat', chatbotRateLimiter, chatHandler);

module.exports = router;
