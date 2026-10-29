/**
 * image.service.js
 * 
 * Dịch vụ xử lý ảnh bảo mật chuyên sâu:
 * 1. Chống SSRF triệt để (Manual DNS resolution, IP Blocklist, DNS Rebinding Pinning, No-Redirects, 3000ms Timeout).
 * 2. Khử độc dữ liệu với Sharp (Decode raw pixels, Strip EXIF/IPTC/XMP/Comments, Auto-orient, Re-encode thành WebP).
 * 3. Tương tác an toàn với Supabase Storage:
 *    - TUYỆT ĐỐI KHÔNG dùng SUPABASE_SERVICE_ROLE_KEY.
 *    - Sử dụng Dynamic Supabase Client với anon_key + accessToken (impersonate user) để ép Supabase thực thi Storage RLS Policies.
 */

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { detectImageMimeType, MAX_FILE_SIZE } = require('./upload.middleware');

// Sử dụng chuẩn Anon Key (tuyệt đối không dùng Service Role Key trong luồng upload)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

/**
 * Tạo Dynamic Supabase Client đóng vai (impersonate) chính User đang gửi request.
 * Khi đẩy file lên Supabase Storage, engine Postgres sẽ dùng token này để chạy RLS:
 * auth.uid() sẽ tương ứng với người dùng sở hữu token.
 *
 * @param {string} accessToken - JWT Bearer token của user
 * @returns {object} Supabase Client instance với Authorization header của User
 */
function createAuthenticatedClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Chuyển chuỗi IPv4 thành số nguyên 32-bit không dấu
 */
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/**
 * So sánh IP dạng số nguyên với một Subnet CIDR
 */
function inSubnet(ipInt, subnetInt, maskBits) {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (subnetInt & mask);
}

/**
 * IP Blocklist toàn diện chặn đứng toàn bộ mạng nội bộ và các dải nhạy cảm:
 * - IPv4: 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (Metadata), 172.16.0.0/12, 192.168.0.0/16, CGNAT, Multicast, Broadcast
 * - IPv6: ::1, ::, fc00::/7 (ULA), fe80::/10 (Link-Local), ff00::/8 (Multicast), IPv4-mapped IPv6 (::ffff:0:0/96)
 *
 * @param {string} rawIp
 * @returns {boolean} true nếu IP bị chặn, false nếu IP công khai an toàn
 */
