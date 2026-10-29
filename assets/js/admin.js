/**
 * assets/js/admin.js
 * Quản lý Phân hệ Quản trị Admin (CRUD Sản phẩm, Thống kê KPI, Dual Image Upload, Audit Logs)
 * Tuân thủ RLS Policy: public.is_admin()
 * Bảo mật DOM chống XSS 100% bằng DOM API & textContent
 */

import { supabase } from './supabaseClient.js';
import { formatCurrency, getCategoryLabel } from './ui.js';
import { showToast } from './toast.js';

const FALLBACK_IMAGE = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22100%22%20height%3D%22100%22%20viewBox%3D%220%200%20100%20100%22%3E%3Crect%20fill%3D%22%23F5F5F7%22%20width%3D%22100%22%20height%3D%22100%22%2F%3E%3Ctext%20fill%3D%22%238E6541%22%20font-size%3D%2212%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%20dy%3D%22.3em%22%3Em%E1%BB%99cnh%C3%A0.%3C%2Ftext%3E%3C%2Fsvg%3E";

let adminProductsList = [];
let pendingDeleteProduct = null;

/**
 * Lấy danh sách sản phẩm quản trị từ Supabase
 */
export async function fetchAdminProducts() {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[mộcnhà. Admin] Lỗi fetch products:', error.message);
      return { success: false, data: [], error: error.message };
    }

    adminProductsList = Array.isArray(data) ? data : [];
    return { success: true, data: adminProductsList };
  } catch (err) {
    console.error('[mộcnhà. Admin] Ngoại lệ fetch products:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Cập nhật số liệu tóm tắt KPI trên Admin Dashboard
 */
export function updateAdminKPIs(products) {
  const kpiTotalEl = document.getElementById('admin-kpi-total-products');
  const kpiStockEl = document.getElementById('admin-kpi-total-stock');
  const kpiLowStockEl = document.getElementById('admin-kpi-low-stock');

  const list = products || adminProductsList;

  if (kpiTotalEl) {
    kpiTotalEl.textContent = list.length;
  }
  if (kpiStockEl) {
    const totalStock = list.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
    kpiStockEl.textContent = totalStock;
  }
  if (kpiLowStockEl) {
    const lowStockCount = list.filter((p) => Number(p.stock) <= 3).length;
    kpiLowStockEl.textContent = lowStockCount;
  }
}

/**
 * Render bảng dữ liệu sản phẩm trong Admin Dashboard (Chống XSS 100%)
 */
export function renderAdminTable(products) {
  const tbody = document.getElementById('admin-products-table-body');
  if (!tbody) return;

  tbody.replaceChildren();
  const list = products || adminProductsList;

  updateAdminKPIs(list);

  if (list.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'text-center py-5 text-muted';
    td.textContent = 'Chưa có sản phẩm nào trong cơ sở dữ liệu.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  list.forEach((product) => {
    const tr = document.createElement('tr');
    tr.dataset.productId = product.id;

    // 1. Thumbnail
    const tdThumb = document.createElement('td');
    tdThumb.style.width = '70px';
    const img = document.createElement('img');
    img.className = 'admin-product-thumb';
    img.src = product.image_url || FALLBACK_IMAGE;
    img.setAttribute('alt', product.name);
    img.onerror = () => {
      img.onerror = null;
      img.src = FALLBACK_IMAGE;
    };
    tdThumb.appendChild(img);

    // 2. Tên & Vật liệu
    const tdName = document.createElement('td');
    const title = document.createElement('strong');
    title.className = 'd-block text-dark';
    title.textContent = product.name;
    const material = document.createElement('span');
    material.className = 'text-muted small d-block';
    material.textContent = product.material || 'Gỗ tự nhiên';
    tdName.appendChild(title);
    tdName.appendChild(material);

    // 3. Danh mục
    const tdCat = document.createElement('td');
    const catBadge = document.createElement('span');
    catBadge.className = 'badge bg-light text-dark border';
    catBadge.textContent = getCategoryLabel(product.category);
    tdCat.appendChild(catBadge);

    // 4. Giá bán
    const tdPrice = document.createElement('td');
    tdPrice.className = 'fw-semibold';
    tdPrice.textContent = formatCurrency(product.price);

    // 5. Tồn kho
    const tdStock = document.createElement('td');
    const stockBadge = document.createElement('span');
    const stock = Number(product.stock) || 0;
    if (stock <= 0) {
      stockBadge.className = 'stock-badge stock-out';
      stockBadge.textContent = '0 (Hết hàng)';
    } else if (stock <= 3) {
      stockBadge.className = 'stock-badge stock-low';
      stockBadge.textContent = `${stock} (Sắp hết)`;
    } else {
      stockBadge.className = 'stock-badge stock-in';
      stockBadge.textContent = `${stock} chiếc`;
    }
    tdStock.appendChild(stockBadge);

    // 6. Nút thao tác (Sửa / Xóa)
    const tdActions = document.createElement('td');
    tdActions.className = 'text-end';
    tdActions.style.whiteSpace = 'nowrap';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'admin-action-btn me-2 btn-admin-edit';
    editBtn.dataset.id = product.id;
    editBtn.textContent = 'Sửa';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'admin-action-btn btn-delete btn-admin-delete';
    delBtn.dataset.id = product.id;
    delBtn.textContent = 'Xóa';

    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);

    tr.appendChild(tdThumb);
    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdPrice);
    tr.appendChild(tdStock);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

/**
 * Lấy danh sách Nhật ký kiểm toán (Audit Logs) từ Supabase và render ra bảng
 */
export async function fetchAndRenderAuditLogs() {
  const tbody = document.getElementById('admin-audit-table-body');
  if (!tbody) return;

  tbody.replaceChildren();

  // Dòng trạng thái Loading
  const loadingTr = document.createElement('tr');
  const loadingTd = document.createElement('td');
  loadingTd.colSpan = 6;
  loadingTd.className = 'text-center py-4 text-muted';
  loadingTd.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Đang tải dữ liệu kiểm toán bất biến...';
  loadingTr.appendChild(loadingTd);
  tbody.appendChild(loadingTr);

  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw error;
    }

    tbody.replaceChildren();

    if (!data || data.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'text-center py-5 text-muted';
      td.textContent = 'Chưa có bản ghi nhật ký kiểm toán nào.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    data.forEach((log) => {
      const tr = document.createElement('tr');

      // 1. Thời gian
      const tdTime = document.createElement('td');
      tdTime.className = 'small text-muted';
      tdTime.style.whiteSpace = 'nowrap';
      const date = log.created_at ? new Date(log.created_at) : new Date();
      tdTime.textContent = date.toLocaleString('vi-VN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });

      // 2. Vai trò Actor (Hiển thị Email hoặc Role)
      const tdActor = document.createElement('td');
      const actorBadge = document.createElement('span');
      const actorIdentifier = log.actor_role || 'authenticated';
      actorBadge.className = 'badge bg-light text-dark border text-truncate';
      actorBadge.style.maxWidth = '200px';
      actorBadge.style.display = 'inline-block';
      actorBadge.style.verticalAlign = 'middle';
      actorBadge.textContent = actorIdentifier;
      actorBadge.title = actorIdentifier;
      tdActor.appendChild(actorBadge);

      if (log.client_ip) {
        const ipSpan = document.createElement('div');
        ipSpan.className = 'text-muted';
        ipSpan.style.fontSize = '0.72rem';
        ipSpan.textContent = `IP: ${log.client_ip}`;
        tdActor.appendChild(ipSpan);
      }

      // 3. Hành động (Action)
      const tdAction = document.createElement('td');
      const actionBadge = document.createElement('span');
      const act = (log.action || '').toUpperCase();
      if (act === 'INSERT') {
        actionBadge.className = 'audit-badge-insert';
      } else if (act === 'UPDATE') {
        actionBadge.className = 'audit-badge-update';
      } else if (act === 'DELETE') {
        actionBadge.className = 'audit-badge-delete';
      } else {
        actionBadge.className = 'badge bg-secondary';
      }
      actionBadge.textContent = act;
      tdAction.appendChild(actionBadge);

      // 4. Bảng dữ liệu (Table)
      const tdTable = document.createElement('td');
      const codeTable = document.createElement('code');
      codeTable.style.fontSize = '0.82rem';
      codeTable.textContent = log.table_name || 'unknown';
      tdTable.appendChild(codeTable);

      // 5. Record ID
      const tdRecord = document.createElement('td');
      const codeRecord = document.createElement('code');
      codeRecord.className = 'text-muted';
      codeRecord.style.fontSize = '0.78rem';
      const recordStr = String(log.record_id || '');
      codeRecord.textContent = recordStr.length > 8 ? `${recordStr.slice(0, 8)}...` : recordStr;
      codeRecord.title = recordStr;
      tdRecord.appendChild(codeRecord);

      // 6. Trường thay đổi (Changed Fields)
      const tdChanges = document.createElement('td');
      tdChanges.className = 'small';
      if (Array.isArray(log.changed_fields) && log.changed_fields.length > 0) {
        const fieldList = document.createElement('div');
        fieldList.className = 'd-flex flex-wrap gap-1';
        log.changed_fields.forEach((field) => {
          const pill = document.createElement('span');
          pill.className = 'badge bg-light text-secondary border';
          pill.style.fontSize = '0.7rem';
          pill.textContent = field;
          fieldList.appendChild(pill);
        });
        tdChanges.appendChild(fieldList);
      } else if (act === 'INSERT') {
        const span = document.createElement('span');
        span.className = 'text-muted';
        span.textContent = 'Toàn bộ dữ liệu mới';
        tdChanges.appendChild(span);
      } else if (act === 'DELETE') {
        const span = document.createElement('span');
        span.className = 'text-danger';
        span.textContent = 'Bản ghi đã bị xóa';
        tdChanges.appendChild(span);
      } else {
        tdChanges.textContent = '-';
      }

      tr.appendChild(tdTime);
      tr.appendChild(tdActor);
      tr.appendChild(tdAction);
      tr.appendChild(tdTable);
      tr.appendChild(tdRecord);
      tr.appendChild(tdChanges);

      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('[mộcnhà. Audit] Lỗi nạp nhật ký kiểm toán:', err);
    tbody.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'text-center py-4 text-danger small';
    td.textContent = `Lỗi tải nhật ký kiểm toán: ${err.message || 'Không có quyền truy cập.'}`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

/**
 * Cài đặt cơ chế Dual Image Upload (Local File & SSRF-Protected URL)
 */
function setupImageUploadHandlers() {
  const tabFile = document.getElementById('tab-upload-file');
  const tabUrl = document.getElementById('tab-upload-url');
  const containerFile = document.getElementById('upload-mode-file-container');
  const containerUrl = document.getElementById('upload-mode-url-container');
  const fileInput = document.getElementById('admin-file-upload');
  const urlInput = document.getElementById('admin-url-upload');
  const processUrlBtn = document.getElementById('btn-process-url-upload');
  const spinner = document.getElementById('admin-upload-spinner');
  const previewImg = document.getElementById('admin-image-preview-img');
  const previewPlaceholder = document.getElementById('admin-image-preview-placeholder');
  const uploadStatus = document.getElementById('admin-upload-status');
  const hiddenInput = document.getElementById('admin-input-image');

  // Chuyển Tab: Tải file
  tabFile?.addEventListener('click', () => {
    tabFile.classList.add('active');
    tabUrl?.classList.remove('active');
    containerFile?.classList.remove('d-none');
    containerUrl?.classList.add('d-none');
  });

  // Chuyển Tab: Dán link URL
  tabUrl?.addEventListener('click', () => {
    tabUrl.classList.add('active');
    tabFile?.classList.remove('active');
    containerUrl?.classList.remove('d-none');
    containerFile?.classList.add('d-none');
  });

  // Xử lý khi chọn File tải lên từ thiết bị
  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showToast('Kích thước ảnh vượt quá giới hạn cho phép (Tối đa 5MB).', 'warning');
      fileInput.value = '';
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      showToast('Định dạng tệp không hợp lệ. Chỉ chấp nhận JPG, PNG hoặc WebP.', 'warning');
      fileInput.value = '';
      return;
    }

    try {
      spinner?.classList.remove('d-none');
      uploadStatus?.classList.add('d-none');

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 'error');
        return;
      }

      const formData = new FormData();
      formData.append('image', file);

      const res = await fetch('/api/upload/local', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const result = await res.json();
      if (!res.ok || result.status !== 'success') {
        throw new Error(result.message || 'Lỗi xử lý tải tệp lên máy chủ.');
      }

      // Lấy URL công khai trực tiếp từ response của backend
      const finalUrl = result.data?.publicUrl || (result.data?.path ? supabase.storage.from('user_uploads').getPublicUrl(result.data.path).data?.publicUrl : '');

      if (hiddenInput) hiddenInput.value = finalUrl;
      if (previewImg) {
        previewImg.src = finalUrl;
        previewImg.classList.remove('d-none');
      }
      previewPlaceholder?.classList.add('d-none');
      if (uploadStatus) {
        uploadStatus.classList.remove('d-none');
        uploadStatus.textContent = '✓ Tải ảnh thành công (Đã strip EXIF & nén WebP an toàn)';
      }

      showToast('Khử độc ảnh EXIF và tải lên thành công!', 'success');

    } catch (err) {
      console.error('[mộcnhà. Upload] Lỗi upload local:', err);
      showToast(`Tải ảnh thất bại: ${err.message}`, 'error', 6000);
    } finally {
      spinner?.classList.add('d-none');
    }
  });

  // Xử lý khi người dùng dán URL và bấm "Xử lý ảnh"
  processUrlBtn?.addEventListener('click', async () => {
    const url = urlInput?.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      showToast('Vui lòng nhập đường dẫn URL hình ảnh hợp lệ (bắt đầu với http:// hoặc https://).', 'warning');
      urlInput?.focus();
      return;
    }

    const originalBtnText = processUrlBtn.innerText;

    try {
      spinner?.classList.remove('d-none');
      uploadStatus?.classList.add('d-none');
      processUrlBtn.disabled = true;
      processUrlBtn.innerText = 'Đang xử lý...';

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 'error');
        return;
      }

      const res = await fetch('/api/upload/url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ url })
      });

      const result = await res.json();
      if (!res.ok || result.status !== 'success') {
        throw new Error(result.message || 'Lỗi tải ảnh từ URL (bị chặn SSRF hoặc ảnh hỏng).');
      }

      // Lấy URL công khai trực tiếp từ response của backend
      const finalUrl = result.data?.publicUrl || (result.data?.path ? supabase.storage.from('user_uploads').getPublicUrl(result.data.path).data?.publicUrl : '');

      if (hiddenInput) hiddenInput.value = finalUrl;
      if (previewImg) {
        previewImg.src = finalUrl;
        previewImg.classList.remove('d-none');
      }
      previewPlaceholder?.classList.add('d-none');
      if (uploadStatus) {
        uploadStatus.classList.remove('d-none');
        uploadStatus.textContent = '✓ Ảnh từ URL đã được phân giải an toàn & nén WebP';
      }

      showToast('Phân giải DNS an toàn, khử độc EXIF và lưu ảnh thành công!', 'success');

    } catch (err) {
      console.error('[mộcnhà. Upload] Lỗi upload từ URL:', err);
      showToast(`Xử lý ảnh thất bại: ${err.message}`, 'error', 7000);
    } finally {
      spinner?.classList.add('d-none');
      processUrlBtn.disabled = false;
      processUrlBtn.innerText = originalBtnText;
    }
  });
}

