/**
 * upload.routes.js
 * 
 * Express Router cấu hình 2 luồng tải ảnh:
 * 1. POST /api/upload/url   : Yêu cầu requireAuth -> fetchSecureImage -> sanitize -> Supabase Storage (RLS).
 * 2. POST /api/upload/local : Yêu cầu requireAuth -> Multer memoryStorage -> Magic Number -> sanitize -> Supabase Storage (RLS).
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./requireAuth.middleware');
const { handleLocalUpload } = require('./upload.middleware');
const { uploadFromUrl, uploadFromLocal } = require('./upload.controller');

// Luồng 1: Cung cấp URL ảnh (Bắt buộc xác thực Bearer token)
router.post('/url', requireAuth, uploadFromUrl);

// Luồng 2: Tải file cục bộ lên (Bắt buộc xác thực Bearer token + Magic Number validation)
router.post('/local', requireAuth, handleLocalUpload, uploadFromLocal);

module.exports = router;
