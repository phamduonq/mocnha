/**
 * checkout.service.js
 * 
 * Service xử lý đặt hàng nguyên tử (Atomic Checkout):
 * 1. Tính toán mã băm SHA-256 (requestHash) từ giỏ hàng đã chuẩn hóa để phát hiện Payload Mismatch.
 * 2. Tạo Dynamic Supabase Client với User JWT Token (bảo tồn context auth.uid(), không dùng Service Key).
 * 3. Gọi Stored Procedure nguyên tử `process_atomic_checkout` và map mã lỗi chuẩn HTTP.
 *    - Xử lý lock_timeout (55P03): Trả về HTTP 409 khi có đụng độ tranh chấp khóa.
 *    - Bắt lỗi INVALID_QUANTITY (HTTP 400) khi có gian lận số lượng.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

/**
 * Khởi tạo Dynamic Supabase Client với token của chính người dùng
 * Bắt buộc để PostgreSQL nhận diện đúng auth.uid() trong Stored Procedure
 *
 * @param {string} accessToken - JWT Bearer Token của người dùng
 * @returns {object} Supabase Client instance
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
 * Chuẩn hóa giỏ hàng và tính toán mã băm SHA-256:
 * - Gộp các mặt hàng có cùng product_id.
 * - Sắp xếp theo thứ tự product_id ASC để đảm bảo tính nhất quán (deterministic).
 * - Kết hợp với shipping_address và payment_method trước khi băm SHA-256.
 *
 * @param {Array<{ product_id: string, quantity: number }>} items
 * @param {string} shippingAddress
 * @param {string} paymentMethod
 * @returns {{ sortedItems: Array, requestHash: string }}
 */
function canonicalizeAndHashPayload(items, shippingAddress, paymentMethod) {
  const aggregatedMap = new Map();

  for (const item of items) {
    const pId = String(item.product_id).toLowerCase().trim();
    const qty = Number(item.quantity);
    aggregatedMap.set(pId, (aggregatedMap.get(pId) || 0) + qty);
  }

  // Sắp xếp product_id tăng dần (bảo đảm thứ tự đồng nhất cho hash và lock order)
  const sortedItems = Array.from(aggregatedMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([product_id, quantity]) => ({
      product_id,
      quantity,
    }));

  const canonicalPayload = JSON.stringify({
    items: sortedItems,
    shipping_address: String(shippingAddress || '').trim(),
    payment_method: String(paymentMethod || '').trim().toUpperCase(),
  });

  const requestHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex');

  return { sortedItems, requestHash };
}

/**
 * Thực thi Checkout nguyên tử thông qua Supabase RPC
 *
 * @param {object} params
 * @param {string} params.idempotencyKey - UUID v4 Idempotency Key từ header
 * @param {Array} params.items - Danh sách mặt hàng giỏ hàng
 * @param {string} params.shippingAddress - Địa chỉ nhận hàng
 * @param {string} params.paymentMethod - Phương thức thanh toán
 * @param {string} params.accessToken - JWT Bearer token
 * @returns {Promise<{ is_replay: boolean, response_code: number, data: object }>}
 */