/**
 * Mở Modal Thêm hoặc Sửa sản phẩm
 */
export function openProductModal(product = null) {
  const modal = document.getElementById('admin-product-modal');
  const titleEl = document.getElementById('admin-product-modal-title');
  const form = document.getElementById('form-admin-product');
  if (!modal || !form) return;

  form.reset();

  const previewImg = document.getElementById('admin-image-preview-img');
  const previewPlaceholder = document.getElementById('admin-image-preview-placeholder');
  const uploadStatus = document.getElementById('admin-upload-status');
  const hiddenImage = document.getElementById('admin-input-image');

  // Đặt lại trạng thái tab upload về tải file
  document.getElementById('tab-upload-file')?.classList.add('active');
  document.getElementById('tab-upload-url')?.classList.remove('active');
  document.getElementById('upload-mode-file-container')?.classList.remove('d-none');
  document.getElementById('upload-mode-url-container')?.classList.add('d-none');

  const fileInput = document.getElementById('admin-file-upload');
  if (fileInput) fileInput.value = '';
  const urlInput = document.getElementById('admin-url-upload');
  if (urlInput) urlInput.value = '';

  if (product) {
    // Chế độ EDIT
    if (titleEl) titleEl.textContent = 'Cập nhật tác phẩm nội thất';
    form.dataset.editId = product.id;

    document.getElementById('admin-input-name').value = product.name || '';
    document.getElementById('admin-input-slug').value = product.slug || '';
    document.getElementById('admin-select-category').value = product.category || 'table';
    document.getElementById('admin-input-material').value = product.material || '';
    document.getElementById('admin-input-dimensions').value = product.dimensions || '';
    document.getElementById('admin-input-price').value = product.price || 0;
    document.getElementById('admin-input-stock').value = product.stock || 0;
    document.getElementById('admin-input-desc').value = product.description || '';

    if (hiddenImage) hiddenImage.value = product.image_url || '';
    if (previewImg && product.image_url) {
      previewImg.src = product.image_url;
      previewImg.classList.remove('d-none');
      previewPlaceholder?.classList.add('d-none');
      if (uploadStatus) {
        uploadStatus.classList.remove('d-none');
        uploadStatus.textContent = '✓ Ảnh tác phẩm hiện tại';
      }
    } else {
      previewImg?.classList.add('d-none');
      previewPlaceholder?.classList.remove('d-none');
      uploadStatus?.classList.add('d-none');
    }
  } else {
    // Chế độ CREATE
    if (titleEl) titleEl.textContent = 'Thêm tác phẩm nội thất mới';
    delete form.dataset.editId;

    if (hiddenImage) hiddenImage.value = '';
    previewImg?.classList.add('d-none');
    previewPlaceholder?.classList.remove('d-none');
    uploadStatus?.classList.add('d-none');
  }

  modal.classList.remove('d-none');
  document.body.style.overflow = 'hidden';
}

