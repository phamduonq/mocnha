/**
 * assets/js/auth.js
 * Quản lý Authentication (Đăng ký, Đăng nhập, Đăng xuất, Session & Profile State)
 * Sử dụng Supabase JS SDK v2 & Custom Toast UI
 * Xử lý triệt để: Race condition, Email confirmation, Phone mapping
 */

import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';

// State nội bộ của Auth
let currentUser = null;
let currentProfile = null;
let isAuthReady = false;

// Promise cho phép các module khác (như Checkout, Cart) chờ auth resolve xong
let resolveAuthReady;
export const authReadyPromise = new Promise((resolve) => {
  resolveAuthReady = resolve;
});

/**
 * Lấy user hiện tại trong bộ nhớ
 */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Lấy profile (kèm role) của user
 */
export function getCurrentProfile() {
  return currentProfile;
}

/**
 * Kiểm tra xem Auth state đã sẵn sàng hay chưa
 */
export function isAuthInitialized() {
  return isAuthReady;
}

/**
 * Mở Auth Modal với tab chỉ định ('login' hoặc 'register')
 */
export function openAuthModal(mode = 'login') {
  const modalEl = document.getElementById('auth-modal');
  if (!modalEl) return;

  switchAuthTab(mode);
  modalEl.classList.remove('d-none');
  document.body.style.overflow = 'hidden';
}

/**
 * Đóng Auth Modal
 */
export function closeAuthModal() {
  const modalEl = document.getElementById('auth-modal');
  if (!modalEl) return;

  modalEl.classList.add('d-none');
  document.body.style.overflow = '';
}

/**
 * Chuyển tab giữa Đăng nhập và Đăng ký
 */
export function switchAuthTab(tab) {
  const loginForm = document.getElementById('form-login');
  const registerForm = document.getElementById('form-register');
  const tabLoginBtn = document.getElementById('tab-btn-login');
  const tabRegisterBtn = document.getElementById('tab-btn-register');

  if (tab === 'login') {
    loginForm?.classList.remove('d-none');
    registerForm?.classList.add('d-none');
    tabLoginBtn?.classList.add('active');
    tabRegisterBtn?.classList.remove('active');
  } else {
    loginForm?.classList.add('d-none');
    registerForm?.classList.remove('d-none');
    tabLoginBtn?.classList.remove('active');
    tabRegisterBtn?.classList.add('active');
  }
}

/**
 * Đăng nhập qua Supabase Auth
 */
export async function loginUser(email, password) {
  const submitBtn = document.getElementById('btn-submit-login');
  const originalText = submitBtn ? submitBtn.innerText : 'Đăng nhập';

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang xác thực...';
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: password
    });

    if (error) {
      throw error;
    }

    showToast('Đăng nhập thành công. Chào mừng bạn trở lại!', 'success');
    closeAuthModal();
    return { success: true, user: data.user, session: data.session };
  } catch (err) {
    let msg = 'Đăng nhập thất bại: ';
    if (err.message.includes('Invalid login credentials')) {
      msg = 'Email hoặc mật khẩu không chính xác.';
    } else if (err.message.includes('Email not confirmed')) {
      msg = 'Tài khoản chưa được xác nhận email. Vui lòng kiểm tra hộp thư (kể cả hòm thư Spam) để kích hoạt trước khi đăng nhập.';
    } else {
      msg += err.message;
    }
    showToast(msg, 'error', 6000);
    return { success: false, error: err };
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

/**
 * Đăng ký tài khoản mới qua Supabase Auth
 * Xử lý đúng luồng Email Confirmation: không đóng modal nếu cần verify email
 */
export async function registerUser(email, password, fullName, phone = '') {
  const submitBtn = document.getElementById('btn-submit-register');
  const originalText = submitBtn ? submitBtn.innerText : 'Đăng ký';

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang khởi tạo tài khoản...';
    }

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password: password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone: phone.trim()
        }
      }
    });

    if (error) {
      throw error;
    }

    // Trường hợp 1: Dự án bật Email Confirmation -> data.session = null
    if (!data.session) {
      showToast(
        'Đăng ký thành công! Vui lòng kiểm tra hộp thư email (và thư mục Spam) để kích hoạt tài khoản trước khi đăng nhập.',
        'warning',
        8000
      );

      // Điền sẵn email sang form Đăng nhập và chuyển tab để người dùng tiện đăng nhập sau khi xác nhận
      const loginEmailInput = document.getElementById('input-login-email');
      if (loginEmailInput) {
        loginEmailInput.value = email.trim();
      }
      switchAuthTab('login');
      // KHÔNG đóng modal, giữ modal mở để người dùng nhận thức rõ ràng
      return { success: true, requiresConfirmation: true, user: data.user };
    }

    // Trường hợp 2: Dự án tắt Email Confirmation -> Tự động có session
    showToast('Tạo tài khoản và đăng nhập thành công!', 'success');
    closeAuthModal();
    return { success: true, requiresConfirmation: false, user: data.user };

  } catch (err) {
    let msg = 'Đăng ký thất bại: ';
    if (err.message.includes('User already registered') || err.message.includes('already registered')) {
      msg = 'Email này đã tồn tại trong hệ thống. Vui lòng dùng tính năng Đăng nhập.';
    } else if (err.message.includes('Password should be at least')) {
      msg = 'Mật khẩu phải có tối thiểu 6 ký tự.';
    } else {
      msg += err.message;
    }
    showToast(msg, 'error', 6000);
    return { success: false, error: err };
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

/**
 * Đăng xuất
 */
export async function logoutUser() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    showToast('Đã đăng xuất tài khoản.', 'info');
  } catch (err) {
    showToast('Lỗi khi đăng xuất: ' + err.message, 'error');
  }
}

