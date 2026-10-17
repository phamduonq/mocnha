/**
 * assets/js/realtime.js
 * Quản lý Supabase Realtime Synchronization trên bảng `products`
 * Lắng nghe toàn diện các sự kiện INSERT, UPDATE, DELETE qua WebSocket
 * Đồng bộ hai chiều thời gian thực giữa Khách hàng và Admin Dashboard
 */

import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';
import { syncCartWithProductStock } from './cart.js';
import { prependProductCard, updateProductCardData, removeProductCardDOM } from './ui.js';
import { handleAdminRealtimeChange } from './admin.js';

let realtimeChannel = null;

/**
 * Xử lý sự kiện Realtime INSERT (Admin thêm sản phẩm mới)
 */
function handleRealtimeInsert(record, addProductInMemoryFn) {
  if (!record || !record.id) return;
  console.log('[mộcnhà. Realtime] Phát hiện INSERT sản phẩm mới:', record.name);

  // 1. Cập nhật bộ nhớ client
  if (typeof addProductInMemoryFn === 'function') {
    addProductInMemoryFn(record);
  }

  // 2. Tự động chèn ra giao diện trang chủ mà không cần F5
  const gridContainer = document.getElementById('products-grid');
  if (gridContainer && record.is_active) {
    prependProductCard(gridContainer, record);
  }

  // 3. Đồng bộ bảng Admin (nếu đang ở trang quản trị)
  handleAdminRealtimeChange('INSERT', record);

  // 4. Thông báo Toast người dùng
  showToast(`Bộ sưu tập vừa có thêm tác phẩm mới: "${record.name}"!`, 'info', 4500);
}

/**
 * Xử lý sự kiện Realtime UPDATE (Admin sửa thông tin hoặc có đơn hàng giảm tồn kho)
 */
function handleRealtimeUpdate(payload, getCurrentProductsFn, updateProductInMemoryFn) {
  const updatedProduct = payload.new;
  if (!updatedProduct) return;

  const currentProducts = typeof getCurrentProductsFn === 'function' ? getCurrentProductsFn() : [];
  const existingProduct = currentProducts.find((p) => p.id === updatedProduct.id);

  const oldStock = (payload.old && payload.old.stock !== undefined) 
    ? Number(payload.old.stock) 
    : (existingProduct ? Number(existingProduct.stock) : null);
  
  const newStock = Number(updatedProduct.stock);

  console.log(`[mộcnhà. Realtime] UPDATE sản phẩm "${updatedProduct.name}": tồn kho ${oldStock ?? '?'} ➔ ${newStock}`);

  // 1. Cập nhật mảng sản phẩm trong bộ nhớ
  if (typeof updateProductInMemoryFn === 'function') {
    updateProductInMemoryFn(updatedProduct);
  }

  // 2. Cập nhật DOM trực tiếp trên trang chủ
  updateProductCardData(updatedProduct);

  // 3. Đồng bộ bảng Admin
  handleAdminRealtimeChange('UPDATE', updatedProduct);

  // 4. Đồng bộ Giỏ hàng (Realtime Cart Sync)
  syncCartWithProductStock(updatedProduct.id, newStock, updatedProduct.name);

  // 5. Toast thông báo
  if (oldStock !== null && newStock < oldStock) {
    // Có người vừa mua
    showToast(`Có người vừa chốt đơn mặt hàng "${updatedProduct.name}"!`, 'info', 4000);
  } else if (existingProduct && (existingProduct.price !== updatedProduct.price || existingProduct.name !== updatedProduct.name)) {
    // Admin vừa cập nhật thông tin
    showToast(`Tác phẩm "${updatedProduct.name}" vừa được quản trị viên cập nhật thông tin.`, 'info', 3000);
  }
}

/**
 * Xử lý sự kiện Realtime DELETE (Admin xóa sản phẩm khỏi cơ sở dữ liệu)
 */
function handleRealtimeDelete(payload, removeProductFromMemoryFn) {
  const deletedId = payload.old?.id;
  if (!deletedId) return;

  console.log('[mộcnhà. Realtime] Phát hiện DELETE sản phẩm ID:', deletedId);

  // 1. Xóa khỏi bộ nhớ client
  if (typeof removeProductFromMemoryFn === 'function') {
    removeProductFromMemoryFn(deletedId);
  }

  // 2. Tự động gỡ bỏ card khỏi giao diện trang chủ
  removeProductCardDOM(deletedId);

  // 3. Đồng bộ bảng Admin
  handleAdminRealtimeChange('DELETE', null, payload.old);

  // 4. Tự động xóa khỏi Giỏ hàng của khách hàng nếu đang có
  syncCartWithProductStock(deletedId, 0, 'Sản phẩm đã gỡ');

  // 5. Toast thông báo
  showToast('Một tác phẩm nội thất vừa được quản trị viên gỡ khỏi danh mục.', 'warning', 4000);
}

/**
 * Khởi tạo kênh Supabase Realtime toàn cục
 * Lắng nghe CẢ 3 SỰ KIỆN: INSERT, UPDATE, DELETE trên bảng `products`
 */
export function initProductRealtime(getCurrentProductsFn, updateProductInMemoryFn, addProductInMemoryFn, removeProductFromMemoryFn) {
  if (realtimeChannel) {
    console.log('[mộcnhà. Realtime] Kênh public:products đã được khởi tạo.');
    return;
  }

  realtimeChannel = supabase
    .channel('public:products')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'products'
      },
      (payload) => {
        const eventType = payload.eventType;
        if (eventType === 'INSERT') {
          handleRealtimeInsert(payload.new, addProductInMemoryFn);
        } else if (eventType === 'UPDATE') {
          handleRealtimeUpdate(payload, getCurrentProductsFn, updateProductInMemoryFn);
        } else if (eventType === 'DELETE') {
          handleRealtimeDelete(payload, removeProductFromMemoryFn);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[mộcnhà. Realtime] Kênh public:products trạng thái: ${status}`);
    });
}
