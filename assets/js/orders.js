/**
 * assets/js/orders.js
 * Quản lý Data Fetching và Render DOM lịch sử đơn hàng của người dùng
 * Tuân thủ RLS Policy: auth.uid() = user_id
 * Bảo mật DOM chống XSS 100% bằng DOM API & textContent
 */

import { supabase } from './supabaseClient.js';
import { formatCurrency } from './ui.js';

/**
 * Định dạng thời gian chuẩn tiếng Việt
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return new Intl.DateTimeFormat('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(d);
}

/**
 * Lấy nhãn và class trạng thái đơn hàng
 */
function getStatusBadge(status) {
  const map = {
    paid: { label: 'Đã thanh toán (Mock QR)', class: 'bg-success-subtle text-success border border-success-subtle' },
    pending: { label: 'Chờ thanh toán', class: 'bg-warning-subtle text-warning border border-warning-subtle' },
    shipping: { label: 'Đang vận chuyển', class: 'bg-info-subtle text-info border border-info-subtle' },
    completed: { label: 'Hoàn thành', class: 'bg-secondary-subtle text-secondary border border-secondary-subtle' },
    cancelled: { label: 'Đã hủy', class: 'bg-danger-subtle text-danger border border-danger-subtle' }
  };
  return map[status] || { label: status, class: 'bg-light text-dark' };
}

/**
 * Fetch danh sách đơn hàng của người dùng hiện tại từ bảng `orders`
 * RLS trên Supabase tự động giới hạn chỉ trả về đơn mang user_id = auth.uid()
 */
export async function fetchUserOrders() {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id,
        total_amount,
        status,
        customer_name,
        customer_phone,
        shipping_address,
        note,
        payment_method,
        created_at,
        order_items (
          id,
          product_name,
          quantity,
          unit_price,
          subtotal
        )
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[mộcnhà. Orders] Lỗi fetch đơn hàng:', error.message);
      return { success: false, data: [], error: error.message };
    }

    return { success: true, data: Array.isArray(data) ? data : [] };
  } catch (err) {
    console.error('[mộcnhà. Orders] Ngoại lệ fetch đơn hàng:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Render Skeleton Loading cho danh sách đơn hàng
 */
export function renderOrdersSkeleton(containerEl, count = 2) {
  if (!containerEl) return;
  containerEl.replaceChildren();

  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card mb-4 p-4';

    const header = document.createElement('div');
    header.className = 'skeleton-box skeleton-title mb-3';
    header.style.width = '60%';

    const line1 = document.createElement('div');
    line1.className = 'skeleton-box skeleton-text-sm mb-2';
    line1.style.width = '80%';

    const line2 = document.createElement('div');
    line2.className = 'skeleton-box skeleton-desc mb-3';
    line2.style.width = '40%';

    const footer = document.createElement('div');
    footer.className = 'skeleton-box skeleton-footer';
    footer.style.height = '3rem';

    card.append(header, line1, line2, footer);
    containerEl.appendChild(card);
  }
}

/**
 * Render danh sách đơn hàng an toàn (Chống XSS 100% qua DOM API & textContent)
 */
export function renderOrdersList(containerEl, orders) {
  if (!containerEl) return;
  containerEl.replaceChildren();

  if (!orders || orders.length === 0) {
    const emptyCard = document.createElement('div');
    emptyCard.className = 'text-center py-5 border bg-white';

    const p = document.createElement('p');
    p.className = 'text-secondary mb-3';
    p.textContent = 'Bạn chưa có đơn hàng nào trong lịch sử.';

    const link = document.createElement('a');
    link.href = '#home';
    link.className = 'btn-minimal-dark text-decoration-none';
    link.textContent = 'Khám phá sản phẩm ngay';

    emptyCard.appendChild(p);
    emptyCard.appendChild(link);
    containerEl.appendChild(emptyCard);
    return;
  }

  orders.forEach((order) => {
    const card = document.createElement('article');
    card.className = 'border bg-white p-4 mb-4';
    card.style.borderColor = 'var(--color-border)';

    // 1. Order Header: ID, Date, Status
    const header = document.createElement('div');
    header.className = 'd-flex flex-wrap justify-content-between align-items-center border-bottom pb-3 mb-3 gap-2';

    const leftHeader = document.createElement('div');
    const orderTitle = document.createElement('h3');
    orderTitle.className = 'fs-5 fw-bold mb-1';
    orderTitle.textContent = `Đơn hàng #${order.id.slice(0, 8).toUpperCase()}`;

    const dateSpan = document.createElement('span');
    dateSpan.className = 'text-muted small';
    dateSpan.textContent = `Thời gian đặt: ${formatDate(order.created_at)}`;

    leftHeader.appendChild(orderTitle);
    leftHeader.appendChild(dateSpan);

    const statusBadge = document.createElement('span');
    const statusInfo = getStatusBadge(order.status);
    statusBadge.className = `badge py-2 px-3 fw-medium ${statusInfo.class}`;
    statusBadge.style.fontSize = '0.785rem';
    statusBadge.textContent = statusInfo.label;

    header.appendChild(leftHeader);
    header.appendChild(statusBadge);

    // 2. Shipping Info
    const infoRow = document.createElement('div');
    infoRow.className = 'row text-secondary small mb-3 g-2';

    const colRecipient = document.createElement('div');
    colRecipient.className = 'col-md-6';
    colRecipient.textContent = `Người nhận: ${order.customer_name} (${order.customer_phone})`;

    const colAddress = document.createElement('div');
    colAddress.className = 'col-md-6';
    colAddress.textContent = `Địa chỉ: ${order.shipping_address}`;

    infoRow.appendChild(colRecipient);
    infoRow.appendChild(colAddress);

    // 3. Items List
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'bg-light p-3 mb-3';
    itemsContainer.style.backgroundColor = 'var(--color-surface)';

    const items = order.order_items || [];
    items.forEach((item) => {
      const itemRow = document.createElement('div');
      itemRow.className = 'd-flex justify-content-between align-items-center py-1 border-bottom border-light';

      const itemName = document.createElement('span');
      itemName.className = 'fw-medium text-dark small';
      itemName.textContent = `${item.product_name} x ${item.quantity}`;

      const itemSubtotal = document.createElement('span');
      itemSubtotal.className = 'small text-muted';
      itemSubtotal.textContent = formatCurrency(item.subtotal);

      itemRow.appendChild(itemName);
      itemRow.appendChild(itemSubtotal);
      itemsContainer.appendChild(itemRow);
    });

    // 4. Order Footer: Total
    const footer = document.createElement('div');
    footer.className = 'd-flex justify-content-between align-items-center pt-2';

    const totalLabel = document.createElement('span');
    totalLabel.className = 'text-uppercase fw-semibold small';
    totalLabel.style.letterSpacing = '0.05em';
    totalLabel.textContent = 'Tổng giá trị:';

    const totalVal = document.createElement('strong');
    totalVal.className = 'fs-5';
    totalVal.style.color = 'var(--color-wood-dark)';
    totalVal.textContent = formatCurrency(order.total_amount);

    footer.appendChild(totalLabel);
    footer.appendChild(totalVal);

    // Assemble Card
    card.appendChild(header);
    card.appendChild(infoRow);
    card.appendChild(itemsContainer);
    card.appendChild(footer);

    containerEl.appendChild(card);
  });
}
