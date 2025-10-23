// ----- Telegram helpers (سمت Worker) -----
export const tg = {
  api(token, method) {
    return `https://api.telegram.org/bot${token}/${method}`;
  },
  async call(env, method, payload) {
    const res = await fetch(this.api(env.BOT_TOKEN, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data.ok) {
      console.error("TG error:", method, res.status, JSON.stringify(data));
    }
    return data;
  },
  sendMessage(env, chat_id, text, extra = {}) {
    return this.call(env, "sendMessage", {
      chat_id,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  },
  answerCallback(env, callback_query_id, text, show_alert = false) {
    return this.call(env, "answerCallbackQuery", {
      callback_query_id,
      text,
      show_alert,
    });
  },
  // --- عضویت کانال ---
  getChatMember(env, chat_id, user_id) {
    return this.call(env, "getChatMember", { chat_id, user_id });
  },
};
