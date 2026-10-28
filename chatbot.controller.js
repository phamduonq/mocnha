/**
 * chatbot.controller.js
 * 
 * Controller tiếp nhận yêu cầu trò chuyện, điều phối luồng RAG và Gemini Zero-Execution:
 * - Tiếp nhận message từ người dùng.
 * - Validate đầu vào (chống DoS / Token Flooding).
 * - Bắt ngoại lệ triệt để: Lỗi cú pháp JSON, Timeout, Lỗi kết nối AI.
 * - Che giấu hoàn toàn stack trace và API secrets.
 */

const { processChatMessage } = require('./chatbot.service');

// Giới hạn độ dài tin nhắn người dùng (chống Prompt Stuffing / DoS)
const MAX_MESSAGE_LENGTH = 1500;

/**
 * Phụ trợ chuẩn hóa lỗi của Chatbot
 */
function handleChatbotError(res, err) {
  const statusCode = err.status && Number.isInteger(err.status) ? err.status : 500;

  const codeMap = {
    400: 'BAD_REQUEST',
    408: 'REQUEST_TIMEOUT',
    500: 'AI_PROCESSING_ERROR',
    504: 'GATEWAY_TIMEOUT',
  };

  const errorCode = codeMap[statusCode] || 'INTERNAL_SERVER_ERROR';

  // Thông báo thân thiện cho client
  const clientMessage = statusCode === 504 || statusCode === 408
    ? 'Hệ thống AI phản hồi quá lâu. Vui lòng thử lại sau.'
    : statusCode === 400
    ? err.message
    : 'Hệ thống trợ lý ảo tạm thời gặp sự cố khi xử lý câu hỏi.';

  // Log nội bộ server
  console.error(`[Chatbot Controller Error] Status: ${statusCode} | Code: ${errorCode} | Message: ${err.message}`);
  if (statusCode === 500 && err.stack) {
    console.error(err.stack);
  }

  // Trả về lỗi kèm cấu trúc fallback an toàn để UI không bị vỡ giao diện
  return res.status(statusCode).json({
    status: 'error',
    code: errorCode,
    message: clientMessage,
    fallback: {
      reply: 'Xin lỗi, tôi chưa thể xử lý yêu cầu lúc này. Bạn vui lòng thử lại câu hỏi khác nhé.',
      action: {
        type: 'none',
        payload: {
          product_id: '',
          quantity: 0,
        },
      },
    },
  });
}

/**
 * Endpoint: POST /api/chat
 * Body: { "message": "Tôi muốn mua bàn ăn gỗ sồi 6 ghế" }
 */
async function chatHandler(req, res) {
  try {
    const { message } = req.body || {};

    // 1. Kiểm tra tính hợp lệ của tin nhắn đầu vào
    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'Trường "message" là bắt buộc và phải là chuỗi văn bản.',
      });
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'Nội dung câu hỏi không được để trống.',
      });
    }

    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        status: 'error',
        code: 'BAD_REQUEST',
        message: `Câu hỏi quá dài. Vui lòng rút gọn dưới ${MAX_MESSAGE_LENGTH} ký tự.`,
      });
    }

    // 2. Gọi Service RAG + Gemini với Zero-Execution
    const aiResult = await processChatMessage(trimmedMessage);

    // 3. Trả về kết quả JSON hợp lệ cho Frontend
    // Frontend sẽ đọc action.type:
    // - Nếu type === "add_to_cart": hiển thị nút bấm "Xác nhận thêm vào giỏ hàng"
    // - Nếu type === "checkout": hiển thị nút bấm "Đến trang thanh toán"
    // Chatbot hoàn toàn KHÔNG tự ý ghi vào database giỏ hàng.
    return res.status(200).json({
      status: 'success',
      data: {
        reply: aiResult.reply,
        action: aiResult.action,
      },
    });
  } catch (error) {
    return handleChatbotError(res, error);
  }
}

module.exports = {
  chatHandler,
};
