/**
 * webhook.controller.js
 * 
 * Controller xử lý Webhook thanh toán:
 * 1. Đọc và xác thực Header x-webhook-timestamp (chống Replay Attack, giới hạn độ lệch 300s).
 * 2. Xác thực chữ ký HMAC-SHA256 Timing-Safe với crypto.timingSafeEqual (chống Timing Side-Channel Attack).
 * 3. Bảo toàn nguyên vẹn raw body buffer khi tính toán HMAC.
 * 4. Gọi Supabase RPC process_verified_payment_webhook bằng Service Role Client (đã được chứng thực chữ ký).
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Supabase Admin Client với Service Role Key (Chỉ sử dụng sau khi đã verify chữ ký Webhook 100%)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

// Giới hạn độ lệch thời gian cho phép giữa Server và Timestamp Webhook (5 phút = 300 giây)
const MAX_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Xử lý Webhook thanh toán an toàn
 * Route: POST /api/webhooks/payment
 * Yêu cầu: raw body buffer từ middleware express.raw()
 */
async function handlePaymentWebhook(req, res) {
  try {
    // 1. KIỂM TRA SỰ TỒN TẠI CỦA RAW BODY BUFFER
    const rawBodyBuffer = req.body;
    if (!rawBodyBuffer || !Buffer.isBuffer(rawBodyBuffer)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_BODY_FORMAT',
        message: 'Raw body buffer is required. Ensure express.raw() middleware is configured.',
      });
    }

    // 2. ĐỌC HEADERS CHỮ KÝ VÀ TIMESTAMP
    const signature = req.headers['x-webhook-signature'];
    const timestampHeader = req.headers['x-webhook-timestamp'];

    if (!signature || typeof signature !== 'string') {
      return res.status(401).json({
        status: 'error',
        code: 'MISSING_SIGNATURE',
        message: 'Missing "x-webhook-signature" header.',
      });
    }

    if (!timestampHeader || typeof timestampHeader !== 'string') {
      return res.status(401).json({
        status: 'error',
        code: 'MISSING_TIMESTAMP',
        message: 'Missing "x-webhook-timestamp" header.',
      });
    }

    // 3. CHỐNG REPLAY ATTACK: KIỂM TRA TIMESTAMP
    const rawTimestamp = Number(timestampHeader);
    if (!Number.isInteger(rawTimestamp) || rawTimestamp <= 0) {
      return res.status(401).json({
        status: 'error',
        code: 'INVALID_TIMESTAMP',
        message: 'Header "x-webhook-timestamp" must be a valid positive integer timestamp.',
      });
    }

    // Hỗ trợ cả timestamp dạng giây (10 số) hoặc mili-giây (13 số)
    const timestampInSeconds = rawTimestamp > 10000000000 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
    const currentServerTimeSeconds = Math.floor(Date.now() / 1000);
    const timeDifference = Math.abs(currentServerTimeSeconds - timestampInSeconds);

    if (timeDifference > MAX_TIMESTAMP_TOLERANCE_SECONDS) {
      return res.status(401).json({
        status: 'error',
        code: 'TIMESTAMP_OUT_OF_BOUNDS',
        message: `Webhook timestamp expired. Request time drift (${timeDifference}s) exceeds allowed tolerance (${MAX_TIMESTAMP_TOLERANCE_SECONDS}s).`,
      });
    }

    // 4. XÁC THỰC CHỮ KÝ HMAC-SHA256 TIMING-SAFE
    const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Webhook Error] PAYMENT_WEBHOOK_SECRET environment variable is missing.');
      return res.status(500).json({
        status: 'error',
        code: 'CONFIGURATION_ERROR',
        message: 'Webhook secret is not configured on the server.',
      });
    }

    // Chuỗi ký chuẩn: ${timestamp}.${rawBody}
    const signedPayload = `${timestampHeader}.${rawBodyBuffer.toString('utf8')}`;
    const expectedSignatureHex = crypto
      .createHmac('sha256', webhookSecret)
      .update(signedPayload)
      .digest('hex');

    // Chuyển sang Buffer để thực hiện Timing-Safe Equal (chống Timing Side-Channel Attack)
    const sigBuffer = Buffer.from(signature.trim().toLowerCase(), 'utf8');
    const expectedBuffer = Buffer.from(expectedSignatureHex.toLowerCase(), 'utf8');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return res.status(401).json({
        status: 'error',
        code: 'INVALID_SIGNATURE',
        message: 'Webhook signature verification failed.',
      });
    }

    // 5. PARSE JSON VÀ VALIDATE DỮ LIỆU PAYLOAD
    let payload;
    try {
      payload = JSON.parse(rawBodyBuffer.toString('utf8'));
    } catch {
      return res.status(400).json({
        status: 'error',
        code: 'MALFORMED_JSON',
        message: 'Webhook raw body is not valid JSON.',
      });
    }

    const { event_id, order_id, amount, status, provider = 'PAYMENT_GATEWAY' } = payload || {};

    if (!event_id || typeof event_id !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_EVENT_ID',
        message: 'Field "event_id" is required in webhook payload.',
      });
    }

    if (!order_id || typeof order_id !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_ORDER_ID',
        message: 'Field "order_id" is required in webhook payload.',
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_AMOUNT',
        message: 'Field "amount" must be a positive number.',
      });
    }

    // Nếu trạng thái sự kiện không phải SUCCESS -> Bỏ qua không cập nhật đơn hàng
    if (status !== 'SUCCESS') {
      return res.status(200).json({
        status: 'ignored',
        message: `Webhook event received with non-success status: '${status}'. No order update performed.`,
      });
    }

    // 6. GỌI RPC CẬP NHẬT ĐƠN HÀNG NGUYÊN TỬ VÀ CHỐNG REPLAY TRÊN CSDL
    const { data, error } = await supabaseAdmin.rpc('process_verified_payment_webhook', {
      p_event_id: String(event_id).trim(),
      p_order_id: String(order_id).trim(),
      p_provider: String(provider).trim().toUpperCase(),
      p_amount: amount,
      p_raw_payload: payload,
    });

    if (error) {
      const errorMsg = error.message || '';

      if (errorMsg.includes('AMOUNT_MISMATCH')) {
        return res.status(422).json({
          status: 'error',
          code: 'AMOUNT_MISMATCH',
          message: 'Số tiền thanh toán không khớp với tổng tiền của đơn hàng.',
        });
      }

      if (errorMsg.includes('ORDER_NOT_FOUND')) {
        return res.status(404).json({
          status: 'error',
          code: 'ORDER_NOT_FOUND',
          message: 'Không tìm thấy đơn hàng cần thanh toán.',
        });
      }

      console.error(`[Webhook RPC Error] ${errorMsg}`);
      return res.status(500).json({
        status: 'error',
        code: 'WEBHOOK_PROCESSING_FAILED',
        message: 'Gặp sự cố khi cập nhật trạng thái đơn hàng từ Webhook.',
      });
    }

    // 7. TRẢ VỀ PHẢN HỒI THÀNH CÔNG
    // Nếu data.is_duplicate === true: Webhook đã được xử lý trước đó -> Vẫn trả 200 OK để cổng thanh toán ngừng retry
    if (data && data.is_duplicate) {
      return res.status(200).json({
        status: 'success',
        is_duplicate: true,
        message: 'Sự kiện thanh toán đã được ghi nhận trước đó.',
        event_id: data.event_id,
        order_id: data.order_id,
      });
    }

    return res.status(200).json({
      status: 'success',
      is_duplicate: false,
      message: 'Cập nhật thanh toán thành công.',
      data,
    });
  } catch (err) {
    console.error(`[Webhook Controller Error] ${err.message}`);
    return res.status(500).json({
      status: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Lỗi hệ thống khi xử lý Webhook.',
    });
  }
}

module.exports = {
  handlePaymentWebhook,
};
