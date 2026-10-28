/**
 * assets/js/cart.js
 * Quản lý Giỏ hàng lưu trữ LocalStorage theo kiến trúc Event-Driven Architecture (EDA)
 * Tách biệt hoàn toàn Business Logic và UI Rendering (Loosely Coupled)
 * Hỗ trợ tách biệt khóa lưu trữ giữa Khách vãng lai và Tài khoản người dùng (Guest vs User)
 * Tích hợp xác thực tồn kho thời gian thực từ Supabase Database khi gộp giỏ hàng
 */

import { supabase } from './supabaseClient.js';
import { formatCurrency } from './ui.js';
import { showToast } from './toast.js';

// Các hằng số khóa lưu trữ LocalStorage
const GUEST_CART_KEY = 'mocnha_cart_guest';
const LEGACY_CART_KEY = 'mocnha_cart_v1';

function getUserCartKey(userId) {
  return `mocnha_cart_user_${userId}`;
}

// Khóa lưu trữ hoạt động hiện tại (Mặc định là Guest)
let activeStorageKey = GUEST_CART_KEY;
let cartItems = [];

/**
 * Lấy khóa lưu trữ hiện tại
 */
export function getActiveStorageKey() {
  return activeStorageKey;
}

/**
 * Đọc giỏ hàng từ LocalStorage theo ngữ cảnh khóa hiện tại
 */
export function getCart() {
  try {
    let raw = localStorage.getItem(activeStorageKey);

    // Fallback: Di chuyển dữ liệu từ legacy key (nếu có) sang guest key
    if (!raw && activeStorageKey === GUEST_CART_KEY) {
      const legacyRaw = localStorage.getItem(LEGACY_CART_KEY);
      if (legacyRaw) {
        raw = legacyRaw;
        localStorage.setItem(GUEST_CART_KEY, legacyRaw);
        localStorage.removeItem(LEGACY_CART_KEY);
      }
    }

    cartItems = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(cartItems)) cartItems = [];
  } catch (err) {
    console.error('[mộcnhà. Cart] Lỗi parse LocalStorage:', err);
    cartItems = [];
  }
  return cartItems;
}

/**
 * Lưu giỏ hàng vào LocalStorage theo khóa hiện tại
 */
function saveCart() {
  try {
    localStorage.setItem(activeStorageKey, JSON.stringify(cartItems));
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
 * Xóa sạch giỏ hàng hiện tại (sau khi checkout thành công)
 */
export function clearCart() {
  cartItems = [];
  saveCart();
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'checkout_cleared' } }));
}

/**
 * ĐỒNG BỘ & GỘP GIỎ HÀNG TỪ GUEST SANG USER KHI ĐĂNG NHẬP
 * Đọc từ 'mocnha_cart_guest', truy vấn tồn kho thực tế từ Supabase BaaS,
 * điều chỉnh số lượng hoặc loại bỏ sản phẩm không hợp lệ, sau đó gộp vào 'mocnha_cart_user_${userId}'.
 * @param {Object} user - Đối tượng Auth User sau khi xác thực thành công
 */
