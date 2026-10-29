/**
 * assets/js/checkout.js
 * Quản lý quy trình Thanh toán Nguyên tử (Atomic Checkout) & Idempotency Key
 * Kết nối API an toàn: POST /api/checkout với Pessimistic Locking & Chống Overselling
 * Tự động Autofill Profile, Khóa chặn Auth, Chống Race Condition & Double Submit
 */

import { supabase } from './supabaseClient.js';
import { requireAuth } from './auth.js';
import { getCart, getCartTotal, clearCart, closeCartDrawer } from './cart.js';
import { formatCurrency } from './ui.js';
import { showToast } from './toast.js';

// Idempotency Key hiện tại (UUID v4)
let currentIdempotencyKey = null;

/**
 * Sinh UUID v4 chuẩn theo tiêu chuẩn RFC 4122
 */
function generateUUIDv4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Mở Checkout Modal
 * Bắt buộc kiểm tra quyền qua requireAuth()
 */
export async function openCheckoutModal() {
  const cart = getCart();
  if (cart.length === 0) {
    showToast('Giỏ hàng của bạn đang trống. Vui lòng chọn sản phẩm.', 'warning');
    return;
  }

  // Khởi tạo Idempotency Key mới nếu chưa có
  if (!currentIdempotencyKey) {
    currentIdempotencyKey = generateUUIDv4();
  }

  // Khóa chặn Route Protection
  const isAuthenticated = await requireAuth((user, profile) => {
    setupAndShowCheckout(user, profile);
  });

  if (isAuthenticated) {
    closeCartDrawer();
  }
}

/**
 * Đóng Checkout Modal
 */
export function closeCheckoutModal() {
  const modal = document.getElementById('checkout-modal');
  modal?.classList.add('d-none');
  document.body.style.overflow = '';
}

/**
 * Điền sẵn dữ liệu và hiển thị giao diện Checkout
 */
function setupAndShowCheckout(user, profile) {
  const modal = document.getElementById('checkout-modal');
  if (!modal) return;

  closeCartDrawer();

  // 1. Tự động điền (Auto-fill) thông tin người dùng từ Profile
  const nameInput = document.getElementById('checkout-name');
  const phoneInput = document.getElementById('checkout-phone');

  if (nameInput) {
    nameInput.value = profile?.full_name || user?.user_metadata?.full_name || '';
  }
  if (phoneInput) {
    phoneInput.value = profile?.phone || user?.user_metadata?.phone || '';
  }

  // 2. Cập nhật thông tin tổng tiền và QR Code
  const totalAmount = getCartTotal();
  const totalAmountEl = document.getElementById('checkout-total-amount');
  if (totalAmountEl) {
    totalAmountEl.textContent = formatCurrency(totalAmount);
  }

  // Tạo URL mã QR thanh toán VietQR mô phỏng
  const qrImg = document.getElementById('checkout-qr-image');
  if (qrImg) {
    const bankId = 'MB'; // Ngân hàng Quân Đội MBBank mô phỏng
    const accountNo = '0388886666';
    const template = 'compact2';
    const userTag = user?.id ? user.id.slice(0, 6).toUpperCase() : 'USER';
    const desc = encodeURIComponent(`MOCNHA ${userTag}`);
    qrImg.src = `https://img.vietqr.io/image/${bankId}-${accountNo}-${template}.png?amount=${totalAmount}&addInfo=${desc}&accountName=MOC%20NHA%20FURNITURE`;
  }

  modal.classList.remove('d-none');
  document.body.style.overflow = 'hidden';
}

/**
 * Thực thi Lệnh gọi API Backend: POST /api/checkout
 * Gửi kèm Header Idempotency-Key & Authorization Bearer Token
 * Hỗ trợ các mã trạng thái:
 *   - 201 Created: Đơn hàng mới nguyên tử
 *   - 200 OK: Idempotency Replay (đã xử lý trước đó)
 *   - 422 Unprocessable Entity: Hết hàng trong kho
 *   - 409 Conflict: Đang xử lý hoặc xung đột transaction
 */
