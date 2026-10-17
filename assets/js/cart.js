/**
 * assets/js/cart.js
 * Quản lý Giỏ hàng lưu trữ LocalStorage theo kiến trúc Event-Driven Architecture (EDA)
 * Tách biệt hoàn toàn Business Logic và UI Rendering (Loosely Coupled)
 */

import { formatCurrency } from './ui.js';
import { showToast } from './toast.js';

const CART_STORAGE_KEY = 'mocnha_cart_v1';
let cartItems = [];

/**
 * Đọc giỏ hàng từ LocalStorage
 */
export function getCart() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    cartItems = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(cartItems)) cartItems = [];
  } catch (err) {
    console.error('[mộcnhà. Cart] Lỗi parse LocalStorage:', err);
    cartItems = [];
  }
  return cartItems;
}

/**
 * Lưu giỏ hàng vào LocalStorage (Thuần State Mutation, không gọi trực tiếp UI render)
 */
function saveCart() {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cartItems));
  } catch (err) {
    console.error('[mộcnhà. Cart] Không thể lưu LocalStorage:', err);
  }
}

/**
 * Cập nhật số lượng trên Navbar Badge
 */
export function updateCartBadge() {
  const badge = document.getElementById('cart-counter-badge');
  if (!badge) return;
  const count = getCartCount();
  badge.textContent = `(${count})`;
}

/**
 * Tổng số lượng sản phẩm trong giỏ
 */
export function getCartCount() {
  return cartItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

/**
 * Tổng giá trị giỏ hàng (VND)
 */
export function getCartTotal() {
  return cartItems.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
}

/**
 * Thêm sản phẩm vào giỏ
 */
export function addToCart(product, quantity = 1) {
  if (!product || !product.id) return;
  const stock = Number(product.stock) || 0;

  if (stock <= 0) {
    showToast(`Sản phẩm "${product.name}" hiện đã hết hàng.`, 'warning');
    return;
  }

  const existingIndex = cartItems.findIndex((item) => item.id === product.id);

  if (existingIndex > -1) {
    const currentQty = cartItems[existingIndex].quantity;
    if (currentQty + quantity > stock) {
      showToast(`Rất tiếc, kho chỉ còn ${stock} chiếc sản phẩm này.`, 'warning');
      return;
    }
    cartItems[existingIndex].quantity += quantity;
  } else {
    if (quantity > stock) {
      showToast(`Rất tiếc, kho chỉ còn ${stock} chiếc sản phẩm này.`, 'warning');
      return;
    }
    cartItems.push({
      id: product.id,
      name: product.name,
      price: Number(product.price) || 0,
      image_url: product.image_url || '',
      stock: stock,
      quantity: quantity
    });
  }

  saveCart();
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'user_add', productId: product.id } }));
  showToast(`Đã thêm "${product.name}" vào giỏ hàng.`, 'success', 2500);
}

/**
 * Cập nhật số lượng một sản phẩm
 */
export function updateCartItemQuantity(productId, delta) {
  const itemIndex = cartItems.findIndex((item) => item.id === productId);
  if (itemIndex === -1) return;

  const item = cartItems[itemIndex];
  const newQty = item.quantity + delta;

  if (newQty <= 0) {
    removeFromCart(productId);
    return;
  }

  if (item.stock && newQty > item.stock) {
    showToast(`Chỉ còn tối đa ${item.stock} chiếc trong kho.`, 'warning');
    return;
  }

  item.quantity = newQty;
  saveCart();
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'user_update_qty', productId } }));
}

/**
 * Xóa sản phẩm khỏi giỏ
 */
export function removeFromCart(productId) {
  const item = cartItems.find((i) => i.id === productId);
  cartItems = cartItems.filter((i) => i.id !== productId);
  saveCart();
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'user_remove', productId } }));
  if (item) {
    showToast(`Đã xóa "${item.name}" khỏi giỏ hàng.`, 'info', 2000);
  }
}

/**
 * Xóa sạch giỏ hàng (sau khi checkout thành công)
 */
export function clearCart() {
  cartItems = [];
  saveCart();
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'checkout_cleared' } }));
}

