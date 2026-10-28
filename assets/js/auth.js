/**
 * assets/js/auth.js
 * Quản lý Xác thực và Phân quyền theo vai trò RBAC (Admin, Customer, Guest)
 * Tích hợp Supabase Auth v2, Async/Await, Token Verification, Cart Sync & Toast i18n
 * Hotfix: Xử lý Password Recovery, chống Double Toast & đồng bộ giỏ hàng an toàn
 */

import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';
import { renderNavbarAuth, updateRoleDOMVisibility } from './ui.js';
import { syncGuestCartOnLogin, resetCartToGuest } from './cart.js';

// ==============================================================================
// 1. STATE NỘI BỘ CỦA AUTH
// ==============================================================================
let currentUser = null;
let currentProfile = null;
let isAuthReady = false;
let isSyncingCart = false; // Cờ chống Race Condition & Double Toast khi đồng bộ giỏ hàng

// Promise giải quyết triệt để Race Condition: Cho phép các module khác (Router, Checkout, Cart)
// chờ đợi cho tới khi Auth state và Profile được resolve hoàn tất.
let resolveAuthReady;
export const authReadyPromise = new Promise((resolve) => {
  resolveAuthReady = resolve;
});

// ==============================================================================
// 2. STATE GETTERS
// ==============================================================================

/**
 * Lấy đối tượng Auth User hiện tại trong bộ nhớ
 * @returns {Object|null}
 */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Lấy Profile (kèm trường role: 'admin' | 'customer') từ bảng public.profiles
 * @returns {Object|null}
 */
export function getCurrentProfile() {
  return currentProfile;
}

/**
 * Lấy vai trò hiện hành của người dùng
 * @returns {'admin' | 'customer' | 'guest'}
 */
export function getUserRole() {
  if (!currentUser) return 'guest';
  return currentProfile?.role || 'customer';
}

/**
 * Kiểm tra xem người dùng hiện tại có vai trò Admin hay không
 * @returns {boolean}
 */
export function isAdminUser() {
  return getUserRole() === 'admin';
}

/**
 * Kiểm tra xem Auth state đã sẵn sàng hay chưa
 * @returns {boolean}
 */
export function isAuthInitialized() {
  return isAuthReady;
}

// ==============================================================================
// 3. DICTIONARY DỊCH LỖI SUPABASE AUTH SANG TIẾNG VIỆT THÂN THIỆN
// ==============================================================================
/**
 * Chuyển đổi mã lỗi và thông điệp tiếng Anh từ Supabase Auth sang tiếng Việt rõ nghĩa
 * @param {Error|Object|string} error 
 * @returns {string}
 */
export function translateAuthError(error) {
  if (!error) return 'Đã xảy ra lỗi không xác định.';
  const msg = typeof error === 'string' ? error : (error.message || '');
  const code = error?.code || '';

  if (msg.includes('Invalid login credentials') || code === 'invalid_credentials') {
    return 'Địa chỉ email hoặc mật khẩu không chính xác. Vui lòng kiểm tra lại.';
  }

  if (msg.includes('Email not confirmed') || code === 'email_not_confirmed') {
    return 'Tài khoản chưa được kích hoạt email. Vui lòng kiểm tra hộp thư đến (hoặc thư mục Spam) để xác nhận trước khi đăng nhập.';
  }

  if (msg.includes('User already registered') || msg.includes('already registered') || code === 'user_already_exists') {
    return 'Địa chỉ email này đã được đăng ký trong hệ thống. Vui lòng đăng nhập hoặc sử dụng tính năng "Quên mật khẩu".';
  }

  if (msg.includes('Password should be at least') || msg.includes('weak_password')) {
    return 'Mật khẩu quá ngắn. Vui lòng nhập tối thiểu 6 ký tự.';
  }

  if (
    msg.toLowerCase().includes('rate limit') ||
    msg.includes('over_email_send_rate_limit') ||
    msg.includes('over_request_rate_limit') ||
    code === 'over_request_rate_limit' ||
    code === 'over_email_send_rate_limit'
  ) {
    return 'Hệ thống phát hiện thao tác gửi yêu cầu quá nhanh (Rate Limit). Vui lòng đợi trong giây lát rồi thử lại.';
  }

  if (msg.includes('User not found')) {
    return 'Không tìm thấy tài khoản người dùng tương ứng với email này.';
  }

  if (msg.includes('Token has expired') || msg.includes('otp_expired')) {
    return 'Mã xác thực hoặc liên kết bảo mật đã hết hạn. Vui lòng gửi lại yêu cầu mới.';
  }

  if (msg.includes('Auth session missing') || msg.includes('session_not_found')) {
    return 'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.';
  }

  if (msg.includes('Network request failed') || msg.includes('Failed to fetch')) {
    return 'Không thể kết nối tới máy chủ xác thực. Vui lòng kiểm tra kết nối internet của bạn.';
  }

  return `Lỗi xác thực: ${msg}`;
}

