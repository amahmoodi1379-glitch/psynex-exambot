// ===================== Telegram helpers =====================
const tg = {
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
  editMessageText(env, chat_id, message_id, text, extra = {}) {
    return this.call(env, "editMessageText", {
      chat_id,
      message_id,
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
};

// ===================== Utilities =====================
const now = () => Date.now();
const shortId = () =>
  now().toString(36).slice(-6) +
  Math.floor(Math.random() * 2176782336).toString(36).slice(-2);

// استخراج امن دستور حتی با @username
function getCommand(msg) {
  const text = msg.text || "";
  const entities = msg.entities || [];
  const cmdEnt = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!cmdEnt) return null;
  const raw = text.substring(cmdEnt.offset, cmdEnt.offset + cmdEnt.length).toLowerCase();
  return raw.split("@")[0]; // "/newgame"
}

// ===================== Durable Object: Room =====================
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null; // lazy load
  }

  async load() {
    if (!this.room) this.room = (await this.state.storage.get("room")) || null;
    return this.room;
  }
  async save() {
    await this.state.storage.put("room", this.room);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname; // "/create", "/join", "/start", "/answer"
    const body = await request.json().catch(() => ({}));

    if (path === "/create") {
      const { chat_id, starter_id, starter_name, room_id } = body;

      // *نمونه* سوالات — بعداً از R2 می‌آیند
      const questions = [
        { id: "Q1", text: "کدام گزینه صحیح است؟", options: ["۱","۲","۳","۴"], correct: 1 },
        { id: "Q2", text: "روان‌شناسی کدام است؟", options: ["الف","ب","ج","د"], correct: 0 },
        { id: "Q3", text: "نمونه سؤال سوم", options: ["A","B","C","D"], correct: 2 },
      ];

      this.room = {
        id: room_id,             // شناسه‌ی ثابت اتاق
        chat_id,
        starter_id,
        starter_name,
        status: "lobby",         // lobby | running | ended
        players: { [String(starter_id)]: { name: starter_name || "Starter", ready: true, answers: [] } },
        createdAt: now(),
        qIndex: -1,
        questions,
      };
      await this.save();
      return new Response(JSON.stringify({ ok: true, roomId: this.room.id }), { status: 200 });
    }

    await this.load();
    if (!this.room) {
      return new Response(JSON.stringify({ ok: false, error: "no-room" }), { status: 404 });
    }

    if (path === "/join") {
      const { user_id, name } = body;
      const uid = String(user_id);
      if (!this.room.players[uid]) this.room.players[uid] = { name, ready: true, answers: [] };
      else this.room.players[uid].ready = true;
      await this.save();
      const readyCount = Object.values(this.room.players).filter((p) => p.ready).length;
      return new Response(JSON.stringify({ ok: true, readyCount }), { status: 200 });
    }

    if (path === "/start") {
      const { by_user } = body;
      if (String(by_user) !== String(this.room.starter_id)) {
        return new Response(JSON.stringify({ ok: false, error: "only-starter" }), { status: 403 });
      }
      if (this.room.status !== "lobby") {
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });
      }
      this.room.status = "running";
      this.room.qIndex = 0;
      await this.save();
      const q = this.room.questions[this.room.qIndex];
      return new Response(JSON.stringify({ ok: true, qIndex: this.room.qIndex, q }), { status: 200 });
    }

    if (path === "/answer") {
      const { user_id, qIndex, option } = body;
      if (this.room.status !== "running") {
        return new Response(JSON.stringify({ ok: false, error: "not-running" }), { status: 400 });
      }
      if (qIndex !== this.room.qIndex) {
        return new Response(JSON.stringify({ ok: false, error: "stale-question" }), { status: 409 });
      }
      const uid = String(user_id);
      if (!this.room.players[uid]) this.room.players[uid] = { name: "?", ready: true, answers: [] };
      if (this.room.players[uid].answers[qIndex] != null) {
        return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 });
      }
      this.room.players[uid].answers[qIndex] = option;
      await this.save();
      const answeredCount = Object.values(this.room.players).filter((p) => p.answers[qIndex] != null).length;
      const totalPlayers = Object.keys(this.room.players).length;
      return new Response(JSON.stringify({ ok: true, answeredCount, totalPlayers }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: false, error: "bad-path" }), { status: 404 });
  }
}