/**
 * Đồng bộ tồn kho thời gian thực với Giỏ hàng (Realtime Cart Sync)
 * Áp dụng kiến trúc Event-Driven: Không gọi chéo hàm UI render, chỉ lưu State và phát Event toàn cục
 */
export function syncCartWithProductStock(productId, newStock, productName = '') {
  const itemIndex = cartItems.findIndex((item) => item.id === productId);
  if (itemIndex === -1) return false;

  const item = cartItems[itemIndex];
  const name = productName || item.name;

  if (newStock <= 0) {
    // 1. Tự động xóa khỏi giỏ nếu kho đã hết hàng
    cartItems.splice(itemIndex, 1);
    saveCart();

    // 2. PHÁT SỰ KIỆN TOÀN CỤC BẮT BUỘC ĐỂ UI PHẢN ỨNG TỰ ĐỘNG
    window.dispatchEvent(new CustomEvent('cartUpdated', { 
      detail: { reason: 'realtime_sync', action: 'removed', productId, newStock: 0 } 
    }));

    showToast(
      `Sản phẩm "${name}" vừa hết hàng trên hệ thống và đã được tự động xóa khỏi giỏ hàng của bạn.`,
      'error',
      6000
    );
    return true;
  }

  item.stock = newStock;
  if (item.quantity > newStock) {
    // 1. Tự động điều chỉnh số lượng trong giỏ xuống bằng tồn kho mới nhất
    item.quantity = newStock;
    saveCart();

    // 2. PHÁT SỰ KIỆN TOÀN CỤC BẮT BUỘC ĐỂ UI PHẢN ỨNG TỰ ĐỘNG
    window.dispatchEvent(new CustomEvent('cartUpdated', { 
      detail: { reason: 'realtime_sync', action: 'adjusted', productId, newStock } 
    }));

    showToast(
      `Sản phẩm "${name}" vừa bị giới hạn số lượng tồn kho (chỉ còn ${newStock} chiếc). Giỏ hàng của bạn đã được điều chỉnh.`,
      'error',
      6000
    );
    return true;
  }

  saveCart();
  return false;
}

/**
 * Mở Drawer giỏ hàng
 */