// ==============================================================================
// 4. TRUY VẤN PROFILE TỪ DATABASE (PUBLIC.PROFILES)
// ==============================================================================
/**
 * Lấy Profile chi tiết từ bảng public.profiles thông qua UUID
 * @param {string} userId 
 * @returns {Promise<Object|null>}
 */
export async function fetchUserProfile(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, created_at, updated_at')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[mộcnhà. Auth] fetchUserProfile cảnh báo:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[mộcnhà. Auth] Ngoại lệ fetch profile:', err);
    return null;
  }
}

// ==============================================================================
// 5. CÁC LUỒNG XÁC THỰC: SIGN UP, SIGN IN, SIGN OUT, RESET PASSWORD
// ==============================================================================

/**
 * Đăng ký tài khoản người dùng mới qua Supabase Auth
 * Lưu ý: Role mặc định luôn được kiểm soát chặt chẽ ở Database Trigger (on_auth_user_created).
 * @param {string} email 
 * @param {string} password 
 * @param {string} fullName 
 * @param {string} phone 
 * @returns {Promise<{success: boolean, requiresConfirmation?: boolean, user?: Object, error?: any}>}
 */
export async function registerUser(email, password, fullName, phone = '') {
  const submitBtn = document.getElementById('btn-submit-register');
  const originalText = submitBtn ? submitBtn.innerText : 'Tạo tài khoản mới';

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang khởi tạo tài khoản...';
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    // Gọi API đăng ký của Supabase Auth.
    // Tuyệt đối không truyền role từ Client để bảo đảm an toàn.
    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password: password,
      options: {
        data: {
          full_name: trimmedName,
          phone: trimmedPhone
        }
      }
    });

    if (error) {
      throw error;
    }

    // Trường hợp 1: Dự án bật tính năng Email Confirmation
    if (data.user && !data.session) {
      showToast(
        'Đăng ký tài khoản thành công! Vui lòng kiểm tra hộp thư email (và thư mục Spam) để kích hoạt trước khi đăng nhập.',
        'warning',
        8000
      );

      // Tự động điền email sang form Đăng nhập và chuyển tab để tiện thao tác
      const loginEmailInput = document.getElementById('input-login-email');
      if (loginEmailInput) {
        loginEmailInput.value = trimmedEmail;
      }
      switchAuthTab('login');
      return { success: true, requiresConfirmation: true, user: data.user };
    }

    // Trường hợp 2: Dự án tắt Email Confirmation -> Tự động có Session ngay lập tức
    showToast('Tạo tài khoản thành công! Đang đăng nhập hệ thống...', 'success', 3500);
    closeAuthModal();
    return { success: true, requiresConfirmation: false, user: data.user };

  } catch (err) {
    const viMessage = translateAuthError(err);
    showToast(viMessage, 'error', 6000);
    return { success: false, error: err };
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

/**
 * Đăng nhập người dùng qua Supabase Auth
 * Loại bỏ lệnh sync giỏ hàng trực tiếp tại đây để tránh Double Toast với onAuthStateChange
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<{success: boolean, user?: Object, session?: Object, error?: any}>}
 */
export async function loginUser(email, password) {
  const submitBtn = document.getElementById('btn-submit-login');
  const originalText = submitBtn ? submitBtn.innerText : 'Đăng nhập';

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang xác thực thông tin...';
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: password
    });

    if (error) {
      throw error;
    }

    currentUser = data.user;
    currentProfile = await fetchUserProfile(data.user.id);

    showToast('Đăng nhập thành công. Chào mừng bạn trở lại với mộcnhà.!', 'success', 3500);
    closeAuthModal();

    // Cập nhật DOM thanh điều hướng và phân quyền giao diện
    renderNavbarAuth(currentUser, currentProfile);
    applyClientRoleRestrictions();

    return { success: true, user: data.user, session: data.session };

  } catch (err) {
    const viMessage = translateAuthError(err);
    showToast(viMessage, 'error', 6000);
    return { success: false, error: err };
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

/**
 * Đăng xuất người dùng khỏi hệ thống
 * Xóa sạch State bộ nhớ, reset giỏ hàng về Guest trống, cập nhật UI và điều hướng an toàn
 */
export async function logoutUser() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;

    currentUser = null;
    currentProfile = null;

    // Chuyển ngữ cảnh giỏ hàng về lại Guest trống (Bảo mật giữa các người dùng)
    resetCartToGuest();

    // Cập nhật UI về Guest
    renderNavbarAuth(null, null);
    applyClientRoleRestrictions();

    showToast('Đã đăng xuất tài khoản an toàn.', 'info', 2500);

    // Nếu đang ở các trang yêu cầu quyền (Admin hoặc Đơn hàng của tôi), redirect về trang chủ
    const currentHash = window.location.hash;
    if (currentHash === '#admin' || currentHash === '#orders-section') {
      window.location.hash = '#home';
    }

    return { success: true };
  } catch (err) {
    const viMessage = translateAuthError(err);
    showToast(viMessage, 'error');
    return { success: false, error: err };
  }
}