// ===================== Worker =====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- Telegram webhook ----------
    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!secret || secret !== env.TG_WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }

      const update = await request.json().catch(() => ({}));

      // helper: DO stub با نام پایدار
      const getStubByKey = (key) => env.ROOMS.get(env.ROOMS.idFromName(key));

      // پیام‌های متنی (دستورها)
      if (update.message?.text) {
        const msg = update.message;
        const chat = msg.chat || {};
        const chat_id = chat.id;
        const chat_type = chat.type || "private";

        const cmd = getCommand(msg);

        if (cmd === "/ping") {
          await tg.sendMessage(env, chat_id, "pong ✅", { reply_to_message_id: msg.message_id });
          return new Response("ok", { status: 200 });
        }

        if (cmd === "/newgame") {
          if (chat_type !== "group" && chat_type !== "supergroup") {
            await tg.sendMessage(env, chat_id, "این دستور فقط در گروه کار می‌کند.", { reply_to_message_id: msg.message_id });
            return new Response("ok", { status: 200 });
          }

          const starter = msg.from;
          const roomId = shortId(); // شناسه‌ی اتاق
          const nameKey = `${chat_id}-${roomId}`;
          const stub = getStubByKey(nameKey);

          // ساخت اتاق در DO
          const res = await stub.fetch("https://do/create", {
            method: "POST",
            body: JSON.stringify({
              chat_id,
              starter_id: starter.id,
              starter_name: starter.first_name,
              room_id: roomId,
            }),
          });
          const data = await res.json();
          const rid = data.roomId;

          const kb = {
            inline_keyboard: [[
              { text: "✅ آماده‌ام", callback_data: `j:${rid}` },
              { text: "🟢 آغاز بازی", callback_data: `s:${rid}` },
            ]],
          };
          await tg.sendMessage(
            env,
            chat_id,
            "بازی جدید ساخته شد.\nشرکت‌کننده‌ها: دکمه «✅ آماده‌ام» را بزنید.\nشروع‌کننده می‌تواند «🟢 آغاز بازی» را بزند.",
            { reply_markup: kb }
          );

          return new Response("ok", { status: 200 });
        }
      }

      // کال‌بک دکمه‌ها
      if (update.callback_query) {
        const cq = update.callback_query;
        const msg = cq.message || {};
        const chat_id = msg.chat?.id;
        const from = cq.from;
        const parts = (cq.data || "").split(":"); // j:<rid> | s:<rid> | a:<rid>:<qIndex>:<opt>
        const act = parts[0];
        const rid = parts[1];
        const key = `${chat_id}-${rid}`;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(key));

        if (act === "j") {
          await stub.fetch("https://do/join", {
            method: "POST",
            body: JSON.stringify({ user_id: from.id, name: from.first_name }),
          });
          await tg.answerCallback(env, cq.id, "ثبت شد: آماده‌ای ✅");
          await tg.sendMessage(env, chat_id, `👤 ${from.first_name} آماده شد.`);
          return new Response("ok", { status: 200 });
        }

        if (act === "s") {
          const r = await stub.fetch("https://do/start", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(
              env,
              cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند آغاز کند." :
              out.error === "already-started" ? "بازی قبلاً شروع شده." : "خطا",
              true
            );
            return new Response("ok", { status: 200 });
          }
          const q = out.q;
          const qIdx = out.qIndex;
          const kbAns = {
            inline_keyboard: [[
              { text: "1", callback_data: `a:${rid}:${qIdx}:0` },
              { text: "2", callback_data: `a:${rid}:${qIdx}:1` },
              { text: "3", callback_data: `a:${rid}:${qIdx}:2` },
              { text: "4", callback_data: `a:${rid}:${qIdx}:3` },
            ]],
          };
          await tg.answerCallback(env, cq.id, "بازی شروع شد!");
          await tg.sendMessage(
            env,
            chat_id,
            `❓ سوال ${qIdx + 1}:\n${q.text}\n\nگزینه‌ها:\n1) ${q.options[0]}\n2) ${q.options[1]}\n3) ${q.options[2]}\n4) ${q.options[3]}`,
            { reply_markup: kbAns }
          );
          return new Response("ok", { status: 200 });
        }

        if (act === "a") {
          const qIndex = Number(parts[2]);
          const opt = Number(parts[3]);
          const r = await stub.fetch("https://do/answer", {
            method: "POST",
            body: JSON.stringify({ user_id: from.id, qIndex, option: opt }),
          });
          const out = await r.json();
          if (out.ok && out.duplicate) {
            await tg.answerCallback(env, cq.id, "قبلاً ثبت شده بود.");
          } else if (out.ok) {
            await tg.answerCallback(env, cq.id, "پاسخ ثبت شد ✅");
            await tg.sendMessage(
              env,
              chat_id,
              `📝 پاسخ ${from.first_name} ثبت شد (${out.answeredCount}/${out.totalPlayers}).`
            );
          } else {
            await tg.answerCallback(env, cq.id, "خطا در ثبت پاسخ", true);
          }
          return new Response("ok", { status: 200 });
        }
      }

      return new Response("ok", { status: 200 });
    }

    // ---------- Debug helpers ----------
    if (url.pathname === "/tg/register") {
      const webhookUrl = new URL("/webhook", request.url).toString();
      const out = await tg.call(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TG_WEBHOOK_SECRET,
        drop_pending_updates: true,
        allowed_updates: ["message", "callback_query"],
      });
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
    if (url.pathname === "/tg/info") {
      const out = await tg.call(env, "getWebhookInfo", {});
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }

    // ---------- Health ----------
    if (url.pathname === "/") return new Response("psynex-exambot: OK", { status: 200 });
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });

    return new Response("Not Found", { status: 404 });
  },
};
