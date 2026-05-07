const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_BASE_URL = process.env.DIFY_BASE_URL;
const PANCAKE_API_KEY = process.env.PANCAKE_API_KEY;

// Lưu mapping: pancake_conv_id → dify_conv_id (dùng RAM, đủ cho demo)
const sessions = {};

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Aiecos AI Middleware' }));

// Pancake gửi webhook vào đây khi có tin nhắn mới từ khách
app.post('/webhook/pancake', async (req, res) => {
  // Trả 200 ngay để Pancake không timeout
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('[Pancake Webhook]', JSON.stringify(body, null, 2));

    // Pancake webhook payload
    const conversationId = body.conversation_id || body.id;
    const messageText =
      body.messages?.[0]?.message ||
      body.message?.text ||
      body.text;
    const senderId = String(
      body.customer?.uid || body.customer?.id || body.sender?.id || conversationId
    );

    if (!messageText || !conversationId) {
      console.log('[Skip] Không có message hoặc conversation_id');
      return;
    }

    // Bỏ qua tin nhắn do page gửi (tránh vòng lặp)
    if (body.is_page_message || body.from_page) {
      console.log('[Skip] Tin nhắn từ page, bỏ qua');
      return;
    }

    console.log(`[Message] Conv: ${conversationId} | User: ${senderId} | Text: ${messageText}`);

    // Lấy Dify conversation_id cũ nếu có
    const difyConvId = sessions[conversationId] || '';

    // Gọi Dify Agent
    const difyRes = await axios.post(
      `${DIFY_BASE_URL}/chat-messages`,
      {
        inputs: {},
        query: messageText,
        response_mode: 'blocking',
        conversation_id: difyConvId,
        user: senderId,
      },
      {
        headers: {
          Authorization: `Bearer ${DIFY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const { answer, conversation_id: newDifyConvId } = difyRes.data;
    sessions[conversationId] = newDifyConvId;

    console.log(`[Dify Reply] ${answer}`);

    // Gửi reply về Pancake
    await sendPancakeReply(conversationId, answer);
  } catch (err) {
    console.error('[Error]', err.response?.data || err.message);
  }
});

async function sendPancakeReply(conversationId, message) {
  try {
    await axios.post(
      `https://pages.fm/api/v1/conversations/${conversationId}/messages`,
      { message },
      {
        headers: {
          Authorization: `Bearer ${PANCAKE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('[Pancake] Đã gửi reply thành công');
  } catch (err) {
    console.error('[Pancake Reply Error]', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Aiecos Middleware running on port ${PORT}`);
});
