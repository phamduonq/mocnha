/**
 * assets/js/ui.js
 * Quản lý Render DOM và Bảo mật DOM chống XSS triệt để
 * - Bắt buộc dùng document.createElement() & textContent cho dữ liệu động
 * - Hỗ trợ Fallback ảnh 404 sang placeholder thương hiệu mộcnhà.
 * - Quản lý trạng thái Navbar và Phân quyền giao diện theo vai trò RBAC
 */

// Placeholder SVG dự phòng khi link ảnh bị hỏng 404
const FALLBACK_IMAGE = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22600%22%20height%3D%22450%22%20viewBox%3D%220%200%20600%20450%22%3E%3Crect%20fill%3D%22%23F5F5F7%22%20width%3D%22600%22%20height%3D%22450%22%2F%3E%3Ccircle%20cx%3D%22300%22%20cy%3D%22200%22%20r%3D%2248%22%20fill%3D%22%23E8E8EC%22%2F%3E%3Cpath%20d%3D%22M280%20205%20L295%20185%20L310%20200%20L320%20190%20L335%20210%20Z%22%20fill%3D%22%238E6541%22%2F%3E%3Ctext%20fill%3D%22%238E6541%22%20font-family%3D%22Playfair%20Display%2C%20serif%22%20font-size%3D%2222%22%20font-weight%3D%22600%22%20x%3D%22300%22%20y%3D%22270%22%20text-anchor%3D%22middle%22%3Em%E1%BB%99cnh%C3%A0.%3C%2Ftext%3E%3Ctext%20fill%3D%22%239CA3AF%22%20font-family%3D%22Plus%20Jakarta%20Sans%2C%20sans-serif%22%20font-size%3D%2212%22%20x%3D%22300%22%20y%3D%22295%22%20text-anchor%3D%22middle%22%3EH%C3%ACnh%20%E1%BA%A3nh%20s%E1%BA%A3n%20ph%E1%BA%A9m%20%C4%91ang%20c%E1%BA%ADp%20nh%E1%BA%ADt%3C%2Ftext%3E%3C%2Fsvg%3E";

/**
 * Định dạng tiền tệ VND chuẩn quốc gia
 */
export function formatCurrency(amount) {
  const num = Number(amount) || 0;
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND'
  }).format(num);
}

/**
 * Ánh xạ tên danh mục tiếng Việt
 */
export function getCategoryLabel(category) {
  const map = {
    table: 'Bàn',
    chair: 'Ghế',
    cabinet: 'Tủ & Kệ',
    bed: 'Giường',
    decor: 'Đồ trang trí'
  };
  return map[category] || 'Nội thất';
}

/**
 * Sanitize URL hình ảnh an toàn chống javascript: XSS
 */
function sanitizeImageUrl(url) {
  if (!url || typeof url !== 'string') {
    return FALLBACK_IMAGE;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('/')) {
    return trimmed;
  }
  return FALLBACK_IMAGE;
}

/**
 * Xử lý escape ký tự đặc biệt chống XSS khi render chuỗi HTML
 * @param {string} str 
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[m]));
}

/**
 * Render CSS Skeleton Loading Shimmering
 */
export function renderProductsSkeleton(containerEl, count = 6) {
  if (!containerEl) return;
  containerEl.replaceChildren();

  for (let i = 0; i < count; i++) {
    const col = document.createElement('div');
    col.className = 'col-12 col-md-6 col-lg-4';

    const card = document.createElement('div');
    card.className = 'skeleton-card';

    const media = document.createElement('div');
    media.className = 'skeleton-box skeleton-media';

    const cat = document.createElement('div');
    cat.className = 'skeleton-box skeleton-text-sm';

    const title = document.createElement('div');
    title.className = 'skeleton-box skeleton-title';

    const desc = document.createElement('div');
    desc.className = 'skeleton-box skeleton-desc';

    const footer = document.createElement('div');
    footer.className = 'skeleton-box skeleton-footer';

    card.append(media, cat, title, desc, footer);
    col.appendChild(card);
    containerEl.appendChild(col);
  }
}