export function openCartDrawer() {
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-drawer-backdrop');
  renderCartUI();
  drawer?.classList.add('is-open');
  backdrop?.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

/**
 * Đóng Drawer giỏ hàng
 */
export function closeCartDrawer() {
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-drawer-backdrop');
  drawer?.classList.remove('is-open');
  backdrop?.classList.remove('is-open');
  document.body.style.overflow = '';
}

/**
 * Render DOM danh sách sản phẩm trong giỏ hàng (Chống XSS 100%)
 */
export function renderCartUI() {
  const container = document.getElementById('cart-drawer-items');
  const totalEl = document.getElementById('cart-drawer-total');
  const checkoutBtn = document.getElementById('btn-open-checkout');
  if (!container) return;

  container.replaceChildren();

  const total = getCartTotal();
  if (totalEl) {
    totalEl.textContent = formatCurrency(total);
  }

  if (cartItems.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'text-center py-5';

    const p = document.createElement('p');
    p.className = 'text-muted mb-3';
    p.textContent = 'Giỏ hàng của bạn đang trống.';

    const continueBtn = document.createElement('button');
    continueBtn.className = 'btn-minimal-outline py-2 px-3';
    continueBtn.style.fontSize = '0.8rem';
    continueBtn.textContent = 'Tiếp tục xem sản phẩm';
    continueBtn.onclick = closeCartDrawer;

    emptyDiv.appendChild(p);
    emptyDiv.appendChild(continueBtn);
    container.appendChild(emptyDiv);

    if (checkoutBtn) {
      checkoutBtn.disabled = true;
    }
    return;
  }

  if (checkoutBtn) {
    checkoutBtn.disabled = false;
  }

  // Render từng sản phẩm an toàn bằng DOM API
  cartItems.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.dataset.cartItemId = item.id;

    const img = document.createElement('img');
    img.className = 'cart-item-img';
    img.src = item.image_url || 'assets/css/placeholder.svg';
    img.setAttribute('alt', item.name);
    img.onerror = () => {
      img.onerror = null;
      img.src = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2272%22%20height%3D%2272%22%20viewBox%3D%220%200%2072%2072%22%3E%3Crect%20fill%3D%22%23F5F5F7%22%20width%3D%2272%22%20height%3D%2272%22%2F%3E%3Ctext%20fill%3D%22%238E6541%22%20font-size%3D%2210%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%20dy%3D%22.3em%22%3Em%E1%BB%99cnh%C3%A0.%3C%2Ftext%3E%3C%2Fsvg%3E";
    };

    const details = document.createElement('div');
    details.className = 'cart-item-details';

    const header = document.createElement('div');
    const title = document.createElement('h4');
    title.className = 'cart-item-title';
    title.textContent = item.name;

    const price = document.createElement('div');
    price.className = 'cart-item-price';
    price.textContent = formatCurrency(item.price);

    header.appendChild(title);
    header.appendChild(price);

    const controls = document.createElement('div');
    controls.className = 'd-flex align-items-center justify-content-between mt-2';

    // Bộ tăng giảm số lượng (+/-)
    const qtyWrap = document.createElement('div');
    qtyWrap.className = 'cart-qty-control';

    const minusBtn = document.createElement('button');
    minusBtn.className = 'cart-qty-btn cart-btn-minus';
    minusBtn.textContent = '−';
    minusBtn.dataset.id = item.id;

    const qtySpan = document.createElement('span');
    qtySpan.className = 'cart-qty-val';
    qtySpan.textContent = item.quantity;

    const plusBtn = document.createElement('button');
    plusBtn.className = 'cart-qty-btn cart-btn-plus';
    plusBtn.textContent = '+';
    plusBtn.dataset.id = item.id;

    qtyWrap.appendChild(minusBtn);
    qtyWrap.appendChild(qtySpan);
    qtyWrap.appendChild(plusBtn);

    // Nút Xóa
    const removeBtn = document.createElement('button');
    removeBtn.className = 'cart-item-remove cart-btn-remove';
    removeBtn.textContent = 'Xóa';
    removeBtn.dataset.id = item.id;

    controls.appendChild(qtyWrap);
    controls.appendChild(removeBtn);

    details.appendChild(header);
    details.appendChild(controls);

    row.appendChild(img);
    row.appendChild(details);
    container.appendChild(row);
  });
}

/**
 * Khởi tạo giỏ hàng theo Event-Driven Architecture
 * Đăng ký Listener độc lập ở cấp Root: phản ứng tự động vẽ lại giỏ hàng và cập nhật Badge
 */
export function initCart() {
  getCart();
  updateCartBadge();

  // LISTENER ĐỘC LẬP Ở CẤP ROOT: Phản ứng tự động khi State giỏ hàng thay đổi
  window.addEventListener('cartUpdated', (e) => {
    console.log('[mộcnhà. EDA] Bắt được sự kiện cartUpdated:', e.detail?.reason);
    updateCartBadge();
    renderCartUI();
  });

  // Nút mở/đóng giỏ hàng
  document.getElementById('btn-toggle-cart')?.addEventListener('click', openCartDrawer);
  document.getElementById('btn-close-cart-drawer')?.addEventListener('click', closeCartDrawer);
  document.getElementById('cart-drawer-backdrop')?.addEventListener('click', closeCartDrawer);

  // EVENT DELEGATION: Xử lý tăng / giảm / xóa trong Cart Drawer
  const cartContainer = document.getElementById('cart-drawer-items');
  cartContainer?.addEventListener('click', (e) => {
    const minusBtn = e.target.closest('.cart-btn-minus');
    if (minusBtn) {
      updateCartItemQuantity(minusBtn.dataset.id, -1);
      return;
    }

    const plusBtn = e.target.closest('.cart-btn-plus');
    if (plusBtn) {
      updateCartItemQuantity(plusBtn.dataset.id, 1);
      return;
    }

    const removeBtn = e.target.closest('.cart-btn-remove');
    if (removeBtn) {
      removeFromCart(removeBtn.dataset.id);
      return;
    }
  });
}
