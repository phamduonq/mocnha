/**
 * assets/js/app.js
 * Entry Point chính điều phối các module theo Vanilla JS ES6 Module Pattern
 */

import { supabase, testSupabaseConnection } from './supabaseClient.js';
import { showToast } from './toast.js';
import { initAuth } from './auth.js';
import { fetchProducts } from './products.js';
import { renderProductsSkeleton, renderProductList } from './ui.js';
import { initCart, addToCart } from './cart.js';
import { initCheckout } from './checkout.js';
import { initProductRealtime } from './realtime.js';

console.log('[mộcnhà.] App initializing...');

// State quản lý sản phẩm trong bộ nhớ
let currentCategory = 'all';
let currentProducts = [];

/**
 * Nạp danh sách sản phẩm theo danh mục và render lên UI
 */
async function loadAndRenderProducts(category = 'all') {
  const container = document.getElementById('products-grid');
  if (!container) return;

  // 1. Hiển thị CSS Skeleton Loading Shimmering giữ khung layout
  renderProductsSkeleton(container, 6);

  // 2. Fetch dữ liệu an toàn từ Supabase
  const result = await fetchProducts({ category });

  if (result.success) {
    currentProducts = result.data;
    // 3. Render danh sách sản phẩm bằng DOM API chống XSS 100%
    renderProductList(container, currentProducts);
  } else {
    showToast('Lỗi khi tải danh sách sản phẩm: ' + result.error, 'error');
  }
}

/**
 * Cập nhật cục bộ một sản phẩm trong mảng bộ nhớ (không cần fetch lại toàn bộ)
 */
function updateProductInMemory(updatedProduct) {
  const idx = currentProducts.findIndex((p) => p.id === updatedProduct.id);
  if (idx > -1) {
    currentProducts[idx] = { ...currentProducts[idx], ...updatedProduct };
  } else {
    currentProducts.push(updatedProduct);
  }
}

/**
 * Thiết lập các bộ lọc danh mục sản phẩm
 */
function setupCategoryFilters() {
  const filterBtns = document.querySelectorAll('#category-filters .filter-btn');
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const targetCategory = btn.dataset.category || 'all';
      if (targetCategory === currentCategory) return;

      filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      currentCategory = targetCategory;
      await loadAndRenderProducts(currentCategory);
    });
  });
}

/**
 * EVENT DELEGATION: Bắt sự kiện Thêm vào giỏ trên toàn bộ khung sản phẩm
 * Tránh triệt để Memory Leak do gắn listener trong vòng lặp
 */
function setupProductGridEventDelegation() {
  const gridContainer = document.getElementById('products-grid');
  if (!gridContainer) return;

  gridContainer.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.add-to-cart-btn');
    if (!addBtn) return;

    const productId = addBtn.dataset.productId;
    const product = currentProducts.find((p) => p.id === productId);

    if (product) {
      addToCart(product, 1);
    } else {
      // Fallback từ dataset nếu danh sách chưa kịp sync
      addToCart({
        id: productId,
        name: addBtn.dataset.productName,
        price: Number(addBtn.dataset.productPrice),
        image_url: addBtn.dataset.productImage,
        stock: Number(addBtn.dataset.productStock)
      }, 1);
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  // 1. Kiểm tra kết nối Supabase
  const conn = await testSupabaseConnection();
  if (!conn.connected) {
    showToast('Cảnh báo: Không thể kết nối tới Supabase BaaS: ' + conn.error, 'warning', 5000);
  }

  // 2. Khởi tạo module Auth
  await initAuth();

  // 3. Khởi tạo Giỏ hàng & Checkout
  initCart();
  initCheckout();

  // 4. Thiết lập Event Delegation cho Grid sản phẩm
  setupProductGridEventDelegation();

  // 5. Thiết lập bộ lọc danh mục và nạp sản phẩm ban đầu
  setupCategoryFilters();
  await loadAndRenderProducts('all');

  // 6. Kích hoạt Supabase Realtime Synchronization
  // Lắng nghe UPDATE trên bảng products, cập nhật cục bộ và DOM trực tiếp (không re-fetch toàn bộ)
  initProductRealtime(
    () => currentProducts,
    updateProductInMemory
  );
});