/**
 * Lấy Profile chi tiết từ bảng `profiles`
 */
async function fetchUserProfile(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) {
      return data;
    }
    if (error) {
      console.warn('[mộcnhà. Auth] fetchUserProfile error:', error.message);
    }
  } catch (err) {
    console.warn('[mộcnhà. Auth] Lỗi ngoại lệ fetch profile:', err.message);
  }
  return null;
}

/**
 * Cập nhật giao diện Header / Navbar
 */
export function updateAuthUI(user, profile) {
  const container = document.getElementById('auth-header-container');
  const myOrdersLink = document.getElementById('nav-my-orders');
  if (!container) return;

  if (user && profile) {
    const displayName = profile.full_name || user.user_metadata?.full_name || user.email.split('@')[0];
    const isAdmin = profile.role === 'admin';

    container.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <span class="small text-secondary d-none d-sm-inline" style="font-size: 0.85rem;">
          Chào, <strong class="text-dark">${escapeHtml(displayName)}</strong>
          ${isAdmin ? '<span class="badge bg-dark ms-1" style="font-size: 0.65rem; letter-spacing: 0.05em;">ADMIN</span>' : ''}
        </span>
        <button id="btn-logout" class="btn-minimal-outline py-1 px-2" style="font-size: 0.75rem;">
          Đăng xuất
        </button>
      </div>
    `;

    document.getElementById('btn-logout')?.addEventListener('click', logoutUser);
    myOrdersLink?.classList.remove('d-none');
  } else {
    // Trạng thái Guest / Chưa đăng nhập
    container.innerHTML = `
      <button id="btn-open-auth" class="btn-minimal-outline py-2 px-3" style="font-size: 0.8rem;">
        Đăng nhập
      </button>
    `;
    document.getElementById('btn-open-auth')?.addEventListener('click', () => openAuthModal('login'));
    myOrdersLink?.classList.add('d-none');
  }
}

/**
 * ROUTE / ACTION PROTECTION:
 * Chống Race Condition: Chờ Auth khởi tạo xong trước khi quyết định
 * Kiểm tra cả User và Profile (chứa Role)
 */
export async function requireAuth(onAuthenticatedCallback) {
  // Nếu auth chưa khởi tạo xong, chờ hoàn tất
  if (!isAuthReady) {
    await authReadyPromise;
  }

  // Bắt buộc phải có cả user và profile hợp lệ
  if (currentUser && currentProfile) {
    if (typeof onAuthenticatedCallback === 'function') {
      onAuthenticatedCallback(currentUser, currentProfile);
    }
    return true;
  }

  // Chặn lại, cảnh báo qua Toast và tự động bật modal đăng nhập
  showToast('Vui lòng đăng nhập để tiến hành đặt hàng và thanh toán.', 'warning', 4500);
  openAuthModal('login');
  return false;
}

/**
 * Khởi tạo listener và event handlers cho Auth
 * Giải quyết triệt để Race condition: Chặn render dở dang cho tới khi session và profile được resolve
 */
export async function initAuth() {
  // 1. Lắng nghe onAuthStateChange
  supabase.auth.onAuthStateChange(async (event, session) => {
    console.log(`[mộcnhà. Auth] Sự kiện Auth State: ${event}`);

    if (session?.user) {
      // Đợi fetch profile hoàn tất TRƯỚC KHI gán currentUser và profile vào bộ nhớ
      const profile = await fetchUserProfile(session.user.id);
      currentUser = session.user;
      currentProfile = profile;
    } else {
      currentUser = null;
      currentProfile = null;
    }

    // Đánh dấu Auth đã khởi tạo sẵn sàng
    if (!isAuthReady) {
      isAuthReady = true;
      resolveAuthReady?.(true);
    }

    // Cập nhật DOM Navbar đồng bộ
    updateAuthUI(currentUser, currentProfile);
  });

  // 2. Thiết lập các event listeners cho modal form
  setupModalEvents();
}

/**
 * Gắn sự kiện DOM cho Auth Modal
 */
function setupModalEvents() {
  document.getElementById('btn-open-auth')?.addEventListener('click', () => openAuthModal('login'));
  document.getElementById('btn-close-auth-modal')?.addEventListener('click', closeAuthModal);
  
  const modalEl = document.getElementById('auth-modal');
  modalEl?.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      closeAuthModal();
    }
  });

  document.getElementById('tab-btn-login')?.addEventListener('click', () => switchAuthTab('login'));
  document.getElementById('tab-btn-register')?.addEventListener('click', () => switchAuthTab('register'));

  // Form Đăng nhập Submit
  const formLogin = document.getElementById('form-login');
  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('input-login-email')?.value;
    const password = document.getElementById('input-login-password')?.value;
    if (!email || !password) {
      showToast('Vui lòng nhập đầy đủ email và mật khẩu.', 'warning');
      return;
    }
    await loginUser(email, password);
  });

  // Form Đăng ký Submit
  const formRegister = document.getElementById('form-register');
  formRegister?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('input-register-name')?.value;
    const email = document.getElementById('input-register-email')?.value;
    const phone = document.getElementById('input-register-phone')?.value;
    const password = document.getElementById('input-register-password')?.value;

    if (!name || !email || !password) {
      showToast('Vui lòng điền họ tên, email và mật khẩu.', 'warning');
      return;
    }

    if (password.length < 6) {
      showToast('Mật khẩu tối thiểu phải từ 6 ký tự.', 'warning');
      return;
    }

    await registerUser(email, password, name, phone);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[m]));
}
