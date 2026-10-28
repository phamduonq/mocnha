/**
 * upload.middleware.js
 * 
 * Middleware kiểm soát tải tệp cục bộ (Local Upload Security):
 * - Lưu trữ trong Memory (Multer memoryStorage), không ghi file tạm ra đĩa cứng.
 * - Giới hạn kích thước cứng: 5MB (5 * 1024 * 1024 bytes).
 * - Không tin cậy File Extension hay Content-Type do Client gửi.
 * - Xác thực Magic Number (File Signature) trực tiếp trên Buffer.
 * - Chặn đứng SVG và các định dạng tệp nguy hiểm khác.
 */

const multer = require('multer');

// Giới hạn dung lượng cứng 5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Kiểm tra Magic Number (File Signatures) từ Buffer nhị phân.
 * Chỉ cho phép: JPEG, PNG, WebP. Cấm tuyệt đối SVG và mọi tệp thực thi.
 *
 * @param {Buffer} buffer
 * @returns {string|null} MIME type hợp lệ hoặc null nếu không khớp
 */
function detectImageMimeType(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // 1. JPEG: Bắt đầu bằng byte FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // 2. PNG: Bắt đầu bằng byte 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return 'image/png';
  }

  // 3. WebP: RIFF (bytes 0..3: 0x52 0x49 0x46 0x46) và WEBP (bytes 8..11: 0x57 0x45 0x42 0x50)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

// Cấu hình Multer lưu trữ trực tiếp trong RAM
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1, // Chỉ nhận 1 tệp mỗi request
  },
});

/**
 * Middleware xử lý upload tệp cục bộ và xác thực Magic Number
 */
function handleLocalUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    // 1. Xử lý lỗi từ Multer (VD: quá kích thước)
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          status: 'error',
          code: 'PAYLOAD_TOO_LARGE',
          message: 'File size exceeds maximum allowed limit of 5MB.',
        });
      }
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: err.message || 'File upload error occurred.',
      });
    }

    // 2. Kiểm tra sự tồn tại của tệp
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'No image file was provided in form-data field "image".',
      });
    }

    // 3. Xác thực Magic Number (Phát hiện giả mạo extension/mimetype)
    const detectedMime = detectImageMimeType(req.file.buffer);

    if (!detectedMime) {
      return res.status(415).json({
        status: 'error',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Unsupported or malformed image format. Only JPEG, PNG, and WebP are permitted.',
      });
    }

    // Lưu lại MIME chuẩn đã xác thực vào req.file
    req.file.verifiedMimeType = detectedMime;
    next();
  });
}

module.exports = {
  handleLocalUpload,
  detectImageMimeType,
  MAX_FILE_SIZE,
};