async function executeAtomicCheckout({
  idempotencyKey,
  items,
  shippingAddress,
  paymentMethod,
  accessToken,
}) {
  if (!accessToken) {
    const err = new Error('Authentication required: Missing access token.');
    err.status = 401;
    throw err;
  }

  // 1. Chuẩn hóa payload và tính mã băm SHA-256
  const { sortedItems, requestHash } = canonicalizeAndHashPayload(
    items,
    shippingAddress,
    paymentMethod
  );

  // 2. Khởi tạo Dynamic Client với JWT của người dùng
  const userSupabase = createAuthenticatedClient(accessToken);

  // 3. Thực thi Stored Procedure nguyên tử trong PostgreSQL
  const { data, error } = await userSupabase.rpc('process_atomic_checkout', {
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    p_items: sortedItems,
    p_shipping_address: shippingAddress.trim(),
    p_payment_method: paymentMethod.trim().toUpperCase(),
  });

  // 4. Bắt và phân loại lỗi từ PostgreSQL Transaction
  if (error) {
    const errorMsg = error.message || '';
    const err = new Error();

    // 4.1. Lỗi hết thời gian chờ khóa dòng (Lock Timeout / 55P03 tranh chấp cao)
    if (
      (errorMsg.includes('lock_timeout') ||
       errorMsg.includes('canceling statement due to lock timeout') ||
       errorMsg.includes('55P03')) &&
      !errorMsg.includes('INSUFFICIENT_STOCK') &&
      !errorMsg.includes('REQUEST_IN_PROGRESS')
    ) {
      err.status = 409;
      err.code = 'CONCURRENT_LOCK_TIMEOUT';
      err.message = 'Sản phẩm đang có nhiều người đặt mua cùng lúc, vui lòng thử lại sau giây lát.';
    }
    // 4.2. Lỗi xác thực
    else if (errorMsg.includes('UNAUTHORIZED')) {
      err.status = 401;
      err.code = 'UNAUTHORIZED';
      err.message = 'Bạn cần đăng nhập để thực hiện đặt hàng.';
    }
    // 4.3. Lỗi Idempotency
    else if (errorMsg.includes('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH')) {
      err.status = 409;
      err.code = 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH';
      err.message = 'Idempotency Key đã được sử dụng cho một giỏ hàng khác. Vui lòng tạo key mới.';
    } else if (errorMsg.includes('REQUEST_IN_PROGRESS')) {
      err.status = 409;
      err.code = 'REQUEST_IN_PROGRESS';
      err.message = 'Đơn hàng đang được xử lý. Vui lòng không gửi nhiều yêu cầu liên tiếp.';
    } else if (errorMsg.includes('IDEMPOTENCY_KEY_OWNERSHIP_MISMATCH')) {
      err.status = 403;
      err.code = 'FORBIDDEN';
      err.message = 'Bạn không có quyền sử dụng Idempotency Key này.';
    }
    // 4.4. Lỗi Validate số lượng & giỏ hàng (SQL Defense)
    else if (errorMsg.includes('INVALID_QUANTITY')) {
      err.status = 400;
      err.code = 'INVALID_QUANTITY';
      err.message = 'Số lượng sản phẩm không hợp lệ (phải từ 1 đến 100).';
    } else if (errorMsg.includes('MAX_CART_ITEMS_EXCEEDED')) {
      err.status = 400;
      err.code = 'MAX_CART_ITEMS_EXCEEDED';
      err.message = 'Giỏ hàng chỉ được chứa tối đa 50 mặt hàng.';
    } else if (errorMsg.includes('INVALID_SHIPPING_ADDRESS')) {
      err.status = 400;
      err.code = 'INVALID_SHIPPING_ADDRESS';
      err.message = 'Địa chỉ nhận hàng không hợp lệ (độ dài từ 5 đến 500 ký tự).';
    } else if (errorMsg.includes('INVALID_PAYMENT_METHOD')) {
      err.status = 400;
      err.code = 'INVALID_PAYMENT_METHOD';
      err.message = 'Phương thức thanh toán không hợp lệ (COD, BANK_TRANSFER, VNPAY, MOMO).';
    } else if (errorMsg.includes('INVALID_PRODUCT_ID')) {
      err.status = 400;
      err.code = 'INVALID_PRODUCT_ID';
      err.message = 'Mã sản phẩm không đúng định dạng UUID.';
    } else if (errorMsg.includes('INVALID_CART_ITEMS') || errorMsg.includes('EMPTY_CART')) {
      err.status = 400;
      err.code = 'BAD_REQUEST';
      err.message = 'Giỏ hàng không có sản phẩm nào hợp lệ.';
    }
    // 4.5. Lỗi tồn kho và sản phẩm
    else if (errorMsg.includes('INSUFFICIENT_STOCK')) {
      err.status = 422;
      err.code = 'INSUFFICIENT_STOCK';
      err.message = errorMsg.replace('INSUFFICIENT_STOCK: ', '');
    } else if (errorMsg.includes('PRODUCT_NOT_FOUND')) {
      err.status = 422;
      err.code = 'PRODUCT_NOT_FOUND';
      err.message = 'Một hoặc nhiều sản phẩm trong giỏ hàng không tồn tại.';
    } else if (errorMsg.includes('PRODUCT_INACTIVE')) {
      err.status = 422;
      err.code = 'PRODUCT_INACTIVE';
      err.message = errorMsg.replace('PRODUCT_INACTIVE: ', '');
    }
    // 4.6. Lỗi hệ thống nội bộ
    else {
      err.status = 500;
      err.code = 'INTERNAL_CHECKOUT_ERROR';
      err.message = 'Hệ thống gặp lỗi trong quá trình xử lý đơn hàng.';
      console.error(`[Atomic Checkout Postgres Error] ${errorMsg}`);
    }

    throw err;
  }

  return data;
}

module.exports = {
  executeAtomicCheckout,
  canonicalizeAndHashPayload,
  createAuthenticatedClient,
};
