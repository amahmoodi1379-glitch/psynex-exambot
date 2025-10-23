const tg = {
  api(token, method) {
    return `https://api.telegram.org/bot${token}/${method}`;
  },
  async sendMessage(env, chat_id, text, reply_to_message_id) {
    const body = {
      chat_id,
      text,
      reply_to_message_id,
      allow_sending_without_reply: true,
      parse_mode: "HTML",
    };
    const res = await fetch(this.api(env.BOT_TOKEN, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("sendMessage failed:", res.status, err);
    }
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- وب‌هوک تلگرام ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      // امنیت ساده با secret header تلگرام
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!secret || secret !== env.TG_WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }

      const update = await request.json().catch(() => ({}));

      const msg =
        update.message ||
        update.edited_message ||
        (update.callback_query ? update.callback_query.message : null);

      if (!msg || !msg.chat) {
        return new Response("ok", { status: 200 });
      }

      const chat_id = msg.chat.id;
      const text = msg.text || "";

      // دستورات ساده برای تست
      if (text.startsWith("/ping")) {
        await tg.sendMessage(env, chat_id, "pong ✅", msg.message_id);
      } else if (text.startsWith("/start")) {
        await tg.sendMessage(env, chat_id, "Webhook is live. Type /ping", msg.message_id);
      }

      return new Response("ok", { status: 200 });
    }

    // --- مسیرهای قبلی ---
    if (url.pathname === "/") {
      return new Response("psynex-exambot: OK", { status: 200 });
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