export async function executeCheckout() {
  const confirmBtn = document.getElementById('btn-confirm-checkout');
  const originalText = confirmBtn ? confirmBtn.innerText : 'Xác nhận thanh toán';

  try {
    const nameInput = document.getElementById('checkout-name');
    const phoneInput = document.getElementById('checkout-phone');
    const addressInput = document.getElementById('checkout-address');
    const noteInput = document.getElementById('checkout-note');

    const customerName = nameInput?.value.trim() || '';
    const customerPhone = phoneInput?.value.trim().replace(/\s+/g, '') || '';
    const rawAddress = addressInput?.value.trim() || '';
    const note = noteInput?.value.trim() || '';

    // 1. Validate form cơ bản
    if (!customerName || !customerPhone || !rawAddress) {
      showToast('Vui lòng điền đầy đủ Họ tên, Số điện thoại và Địa chỉ nhận hàng.', 'warning');
      return;
    }

    // 2. Validate định dạng số điện thoại chuẩn di động Việt Nam
    const vnPhoneRegex = /^(0|\+84)[3|5|7|8|9][0-9]{8}$/;
    if (!vnPhoneRegex.test(customerPhone)) {
      showToast('Số điện thoại không đúng định dạng di động Việt Nam (Ví dụ: 0901234567 hoặc +84901234567).', 'warning', 5000);
      phoneInput?.focus();
      return;
    }

    const cart = getCart();
    if (cart.length === 0) {
      showToast('Giỏ hàng trống! Vui lòng chọn sản phẩm.', 'warning');
      closeCheckoutModal();
      return;
    }

    if (cart.length > 50) {
      showToast('Mỗi đơn hàng chỉ được chứa tối đa 50 mặt hàng khác nhau.', 'warning', 5000);
      return;
    }

    // 3. Chuẩn bị Idempotency Key (bắt buộc chuẩn UUID v4)
    if (!currentIdempotencyKey) {
      currentIdempotencyKey = generateUUIDv4();
    }

    // 4. Lấy Bearer Token từ phiên đăng nhập Supabase Auth
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) {
      showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 'warning');
      return;
    }

    // Chuẩn bị payload items: mảng [{"product_id": uuid, "quantity": int}]
    const itemsPayload = cart.map((item) => ({
      product_id: item.id,
      quantity: Number(item.quantity) || 1
    }));

    // Chuẩn bị địa chỉ nhận hàng (đảm bảo độ dài từ 5 đến 500 ký tự)
    let fullShippingAddress = rawAddress;
    if (customerName || customerPhone) {
      fullShippingAddress = `${rawAddress} (Người nhận: ${customerName} - ${customerPhone}${note ? `, Ghi chú: ${note}` : ''})`;
    }
    if (fullShippingAddress.length < 5) {
      fullShippingAddress = `${rawAddress}, Việt Nam`;
    }
    if (fullShippingAddress.length > 500) {
      fullShippingAddress = fullShippingAddress.slice(0, 500);
    }

    // Thiết lập trạng thái Loading trên UI
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Đang khóa kho & xác nhận giao dịch...';
    }

    // 5. GỌI API BACKEND EXPRESS POST /api/checkout
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Idempotency-Key': currentIdempotencyKey,
      },
      body: JSON.stringify({
        items: itemsPayload,
        shipping_address: fullShippingAddress,
        payment_method: 'BANK_TRANSFER'
      })
    });

    const result = await response.json();

    // 6. XỬ LÝ THEO MÃ TRẠNG THÁI HTTP
    if (response.status === 201) {
      // ĐƠN MỚI THÀNH CÔNG NGUYÊN TỬ
      currentIdempotencyKey = null; // Đặt lại key cho phiên tiếp theo
      clearCart();
      closeCheckoutModal();

      const orderId = result.data?.order_id || result.data?.id || '';
      const orderShortId = orderId ? orderId.slice(0, 8).toUpperCase() : 'OK';

      showToast(
        `Khởi tạo đơn hàng #${orderShortId} thành công (Trạng thái: Chờ thanh toán). Kho hàng đã tự động khóa và cập nhật.`,
        'success',
        7000
      );

      // Kích hoạt custom event báo đơn hàng mới được tạo
      window.dispatchEvent(new CustomEvent('orderCreated', { detail: result.data }));

    } else if (response.status === 200) {
      // IDEMPOTENCY REPLAY: Đơn hàng đã ghi nhận thành công từ trước
      currentIdempotencyKey = null;
      clearCart();
      closeCheckoutModal();

      const orderId = result.data?.order_id || result.data?.id || '';
      const orderShortId = orderId ? orderId.slice(0, 8).toUpperCase() : 'OK';

      showToast(
        `Đơn hàng #${orderShortId} đã được xử lý trước đó (Giao dịch an toàn Idempotent Replay).`,
        'info',
        7000
      );

      window.dispatchEvent(new CustomEvent('orderCreated', { detail: result.data }));

    } else if (response.status === 422) {
      // HẾT HÀNG TRONG KHO (Overselling Prevention)
      showToast(
        result.message || 'Đặt hàng thất bại: Một hoặc nhiều sản phẩm trong giỏ đã hết hàng hoặc không đủ số lượng tồn kho.',
        'warning',
        7000
      );

    } else if (response.status === 409) {
      // XUNG ĐỘT KHÓA DÒNG HOẶC GIAO DỊCH TRÙNG LẶP ĐANG CHẠY
      // Giữ nguyên currentIdempotencyKey để người dùng có thể thử lại an toàn
      showToast(
        result.message || 'Hệ thống đang khóa kho xử lý giao dịch. Vui lòng bấm thử lại sau vài giây.',
        'warning',
        6000
      );

    } else {
      // CÁC MÃ LỖI KHÁC (400, 401, 500)
      showToast(
        result.message || 'Có lỗi xảy ra trong quá trình xử lý đơn hàng. Vui lòng thử lại.',
        'error',
        6000
      );
    }

  } catch (err) {
    console.error('[mộcnhà. Checkout] Lỗi ngoại lệ kết nối API Checkout:', err);
    showToast(`Đặt hàng thất bại: ${err.message || 'Lỗi mạng hoặc kết nối máy chủ.'}`, 'error', 7000);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerText = originalText;
    }
  }
}

/**
 * Khởi tạo event listeners cho Checkout
 */
export function initCheckout() {
  // Nút mở checkout từ Drawer giỏ hàng
  document.getElementById('btn-open-checkout')?.addEventListener('click', openCheckoutModal);

  // Nút đóng modal checkout
  document.getElementById('btn-close-checkout-modal')?.addEventListener('click', closeCheckoutModal);

  // Đóng khi click ngoài backdrop
  const modal = document.getElementById('checkout-modal');
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeCheckoutModal();
    }
  });

  // Form xác nhận thanh toán
  const checkoutForm = document.getElementById('form-checkout');
  checkoutForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await executeCheckout();
  });

  // Khi giỏ hàng có sự thay đổi -> làm mới Idempotency Key
  window.addEventListener('cartUpdated', () => {
    currentIdempotencyKey = null;
  });
}