function isBlockedIp(rawIp) {
  let ip = rawIp.trim();

  // Chuẩn hóa IPv4-mapped IPv6 (ví dụ: ::ffff:127.0.0.1 hoặc ::ffff:169.254.169.254)
  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  const family = net.isIP(ip);
  if (family === 0) return true; // IP không hợp lệ -> Chặn ngay

  if (family === 4) {
    const ipInt = ipv4ToInt(ip);

    // 0.0.0.0/8 (This network - trên Linux có thể trỏ về localhost)
    if (inSubnet(ipInt, ipv4ToInt('0.0.0.0'), 8)) return true;

    // 10.0.0.0/8 (Private Network RFC 1918)
    if (inSubnet(ipInt, ipv4ToInt('10.0.0.0'), 8)) return true;

    // 100.64.0.0/10 (Shared Address Space / CGNAT RFC 6598)
    if (inSubnet(ipInt, ipv4ToInt('100.64.0.0'), 10)) return true;

    // 127.0.0.0/8 (Loopback RFC 1122)
    if (inSubnet(ipInt, ipv4ToInt('127.0.0.0'), 8)) return true;

    // 169.254.0.0/16 (Link-Local, Cloud Metadata Service: AWS, GCP, Azure, DigitalOcean)
    if (inSubnet(ipInt, ipv4ToInt('169.254.0.0'), 16)) return true;

    // 172.16.0.0/12 (Private Network RFC 1918: 172.16.0.0 - 172.31.255.255)
    if (inSubnet(ipInt, ipv4ToInt('172.16.0.0'), 12)) return true;

    // 192.0.0.0/24 (IETF Assignments) & 192.0.2.0/24 (TEST-NET-1)
    if (inSubnet(ipInt, ipv4ToInt('192.0.0.0'), 24)) return true;
    if (inSubnet(ipInt, ipv4ToInt('192.0.2.0'), 24)) return true;

    // 192.168.0.0/16 (Private Network RFC 1918)
    if (inSubnet(ipInt, ipv4ToInt('192.168.0.0'), 16)) return true;

    // 198.18.0.0/15 (Benchmarking RFC 2544) & 198.51.100.0/24 (TEST-NET-2)
    if (inSubnet(ipInt, ipv4ToInt('198.18.0.0'), 15)) return true;
    if (inSubnet(ipInt, ipv4ToInt('198.51.100.0'), 24)) return true;

    // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
    if (inSubnet(ipInt, ipv4ToInt('203.0.113.0'), 24)) return true;

    // 224.0.0.0/4 (Multicast RFC 5771)
    if (inSubnet(ipInt, ipv4ToInt('224.0.0.0'), 4)) return true;

    // 240.0.0.0/4 (Reserved RFC 1112 bao gồm cả Broadcast 255.255.255.255)
    if (inSubnet(ipInt, ipv4ToInt('240.0.0.0'), 4)) return true;

    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();

    // Loopback: ::1
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;

    // Unspecified: ::
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;

    // Unique Local Address (ULA fc00::/7 -> bắt đầu bằng fc hoặc fd)
    if (/^[fF][cCdD]/.test(lower)) return true;

    // Link-Local (fe80::/10 -> bắt đầu bằng fe8, fe9, fea, feb)
    if (/^[fF][eE][89aAbB]/.test(lower)) return true;

    // Multicast (ff00::/8 -> bắt đầu bằng ff)
    if (/^[fF][fF]/.test(lower)) return true;

    // Documentation (2001:db8::/32)
    if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return true;

    return false;
  }

  return true;
}

/**
 * Tải ảnh từ URL với cơ chế bảo vệ SSRF tuyệt đối.
 * 
 * @param {string} rawUrl - URL do người dùng cung cấp
 * @returns {Promise<{ buffer: Buffer, mimeType: string, size: number }>}
 */