/**
 * Đóng Modal Thêm / Sửa
 */
export function closeProductModal() {
  const modal = document.getElementById('admin-product-modal');
  modal?.classList.add('d-none');
  document.body.style.overflow = '';
}

/**
 * Tạo slug tự động từ tên tiếng Việt
 */
export function generateSlug(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Thực thi Thêm hoặc Cập nhật sản phẩm qua Supabase SDK
 */
export async function saveProductFromForm() {
  const form = document.getElementById('form-admin-product');
  const submitBtn = document.getElementById('btn-admin-submit-product');
  const originalText = submitBtn ? submitBtn.innerText : 'Lưu sản phẩm';

  try {
    const editId = form.dataset.editId;
    const name = document.getElementById('admin-input-name')?.value.trim();
    let slug = document.getElementById('admin-input-slug')?.value.trim();
    const category = document.getElementById('admin-select-category')?.value;
    const material = document.getElementById('admin-input-material')?.value.trim();
    const dimensions = document.getElementById('admin-input-dimensions')?.value.trim();
    const price = Number(document.getElementById('admin-input-price')?.value) || 0;
    const stock = Number(document.getElementById('admin-input-stock')?.value) || 0;
    const imageUrl = document.getElementById('admin-input-image')?.value.trim();
    const description = document.getElementById('admin-input-desc')?.value.trim();

    if (!name || !category || price < 0 || stock < 0) {
      showToast('Vui lòng điền đầy đủ Tên, Danh mục, Giá và Tồn kho hợp lệ.', 'warning');
      return;
    }

    if (!imageUrl) {
      showToast('Vui lòng tải ảnh tác phẩm (qua tệp máy hoặc dán link URL) trước khi lưu.', 'warning');
      return;
    }

    if (!slug) {
      slug = generateSlug(name) + '-' + Math.random().toString(36).substring(2, 6);
    }

    const payload = {
      name,
      slug,
      category,
      material: material || 'Gỗ tự nhiên',
      dimensions: dimensions || '',
      price,
      stock,
      image_url: imageUrl,
      description: description || '',
      is_active: true
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Đang lưu vào cơ sở dữ liệu...';
    }

    if (editId) {
      // 1. UPDATE
      payload.updated_at = new Date().toISOString();
      const { data, error } = await supabase
        .from('products')
        .update(payload)
        .eq('id', editId)
        .select()
        .single();

      if (error) throw error;

      showToast(`Đã cập nhật sản phẩm "${name}" thành công!`, 'success');
      closeProductModal();

      // Cập nhật mảng local và vẽ lại bảng
      const idx = adminProductsList.findIndex((p) => p.id === editId);
      if (idx > -1) {
        adminProductsList[idx] = data;
      }
      renderAdminTable(adminProductsList);

    } else {
      // 2. INSERT
      const { data, error } = await supabase
        .from('products')
        .insert(payload)
        .select()
        .single();

      if (error) throw error;

      showToast(`Đã thêm sản phẩm mới "${name}" thành công!`, 'success');
      closeProductModal();

      adminProductsList.unshift(data);
      renderAdminTable(adminProductsList);
    }

  } catch (err) {
    console.error('[mộcnhà. Admin] Lỗi thao tác sản phẩm:', err);
    let msg = 'Lỗi lưu sản phẩm: ';
    if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
      msg += 'Slug sản phẩm bị trùng lặp. Vui lòng đổi slug khác.';
    } else if (err.message.includes('violates row-level security policy')) {
      msg += 'Bạn không có quyền quản trị viên để thực hiện thao tác này.';
    } else {
      msg += err.message;
    }
    showToast(msg, 'error', 6000);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  }
}