/**
 * Gửi email yêu cầu đặt lại mật khẩu (Forgot Password)
 * @param {string} email 
 * @returns {Promise<{success: boolean, error?: any}>}
 */
export async function requestPasswordReset(email) {
  const submitBtn = document.getElementById('btn-submit-reset');
  const originalText = submitBtn ? submitBtn.innerText : 'Gửi email khôi phục';

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang gửi yêu cầu...';
    }

    const trimmedEmail = email.trim().toLowerCase();
    const redirectUrl = `${window.location.origin}${window.location.pathname}#reset-password`;

    const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
      redirectTo: redirectUrl
    });

    if (error) throw error;

    showToast(
      'Liên kết khôi phục mật khẩu đã được gửi! Vui lòng kiểm tra hộp thư email của bạn.',
      'success',
      7000
    );
    switchAuthTab('login');
    return { success: true };

  } catch (err) {
    const viMessage = translateAuthError(err);
    showToast(viMessage, 'error', 6000);
    return { success: false, error: err };
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

/**
 * Cập nhật mật khẩu mới khi người dùng xác thực luồng Password Recovery
 * @param {string} newPassword 
 * @returns {Promise<{success: boolean, error?: any}>}
 */
export async function updateUserPassword(newPassword) {
  const submitBtn = document.getElementById('btn-submit-new-password');
  const originalText = submitBtn ? submitBtn.innerText : 'Lưu mật khẩu mới & Đăng nhập';

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang lưu mật khẩu mới...';
    }

    if (!newPassword || newPassword.length < 6) {
      showToast('Mật khẩu mới phải có tối thiểu 6 ký tự trở lên.', 'warning');
      return { success: false };
    }

    const { data, error } = await supabase.auth.updateUser({
      password: newPassword
    });

    if (error) throw error;

    showToast('Cập nhật mật khẩu mới thành công! Bạn có thể tiếp tục sử dụng hệ thống.', 'success', 4500);

    // Xóa hash #reset-password khỏi URL
    if (window.location.hash.includes('reset-password')) {
      history.replaceState(null, '', window.location.pathname);
    }

    closeAuthModal();
    return { success: true, user: data.user };

  } catch (err) {
    const viMessage = translateAuthError(err);
    showToast(viMessage, 'error', 6000);
    return { success: false, error: err };
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

// ==============================================================================
// 6. CLIENT-SIDE MIDDLEWARE & ROUTE PROTECTION (BẢO VỆ GIAO DIỆN)
// ==============================================================================

/**
 * Xác thực lại Session Token hiện hành trực tiếp với Supabase Server
 * Tuyệt đối không chỉ tin cậy biến RAM ở client-side
 * @returns {Promise<{valid: boolean, session: Object|null, user: Object|null}>}
 */
export async function validateSession() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session || !session.user) {
      return { valid: false, session: null, user: null };
    }

    // Kiểm tra thời hạn token (Nếu hết hạn, tự động refresh nhờ Supabase autoRefreshToken: true)
    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
    if (expiresAt && Date.now() >= expiresAt) {
      const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr || !refreshData.session) {
        return { valid: false, session: null, user: null };
      }
      return { valid: true, session: refreshData.session, user: refreshData.user };
    }

    return { valid: true, session, user: session.user };
  } catch (err) {
    console.error('[mộcnhà. Auth] validateSession exception:', err);
    return { valid: false, session: null, user: null };
  }
}

/**
 * Middleware bảo vệ Route yêu cầu Đăng nhập (Customer hoặc Admin)
 * Chống Race Condition: Đợi Auth khởi tạo xong trước khi thực thi
 * @param {Function} onAuthenticatedCallback 
 * @returns {Promise<boolean>}
 */
