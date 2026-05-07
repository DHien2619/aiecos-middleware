const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_BASE_URL = process.env.DIFY_BASE_URL;
const PANCAKE_SESSION_TOKEN = process.env.PANCAKE_SESSION_TOKEN;
const PANCAKE_PAGE_ID = process.env.PANCAKE_PAGE_ID;
const PANCAKE_API = 'https://pancake.vn/api/v1';

// Dify session: pancake_conv_id → dify_conv_id
const difyConversations = {};

// Track processed message IDs to prevent double-processing
const processedMessages = new Set();

// Health check
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'Aiecos AI Middleware',
  mode: 'polling',
  processed: processedMessages.size,
}));

// Polling: check for new customer messages every 5 seconds
async function pollPancakeMessages() {
  if (!PANCAKE_SESSION_TOKEN || !PANCAKE_PAGE_ID) {
    console.error('[Config] Missing PANCAKE_SESSION_TOKEN or PANCAKE_PAGE_ID');
    return;
  }

  try {
    const res = await axios.get(`${PANCAKE_API}/pages/${PANCAKE_PAGE_ID}/conversations`, {
      params: {
        access_token: PANCAKE_SESSION_TOKEN,
        unread_first: true,
        mode: 'NONE',
        cursor_mode: true,
        from_platform: 'web',
      },
      timeout: 10000,
    });

    const conversations = res.data.conversations || [];

    for (const conv of conversations) {
      const hasUnread = (conv.unread_count || 0) > 0;
      const lastSentByPage = conv.last_sent_by?.id === PANCAKE_PAGE_ID;

      if (hasUnread && !lastSentByPage) {
        console.log('[Poll] Processing conv id:', conv.id, '| from_psid:', conv.from_psid, '| last_sent_by:', conv.last_sent_by?.id);
        await processConversation(conv);
      }
    }
  } catch (err) {
    console.error('[Poll Error]', err.message);
  }
}

async function processConversation(conv) {
  const convId = conv.id;
  const convIdForApi = convId; // use full conv ID as returned by Pancake
  const customerPsid = String(conv.from_psid || conv.from?.id || '');

  try {
    // Get last message from customer
    const msgUrl = `${PANCAKE_API}/pages/${PANCAKE_PAGE_ID}/conversations/${convIdForApi}/messages`;
    console.log('[Fetch] URL:', msgUrl, '| from_id:', customerPsid);
    const msgRes = await axios.get(msgUrl, {
      params: { access_token: PANCAKE_SESSION_TOKEN, from_id: customerPsid },
      timeout: 10000,
    });

    const msgId = msgRes.data.id;
    const messageText = msgRes.data.message;

    if (!messageText || !msgId) return;
    if (processedMessages.has(msgId)) return;

    processedMessages.add(msgId);
    console.log(`[New Message] Conv: ${convIdForApi} | Text: ${messageText}`);

    // Call Dify Agent
    const difyConvId = difyConversations[convIdForApi] || '';
    const { answer, newDifyConvId } = await callDifyStreaming({
      query: messageText,
      conversationId: difyConvId,
      user: customerPsid || convIdForApi,
    });
    difyConversations[convIdForApi] = newDifyConvId;

    console.log(`[Dify Reply] ${answer}`);

    // Send reply to Pancake
    await sendPancakeReply(convIdForApi, answer);
  } catch (err) {
    console.error('[Process Error]', JSON.stringify(err.response?.data) || err.message, '| convIdForApi:', convIdForApi, '| psid:', customerPsid);
  }
}

async function sendPancakeReply(convId, message) {
  try {
    const formData = new URLSearchParams();
    formData.append('action', 'reply_inbox');
    formData.append('message', message);
    formData.append('send_by_platform', 'web');

    await axios.post(
      `${PANCAKE_API}/pages/${PANCAKE_PAGE_ID}/conversations/${convId}/messages`,
      formData.toString(),
      {
        params: { access_token: PANCAKE_SESSION_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );
    console.log('[Pancake] Reply sent successfully');
  } catch (err) {
    console.error('[Pancake Reply Error]', err.response?.data || err.message);
  }
}

async function callDifyStreaming({ query, conversationId, user }) {
  const response = await axios.post(
    `${DIFY_BASE_URL}/chat-messages`,
    {
      inputs: {},
      query,
      response_mode: 'streaming',
      conversation_id: conversationId,
      user,
    },
    {
      headers: {
        Authorization: `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      timeout: 60000,
    }
  );

  return new Promise((resolve, reject) => {
    let answer = '';
    let newDifyConvId = conversationId;
    let buffer = '';

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const event = JSON.parse(jsonStr);
          if (event.event === 'agent_message' || event.event === 'message') {
            answer += event.answer || '';
          }
          if (event.event === 'message_end') {
            newDifyConvId = event.conversation_id || newDifyConvId;
          }
        } catch (_) {}
      }
    });

    response.data.on('end', () => resolve({ answer: answer.trim(), newDifyConvId }));
    response.data.on('error', reject);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Aiecos Middleware running on port ${PORT} (polling mode)`);
  // Start polling immediately then every 5 seconds
  pollPancakeMessages();
  setInterval(pollPancakeMessages, 5000);
});
