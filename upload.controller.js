/**
 * upload.controller.js
 * 
 * Controller xử lý 2 luồng nhận ảnh:
 * 1. uploadFromUrl: Tải ảnh từ URL với cơ chế bảo vệ SSRF.
 * 2. uploadFromLocal: Tải ảnh từ tệp cục bộ qua Multer + Magic Number verification.
 * 
 * BẢO MẬT:
 * - CẤM TUYỆT ĐỐI req.headers['x-user-id'] (chống Identity Spoofing).
 * - userId CHỈ ĐƯỢC PHÉP lấy duy nhất từ req.user.id (đã được requireAuth middleware xác thực).
 * - Truyền accessToken của user vào service để impersonate khi tương tác với Supabase Storage.
 */

const {
  fetchSecureImage,
  sanitizeAndConvertImage,
  uploadToSupabase,
} = require('./image.service');

/**
 * Hàm phụ trợ chuẩn hóa phản hồi lỗi, che giấu stack trace
 */
function sendErrorResponse(res, err) {
  // Lấy HTTP Status đã được gán hoặc mặc định là 500
  const statusCode = err.status && Number.isInteger(err.status) ? err.status : 500;

  // Bản đồ mã lỗi chuẩn
  const codeMap = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    408: 'REQUEST_TIMEOUT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    500: 'INTERNAL_SERVER_ERROR',
  };

  const errorCode = codeMap[statusCode] || 'UNKNOWN_ERROR';

  // Thông báo an toàn cho client (không rò rỉ chi tiết nhạy cảm của hệ thống nếu là 500)
  const clientMessage = statusCode === 500
    ? 'An unexpected error occurred while processing the image. Please try again later.'
    : err.message || 'Operation failed.';

  // Chỉ log lỗi chi tiết và stack trace trên server console/logger nội bộ
  console.error(`[Upload Error] Status: ${statusCode} | Code: ${errorCode} | Message: ${err.message}`);
  if (statusCode === 500 && err.stack) {
    console.error(err.stack);
  }

  return res.status(statusCode).json({
    status: 'error',
    code: errorCode,
    message: clientMessage,
  });
}

/**
 * Controller: Nhận ảnh từ URL (Chống SSRF, Khử độc qua Sharp, Lưu Supabase)
 * Route: POST /api/upload/url
 * Body: { "url": "https://example.com/photo.jpg" }
 */
async function uploadFromUrl(req, res) {
  try {
    const { url } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'Field "url" is required and must be a valid URL string.',
      });
    }

    // CHỐNG IDENTITY SPOOFING:
    // Tuyệt đối không đọc req.headers['x-user-id'].
    // userId CHỈ lấy duy nhất từ req.user.id đã được requireAuth xác thực.
    const userId = req.user?.id;
    const accessToken = req.token;

    if (!userId || !accessToken) {
      return res.status(401).json({
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Authentication context missing. Request must pass requireAuth middleware.',
      });
    }

    // Bước 1: Fetch ảnh an toàn (Chống SSRF, DNS Rebinding, 3000ms timeout, <5MB)
    const { buffer: rawBuffer } = await fetchSecureImage(url);

    // Bước 2: Khử độc dữ liệu với Sharp (Strip 100% EXIF/Metadata, Convert WebP)
    const cleanBuffer = await sanitizeAndConvertImage(rawBuffer);

    // Bước 3: Lưu trữ an toàn lên Supabase Storage với Dynamic Authenticated Client (RLS Enforced)
    const uploadResult = await uploadToSupabase(cleanBuffer, userId, accessToken, 'remote_image');

    // Phản hồi thành công
    return res.status(201).json({
      status: 'success',
      message: 'Image fetched, sanitized, and stored successfully.',
      data: {
        path: uploadResult.path,
        fullPath: uploadResult.fullPath,
        format: 'webp',
        size: cleanBuffer.length,
      },
    });
  } catch (error) {
    return sendErrorResponse(res, error);
  }
}

/**
 * Controller: Nhận ảnh từ tệp cục bộ (Đã qua Multer + Magic Number validation)
 * Route: POST /api/upload/local
 * Body: multipart/form-data with field "image"
 */
async function uploadFromLocal(req, res) {
  try {
    // req.file đã được middleware handleLocalUpload kiểm tra magic number
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'No valid image file uploaded.',
      });
    }

    // CHỐNG IDENTITY SPOOFING:
    // userId CHỈ lấy duy nhất từ req.user.id đã được requireAuth xác thực.
    const userId = req.user?.id;
    const accessToken = req.token;

    if (!userId || !accessToken) {
      return res.status(401).json({
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Authentication context missing. Request must pass requireAuth middleware.',
      });
    }

    // Bước 1: Khử độc dữ liệu với Sharp (Strip 100% EXIF/Metadata, Convert WebP)
    const cleanBuffer = await sanitizeAndConvertImage(req.file.buffer);

    // Bước 2: Lưu trữ an toàn lên Supabase Storage với Dynamic Authenticated Client (RLS Enforced)
    const uploadResult = await uploadToSupabase(
      cleanBuffer,
      userId,
      accessToken,
      req.file.originalname || 'local_image'
    );

    // Phản hồi thành công
    return res.status(201).json({
      status: 'success',
      message: 'Image uploaded, sanitized, and stored successfully.',
      data: {
        path: uploadResult.path,
        fullPath: uploadResult.fullPath,
        format: 'webp',
        size: cleanBuffer.length,
      },
    });
  } catch (error) {
    return sendErrorResponse(res, error);
  }
}

module.exports = {
  uploadFromUrl,
  uploadFromLocal,
  sendErrorResponse,
};