/**
 * Mở Dialog xác nhận xóa
 */
export function openDeleteConfirm(product) {
  pendingDeleteProduct = product;
  const modal = document.getElementById('admin-delete-modal');
  const nameEl = document.getElementById('admin-delete-product-name');
  if (nameEl) {
    nameEl.textContent = product.name;
  }
  modal?.classList.remove('d-none');
  document.body.style.overflow = 'hidden';
}

/**
 * Đóng Dialog xác nhận xóa
 */
export function closeDeleteConfirm() {
  pendingDeleteProduct = null;
  const modal = document.getElementById('admin-delete-modal');
  modal?.classList.add('d-none');
  document.body.style.overflow = '';
}

/**
 * Thực thi Xóa sản phẩm qua Supabase SDK
 */
export async function executeDeleteProduct() {
  if (!pendingDeleteProduct) return;

  const confirmBtn = document.getElementById('btn-admin-confirm-delete');
  const originalText = confirmBtn ? confirmBtn.innerText : 'Xóa sản phẩm';

  try {
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Đang xóa...';
    }

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', pendingDeleteProduct.id);

    if (error) throw error;

    showToast(`Đã xóa sản phẩm "${pendingDeleteProduct.name}" khỏi hệ thống.`, 'success');
    closeDeleteConfirm();

    // Cập nhật bảng
    adminProductsList = adminProductsList.filter((p) => p.id !== pendingDeleteProduct.id);
    renderAdminTable(adminProductsList);

  } catch (err) {
    console.error('[mộcnhà. Admin] Lỗi xóa sản phẩm:', err);
    let msg = 'Không thể xóa: ';
    if (err.message.includes('violates foreign key constraint') || err.message.includes('order_items')) {
      msg = 'Không thể xóa sản phẩm này vì đã có đơn hàng liên kết trong lịch sử. Bạn có thể cập nhật số lượng tồn kho = 0 thay vì xóa.';
    } else if (err.message.includes('violates row-level security policy')) {
      msg = 'Bạn không có quyền quản trị viên để xóa sản phẩm.';
    } else {
      msg += err.message;
    }
    showToast(msg, 'error', 7000);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerText = originalText;
    }
  }
}

