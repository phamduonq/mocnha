/**
 * assets/js/app.js
 * Entry Point chính điều phối các module theo Vanilla JS ES6 Module Pattern
 * Tích hợp SPA Hash Router, Route Protection, Event Delegation & Realtime
 */

import { supabase, testSupabaseConnection } from './supabaseClient.js';
import { showToast } from './toast.js';
import { initAuth, requireAuth } from './auth.js';
import { fetchProducts } from './products.js';
import { renderProductsSkeleton, renderProductList } from './ui.js';
import { initCart, addToCart } from './cart.js';
import { initCheckout } from './checkout.js';
import { initProductRealtime } from './realtime.js';
import { fetchUserOrders, renderOrdersSkeleton, renderOrdersList } from './orders.js';

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
 * Nạp và render danh sách đơn hàng của người dùng hiện tại
 */
async function loadAndRenderUserOrders() {
  const container = document.getElementById('orders-list-container');
  if (!container) return;

  renderOrdersSkeleton(container, 2);

  const res = await fetchUserOrders();
  if (res.success) {
    renderOrdersList(container, res.data);
  } else {
    showToast('Lỗi khi tải danh sách đơn hàng: ' + res.error, 'error');
  }
}

/**
 * SPA HASH ROUTER: Điều phối hiển thị View dựa trên window.location.hash
 */
async function handleRouting() {
  const rawHash = (window.location.hash || '').trim();
  const hash = rawHash === '' || rawHash === '#' ? '#home' : rawHash;

  const homeView = document.getElementById('home-view');
  const ordersSection = document.getElementById('orders-section');
  const navOrdersLink = document.getElementById('nav-my-orders');

  console.log('[mộcnhà. Router] Đang điều hướng đến:', hash);

  // VIEW 1: ĐƠN HÀNG CỦA TÔI (#orders-section)
  if (hash === '#orders-section') {
    const isAllowed = await requireAuth(async (user, profile) => {
      // Ẩn trang chủ, hiện phần đơn hàng
      homeView?.classList.add('d-none');
      ordersSection?.classList.remove('d-none');
      navOrdersLink?.classList.add('active');

      window.scrollTo({ top: 0, behavior: 'smooth' });
      await loadAndRenderUserOrders();
    });

    if (!isAllowed) {
      // Chưa đăng nhập: đẩy về trang chủ #home
      window.location.hash = '#home';
    }
    return;
  }

  // VIEW 2: TRANG CHỦ & CÁC SUB-SECTIONS (#home, #products-section, #about-section)
  ordersSection?.classList.add('d-none');
  homeView?.classList.remove('d-none');
  navOrdersLink?.classList.remove('active');

  if (hash === '#products-section' || hash === '#about-section') {
    const targetEl = document.querySelector(hash);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth' });
    }
  } else if (hash === '#home') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
  // 1. Kiểm tra kết nối Supabase BaaS
  const conn = await testSupabaseConnection();
  if (!conn.connected) {
    showToast('Cảnh báo: Không thể kết nối tới Supabase BaaS: ' + conn.error, 'warning', 5000);
  }

  // 2. Khởi tạo module Auth (Promise-Gate & OnAuthStateChange)
  await initAuth();

  // 3. Khởi tạo Giỏ hàng theo Event-Driven Architecture & Checkout RPC
  initCart();
  initCheckout();

  // 4. Thiết lập Event Delegation cho Grid sản phẩm
  setupProductGridEventDelegation();

  // 5. Thiết lập bộ lọc danh mục và nạp sản phẩm ban đầu
  setupCategoryFilters();
  await loadAndRenderProducts('all');

  // 6. Kích hoạt Supabase Realtime Synchronization trên bảng products
  initProductRealtime(
    () => currentProducts,
    updateProductInMemory
  );

  // 7. LẮNG NGHE ĐIỀU PHỐI SPA ROUTER
  window.addEventListener('hashchange', handleRouting);
  // Kích hoạt định tuyến ngay lần tải đầu tiên (Initial Load)
  await handleRouting();

  // 8. Khi người dùng hoàn thành đơn hàng mới -> nếu đang xem đơn hàng thì tự động refresh
  window.addEventListener('orderCreated', async () => {
    if (window.location.hash === '#orders-section') {
      await loadAndRenderUserOrders();
    }
  });
});
