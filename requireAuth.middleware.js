/**
 * requireAuth.middleware.js
 * 
 * Middleware xác thực danh tính người dùng qua Supabase Auth:
 * - Trích xuất Bearer Token từ Header 'Authorization'.
 * - Xác thực token trực tiếp với Supabase Auth qua `supabase.auth.getUser(token)`.
 * - Gán đối tượng user đã xác thực vào `req.user` và accessToken vào `req.token`.
 * - Từ chối ngay lập tức (HTTP 401) nếu token không tồn tại, hết hạn, hoặc không hợp lệ.
 * - Triệt tiêu hoàn toàn nguy cơ Identity Spoofing (giả mạo định danh).
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

// Khởi tạo Supabase client với Anon Key chuẩn (không bao giờ dùng Service Role Key ở đây)
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * Middleware bắt buộc xác thực token người dùng
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  // 1. Kiểm tra sự tồn tại của header Authorization với định dạng Bearer
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Access denied: Missing or malformed Authorization header. Expected Bearer token.',
    });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Access denied: Empty Bearer token provided.',
    });
  }

  try {
    // 2. Xác thực JWT Token với Supabase Auth
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Invalid, expired, or revoked access token.',
      });
    }

    // 3. Gán thông tin người dùng và token đã được chứng thực vào request object
    req.user = user;
    req.token = token;

    next();
  } catch (err) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Authentication failed due to token validation error.',
    });
  }
}

module.exports = {
  requireAuth,
};
