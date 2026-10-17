/**
 * assets/js/checkout.js
 * Quản lý quy trình Mô phỏng thanh toán & Gọi RPC Atomic process_checkout trên Supabase
 * Tự động Autofill Profile, Khóa chặn Auth, Chống Race Condition
 */

import { supabase } from './supabaseClient.js';
import { requireAuth, getCurrentUser, getCurrentProfile } from './auth.js';
import { getCart, getCartTotal, clearCart, closeCartDrawer } from './cart.js';
import { formatCurrency } from './ui.js';
import { showToast } from './toast.js';

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
  const addressInput = document.getElementById('checkout-address');

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
    const desc = encodeURIComponent(`MOCNHA ${user.id.slice(0, 6).toUpperCase()}`);
    qrImg.src = `https://img.vietqr.io/image/${bankId}-${accountNo}-${template}.png?amount=${totalAmount}&addInfo=${desc}&accountName=MOC%20NHA%20FURNITURE`;
  }

  modal.classList.remove('d-none');
  document.body.style.overflow = 'hidden';
}

/**
 * Thực thi Lệnh gọi API tử huyệt: supabase.rpc('process_checkout')
 * Nguyên khối (Atomic Transaction), tự động trừ tồn kho và tạo đơn hàng
 */
export async function executeCheckout() {
  const confirmBtn = document.getElementById('btn-confirm-checkout');
  const originalText = confirmBtn ? confirmBtn.innerText : 'Xác nhận thanh toán';

  try {
    const nameInput = document.getElementById('checkout-name');
    const phoneInput = document.getElementById('checkout-phone');
    const addressInput = document.getElementById('checkout-address');
    const noteInput = document.getElementById('checkout-note');

    const customerName = nameInput?.value.trim();
    const customerPhone = phoneInput?.value.trim();
    const shippingAddress = addressInput?.value.trim();
    const note = noteInput?.value.trim() || '';

    // Validate form
    if (!customerName || !customerPhone || !shippingAddress) {
      showToast('Vui lòng điền đầy đủ Họ tên, Số điện thoại và Địa chỉ nhận hàng.', 'warning');
      return;
    }

    const cart = getCart();
    if (cart.length === 0) {
      showToast('Giỏ hàng trống!', 'warning');
      closeCheckoutModal();
      return;
    }

    // Chuẩn bị payload items: mảng [{"product_id": uuid, "quantity": int}]
    const itemsPayload = cart.map((item) => ({
      product_id: item.id,
      quantity: item.quantity
    }));

    // Thiết lập trạng thái Loading
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Đang khóa kho & xác nhận giao dịch...';
    }

    // GỌI HÀM RPC ĐÃ THIẾT KẾ Ở BƯỚC 1 TRÊN SUPABASE
    const { data, error } = await supabase.rpc('process_checkout', {
      p_customer_name: customerName,
      p_customer_phone: customerPhone,
      p_shipping_address: shippingAddress,
      p_note: note,
      p_items: itemsPayload
    });

    if (error) {
      throw error;
    }

    if (data && data.success) {
      // 1. Dọn dẹp giỏ hàng LocalStorage
      clearCart();

      // 2. Đóng Checkout Modal
      closeCheckoutModal();

      // 3. Thông báo thành công với mã đơn hàng
      const orderShortId = data.order_id ? data.order_id.slice(0, 8).toUpperCase() : 'OK';
      showToast(
        `Thanh toán thành công! Đơn hàng #${orderShortId} đã được ghi nhận. Kho hàng đã tự động cập nhật.`,
        'success',
        7000
      );

      // Kích hoạt custom event báo đơn hàng mới được tạo (để refresh data nếu cần)
      window.dispatchEvent(new CustomEvent('orderCreated', { detail: data }));
    } else {
      throw new Error(data?.message || 'Giao dịch không thành công.');
    }

  } catch (err) {
    console.error('[mộcnhà. Checkout] Lỗi xử lý thanh toán RPC:', err);
    // Bắt chính xác lỗi từ Postgres Exception (Ví dụ: Hết hàng, tồn kho không đủ)
    let errorMessage = 'Thanh toán thất bại: ';
    if (err.message) {
      errorMessage += err.message;
    } else {
      errorMessage += 'Có lỗi xảy ra trong quá trình xử lý đơn hàng.';
    }
    showToast(errorMessage, 'error', 7000);
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
}