/**
 * Cập nhật một sản phẩm trong Admin Table khi có Realtime Event
 */
export function handleAdminRealtimeChange(eventType, record, oldRecord) {
  if (eventType === 'INSERT') {
    if (!adminProductsList.some((p) => p.id === record.id)) {
      adminProductsList.unshift(record);
      renderAdminTable(adminProductsList);
    }
  } else if (eventType === 'UPDATE') {
    const idx = adminProductsList.findIndex((p) => p.id === record.id);
    if (idx > -1) {
      adminProductsList[idx] = record;
      renderAdminTable(adminProductsList);
    }
  } else if (eventType === 'DELETE') {
    const deletedId = oldRecord?.id || record?.id;
    adminProductsList = adminProductsList.filter((p) => p.id !== deletedId);
    renderAdminTable(adminProductsList);
  }
}

/**
 * Khởi tạo toàn bộ sự kiện cho Admin Dashboard
 */
export function initAdminDashboardEvents() {
  // 1. Chuyển Tab giữa Kho tác phẩm và Nhật ký kiểm toán
  const tabBtnProducts = document.getElementById('tab-btn-admin-products');
  const tabBtnAudit = document.getElementById('tab-btn-admin-audit');
  const viewProducts = document.getElementById('admin-products-view');
  const viewAudit = document.getElementById('admin-audit-view');

  tabBtnProducts?.addEventListener('click', () => {
    tabBtnProducts.classList.add('active');
    tabBtnAudit?.classList.remove('active');
    viewProducts?.classList.remove('d-none');
    viewAudit?.classList.add('d-none');
  });

  tabBtnAudit?.addEventListener('click', async () => {
    tabBtnAudit.classList.add('active');
    tabBtnProducts?.classList.remove('active');
    viewAudit?.classList.remove('d-none');
    viewProducts?.classList.add('d-none');
    await fetchAndRenderAuditLogs();
  });

  // Nút làm mới dữ liệu Audit Logs
  document.getElementById('btn-refresh-audit-logs')?.addEventListener('click', async () => {
    await fetchAndRenderAuditLogs();
    showToast('Đã làm mới dữ liệu nhật ký kiểm toán.', 'info', 2000);
  });

  // Nút đồng bộ tri thức RAG cho AI Chatbot (Admin Only)
  const syncChatbotBtn = document.getElementById('btn-sync-chatbot-knowledge');
  syncChatbotBtn?.addEventListener('click', async () => {
    const originalText = syncChatbotBtn.innerText;
    try {
      syncChatbotBtn.disabled = true;
      syncChatbotBtn.innerText = 'Đang đồng bộ AI...';

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 'error');
        return;
      }

      const res = await fetch('/api/chat/sync', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const result = await res.json();
      if (!res.ok || result.status !== 'success') {
        throw new Error(result.message || 'Lỗi khi đồng bộ dữ liệu vào AI Knowledge Base.');
      }

      showToast(result.message || 'Đồng bộ tri thức AI Chatbot thành công!', 'success', 5000);
    } catch (err) {
      console.error('[mộcnhà. Admin] Lỗi đồng bộ AI Chatbot:', err);
      showToast(`Đồng bộ thất bại: ${err.message}`, 'error', 6000);
    } finally {
      syncChatbotBtn.disabled = false;
      syncChatbotBtn.innerText = originalText;
    }
  });

  // 2. Khởi tạo Dual Image Upload Handlers
  setupImageUploadHandlers();

  // 3. Nút mở modal thêm sản phẩm
  document.getElementById('btn-open-create-product')?.addEventListener('click', () => {
    openProductModal(null);
  });

  // Tự sinh slug khi nhập tên sản phẩm (nếu slug chưa được nhập thủ công)
  const nameInput = document.getElementById('admin-input-name');
  const slugInput = document.getElementById('admin-input-slug');
  nameInput?.addEventListener('input', () => {
    if (slugInput && !document.getElementById('form-admin-product').dataset.editId) {
      slugInput.value = generateSlug(nameInput.value);
    }
  });

  // Đóng modal Thêm / Sửa
  document.getElementById('btn-close-product-modal')?.addEventListener('click', closeProductModal);
  document.getElementById('btn-cancel-product-modal')?.addEventListener('click', closeProductModal);

  // Submit form Thêm / Sửa
  const productForm = document.getElementById('form-admin-product');
  productForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveProductFromForm();
  });

  // Đóng modal xác nhận xóa
  document.getElementById('btn-close-delete-modal')?.addEventListener('click', closeDeleteConfirm);
  document.getElementById('btn-cancel-delete-modal')?.addEventListener('click', closeDeleteConfirm);

  // Xác nhận xóa
  document.getElementById('btn-admin-confirm-delete')?.addEventListener('click', async () => {
    await executeDeleteProduct();
  });

  // EVENT DELEGATION: Bắt nút Sửa và Xóa trong bảng Admin
  const tableBody = document.getElementById('admin-products-table-body');
  tableBody?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.btn-admin-edit');
    if (editBtn) {
      const id = editBtn.dataset.id;
      const product = adminProductsList.find((p) => p.id === id);
      if (product) openProductModal(product);
      return;
    }

    const delBtn = e.target.closest('.btn-admin-delete');
    if (delBtn) {
      const id = delBtn.dataset.id;
      const product = adminProductsList.find((p) => p.id === id);
      if (product) openDeleteConfirm(product);
      return;
    }
  });
}
