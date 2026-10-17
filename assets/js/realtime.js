/**
 * assets/js/realtime.js
 * Quản lý Supabase Realtime Synchronization trên bảng `products`
 * - Lắng nghe Postgres UPDATE event qua WebSocket
 * - Cập nhật cục bộ state bộ nhớ & thao tác DOM trực tiếp không cần re-fetch
 * - Đồng bộ giỏ hàng (Cart Sync) và hiển thị thông báo hiệu ứng khan hiếm
 */

import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';
import { syncCartWithProductStock } from './cart.js';

let realtimeChannel = null;

/**
 * Cập nhật DOM trực tiếp của Product Card khi nhận event Realtime
 * @param {Object} updatedProduct - Dữ liệu payload.new từ Supabase
 */
export function updateProductCardDOM(updatedProduct) {
  if (!updatedProduct || !updatedProduct.id) return;

  const card = document.querySelector(`.product-card[data-product-id="${updatedProduct.id}"]`);
  if (!card) return; // Nếu card không nằm trong view hiện tại (ví dụ đang lọc danh mục khác)

  const newStock = Number(updatedProduct.stock) || 0;

  // 1. Cập nhật Badge tồn kho trực tiếp
  const badge = card.querySelector('.product-card-badge');
  if (badge) {
    badge.className = 'stock-badge product-card-badge';
    if (newStock <= 0) {
      badge.classList.add('stock-out');
      badge.textContent = 'Hết hàng';
    } else if (newStock <= 3) {
      badge.classList.add('stock-low');
      badge.textContent = `Chỉ còn ${newStock} chiếc`;
    } else {
      badge.classList.add('stock-in');
      badge.textContent = `Còn ${newStock} chiếc`;
    }
  }

  // 2. Cập nhật trạng thái Nút bấm
  const btn = card.querySelector('button');
  if (btn) {
    btn.dataset.productStock = newStock;

    if (newStock <= 0) {
      btn.disabled = true;
      btn.textContent = 'Tạm hết hàng';
      btn.classList.remove('add-to-cart-btn');
      btn.classList.add('opacity-50');
    } else {
      btn.disabled = false;
      btn.textContent = 'Thêm vào giỏ';
      btn.classList.add('add-to-cart-btn');
      btn.classList.remove('opacity-50');
    }
  }
}

/**
 * Xử lý sự kiện UPDATE nhận từ Supabase Realtime Channel
 * @param {Object} payload - Dữ liệu từ Supabase Realtime
 * @param {Function} getCurrentProductsFn - Hàm lấy mảng currentProducts hiện hành
 * @param {Function} updateProductInMemoryFn - Hàm cập nhật phần tử trong mảng bộ nhớ
 */
function handleProductRealtimeUpdate(payload, getCurrentProductsFn, updateProductInMemoryFn) {
  const updatedProduct = payload.new;
  if (!updatedProduct) return;

  const currentProducts = typeof getCurrentProductsFn === 'function' ? getCurrentProductsFn() : [];
  const existingProduct = currentProducts.find((p) => p.id === updatedProduct.id);

  // Xác định số lượng tồn kho cũ và mới
  const oldStock = (payload.old && payload.old.stock !== undefined) 
    ? Number(payload.old.stock) 
    : (existingProduct ? Number(existingProduct.stock) : null);
  
  const newStock = Number(updatedProduct.stock);

  console.log(`[mộcnhà. Realtime] Sản phẩm "${updatedProduct.name}" cập nhật: Tồn kho ${oldStock ?? '?'} ➔ ${newStock}`);

  // 1. Trải nghiệm Toast: Hiển thị thông báo khi có người vừa mua (stock giảm)
  if (oldStock !== null && newStock < oldStock) {
    showToast(`Có người vừa chốt đơn mặt hàng "${updatedProduct.name}"!`, 'info', 4000);
  }

  // 2. Cập nhật cục bộ mảng currentProducts ở bộ nhớ (KHÔNG gọi fetch lại)
  if (typeof updateProductInMemoryFn === 'function') {
    updateProductInMemoryFn(updatedProduct);
  }

  // 3. Cập nhật DOM trực tiếp trên màn hình
  updateProductCardDOM(updatedProduct);

  // 4. Đồng bộ Giỏ hàng (Realtime Cart Sync): Điều chỉnh hoặc xóa khỏi giỏ nếu kho không đủ
  syncCartWithProductStock(updatedProduct.id, newStock, updatedProduct.name);
}

/**
 * Khởi tạo kênh lắng nghe Supabase Realtime
 * Bắt buộc dùng supabase.channel('public:products')
 * @param {Function} getCurrentProductsFn - Callback lấy mảng sản phẩm trong bộ nhớ
 * @param {Function} updateProductInMemoryFn - Callback cập nhật sản phẩm trong bộ nhớ
 */
export function initProductRealtime(getCurrentProductsFn, updateProductInMemoryFn) {
  if (realtimeChannel) {
    console.log('[mộcnhà. Realtime] Kênh đã được khởi tạo.');
    return;
  }

  realtimeChannel = supabase
    .channel('public:products')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'products'
      },
      (payload) => {
        handleProductRealtimeUpdate(payload, getCurrentProductsFn, updateProductInMemoryFn);
      }
    )
    .subscribe((status) => {
      console.log(`[mộcnhà. Realtime] Kênh public:products trạng thái: ${status}`);
    });
}