export async function requireAuth(onAuthenticatedCallback) {
  if (!isAuthReady) {
    await authReadyPromise;
  }

  // Luôn xác thực lại tính hợp lệ của Session Token với Supabase
  const { valid, user } = await validateSession();

  if (valid && user && currentProfile) {
    if (typeof onAuthenticatedCallback === 'function') {
      await onAuthenticatedCallback(currentUser, currentProfile);
    }
    return true;
  }

  // Không hợp lệ: Chặn truy cập và mở Modal Đăng nhập
  showToast('Vui lòng đăng nhập để tiếp tục thao tác này.', 'warning', 4500);
  openAuthModal('login');
  return false;
}

/**
 * Middleware bảo vệ Route yêu cầu Quyền Quản trị viên (Admin)
 * Không chỉ kiểm tra biến RAM, mà bắt buộc xác thực token và truy vấn lại role từ Database
 * @param {Function} onAdminCallback 
 * @returns {Promise<boolean>}
 */
export async function requireAdmin(onAdminCallback) {
  if (!isAuthReady) {
    await authReadyPromise;
  }

  // 1. Kiểm tra session token còn sống hay không
  const { valid, user } = await validateSession();
  if (!valid || !user) {
    showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập với tư cách Quản trị viên.', 'warning', 5000);
    openAuthModal('login');
    return false;
  }

  // 2. Xác thực lại vai trò thực tế từ Server Database (public.profiles)
  // Ngăn chặn hoàn toàn việc người dùng chỉnh sửa biến JavaScript trong Console DevTools
  const verifiedProfile = await fetchUserProfile(user.id);
  if (!verifiedProfile || verifiedProfile.role !== 'admin') {
    showToast('Truy cập bị từ chối: Tài khoản của bạn không có đặc quyền Quản trị viên (Admin).', 'error', 5500);
    return false;
  }

  // Cập nhật lại cache profile chuẩn
  currentProfile = verifiedProfile;

  if (typeof onAdminCallback === 'function') {
    await onAdminCallback(user, verifiedProfile);
  }
  return true;
}

/**
 * Quét toàn bộ DOM để ẩn/hiện các thành phần giao diện theo vai trò (Role-based DOM Access)
 */
export function applyClientRoleRestrictions() {
  const role = getUserRole();
  updateRoleDOMVisibility(role);
}

// ==============================================================================
// 7. MODAL UI CONTROLLERS (TABS & EVENTS)
// ==============================================================================

/**
 * Mở Auth Modal với tab chỉ định ('login' | 'register' | 'reset-password' | 'update-password')
 * @param {'login' | 'register' | 'reset-password' | 'update-password'} mode 
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
 * Chuyển tab trong Auth Modal
 * @param {'login' | 'register' | 'reset-password' | 'update-password'} tab 
 */
export function switchAuthTab(tab) {
  const loginForm = document.getElementById('form-login');
  const registerForm = document.getElementById('form-register');
  const resetForm = document.getElementById('form-reset-password');
  const updatePasswordForm = document.getElementById('form-update-password');
  const tabLoginBtn = document.getElementById('tab-btn-login');
  const tabRegisterBtn = document.getElementById('tab-btn-register');

  loginForm?.classList.add('d-none');
  registerForm?.classList.add('d-none');
  resetForm?.classList.add('d-none');
  updatePasswordForm?.classList.add('d-none');
  tabLoginBtn?.classList.remove('active');
  tabRegisterBtn?.classList.remove('active');

  if (tab === 'login') {
    loginForm?.classList.remove('d-none');
    tabLoginBtn?.classList.add('active');
  } else if (tab === 'register') {
    registerForm?.classList.remove('d-none');
    tabRegisterBtn?.classList.add('active');
  } else if (tab === 'reset-password') {
    resetForm?.classList.remove('d-none');
  } else if (tab === 'update-password') {
    updatePasswordForm?.classList.remove('d-none');
  }
}

/**
 * Thiết lập các Event Listeners cho Modal Xác thực
 */
