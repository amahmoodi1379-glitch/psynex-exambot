const tg = {
  api(token, method) {
    return `https://api.telegram.org/bot${token}/${method}`;
  },
  async sendMessage(env, chat_id, text, extra = {}) {
    const body = {
      chat_id,
      text,
      allow_sending_without_reply: true,
      parse_mode: "HTML",
      ...extra,
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
  async call(env, method, payload) {
    const res = await fetch(this.api(env.BOT_TOKEN, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, data };
  },
};

// استخراج امن دستور حتی با @username و آرگومان
function getCommand(msg) {
  const text = msg.text || "";
  const entities = msg.entities || [];
  const cmdEnt = entities.find(e => e.type === "bot_command" && e.offset === 0);
  if (!cmdEnt) return null;
  const raw = text.substring(cmdEnt.offset, cmdEnt.length).toLowerCase(); // مثل "/newgame@psynex_exambot"
  return raw.split("@")[0]; // "/newgame"
}

function htmlApp(title, subtitle) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto}
    .wrap{padding:16px}
    h1{font-size:18px;margin:0 0 8px}
    .card{border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .muted{opacity:.7;font-size:14px}
    .row{margin-top:12px;font-size:14px}
    button{padding:10px 14px;border:0;border-radius:10px;cursor:pointer}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>مینی‌اپ روان‌شناسی – آماده‌سازی</h1>
    <div class="card">
      <div class="muted">${subtitle}</div>
      <div class="row" id="info">در حال خواندن اطلاعات تلگرام…</div>
      <div class="row"><button id="readyBtn">اوکی، ادامه</button></div>
    </div>
  </div>
  <script>
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.expand();
      const data = tg.initDataUnsafe || {};
      const user = data.user || {};
      const chatType = data.chat_type || "unknown";
      const chat = data.chat || {};
      document.getElementById("info").textContent =
        "کاربر: " + (user.first_name || "نامشخص") +
        " | نوع چت: " + chatType +
        (chat.id ? (" | chat_id: " + chat.id) : "");
      document.getElementById("readyBtn").onclick = () => {
        tg.showAlert("اتصال برقرار شد. مرحله بعد: فرم انتخاب درس/قالب (به‌زودی)");
      };
    } else {
      document.getElementById("info").textContent =
        "این صفحه باید از داخل تلگرام باز شود.";
    }
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- ثبت/حذف/اطلاعات وب‌هوک (دیباگ) ---
    if (url.pathname === "/tg/register") {
      const webhookUrl = new URL("/webhook", request.url).toString();
      const out = await tg.call(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TG_WEBHOOK_SECRET,
        drop_pending_updates: true,
        allowed_updates: ["message","callback_query"],
      });
      return new Response(JSON.stringify({ webhookUrl, telegram: out.data }), {
        status: 200, headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    if (url.pathname === "/tg/delete") {
      const out = await tg.call(env, "deleteWebhook", { drop_pending_updates: true });
      return new Response(JSON.stringify(out.data), {
        status: 200, headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    if (url.pathname === "/tg/info") {
      const out = await tg.call(env, "getWebhookInfo", {});
      return new Response(JSON.stringify(out.data), {
        status: 200, headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }

    // --- وب‌هوک تلگرام ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!secret || secret !== env.TG_WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const update = await request.json().catch(() => ({}));
      const msg =
        update.message ||
        update.edited_message ||
        (update.callback_query ? update.callback_query.message : null);
      if (!msg || !msg.chat) return new Response("ok", { status: 200 });

      const cmd = getCommand(msg);
      const chat_id = msg.chat.id;
      const chat_type = msg.chat.type || "private";

      // /ping
      if (cmd === "/ping") {
        await tg.sendMessage(env, chat_id, "pong ✅", { reply_to_message_id: msg.message_id });
        return new Response("ok", { status: 200 });
      }

      // /start
      if (cmd === "/start") {
        await tg.sendMessage(env, chat_id, "بات فعاله. در گروه بزن: /newgame", { reply_to_message_id: msg.message_id });
        return new Response("ok", { status: 200 });
      }

      // /newgame فقط گروه
      if (cmd === "/newgame") {
        if (chat_type !== "group" && chat_type !== "supergroup") {
          await tg.sendMessage(env, chat_id, "این دستور فقط داخل گروه قابل استفاده است.", { reply_to_message_id: msg.message_id });
          return new Response("ok", { status: 200 });
        }
        const appUrl = new URL("/app", request.url).toString();

        // پیام با دکمه WebApp
        await tg.sendMessage(env, chat_id, "برای شروع بازی، روی دکمه زیر بزنید:", {
          reply_to_message_id: msg.message_id,
          reply_markup: { inline_keyboard: [[{ text: "🚀 شروع بازی (Mini App)", web_app: { url: appUrl } }]] }
        });

        // fallback لینک (اگر دکمه باز نشد)
        await tg.sendMessage(env, chat_id, `اگر دکمه باز نشد، از داخل تلگرام روی این لینک بزنید:\n<a href="${appUrl}">${appUrl}</a>`);
        return new Response("ok", { status: 200 });
      }

      return new Response("ok", { status: 200 });
    }

    // --- صفحه Mini App ---
    if (url.pathname === "/app") {
      const html = htmlApp("Psynex Mini App", "اتصال اولیه برقرار شد.");
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }

    // --- مسیرهای کمکی ---
    if (url.pathname === "/") return new Response("psynex-exambot: OK", { status: 200 });
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200, headers: { "content-type": "application/json; charset=UTF-8" }
      });

    return new Response("Not Found", { status: 404 });
  },
};
