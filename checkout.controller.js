/**
 * checkout.controller.js
 * 
 * Controller xử lý luồng đặt hàng thanh toán:
 * - Kiểm tra định dạng Header Idempotency-Key (Bắt buộc chuẩn UUID v4).
 * - Kiểm tra dữ liệu đầu vào nghiêm ngặt (items từ 1 đến 50 mặt hàng, quantity từ 1 đến 100).
 * - Validate shipping_address (5 - 500 ký tự) và payment_method ('COD', 'BANK_TRANSFER', 'VNPAY', 'MOMO').
 * - Phân biệt mã phản hồi:
 *   + 200 OK: Đơn hàng đã xử lý thành công trước đó (Idempotent replay).
 *   + 201 Created: Đơn hàng mới vừa được tạo nguyên tử.
 *   + 400 Bad Request: Dữ liệu gửi lên sai định dạng hoặc thiếu Idempotency-Key.
 *   + 409 Conflict: Request trùng lặp đang chạy, lệch payload hoặc đụng độ khóa dòng đồng thời.
 *   + 422 Unprocessable Entity: Hết hàng trong kho hoặc sản phẩm không tồn tại.
 *   + 500 Internal Server Error: Che giấu toàn bộ stack trace và chi tiết SQL.
 */

const { executeAtomicCheckout } = require('./checkout.service');

// Biểu thức chính quy kiểm tra định dạng chuẩn UUID v4
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Biểu thức chính quy kiểm tra UUID tổng quát
const UUID_GENERAL_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Danh sách các phương thức thanh toán được hỗ trợ
const ALLOWED_PAYMENT_METHODS = ['COD', 'BANK_TRANSFER', 'VNPAY', 'MOMO'];
const MAX_CART_ITEMS = 50;
const MAX_QUANTITY_PER_ITEM = 100;

/**
 * Controller xử lý yêu cầu Checkout
 * POST /api/checkout
 * Headers:
 *   Authorization: Bearer <jwt_token>
 *   Idempotency-Key: <uuid_v4>
 */
async function checkoutHandler(req, res) {
  try {
    // 1. KIỂM TRA HEADER IDEMPOTENCY-KEY
    const rawIdempotencyKey = req.headers['idempotency-key'];

    if (!rawIdempotencyKey || typeof rawIdempotencyKey !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Header "Idempotency-Key" là bắt buộc để ngăn chặn thanh toán trùng lặp.',
      });
    }

    const idempotencyKey = rawIdempotencyKey.trim().toLowerCase();
    if (!UUID_V4_REGEX.test(idempotencyKey)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_IDEMPOTENCY_KEY_FORMAT',
        message: 'Header "Idempotency-Key" phải là chuỗi định danh hợp lệ chuẩn UUID v4.',
      });
    }

    // 2. KIỂM TRA DỮ LIỆU ĐẦU VÀO (REQUEST BODY)
    const { items, shipping_address, payment_method } = req.body || {};

    // 2.1. Kiểm tra items
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_CART_ITEMS',
        message: 'Trường "items" phải là một mảng danh sách sản phẩm và không được để trống.',
      });
    }

    if (items.length > MAX_CART_ITEMS) {
      return res.status(400).json({
        status: 'error',
        code: 'MAX_CART_ITEMS_EXCEEDED',
        message: `Giỏ hàng chỉ được chứa tối đa ${MAX_CART_ITEMS} mặt hàng mỗi lần đặt.`,
      });
    }

    // Kiểm tra chi tiết từng mặt hàng (product_id và quantity từ 1 đến 100)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        return res.status(400).json({
          status: 'error',
          code: 'MALFORMED_ITEM',
          message: `Mặt hàng tại vị trí ${i} không hợp lệ.`,
        });
      }

      if (!item.product_id || !UUID_GENERAL_REGEX.test(String(item.product_id))) {
        return res.status(400).json({
          status: 'error',
          code: 'INVALID_PRODUCT_ID',
          message: `Mã sản phẩm tại vị trí ${i} không đúng định dạng UUID.`,
        });
      }

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
        return res.status(400).json({
          status: 'error',
          code: 'INVALID_QUANTITY',
          message: `Số lượng cho sản phẩm tại vị trí ${i} phải là số nguyên từ 1 đến ${MAX_QUANTITY_PER_ITEM}.`,
        });
      }
    }

    // 2.2. Kiểm tra shipping_address (5 - 500 ký tự)
    if (!shipping_address || typeof shipping_address !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_SHIPPING_ADDRESS',
        message: 'Địa chỉ nhận hàng (shipping_address) không được để trống.',
      });
    }

    const cleanShippingAddress = shipping_address.trim();
    if (cleanShippingAddress.length < 5 || cleanShippingAddress.length > 500) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_SHIPPING_ADDRESS',
        message: 'Địa chỉ nhận hàng phải có độ dài từ 5 đến 500 ký tự.',
      });
    }

    // 2.3. Kiểm tra payment_method
    if (!payment_method || typeof payment_method !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_PAYMENT_METHOD',
        message: 'Phương thức thanh toán (payment_method) không được để trống.',
      });
    }

    const cleanPaymentMethod = payment_method.trim().toUpperCase();
    if (!ALLOWED_PAYMENT_METHODS.includes(cleanPaymentMethod)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_PAYMENT_METHOD',
        message: `Phương thức thanh toán không hợp lệ. Chỉ chấp nhận: ${ALLOWED_PAYMENT_METHODS.join(', ')}.`,
      });
    }

    // 3. LẤY TOKEN ĐÃ ĐƯỢC XÁC THỰC TỪ REQUIREAUTH MIDDLEWARE
    const accessToken = req.token;
    if (!accessToken) {
      return res.status(401).json({
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Yêu cầu không được xác thực.',
      });
    }

    // 4. THỰC THI GIAO DỊCH CHECKOUT NGUYÊN TỬ
    const checkoutResult = await executeAtomicCheckout({
      idempotencyKey,
      items,
      shippingAddress: cleanShippingAddress,
      paymentMethod: cleanPaymentMethod,
      accessToken,
    });

    // 5. TRẢ VỀ PHẢN HỒI CHUẨN
    if (checkoutResult.is_replay) {
      res.setHeader('X-Cache-Lookup', 'HIT');
      res.setHeader('Idempotency-Status', 'REPLAYED');
      return res.status(200).json({
        status: 'success',
        is_replay: true,
        message: 'Đơn hàng đã được ghi nhận trước đó (Idempotency Replay).',
        data: checkoutResult.data,
      });
    }

    res.setHeader('Idempotency-Status', 'PROCESSED');
    return res.status(201).json({
      status: 'success',
      is_replay: false,
      message: 'Đặt hàng thành công.',
      data: checkoutResult.data,
    });
  } catch (err) {
    // 6. XỬ LÝ NGOẠI LỆ TRIỆT ĐỂ, KHÔNG LÀM RÒ RỈ STACK TRACE
    const statusCode = err.status && Number.isInteger(err.status) ? err.status : 500;
    const errorCode = err.code || 'INTERNAL_SERVER_ERROR';

    console.error(`[Checkout Controller Error] Status: ${statusCode} | Code: ${errorCode} | Message: ${err.message}`);
    if (statusCode === 500 && err.stack) {
      console.error(err.stack);
    }

    return res.status(statusCode).json({
      status: 'error',
      code: errorCode,
      message: statusCode === 500
        ? 'Hệ thống thanh toán đang bận hoặc gặp sự cố. Bạn vui lòng thử lại sau.'
        : err.message,
    });
  }
}

module.exports = {
  checkoutHandler,
};