function setupModalEvents() {
  document.getElementById('btn-close-auth-modal')?.addEventListener('click', closeAuthModal);
  
  const modalEl = document.getElementById('auth-modal');
  modalEl?.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      closeAuthModal();
    }
  });

  document.getElementById('tab-btn-login')?.addEventListener('click', () => switchAuthTab('login'));
  document.getElementById('tab-btn-register')?.addEventListener('click', () => switchAuthTab('register'));
  document.getElementById('btn-forgot-password')?.addEventListener('click', () => switchAuthTab('reset-password'));
  document.getElementById('btn-back-to-login')?.addEventListener('click', () => switchAuthTab('login'));

  // Form Đăng nhập Submit
  const formLogin = document.getElementById('form-login');
  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('input-login-email')?.value;
    const password = document.getElementById('input-login-password')?.value;
    if (!email || !password) {
      showToast('Vui lòng nhập đầy đủ địa chỉ email và mật khẩu.', 'warning');
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
      showToast('Vui lòng điền họ tên, địa chỉ email và mật khẩu.', 'warning');
      return;
    }

    if (password.length < 6) {
      showToast('Mật khẩu bảo mật tối thiểu phải từ 6 ký tự trở lên.', 'warning');
      return;
    }

    await registerUser(email, password, name, phone);
  });

  // Form Quên mật khẩu Submit
  const formReset = document.getElementById('form-reset-password');
  formReset?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('input-reset-email')?.value;
    if (!email) {
      showToast('Vui lòng nhập địa chỉ email để nhận liên kết khôi phục.', 'warning');
      return;
    }
    await requestPasswordReset(email);
  });

  // Form Đặt lại mật khẩu mới (Password Recovery) Submit
  const formUpdatePassword = document.getElementById('form-update-password');
  formUpdatePassword?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPass = document.getElementById('input-update-password')?.value;
    const confirmPass = document.getElementById('input-update-password-confirm')?.value;

    if (!newPass || !confirmPass) {
      showToast('Vui lòng nhập và xác nhận mật khẩu mới.', 'warning');
      return;
    }

    if (newPass !== confirmPass) {
      showToast('Mật khẩu xác nhận không khớp. Vui lòng nhập lại chính xác.', 'warning');
      return;
    }

    if (newPass.length < 6) {
      showToast('Mật khẩu mới phải có tối thiểu 6 ký tự.', 'warning');
      return;
    }

    await updateUserPassword(newPass);
  });
}

// ==============================================================================
// 8. KHỞI TẠO HỆ THỐNG XÁC THỰC (ON_AUTH_STATE_CHANGE & INITIAL SESSION)
// ==============================================================================
/**
 * Khởi tạo listener và event handlers cho Auth
 * Giải quyết triệt để Race condition & Double Toast
 */
export async function initAuth() {
  console.log('[mộcnhà. Auth] Đang khởi tạo hệ thống Xác thực & RBAC...');

  // 1. Lắng nghe trạng thái phiên với supabase.auth.onAuthStateChange
  supabase.auth.onAuthStateChange(async (event, session) => {
    console.log(`[mộcnhà. Auth] Sự kiện Auth State Change: ${event}`);

    // BẮT SỰ KIỆN PASSWORD_RECOVERY TỰ ĐỘNG
    if (event === 'PASSWORD_RECOVERY') {
      console.log('[mộcnhà. Auth] Bắt được sự kiện PASSWORD_RECOVERY, mở modal cập nhật mật khẩu.');
      openAuthModal('update-password');
      return;
    }

    if (session?.user) {
      // Đợi fetch profile hoàn tất TRƯỚC KHI gán currentUser và profile vào bộ nhớ
      const profile = await fetchUserProfile(session.user.id);
      currentUser = session.user;
      currentProfile = profile;

      // CHỈ GỌI DUY NHẤT 1 LẦN TẠI ĐÂY KHI CHUYỂN PHIÊN VÀ CÓ CỜ CHỐNG LẶP
      if (event === 'SIGNED_IN') {
        if (!isSyncingCart) {
          isSyncingCart = true;
          try {
            await syncGuestCartOnLogin(session.user);
          } finally {
            // Nhả cờ sau 800ms
            setTimeout(() => { isSyncingCart = false; }, 800);
          }
        }
      }
    } else {
      currentUser = null;
      currentProfile = null;

      if (event === 'SIGNED_OUT') {
        resetCartToGuest();
      }
    }

    // Đánh dấu Auth đã sẵn sàng (Resolve Promise Gate)
    if (!isAuthReady) {
      isAuthReady = true;
      resolveAuthReady?.(true);
    }

    // Cập nhật DOM Navbar đồng bộ và phân quyền hiển thị
    renderNavbarAuth(currentUser, currentProfile);
    applyClientRoleRestrictions();
  });

  // 2. Kiểm tra nếu URL hash chứa token khôi phục mật khẩu lúc nạp trang
  const currentHash = window.location.hash || '';
  if (currentHash === '#reset-password' || currentHash.includes('type=recovery')) {
    openAuthModal('update-password');
  }

  // 3. Thiết lập các event listeners cho modal form
  setupModalEvents();
}