async function fetchSecureImage(rawUrl) {
  // 1. Phân tích và kiểm tra cú pháp URL
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    const err = new Error('Invalid URL format.');
    err.status = 400;
    throw err;
  }

  // Chỉ cho phép HTTP và HTTPS (chặn file://, ftp://, gopher://, dict://, ldap://,...)
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    const err = new Error('Forbidden protocol. Only HTTP and HTTPS are permitted.');
    err.status = 400;
    throw err;
  }

  const hostname = parsedUrl.hostname;
  if (!hostname) {
    const err = new Error('URL hostname is required.');
    err.status = 400;
    throw err;
  }

  // 2. Phân giải DNS thủ công (Manual DNS Resolution) trước khi gửi HTTP request
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    const err = new Error('DNS resolution failed for the provided host.');
    err.status = 400;
    throw err;
  }

  if (!addresses || addresses.length === 0) {
    const err = new Error('No IP address found for the specified host.');
    err.status = 400;
    throw err;
  }

  // 3. Kiểm tra TẤT CẢ các địa chỉ IP được trả về với IP Blocklist
  for (const record of addresses) {
    if (isBlockedIp(record.address)) {
      const err = new Error('Access to private, loopback, or restricted network is blocked.');
      err.status = 400; // Trả về 400 thay vì 403 để tránh rò rỉ SSRF probing oracle
      throw err;
    }
  }

  // Chọn IP đã được kiểm chứng an toàn để ghim vào kết nối TCP (Chống DNS Rebinding)
  const verifiedRecord = addresses[0];

  // 4. Thiết lập AbortController với Timeout tối đa 3000ms
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 3000);

  // 5. Gửi HTTP Request với IP Pinning và Stream Size Limiting
  return new Promise((resolve, reject) => {
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions = {
      protocol: parsedUrl.protocol,
      hostname: hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
      method: 'GET',
      headers: {
        'Host': parsedUrl.host,
        'User-Agent': 'SecureImageClient/1.0',
        'Accept': 'image/jpeg, image/png, image/webp',
      },
      signal: controller.signal,
      // CHỐNG DNS REBINDING: Ghim trực tiếp IP đã kiểm tra vào socket kết nối
      lookup: (_hostname, _opts, callback) => {
        callback(null, verifiedRecord.address, verifiedRecord.family);
      },
      // Đảm bảo TLS SNI gửi đúng hostname gốc cho chứng chỉ HTTPS
      servername: hostname,
    };

    const req = client.request(requestOptions, (res) => {
      // CHỐNG SSRF QUA REDIRECT: Cấm chuyển hướng HTTP 3xx
      if (res.statusCode >= 300 && res.statusCode < 400) {
        clearTimeout(timeoutId);
        res.destroy();
        const err = new Error('HTTP redirects are prohibited for security.');
        err.status = 400;
        return reject(err);
      }

      if (res.statusCode !== 200) {
        clearTimeout(timeoutId);
        res.destroy();
        const err = new Error(`Remote server responded with non-200 status code: ${res.statusCode}.`);
        err.status = 400;
        return reject(err);
      }

      // Kiểm tra Header Content-Type
      const rawContentType = res.headers['content-type'] || '';
      const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
      const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

      if (!ALLOWED_MIME.includes(mimeType)) {
        clearTimeout(timeoutId);
        res.destroy();
        const err = new Error(`Unsupported Content-Type: '${mimeType}'. Only JPEG, PNG, and WebP are accepted.`);
        err.status = 415;
        return reject(err);
      }

      // Kiểm tra Header Content-Length (nếu có sẵn)
      const contentLengthHeader = res.headers['content-length'];
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (contentLength > MAX_FILE_SIZE) {
          clearTimeout(timeoutId);
          res.destroy();
          const err = new Error('Image size exceeds 5MB limit.');
          err.status = 413;
          return reject(err);
        }
      }

      // Thu thập chunks và đếm byte (ngắt ngay nếu server gửi quá 5MB mà không có Content-Length)
      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FILE_SIZE) {
          clearTimeout(timeoutId);
          res.destroy();
          const err = new Error('Image payload exceeded 5MB size limit during stream transfer.');
          err.status = 413;
          return reject(err);
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        clearTimeout(timeoutId);
        const buffer = Buffer.concat(chunks);

        // Xác thực lại Magic Number trên Buffer nhị phân
        const detectedMime = detectImageMimeType(buffer);
        if (!detectedMime || !ALLOWED_MIME.includes(detectedMime)) {
          const err = new Error('File signature verification failed: Payload is not a valid JPEG, PNG, or WebP image.');
          err.status = 415;
          return reject(err);
        }

        resolve({
          buffer,
          mimeType: detectedMime,
          size: buffer.length,
        });
      });

      res.on('error', () => {
        clearTimeout(timeoutId);
        const err = new Error('Network error occurred during stream reading.');
        err.status = 500;
        reject(err);
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      if (controller.signal.aborted) {
        const timeoutErr = new Error('Image download timed out after 3000ms.');
        timeoutErr.status = 408;
        return reject(timeoutErr);
      }
      const netErr = new Error('Failed to connect to the image source.');
      netErr.status = 500;
      reject(netErr);
    });

    req.end();
  });
}

/**
 * Khử độc dữ liệu với Sharp (Data Sanitization & Stripping EXIF):
 * 1. Decode ảnh gốc thành uncompressed pixel array trong RAM (bằng libvips).
 * 2. .rotate(): Tự động xoay pixel theo thẻ EXIF Orientation của ảnh chụp trước khi hủy metadata.
 * 3. Mặc định Sharp LOẠI BỎ TOÀN BỘ METADATA (EXIF, IPTC, XMP, Comments, ICC Profiles)
 *    khi không gọi method .withMetadata().
 * 4. Encode lại toàn bộ từ mảng pixel thô thành định dạng WebP đồng nhất.
 * 5. Bất kỳ mã độc, script độc hại hay payload ẩn trong metadata/chunks sẽ bị tiêu hủy 100%.
 *
 * @param {Buffer} inputBuffer - Buffer ảnh gốc
 * @returns {Promise<Buffer>} - Buffer WebP đã được khử độc hoàn toàn
 */