/**
 * Tạo một Node DOM hoàn chỉnh cho thẻ sản phẩm (Chống XSS 100%)
 */
export function createProductCardElement(product) {
  const col = document.createElement('div');
  col.className = 'col-12 col-md-6 col-lg-4';

  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.productId = product.id;

  const mediaWrap = document.createElement('div');
  mediaWrap.className = 'product-card-media';

  const img = document.createElement('img');
  img.className = 'product-card-img';
  img.src = sanitizeImageUrl(product.image_url);
  img.setAttribute('alt', product.name || 'Sản phẩm nội thất mộcnhà.');
  img.setAttribute('loading', 'lazy');

  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK_IMAGE;
  };

  const badge = document.createElement('span');
  badge.className = 'stock-badge product-card-badge';
  badge.dataset.stockBadgeId = product.id;
  const stock = Number(product.stock) || 0;

  if (stock <= 0) {
    badge.classList.add('stock-out');
    badge.textContent = 'Hết hàng';
  } else if (stock <= 3) {
    badge.classList.add('stock-low');
    badge.textContent = `Chỉ còn ${stock} chiếc`;
  } else {
    badge.classList.add('stock-in');
    badge.textContent = `Còn ${stock} chiếc`;
  }

  mediaWrap.appendChild(img);
  mediaWrap.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'product-card-body';

  const catSpan = document.createElement('span');
  catSpan.className = 'product-card-category';
  catSpan.textContent = getCategoryLabel(product.category);

  const titleH3 = document.createElement('h3');
  titleH3.className = 'product-card-title';
  titleH3.textContent = product.name || 'Tác phẩm gỗ mộc';

  const materialP = document.createElement('p');
  materialP.className = 'product-card-material mb-2';
  materialP.textContent = product.material || 'Gỗ tự nhiên cao cấp';

  const dimSpan = document.createElement('p');
  dimSpan.className = 'text-muted small mb-0 product-card-dimensions';
  dimSpan.style.fontSize = '0.775rem';
  dimSpan.textContent = product.dimensions ? `Kích thước: ${product.dimensions}` : '';

  const footer = document.createElement('div');
  footer.className = 'product-card-footer';

  const priceSpan = document.createElement('span');
  priceSpan.className = 'product-card-price';
  priceSpan.textContent = formatCurrency(product.price);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-minimal-dark py-2 px-3 add-to-cart-btn';
  addBtn.style.fontSize = '0.8rem';
  addBtn.dataset.productId = product.id;
  addBtn.dataset.productName = product.name;
  addBtn.dataset.productPrice = product.price;
  addBtn.dataset.productImage = product.image_url;
  addBtn.dataset.productStock = product.stock;

  if (stock <= 0) {
    addBtn.disabled = true;
    addBtn.textContent = 'Hết hàng';
    addBtn.classList.add('opacity-50');
  } else {
    addBtn.textContent = 'Thêm vào giỏ';
  }

  footer.appendChild(priceSpan);
  footer.appendChild(addBtn);

  body.appendChild(catSpan);
  body.appendChild(titleH3);
  body.appendChild(materialP);
  if (product.dimensions) {
    body.appendChild(dimSpan);
  }
  body.appendChild(footer);

  card.appendChild(mediaWrap);
  card.appendChild(body);
  col.appendChild(card);
  return col;
}

/**
 * Render danh sách sản phẩm bằng document.createElement & textContent (Chống XSS 100%)
 * @param {HTMLElement} containerEl 
 * @param {Array} products 
 */
export function renderProductList(containerEl, products) {
  if (!containerEl) return;
  containerEl.replaceChildren();

  if (!products || products.length === 0) {
    renderEmptyState(containerEl, 'Hiện không có sản phẩm nào trong danh mục này.');
    return;
  }

  products.forEach((product) => {
    const col = createProductCardElement(product);
    containerEl.appendChild(col);
  });
}

