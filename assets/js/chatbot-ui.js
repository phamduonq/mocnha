/**
 * assets/js/chatbot-ui.js
 * 
 * Quản lý giao diện và tương tác AI Chatbot Widget (Wabi-Sabi Minimalism):
 * - Nút bấm nổi (Floating Chat Button) mở / đóng khung trò chuyện.
 * - Gửi tin nhắn tới Endpoint /api/chat (RAG + Gemini).
 * - Thực thi nguyên tắc "Zero-Execution" trên UI:
 *   + AI KHÔNG tự ý thêm giỏ hàng hay thanh toán.
 *   + AI chỉ nhả ra action JSON: "add_to_cart" hoặc "checkout".
 *   + UI sẽ hiển thị nút bấm xác nhận để CHÍNH NGƯỜI DÙNG tự tay bấm thực thi!
 */

import { addToCart } from './cart.js';
import { openCheckoutModal } from './checkout.js';
import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';

let isChatOpen = false;
let isSending = false;

/**
 * Thêm một tin nhắn vào khung chat
 * 
 * @param {string} text - Nội dung tin nhắn
 * @param {'bot'|'user'} sender - Người gửi
 * @param {object|null} action - Action đề xuất từ AI (Zero-Execution)
 */
function appendChatMessage(text, sender = 'bot', action = null) {
  const messagesContainer = document.getElementById('chatbot-messages');
  if (!messagesContainer) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${sender === 'user' ? 'chat-msg-user' : 'chat-msg-bot'}`;
  msgDiv.textContent = text;

  // Nếu AI đề xuất Action -> Sinh nút bấm cho người dùng tự bấm xác nhận
  if (action && action.type && sender === 'bot') {
    if (action.type === 'add_to_cart' && action.payload?.product_id) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'chat-action-btn';
      const qty = action.payload.quantity || 1;
      actionBtn.textContent = `➕ Xác nhận thêm vào giỏ (SL: ${qty})`;

      actionBtn.addEventListener('click', async () => {
        actionBtn.disabled = true;
        actionBtn.textContent = '⏳ Đang kiểm tra tác phẩm...';

        try {
          // Lấy thông tin sản phẩm từ Supabase để add to cart
          const { data: product, error } = await supabase
            .from('products')
            .select('*')
            .eq('id', action.payload.product_id)
            .single();

          if (error || !product) {
            actionBtn.textContent = '❌ Không tìm thấy sản phẩm';
            showToast('Sản phẩm này tạm thời không khả dụng.', 'warning');
            return;
          }

          if (product.stock < qty) {
            actionBtn.textContent = '❌ Tồn kho không đủ';
            showToast(`Tồn kho chỉ còn ${product.stock} sản phẩm.`, 'warning');
            return;
          }

          // Gọi hàm thêm vào giỏ hàng của chính người dùng
          addToCart(product, qty);
          actionBtn.textContent = '✓ Đã thêm vào giỏ hàng';
          actionBtn.style.backgroundColor = '#2E7D32';
          showToast(`Đã thêm "${product.name}" vào giỏ hàng!`, 'success');
        } catch (err) {
          console.error('[Chatbot Action Error]', err);
          actionBtn.disabled = false;
          actionBtn.textContent = `➕ Thử lại (SL: ${qty})`;
        }
      });

      msgDiv.appendChild(document.createElement('br'));
      msgDiv.appendChild(actionBtn);
    } else if (action.type === 'checkout') {
      const checkoutBtn = document.createElement('button');
      checkoutBtn.type = 'button';
      checkoutBtn.className = 'chat-action-btn';
      checkoutBtn.style.backgroundColor = '#6C492B';
      checkoutBtn.textContent = '💳 Chuyển tới bước Thanh toán';

      checkoutBtn.addEventListener('click', () => {
        openCheckoutModal();
      });

      msgDiv.appendChild(document.createElement('br'));
      msgDiv.appendChild(checkoutBtn);
    }
  }

  messagesContainer.appendChild(msgDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Hiển thị chỉ báo AI đang soạn câu trả lời
 */
function showTypingIndicator() {
  const messagesContainer = document.getElementById('chatbot-messages');
  if (!messagesContainer) return null;

  const typingDiv = document.createElement('div');
  typingDiv.id = 'chat-typing-indicator';
  typingDiv.className = 'chat-msg chat-msg-bot text-muted fst-italic';
  typingDiv.textContent = 'Mộc Trợ Lý đang tra cứu tri thức...';
  messagesContainer.appendChild(typingDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return typingDiv;
}

function removeTypingIndicator() {
  const typingDiv = document.getElementById('chat-typing-indicator');
  typingDiv?.remove();
}

/**
 * Gửi tin nhắn tới AI Chatbot API
 */
async function sendChatMessage(message) {
  if (isSending || !message.trim()) return;

  const inputEl = document.getElementById('chatbot-input');
  const sendBtn = document.getElementById('btn-send-chat');

  isSending = true;
  if (inputEl) inputEl.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  // 1. Hiển thị tin nhắn người dùng
  appendChatMessage(message, 'user');
  if (inputEl) inputEl.value = '';

  // 2. Hiển thị typing
  showTypingIndicator();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: message.trim() }),
    });

    const resData = await response.json();
    removeTypingIndicator();

    if (response.ok && resData.status === 'success') {
      const reply = resData.data?.reply || 'Cảm ơn bạn đã quan tâm đến Mộc Nhà.';
      const action = resData.data?.action || null;
      appendChatMessage(reply, 'bot', action);
    } else {
      // Xử lý lỗi Rate Limiting (429) hoặc lỗi hệ thống
      const errorReply = resData.fallback?.reply ||
                         resData.message ||
                         'Xin lỗi bạn, trợ lý ảo tạm thời đang bận. Bạn vui lòng thử lại sau nhé.';
      appendChatMessage(errorReply, 'bot', null);
      if (response.status === 429) {
        showToast('Bạn thao tác quá nhanh. Vui lòng chờ 1 phút.', 'warning');
      }
    }
  } catch (err) {
    console.error('[Chatbot Error]', err);
    removeTypingIndicator();
    appendChatMessage('Không thể kết nối đến máy chủ trợ lý ảo. Vui lòng kiểm tra lại mạng.', 'bot', null);
  } finally {
    isSending = false;
    if (inputEl) {
      inputEl.disabled = false;
      inputEl.focus();
    }
    if (sendBtn) sendBtn.disabled = false;
  }
}

/**
 * Mở / Đóng Chatbot Window
 */
export function toggleChatbotWindow() {
  const chatWindow = document.getElementById('chatbot-window');
  if (!chatWindow) return;

  isChatOpen = !isChatOpen;
  if (isChatOpen) {
    chatWindow.classList.remove('d-none');
    document.getElementById('chatbot-input')?.focus();
  } else {
    chatWindow.classList.add('d-none');
  }
}

/**
 * Khởi tạo toàn bộ sự kiện cho Chatbot UI
 */
export function initChatbotUI() {
  const toggleBtn = document.getElementById('chatbot-btn');
  const closeBtn = document.getElementById('btn-close-chatbot');
  const chatForm = document.getElementById('chatbot-form');

  toggleBtn?.addEventListener('click', toggleChatbotWindow);
  closeBtn?.addEventListener('click', toggleChatbotWindow);

  chatForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputEl = document.getElementById('chatbot-input');
    const msg = inputEl?.value || '';
    await sendChatMessage(msg);
  });
}