async function sanitizeAndConvertImage(inputBuffer) {
  try {
    const cleanBuffer = await sharp(inputBuffer, {
      failOn: 'error', // Hủy ngay lập tức nếu phát hiện cấu trúc ảnh bị lỗi, corrupt hoặc tấn công
      animated: false, // Chỉ lấy frame đầu tiên để triệt tiêu nguy cơ WebP/GIF animation memory bomb
      limitInputPixels: 268402689, // Ngăn chặn Decompression Bomb (Pixel Flood Attack)
    })
      .rotate() // Auto-orient pixel matrix dựa trên EXIF orientation trước khi vứt bỏ metadata
      .webp({
        quality: 80,
        effort: 4,
        lossless: false,
      })
      // LƯU Ý BẢO MẬT: KHÔNG GỌI .withMetadata()
      // Việc này đảm bảo Sharp sẽ vứt bỏ 100% EXIF, IPTC, XMP, GPS và text comments của ảnh gốc!
      .toBuffer();

    return cleanBuffer;
  } catch {
    const err = new Error('Image sanitization failed: The provided file is corrupt, malformed, or contains invalid image data.');
    err.status = 400;
    throw err;
  }
}

/**
 * Tải ảnh đã khử độc lên Supabase Storage bucket 'user_uploads'.
 * 
 * YÊU CẦU BẢO MẬT TUYỆT ĐỐI:
 * - KHÔNG DÙNG Service Role Key (để không bao giờ bypass RLS).
 * - Sử dụng dynamic Supabase client được xác thực với `accessToken` của User.
 * - Ép Supabase Storage thực thi RLS Policy:
 *   (storage.foldername(name))[1] = auth.uid()::text
 * 
 * @param {Buffer} cleanBuffer - Buffer ảnh WebP sạch
 * @param {string} userId - UUID của người dùng (từ req.user.id đã xác thực)
 * @param {string} accessToken - JWT Token lấy từ req.headers.authorization
 * @param {string} originalFileName - Tên gốc (dùng để tham khảo)
 * @returns {Promise<{ path: string, fullPath: string }>}
 */
async function uploadToSupabase(cleanBuffer, userId, accessToken, originalFileName = 'image') {
  if (!userId || !accessToken) {
    const err = new Error('User authentication required: Missing userId or accessToken.');
    err.status = 401;
    throw err;
  }

  // Khởi tạo Dynamic Client với token của chính người dùng
  const userSupabase = createAuthenticatedClient(accessToken);

  // Sinh UUID ngẫu nhiên cho tên tệp để chống path traversal và ghi đè
  const fileUuid = crypto.randomUUID();
  const filePath = `${userId}/${fileUuid}.webp`;

  // Thực hiện upload: Supabase sẽ tự động chạy SQL RLS Policy với auth.uid() = userId
  const { data, error } = await userSupabase.storage
    .from('user_uploads')
    .upload(filePath, cleanBuffer, {
      contentType: 'image/webp',
      upsert: false,
    });

  if (error) {
    // Nếu vi phạm RLS (ví dụ folder không khớp với auth.uid() của token), trả về lỗi 403
    const isRlsError = error.message?.toLowerCase().includes('row-level security') ||
                       error.message?.toLowerCase().includes('violates');
    const err = new Error(`Storage upload rejected by policy: ${error.message}`);
    err.status = isRlsError ? 403 : 500;
    throw err;
  }

  // Lấy đường dẫn URL công khai trực tiếp từ Supabase Storage
  const { data: urlData } = userSupabase.storage
    .from('user_uploads')
    .getPublicUrl(data.path);

  return {
    path: data.path,
    fullPath: `user_uploads/${data.path}`,
    publicUrl: urlData?.publicUrl || '',
  };
}

module.exports = {
  fetchSecureImage,
  sanitizeAndConvertImage,
  uploadToSupabase,
  isBlockedIp,
  createAuthenticatedClient,
};
