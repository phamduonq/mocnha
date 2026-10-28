/**
 * assets/js/app.js
 * Entry Point chính điều phối các module theo Vanilla JS ES6 Module Pattern
 * Tích hợp:
 * - SPA Hash Router (Home, Orders, Admin Dashboard)
 * - Role-based Authorization cho Admin Route (#admin)
 * - Supabase Realtime Synchronization 2 chiều (INSERT, UPDATE, DELETE)
 * - Event Delegation & Cart EDA
 */

import { supabase, testSupabaseConnection } from './supabaseClient.js';
import { showToast } from './toast.js';
import { initAuth, requireAuth, requireAdmin, isAdminUser } from './auth.js';
import { fetchProducts } from './products.js';
import { renderProductsSkeleton, renderProductList } from './ui.js';
import { initCart, addToCart } from './cart.js';
import { initCheckout } from './checkout.js';
import { initProductRealtime } from './realtime.js';
import { fetchUserOrders, renderOrdersSkeleton, renderOrdersList } from './orders.js';
import { fetchAdminProducts, renderAdminTable, initAdminDashboardEvents } from './admin.js';

console.log('[mộcnhà.] App initializing...');

// State quản lý sản phẩm trong bộ nhớ
let currentCategory = 'all';
let currentProducts = [];

/**
 * Nạp danh sách sản phẩm theo danh mục và render lên UI khách hàng
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
 * Thêm sản phẩm mới vào đầu mảng bộ nhớ (Realtime INSERT)
 */
function addProductInMemory(newProduct) {
  if (!currentProducts.some((p) => p.id === newProduct.id)) {
    currentProducts.unshift(newProduct);
  }
}

/**
 * Xóa sản phẩm khỏi mảng bộ nhớ (Realtime DELETE)
 */
function removeProductFromMemory(deletedId) {
  currentProducts = currentProducts.filter((p) => p.id !== deletedId);
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
 * Nạp và render danh sách sản phẩm trong Admin Dashboard
 */
async function loadAndRenderAdminDashboard() {
  const res = await fetchAdminProducts();
  if (res.success) {
    renderAdminTable(res.data);
  } else {
    showToast('Lỗi tải dữ liệu quản trị: ' + res.error, 'error');
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
  const adminSection = document.getElementById('admin-dashboard-section');

  const navOrdersLink = document.getElementById('nav-my-orders');
  const navAdminLink = document.getElementById('nav-admin-link');

  console.log('[mộcnhà. Router] Đang điều hướng đến:', hash);

  // VIEW 1: ADMIN DASHBOARD (#admin)
  if (hash === '#admin') {
    // Middleware bảo vệ Route Admin: Xác thực Token sống và Verify Role từ DB
    const isAllowed = await requireAdmin(async (user, profile) => {
      homeView?.classList.add('d-none');
      ordersSection?.classList.add('d-none');
      adminSection?.classList.remove('d-none');

      navOrdersLink?.classList.remove('active');
      navAdminLink?.classList.add('active');

      window.scrollTo({ top: 0, behavior: 'smooth' });
      await loadAndRenderAdminDashboard();
    });

    if (!isAllowed) {
      window.location.hash = '#home';
    }
    return;
  }

  // VIEW 2: ĐƠN HÀNG CỦA TÔI (#orders-section)
  if (hash === '#orders-section') {
    const isAllowed = await requireAuth(async (user, profile) => {
      homeView?.classList.add('d-none');
      adminSection?.classList.add('d-none');
      ordersSection?.classList.remove('d-none');

      navAdminLink?.classList.remove('active');
      navOrdersLink?.classList.add('active');

      window.scrollTo({ top: 0, behavior: 'smooth' });
      await loadAndRenderUserOrders();
    });

    if (!isAllowed) {
      window.location.hash = '#home';
    }
    return;
  }

  // VIEW 3: TRANG CHỦ & SUB-SECTIONS (#home, #products-section, #about-section)
  ordersSection?.classList.add('d-none');
  adminSection?.classList.add('d-none');
  homeView?.classList.remove('d-none');

  navOrdersLink?.classList.remove('active');
  navAdminLink?.classList.remove('active');

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
 * Thiết lập các bộ lọc danh mục sản phẩm trên trang chủ
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

  // 4. Khởi tạo sự kiện Admin Dashboard CRUD
  initAdminDashboardEvents();

  // 5. Thiết lập Event Delegation cho Grid sản phẩm
  setupProductGridEventDelegation();

  // 6. Thiết lập bộ lọc danh mục và nạp sản phẩm ban đầu
  setupCategoryFilters();
  await loadAndRenderProducts('all');

  // 7. KÍCH HOẠT SUPABASE REALTIME TOÀN CỤC (INSERT, UPDATE, DELETE)
  // Đồng bộ hai chiều thời gian thực giữa Khách hàng và Admin Dashboard
  initProductRealtime(
    () => currentProducts,
    updateProductInMemory,
    addProductInMemory,
    removeProductFromMemory
  );

  // 8. LẮNG NGHE ĐIỀU PHỐI SPA ROUTER
  window.addEventListener('hashchange', handleRouting);
  // Kích hoạt định tuyến ngay lần tải đầu tiên (Initial Load)
  await handleRouting();

  // 9. Khi người dùng hoàn thành đơn hàng mới -> tự động refresh nếu đang xem đơn hàng
  window.addEventListener('orderCreated', async () => {
    if (window.location.hash === '#orders-section') {
      await loadAndRenderUserOrders();
    }
  });
});
