// AI/sessionManager.js
let redisClient = null;
let useRedis = false;
const fallbackMap = new Map();

module.exports = {
  _internal: { useRedis, fallbackMap },

  init: (client) => {
    if (client) {
      redisClient = client;
      useRedis = true;
      module.exports._internal.useRedis = true;
    } else {
      redisClient = null;
      useRedis = false;
      module.exports._internal.useRedis = false;
    }
  },

  getSession: async (sessionId) => {
    if (!sessionId) throw new Error('sessionId required');

    if (useRedis && redisClient) {
      const data = await redisClient.get(`ai_session:${sessionId}`);
      return data ? JSON.parse(data) : { aiTurns: 0, welcomed: false, openAiFailures: 0 };
    } else {
      return fallbackMap.get(sessionId) || { aiTurns: 0, welcomed: false, openAiFailures: 0 };
    }
  },

  saveSession: async (sessionId, sessionData) => {
    if (!sessionId) throw new Error('sessionId required');
    if (useRedis && redisClient) {
      await redisClient.set(`ai_session:${sessionId}`, JSON.stringify(sessionData), 'EX', 60 * 60 * 24); // 24h TTL
    } else {
      fallbackMap.set(sessionId, sessionData);
    }
  },

  appendMessage: async (sessionId, message) => {
    const session = await module.exports.getSession(sessionId);
    if (!session.messages) session.messages = [];
    session.messages.push(message);
    await module.exports.saveSession(sessionId, session);
  },

  maybeSummarize: async (sessionId, openaiClient, opts = {}) => {
    const { minTurns = 6, keepLastMessages = 6, model = 'gpt-5-mini', max_tokens = 300 } = opts;
    const session = await module.exports.getSession(sessionId);
    if (!session.messages || session.messages.length < minTurns) return;

    // Keep last N messages
    const lastMessages = session.messages.slice(-keepLastMessages);

    if (!openaiClient) return; // skip if no AI client

    try {
      const completion = await openaiClient.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'Summarize the following conversation for context in a short paragraph.' },
          ...lastMessages.map(m => ({ role: m.role, content: m.text }))
        ],
        max_completion_tokens: max_tokens
      });

      const summary = completion.choices?.[0]?.message?.content?.trim();
      if (summary) {
        session.messages = [
          { role: 'system', text: `Conversation summary: ${summary}` },
          ...lastMessages
        ];
        await module.exports.saveSession(sessionId, session);
      }
    } catch (e) {
      console.warn('Session summarize failed', e.message || e);
    }
  }
};
