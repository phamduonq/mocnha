/**
 * server.js
 * 
 * Máy chủ trung tâm của nền tảng thương mại điện tử Mộc Nhà:
 * 1. Khởi chạy Express API với cấu hình bảo mật Reverse Proxy (trust proxy).
 * 2. Mount Webhook Route TRƯỚC express.json() để bảo toàn Raw Body Buffer cho HMAC-SHA256.
 * 3. Mount các Endpoint Backend: Upload ảnh bảo mật, AI Chatbot RAG, Atomic Checkout.
 * 4. Phục vụ tĩnh AN TOÀN: CHỈ phục vụ thư mục /assets, KHÔNG phục vụ root __dirname (chống lộ mã nguồn).
 * 5. Xuất module.exports = app tương thích môi trường Serverless (Vercel).
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// 1. CẤU HÌNH REVERSE PROXY & CORS
// Đảm bảo req.ip đọc chính xác từ client sau Cloudflare/Nginx/Vercel (chống IP Spoofing)
app.set('trust proxy', 1);

app.use(cors());

// 2. MOUNT WEBHOOK ROUTE TRƯỚC KHI DÙNG EXPRESS.JSON()
// Cực kỳ quan trọng: webhook.routes.js sử dụng express.raw() để giữ nguyên buffer nhị phân,
// nếu để express.json() chạy trước sẽ làm thay đổi formatting khiến chữ ký HMAC bị sai lệch!
const webhookRoutes = require('./backend/webhook.routes');
app.use('/api/webhooks', webhookRoutes);

// 3. MIDDLEWARE PARSER CHO CÁC API THÔNG THƯỜNG
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 4. MOUNT CÁC ROUTE BACKEND
const uploadRoutes = require('./backend/upload.routes');
const chatbotRoutes = require('./backend/chatbot.routes');
const checkoutRoutes = require('./backend/checkout.routes');

app.use('/api/upload', uploadRoutes); // POST /api/upload/url, POST /api/upload/local
app.use('/api', chatbotRoutes);       // POST /api/chat, POST /api/chat/sync
app.use('/api', checkoutRoutes);      // POST /api/checkout

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'MocNha Backend Core',
  });
});

// 5. PHỤC VỤ FILE TĨNH FRONTEND AN TOÀN (CHỐNG LỘ CODE BACKEND & SQL)
// Tuyệt đối KHÔNG dùng app.use(express.static(__dirname)).
// Chỉ phục vụ tĩnh riêng thư mục /assets (css, js, images, ...)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Chặn triệt để mọi truy cập trực tiếp tới /backend, /sql, .env, package.json
app.use(['/backend*', '/sql*', '/.env*', '/package*'], (req, res) => {
  res.status(404).json({
    status: 'error',
    code: 'NOT_FOUND',
    message: 'Tài nguyên không tồn tại hoặc đã bị khóa bảo mật.',
  });
});

// Route phục vụ index.html cho trang chủ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Xử lý 404 cho API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    status: 'error',
    code: 'ROUTE_NOT_FOUND',
    message: `API endpoint "${req.originalUrl}" does not exist.`,
  });
});

// SPA Fallback cho các đường dẫn khác (chỉ trả về index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 6. KHỞI CHẠY SERVER
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` Mộc Nhà - Wabi-Sabi Platform Server is running!`);
    console.log(` URL: http://localhost:${PORT}`);
    console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
