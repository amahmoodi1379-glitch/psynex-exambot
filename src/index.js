// ---------- Telegram helper ----------
const tg = {
  api(token, method) { return `https://api.telegram.org/bot${token}/${method}`; },

  async send(env, method, payload) {
    const res = await fetch(this.api(env.BOT_TOKEN, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data.ok) {
      console.error("TG error", method, res.status, JSON.stringify(data));
    }
    return data;
  },

  sendMessage(env, chat_id, text, extra={}) {
    return this.send(env, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
  },
  editMessageText(env, chat_id, message_id, text, extra={}) {
    return this.send(env, "editMessageText", { chat_id, message_id, text, parse_mode: "HTML", ...extra });
  },
  answerCallback(env, callback_query_id, text, show_alert=false) {
    return this.send(env, "answerCallbackQuery", { callback_query_id, text, show_alert });
  }
};

// ---------- Utilities ----------
const now = () => Date.now();
const shortId = () => (now().toString(36).slice(-6) + Math.floor(Math.random()*2176782336).toString(36).slice(-2)); // کوتاه

// ---------- Durable Object: یک اتاق بازی ----------
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null; // در storage نگه می‌داریم
  }

  async load() {
    if (!this.room) {
      this.room = await this.state.storage.get("room") || null;
    }
    return this.room;
  }
  async save() { await this.state.storage.put("room", this.room); }

  // درخواست‌ها از وورکر به این DO می‌آید
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname; // /create, /join, /start, /answer
    const body = await request.json().catch(() => ({}));

    if (path === "/create") {
      const { chat_id, starter_id, starter_name } = body;
      // نمونه سوالات فرضی (بعداً از R2 می‌آید)
      const questions = [
        { id: "Q1", text: "کدام گزینه صحیح است؟", options: ["۱", "۲", "۳", "۴"], correct: 1 },
        { id: "Q2", text: "روان‌شناسی کدام است؟", options: ["الف", "ب", "ج", "د"], correct: 0 },
        { id: "Q3", text: "نمونه سؤال سوم", options: ["A","B","C","D"], correct: 2 }
      ];

      this.room = {
        id: shortId(),
        chat_id,
        starter_id,
        starter_name,
        status: "lobby",        // lobby | running | ended
        players: {},            // user_id -> {name, ready:true, answers:[]}
        createdAt: now(),
        qIndex: -1,
        questions,
      };
      // ثبت شروع‌کننده به‌صورت آماده
      this.room.players[String(starter_id)] = { name: starter_name || "Starter", ready: true, answers: [] };
      await this.save();
      return new Response(JSON.stringify({ ok:true, roomId: this.room.id }), { status: 200 });
    }

    await this.load();
    if (!this.room) return new Response(JSON.stringify({ ok:false, error:"no-room" }), { status: 404 });

    if (path === "/join") {
      const { user_id, name } = body;
      const uid = String(user_id);
      if (!this.room.players[uid]) this.room.players[uid] = { name, ready: true, answers: [] };
      else this.room.players[uid].ready = true;
      await this.save();
      const readyCount = Object.values(this.room.players).filter(p=>p.ready).length;
      return new Response(JSON.stringify({ ok:true, readyCount }), { status: 200 });
    }

    if (path === "/start") {
      const { by_user } = body;
      if (String(by_user) !== String(this.room.starter_id)) {
        return new Response(JSON.stringify({ ok:false, error:"only-starter" }), { status: 403 });
      }
      if (this.room.status !== "lobby") {
        return new Response(JSON.stringify({ ok:false, error:"already-started" }), { status: 400 });
      }
      this.room.status = "running";
      this.room.qIndex = 0;
      await this.save();
      const q = this.room.questions[this.room.qIndex];
      return new Response(JSON.stringify({ ok:true, qIndex: this.room.qIndex, q }), { status: 200 });
    }

    if (path === "/answer") {
      const { user_id, qIndex, option } = body;
      if (this.room.status !== "running") {
        return new Response(JSON.stringify({ ok:false, error:"not-running" }), { status: 400 });
      }
      if (qIndex !== this.room.qIndex) {
        return new Response(JSON.stringify({ ok:false, error:"stale-question" }), { status: 409 });
      }
      const uid = String(user_id);
      if (!this.room.players[uid]) this.room.players[uid] = { name:"?", ready:true, answers: [] };
      // اگر قبلاً جواب داده بود:
      if (this.room.players[uid].answers[qIndex] != null) {
        return new Response(JSON.stringify({ ok:true, duplicate:true }), { status: 200 });
      }
      this.room.players[uid].answers[qIndex] = option;
      await this.save();
      // فعلاً فقط ثبت می‌کنیم؛ جلو رفتن خودکار را در گام بعد اضافه می‌کنیم
      const answeredCount = Object.values(this.room.players).filter(p => p.answers[qIndex] != null).length;
      const totalPlayers = Object.keys(this.room.players).length;
      return new Response(JSON.stringify({ ok:true, answeredCount, totalPlayers }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok:false, error:"bad-path" }), { status: 404 });
  }
}

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // وب‌هوک‌های تلگرام
    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!secret || secret !== env.TG_WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });

      const update = await request.json().catch(()=> ({}));
      const msg = update.message || (update.callback_query ? update.callback_query.message : null);
      const chat = msg?.chat;
      const chat_id = chat?.id;
      const chat_type = chat?.type;

      // helper برای DO
      const getRoomStub = (roomIdOrName) => {
        const id = env.ROOMS.idFromName(String(roomIdOrName));
        return env.ROOMS.get(id);
      };

      // --- فرمان‌های متنی ---
      if (update.message?.text) {
        const text = update.message.text;
        const entities = update.message.entities || [];
        const cmdEnt = entities.find(e => e.type === "bot_command" && e.offset === 0);
        const cmd = cmdEnt ? text.substring(0, cmdEnt.length).split("@")[0] : "";

        if (cmd === "/ping") {
          await tg.sendMessage(env, chat_id, "pong ✅", { reply_to_message_id: msg.message_id });
          return new Response("ok", { status: 200 });
        }

        if (cmd === "/newgame") {
          if (chat_type !== "group" && chat_type !== "supergroup") {
            await tg.sendMessage(env, chat_id, "این دستور فقط در گروه کار می‌کند.", { reply_to_message_id: msg.message_id });
            return new Response("ok", { status: 200 });
          }
          const starter = update.message.from;
          // ساخت اتاق در DO
          const nameSeed = `${chat_id}-${Date.now()}`;
          const stub = getRoomStub(nameSeed);
          const res = await stub.fetch("https://do/create", {
            method: "POST",
            body: JSON.stringify({ chat_id, starter_id: starter.id, starter_name: starter.first_name })
          });
          const { roomId } = await res.json();

          const kb = {
            inline_keyboard: [[
              { text: "✅ آماده‌ام", callback_data: `j:${roomId}` },
              { text: "🟢 آغاز بازی", callback_data: `s:${roomId}` }
            ]]
          };
          await tg.sendMessage(env, chat_id,
            `بازی جدید ساخته شد.\nشرکت‌کننده‌ها: دکمه «✅ آماده‌ام» را بزنید.\nشروع‌کننده می‌تواند «🟢 آغاز بازی» را بزند.`,
            { reply_markup: kb }
          );
          return new Response("ok", { status: 200 });
        }
      }

      // --- کال‌بک‌های دکمه‌ها ---
      if (update.callback_query) {
        const cq = update.callback_query;
        const data = cq.data || "";     // j:<roomId> | s:<roomId> | a:<roomId>:<qIndex>:<opt>
        const from = cq.from;
        const chat_id_cb = cq.message?.chat?.id;

        // نوع اکشن و آیدی اتاق
        const [act, rid, qIndexStr, optStr] = data.split(":");
        // پیدا کردن همون DO با یک اسم قطعی (chat_id + ابتدای roomId کافی‌ست)
        const stub = env.ROOMS.get(env.ROOMS.idFromName(`${chat_id_cb}-${rid}`));

        if (act === "j") { // join
          await stub.fetch("https://do/join", {
            method: "POST",
            body: JSON.stringify({ user_id: from.id, name: from.first_name })
          });
          await tg.answerCallback(env, cq.id, "ثبت شد: آماده‌ای ✅");
          await tg.sendMessage(env, chat_id_cb, `👤 ${from.first_name} آماده شد.`);
          return new Response("ok", { status: 200 });
        }

        if (act === "s") { // start
          const r = await stub.fetch("https://do/start", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id })
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(env, cq.id, out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند آغاز کند." : "خطا", true);
            return new Response("ok", { status: 200 });
          }
          const q = out.q;
          const qIdx = out.qIndex;
          const kb = {
            inline_keyboard: [[
              { text: "1", callback_data: `a:${rid}:${qIdx}:0` },
              { text: "2", callback_data: `a:${rid}:${qIdx}:1` },
              { text: "3", callback_data: `a:${rid}:${qIdx}:2` },
              { text: "4", callback_data: `a:${rid}:${qIdx}:3` },
            ]]
          };
          await tg.answerCallback(env, cq.id, "بازی شروع شد!");
          await tg.sendMessage(env, chat_id_cb, `❓ سوال ${qIdx+1}:\n${q.text}\n\nگزینه‌ها:\n1) ${q.options[0]}\n2) ${q.options[1]}\n3) ${q.options[2]}\n4) ${q.options[3]}`, { reply_markup: kb });
          return new Response("ok", { status: 200 });
        }

        if (act === "a") { // answer
          const qIndex = Number(qIndexStr);
          const opt = Number(optStr);
          const r = await stub.fetch("https://do/answer", {
            method: "POST",
            body: JSON.stringify({ user_id: from.id, qIndex, option: opt })
          });
          const out = await r.json();
          if (out.ok && out.duplicate) {
            await tg.answerCallback(env, cq.id, "قبلاً ثبت شده بود.");
          } else if (out.ok) {
            await tg.answerCallback(env, cq.id, "پاسخ ثبت شد ✅");
            await tg.sendMessage(env, chat_id_cb, `📝 پاسخ ${from.first_name} ثبت شد (${out.answeredCount}/${out.totalPlayers}).`);
          } else {
            await tg.answerCallback(env, cq.id, "خطا در ثبت پاسخ", true);
          }
          return new Response("ok", { status: 200 });
        }
      }

      return new Response("ok", { status: 200 });
    }

    // مسیرهای کمکی قبلی
    if (url.pathname === "/tg/register") {
      const webhookUrl = new URL("/webhook", request.url).toString();
      const out = await tg.send(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TG_WEBHOOK_SECRET,
        drop_pending_updates: true,
        allowed_updates: ["message","callback_query"]
      });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });
    }
    if (url.pathname === "/tg/info") {
      const out = await tg.send(env, "getWebhookInfo", {});
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });
    }
    if (url.pathname === "/") return new Response("psynex-exambot: OK", { status: 200 });
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, ts: Date.now() }), { status: 200, headers: { "content-type":"application/json; charset=UTF-8" } });
    return new Response("Not Found", { status: 404 });
  }
};