export async function syncGuestCartOnLogin(user) {
  if (!user || !user.id) return;

  try {
    // 1. Đọc giỏ hàng khách vãng lai
    let guestRaw = localStorage.getItem(GUEST_CART_KEY);
    if (!guestRaw) {
      guestRaw = localStorage.getItem(LEGACY_CART_KEY);
    }
    const rawGuestItems = guestRaw ? JSON.parse(guestRaw) : [];

    // 2. Chuyển ngữ cảnh lưu trữ sang tài khoản người dùng
    activeStorageKey = getUserCartKey(user.id);

    // 3. Đọc giỏ hàng hiện có của tài khoản người dùng
    const userRaw = localStorage.getItem(activeStorageKey);
    let userItems = userRaw ? JSON.parse(userRaw) : [];
    if (!Array.isArray(userItems)) userItems = [];

    // 4. Nếu khách vãng lai có sản phẩm, kiểm tra tồn kho từ Supabase trước khi gộp
    if (Array.isArray(rawGuestItems) && rawGuestItems.length > 0) {
      console.log(`[mộcnhà. Cart] Bắt đầu xác thực tồn kho cho ${rawGuestItems.length} mặt hàng từ Guest...`);

      const productIds = rawGuestItems.map((item) => item.id).filter(Boolean);
      let validGuestItems = [];

      try {
        // Truy vấn dữ liệu tồn kho và trạng thái kinh doanh mới nhất từ Supabase Database
        const { data: dbProducts, error: dbError } = await supabase
          .from('products')
          .select('id, name, stock, is_active')
          .in('id', productIds);

        if (dbError) {
          console.warn('[mộcnhà. Cart] Lỗi khi truy vấn tồn kho Database, sử dụng dữ liệu offline tạm thời:', dbError.message);
          validGuestItems = rawGuestItems;
        } else {
          const dbProductMap = new Map((dbProducts || []).map((p) => [p.id, p]));

          for (const gItem of rawGuestItems) {
            if (!gItem || !gItem.id) continue;
            const dbProd = dbProductMap.get(gItem.id);

            // Kiểm tra: Sản phẩm bị gỡ hoặc đã ngừng kinh doanh
            if (!dbProd || dbProd.is_active === false) {
              showToast(`Tác phẩm "${gItem.name || 'sản phẩm'}" hiện đã ngừng kinh doanh và được xóa khỏi giỏ hàng.`, 'warning', 5000);
              continue;
            }

            const currentStock = Number(dbProd.stock) || 0;

            // Kiểm tra: Sản phẩm đã hết hàng trong kho
            if (currentStock <= 0) {
              showToast(`Tác phẩm "${gItem.name || dbProd.name}" hiện đã hết hàng và được xóa khỏi giỏ hàng.`, 'warning', 5000);
              continue;
            }

            // Kiểm tra: Tồn kho thực tế nhỏ hơn số lượng khách đã chọn
            if (currentStock < gItem.quantity) {
              gItem.quantity = currentStock;
              gItem.stock = currentStock;
              showToast(`Sản phẩm "${gItem.name || dbProd.name}" đã được điều chỉnh lại số lượng trong giỏ hàng do thay đổi tồn kho tại cửa hàng.`, 'warning', 5000);
            } else {
              gItem.stock = currentStock;
            }

            validGuestItems.push(gItem);
          }
        }
      } catch (checkErr) {
        console.error('[mộcnhà. Cart] Ngoại lệ kiểm tra tồn kho Supabase:', checkErr);
        validGuestItems = rawGuestItems;
      }

      // 5. Tiến hành gộp các sản phẩm hợp lệ vào tài khoản người dùng
      if (validGuestItems.length > 0) {
        validGuestItems.forEach((gItem) => {
          const existingIdx = userItems.findIndex((u) => u.id === gItem.id);
          if (existingIdx > -1) {
            const maxStock = gItem.stock || userItems[existingIdx].stock || 999;
            const mergedQty = (userItems[existingIdx].quantity || 0) + (gItem.quantity || 1);
            userItems[existingIdx].quantity = Math.min(mergedQty, maxStock);
            userItems[existingIdx].stock = maxStock;
          } else {
            userItems.push(gItem);
          }
        });

        cartItems = userItems;
        saveCart();

        // Xóa sạch giỏ hàng của khách vãng lai sau khi gộp thành công
        localStorage.removeItem(GUEST_CART_KEY);
        localStorage.removeItem(LEGACY_CART_KEY);

        updateCartBadge();
        renderCartUI();
        window.dispatchEvent(new CustomEvent('cartUpdated', {
          detail: { reason: 'guest_to_user_merge', itemCount: validGuestItems.length }
        }));

        showToast(`Đã đồng bộ và gộp ${validGuestItems.length} tác phẩm từ phiên khách vào giỏ hàng của bạn.`, 'info', 4000);
      } else {
        // Toàn bộ sản phẩm của khách không còn khả dụng
        localStorage.removeItem(GUEST_CART_KEY);
        localStorage.removeItem(LEGACY_CART_KEY);
        cartItems = userItems;
        updateCartBadge();
        renderCartUI();
      }

    } else {
      // Khách vãng lai không có sản phẩm nào: Nạp lại giỏ hàng của tài khoản user
      cartItems = userItems;
      updateCartBadge();
      renderCartUI();
      window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'user_cart_loaded' } }));
    }
  } catch (err) {
    console.error('[mộcnhà. Cart] Ngoại lệ khi gộp giỏ hàng:', err);
  }
}

/**
 * ĐẶT LẠI NGỮ CẢNH GIỎ HÀNG VỀ GUEST KHI ĐĂNG XUẤT
 * Chuyển activeStorageKey về 'mocnha_cart_guest' và làm rỗng để bảo mật dữ liệu giữa các phiên
 */
export function resetCartToGuest() {
  activeStorageKey = GUEST_CART_KEY;
  cartItems = [];
  try {
    localStorage.removeItem(GUEST_CART_KEY);
  } catch (e) {}

  updateCartBadge();
  renderCartUI();
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { reason: 'logout_reset' } }));
  console.log('[mộcnhà. Cart] Đã đặt lại giỏ hàng về ngữ cảnh khách vãng lai trống.');
}

/**
 * Đồng bộ tồn kho thời gian thực với Giỏ hàng (Realtime Cart Sync)
 */
export function syncCartWithProductStock(productId, newStock, productName = '') {
  const itemIndex = cartItems.findIndex((item) => item.id === productId);
  if (itemIndex === -1) return false;

  const item = cartItems[itemIndex];
  const name = productName || item.name;

  if (newStock <= 0) {
    cartItems.splice(itemIndex, 1);
    saveCart();

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
    item.quantity = newStock;
    saveCart();

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
 */
export function initCart() {
  getCart();
  updateCartBadge();

  window.addEventListener('cartUpdated', (e) => {
    console.log('[mộcnhà. EDA] Bắt được sự kiện cartUpdated:', e.detail?.reason);
    updateCartBadge();
    renderCartUI();
  });

  document.getElementById('btn-toggle-cart')?.addEventListener('click', openCartDrawer);
  document.getElementById('btn-close-cart-drawer')?.addEventListener('click', closeCartDrawer);
  document.getElementById('cart-drawer-backdrop')?.addEventListener('click', closeCartDrawer);

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