/**
 * Thêm một sản phẩm mới lên đầu danh sách trang chủ (Realtime INSERT)
 */
export function prependProductCard(containerEl, product) {
  if (!containerEl) return;
  if (containerEl.querySelector('.text-center.py-5')) {
    containerEl.replaceChildren();
  }
  const col = createProductCardElement(product);
  containerEl.prepend(col);
}

/**
 * Cập nhật toàn diện một sản phẩm trên DOM trang chủ (Realtime UPDATE)
 */
export function updateProductCardData(product) {
  const card = document.querySelector(`.product-card[data-product-id="${product.id}"]`);
  if (!card) return;

  const titleEl = card.querySelector('.product-card-title');
  if (titleEl) titleEl.textContent = product.name;

  const catEl = card.querySelector('.product-card-category');
  if (catEl) catEl.textContent = getCategoryLabel(product.category);

  const materialEl = card.querySelector('.product-card-material');
  if (materialEl) materialEl.textContent = product.material || 'Gỗ tự nhiên';

  const priceEl = card.querySelector('.product-card-price');
  if (priceEl) priceEl.textContent = formatCurrency(product.price);

  const imgEl = card.querySelector('.product-card-img');
  if (imgEl && product.image_url) {
    imgEl.src = sanitizeImageUrl(product.image_url);
    imgEl.setAttribute('alt', product.name);
  }

  const stock = Number(product.stock) || 0;
  const badge = card.querySelector('.product-card-badge');
  if (badge) {
    badge.className = 'stock-badge product-card-badge';
    if (stock <= 0) {
      badge.classList.add('stock-out');
      badge.textContent = 'Hết hàng';
    } else if (stock <= 3) {
      badge.classList.add('stock-low');
      badge.textContent = `Chỉ còn ${stock} chiếc`;
    } else {
      badge.classList.add('stock-in');
      badge.textContent = `Còn ${stock} chiếc`;
    }
  }

  const btn = card.querySelector('button');
  if (btn) {
    btn.dataset.productName = product.name;
    btn.dataset.productPrice = product.price;
    btn.dataset.productImage = product.image_url;
    btn.dataset.productStock = stock;

    if (stock <= 0) {
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
 * Xóa một sản phẩm khỏi giao diện trang chủ (Realtime DELETE)
 */
export function removeProductCardDOM(productId) {
  const card = document.querySelector(`.product-card[data-product-id="${productId}"]`);
  if (card) {
    const col = card.closest('.col-12');
    col?.remove();
  }
}

/**
 * Hiển thị trạng thái danh sách trống
 */
export function renderEmptyState(containerEl, message) {
  if (!containerEl) return;
  containerEl.replaceChildren();

  const col = document.createElement('div');
  col.className = 'col-12 text-center py-5';

  const p = document.createElement('p');
  p.className = 'text-secondary mb-0';
  p.style.fontSize = '0.95rem';
  p.textContent = message || 'Không có sản phẩm nào.';

  col.appendChild(p);
  containerEl.appendChild(col);
}

/**
 * Cập nhật giao diện thanh điều hướng Header theo vai trò người dùng (RBAC Navbar UI)
 * @param {Object|null} user - Đối tượng Auth User hiện hành
 * @param {Object|null} profile - Đối tượng Profile từ bảng public.profiles
 */
export function renderNavbarAuth(user, profile) {
  const container = document.getElementById('auth-header-container');
  const myOrdersLink = document.getElementById('nav-my-orders');
  const adminNavLink = document.getElementById('nav-admin-link');
  if (!container) return;

  // 1. TRƯỜNG HỢP: ĐÃ ĐĂNG NHẬP (ADMIN HOẶC CUSTOMER)
  if (user && profile) {
    const role = profile.role || 'customer';
    const isAdmin = role === 'admin';
    const displayName = profile.full_name || user.user_metadata?.full_name || (user.email ? user.email.split('@')[0] : 'Người dùng');

    // Phân quyền hiển thị Menu Link trên thanh điều hướng
    if (adminNavLink) {
      if (isAdmin) {
        adminNavLink.classList.remove('d-none');
      } else {
        adminNavLink.classList.add('d-none');
      }
    }

    if (myOrdersLink) {
      myOrdersLink.classList.remove('d-none');
    }

    // Role badge
    const roleBadgeHtml = isAdmin 
      ? '<span class="badge bg-dark ms-1" style="font-size: 0.65rem; letter-spacing: 0.05em; padding: 3px 6px;">ADMIN</span>'
      : '<span class="badge bg-secondary ms-1" style="font-size: 0.65rem; letter-spacing: 0.05em; padding: 3px 6px;">KHÁCH HÀNG</span>';

    container.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <span class="small text-secondary d-none d-sm-inline" style="font-size: 0.85rem;">
          Chào, <strong class="text-dark">${escapeHtml(displayName)}</strong>
          ${roleBadgeHtml}
        </span>
        <button id="btn-logout" class="btn-minimal-outline py-1 px-2" style="font-size: 0.75rem;" title="Đăng xuất khỏi hệ thống">
          Đăng xuất
        </button>
      </div>
    `;

    // Gắn listener đăng xuất thông qua dynamic import để tránh circular dependency
    const logoutBtn = document.getElementById('btn-logout');
    logoutBtn?.addEventListener('click', async () => {
      const { logoutUser } = await import('./auth.js');
      await logoutUser();
    });

  } else {
    // 2. TRƯỜNG HỢP: KHÁCH VÃNG LAI (GUEST)
    if (adminNavLink) {
      adminNavLink.classList.add('d-none');
    }
    if (myOrdersLink) {
      myOrdersLink.classList.add('d-none');
    }

    container.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <button id="btn-open-auth-login" class="btn-minimal-outline py-2 px-3" style="font-size: 0.8rem;">
          Đăng nhập
        </button>
        <button id="btn-open-auth-register" class="btn-minimal-dark py-2 px-3 d-none d-sm-inline-block" style="font-size: 0.8rem;">
          Đăng ký
        </button>
      </div>
    `;

    // Gắn listener mở Modal theo từng tab
    document.getElementById('btn-open-auth-login')?.addEventListener('click', async () => {
      const { openAuthModal } = await import('./auth.js');
      openAuthModal('login');
    });

    document.getElementById('btn-open-auth-register')?.addEventListener('click', async () => {
      const { openAuthModal } = await import('./auth.js');
      openAuthModal('register');
    });
  }
}

/**
 * Ẩn/hiện các thành phần DOM theo vai trò người dùng (data-role-required)
 * @param {'admin' | 'customer' | 'guest'} role 
 */
export function updateRoleDOMVisibility(role = 'guest') {
  // 1. Quản lý các phần tử yêu cầu quyền Admin
  const adminElements = document.querySelectorAll('[data-role-required="admin"]');
  adminElements.forEach((el) => {
    if (role === 'admin') {
      el.classList.remove('d-none');
    } else {
      el.classList.add('d-none');
    }
  });

  // 2. Quản lý các phần tử chỉ dành cho người dùng đã đăng nhập (Customer hoặc Admin)
  const authElements = document.querySelectorAll('[data-role-required="authenticated"]');
  authElements.forEach((el) => {
    if (role === 'admin' || role === 'customer') {
      el.classList.remove('d-none');
    } else {
      el.classList.add('d-none');
    }
  });

  // 3. Quản lý các phần tử chỉ dành cho Khách vãng lai (Guest)
  const guestElements = document.querySelectorAll('[data-role-required="guest"]');
  guestElements.forEach((el) => {
    if (role === 'guest') {
      el.classList.remove('d-none');
    } else {
      el.classList.add('d-none');
    }
  });
}
