// ===================== Telegram helpers (Worker-side) =====================
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
  now().toString(36).slice(-6) + Math.floor(Math.random() * 2176782336).toString(36).slice(-2);

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
// هر سؤال = 60 ثانیه (۱ دقیقه)
const QUESTION_DURATION_SEC = 60;

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

  // --- Telegram helpers (DO-side) ---
  tgApi(method) {
    return `https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`;
  }
  async tgSendMessage(chat_id, text, extra = {}) {
    const res = await fetch(this.tgApi("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML", ...extra }),
    });
    let data = {};
    try { data = await res.json(); } catch(_) {}
    if (!res.ok || !data.ok) {
      console.error("DO TG sendMessage error:", res.status, JSON.stringify(data));
    }
    return data;
  }

  // --- Question rendering ---
  kbForQuestion(rid, qIdx) {
    return {
      inline_keyboard: [[
        { text: "1", callback_data: `a:${rid}:${qIdx}:0` },
        { text: "2", callback_data: `a:${rid}:${qIdx}:1` },
        { text: "3", callback_data: `a:${rid}:${qIdx}:2` },
        { text: "4", callback_data: `a:${rid}:${qIdx}:3` },
      ]],
    };
  }
  textForQuestion(qIdx, q) {
    return `❓ سوال ${qIdx + 1} از ${this.room.questions.length} (⏱ ${QUESTION_DURATION_SEC}s)\n${q.text}\n\nگزینه‌ها:\n1) ${q.options[0]}\n2) ${q.options[1]}\n3) ${q.options[2]}\n4) ${q.options[3]}`;
  }

  // --- Game flow ---
  async startQuestion() {
    const r = this.room;
    const qIdx = r.qIndex;
    const q = r.questions[qIdx];

    r.qStartAtMs = now();
    r.qDeadlineMs = r.qStartAtMs + QUESTION_DURATION_SEC * 1000;
    r.answersByUser = r.answersByUser || {}; // uid -> { [qIdx]: {opt, tMs} }

    await this.save();

    // پیام سؤال
    await this.tgSendMessage(
      r.chat_id,
      this.textForQuestion(qIdx, q),
      { reply_markup: this.kbForQuestion(r.id, qIdx) }
    );

    // برنامه‌ریزی تایمر
    await this.state.storage.setAlarm(r.qDeadlineMs);
  }

  async advanceOrFinish(by="timer") {
    const r = this.room;
    const totalQ = r.questions.length;

    if (r.qIndex + 1 < totalQ) {
      r.qIndex += 1;
      await this.save();
      await this.startQuestion();
    } else {
      r.status = "ended";
      await this.save();
      await this.postSummary(by);
    }
  }

  async postSummary(endedBy) {
    const r = this.room;
    const participants = r.participants || Object.keys(r.players || {});
    const scoreRows = [];

    for (const uid of participants) {
      const p = r.players[uid];
      const answers = (r.answersByUser?.[uid]) || {};
      let correct = 0;
      let totalTime = 0;
      for (let i = 0; i < r.questions.length; i++) {
        const a = answers[i];
        if (!a) continue;
        if (r.questions[i].correct === a.opt) correct++;
        totalTime += a.tMs || 0;
      }
      scoreRows.push({ name: p?.name || uid, correct, totalTime });
    }

    scoreRows.sort((a, b) => {
      if (b.correct !== a.correct) return b.correct - a.correct;
      return a.totalTime - b.totalTime;
    });

    const lines = [];
    lines.push(`🏁 بازی تمام شد (${endedBy === "timer" ? "⏱ با پایان زمان" : "✅ با تکمیل پاسخ‌ها"})`);
    lines.push("");
    scoreRows.forEach((row, i) => {
      const secs = Math.round((row.totalTime || 0) / 1000);
      lines.push(`${i + 1}. ${row.name} — ✅ ${row.correct}/${r.questions.length} — ⏱ ${secs}s`);
    });
    lines.push("");
    lines.push("🔜 «دیدن پاسخ‌های صحیح» و مرور شخصی در پیام خصوصی در گام بعدی فعال می‌شود.");

    await this.tgSendMessage(r.chat_id, lines.join("\n"));
  }

  everyoneAnsweredCurrent() {
    const r = this.room;
    const qIdx = r.qIndex;
    const participants = r.participants || Object.keys(r.players || {});
    let answered = 0;
    for (const uid of participants) {
      if (r.answersByUser?.[uid]?.[qIdx] != null) answered++;
    }
    return { answered, total: participants.length, all: answered === participants.length };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname; // "/create" | "/join" | "/mode" | "/start" | "/answer"
    const body = await request.json().catch(() => ({}));

    if (path === "/create") {
      const { chat_id, starter_id, starter_name, room_id } = body;

      // *نمونه* بانک 10 سوال (بعداً از R2 می‌آید)
      const questionsPool = [
        { id: "Q1", text: "کدام گزینه صحیح است؟", options: ["۱","۲","۳","۴"], correct: 1 },
        { id: "Q2", text: "روان‌شناسی کدام است؟", options: ["الف","ب","ج","د"], correct: 0 },
        { id: "Q3", text: "نمونه سؤال سوم", options: ["A","B","C","D"], correct: 2 },
        { id: "Q4", text: "نمونه سؤال چهارم", options: ["I","II","III","IV"], correct: 3 },
        { id: "Q5", text: "نمونه سؤال پنجم", options: ["گزینه۱","گزینه۲","گزینه۳","گزینه۴"], correct: 0 },
        { id: "Q6", text: "نمونه سؤال ششم", options: ["opt1","opt2","opt3","opt4"], correct: 1 },
        { id: "Q7", text: "نمونه سؤال هفتم", options: ["opt1","opt2","opt3","opt4"], correct: 2 },
        { id: "Q8", text: "نمونه سؤال هشتم", options: ["opt1","opt2","opt3","opt4"], correct: 3 },
        { id: "Q9", text: "نمونه سؤال نهم", options: ["opt1","opt2","opt3","opt4"], correct: 1 },
        { id: "Q10", text: "نمونه سؤال دهم", options: ["opt1","opt2","opt3","opt4"], correct: 2 },
      ];

      this.room = {
        id: room_id,
        chat_id,
        starter_id,
        starter_name,
        status: "lobby",         // lobby | running | ended
        players: { [String(starter_id)]: { name: starter_name || "Starter", ready: true, answers: [] } },
        createdAt: now(),
        qIndex: -1,
        // فعلاً کل 10 سؤال را نگه می‌داریم؛ با انتخاب حالت، برش می‌زنیم
        questions: questionsPool,
        participants: null,
        qStartAtMs: null,
        qDeadlineMs: null,
        answersByUser: {},       // uid -> { [qIndex]: {opt, tMs} }
        modeCount: null,         // 5 یا 10
      };
      await this.save();
      return new Response(JSON.stringify({ ok: true, roomId: this.room.id }), { status: 200 });
    }

    await this.load();
    if (!this.room) {
      return new Response(JSON.stringify({ ok: false, error: "no-room" }), { status: 404 });
    }

    if (path === "/join") {
      if (this.room.status !== "lobby") {
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });
      }
      const { user_id, name } = body;
      const uid = String(user_id);
      if (!this.room.players[uid]) this.room.players[uid] = { name, ready: true, answers: [] };
      else this.room.players[uid].ready = true;
      await this.save();
      const readyCount = Object.values(this.room.players).filter((p) => p.ready).length;
      return new Response(JSON.stringify({ ok: true, readyCount }), { status: 200 });
    }

    if (path === "/mode") {
      // فقط شروع‌کننده می‌تواند تنظیم کند
      const { by_user, count } = body; // 5 یا 10
      if (String(by_user) !== String(this.room.starter_id)) {
        return new Response(JSON.stringify({ ok: false, error: "only-starter" }), { status: 403 });
      }
      if (this.room.status !== "lobby") {
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });
      }
      const n = Number(count);
      if (![5, 10].includes(n)) {
        return new Response(JSON.stringify({ ok: false, error: "invalid-mode" }), { status: 400 });
      }
      // برش سوالات
      this.room.questions = this.room.questions.slice(0, n);
      this.room.modeCount = n;
      await this.save();
      return new Response(JSON.stringify({ ok: true, modeCount: n }), { status: 200 });
    }

    if (path === "/start") {
      const { by_user } = body;
      if (String(by_user) !== String(this.room.starter_id)) {
        return new Response(JSON.stringify({ ok: false, error: "only-starter" }), { status: 403 });
      }
      if (this.room.status !== "lobby") {
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });
      }
      if (!this.room.modeCount) {
        return new Response(JSON.stringify({ ok: false, error: "mode-not-set" }), { status: 400 });
      }

      const participants = Object.entries(this.room.players)
        .filter(([, p]) => p.ready)
        .map(([uid]) => uid);

      if (participants.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "no-participants" }), { status: 400 });
      }

      this.room.participants = participants;
      this.room.status = "running";
      this.room.qIndex = 0;
      await this.save();

      await this.startQuestion();

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (path === "/answer") {
      if (this.room.status !== "running") {
        return new Response(JSON.stringify({ ok: false, error: "not-running" }), { status: 400 });
      }
      const { user_id, qIndex, option } = body;
      const uid = String(user_id);

      if (!this.room.participants || !this.room.participants.includes(uid)) {
        return new Response(JSON.stringify({ ok: false, error: "not-in-participants" }), { status: 403 });
      }
      if (qIndex !== this.room.qIndex) {
        return new Response(JSON.stringify({ ok: false, error: "stale-question" }), { status: 409 });
      }

      const userAns = (this.room.answersByUser[uid] = this.room.answersByUser[uid] || {});
      if (userAns[qIndex] != null) {
        return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 });
      }
      const tMs = Math.max(0, now() - (this.room.qStartAtMs || now()));
      userAns[qIndex] = { opt: option, tMs };
      await this.save();

      const { answered, total, all } = this.everyoneAnsweredCurrent();
      await this.tgSendMessage(this.room.chat_id, `📝 پاسخ ثبت شد (${answered}/${total})`);

      if (all) {
        if (now() < (this.room.qDeadlineMs || 0)) {
          this.room.qDeadlineMs = now();
          await this.save();
        }
        await this.advanceOrFinish("all-answered");
      }

      return new Response(JSON.stringify({ ok: true, answeredCount: answered, totalPlayers: total }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: false, error: "bad-path" }), { status: 404 });
  }

  // --- Alarm handler: پایان زمان هر سؤال ---
  async alarm() {
    await this.load();
    if (!this.room || this.room.status !== "running") return;

    const due = this.room.qDeadlineMs || 0;
    if (now() < due - 5) return;

    await this.tgSendMessage(this.room.chat_id, "⏱ زمان این سؤال تمام شد.");
    await this.advanceOrFinish("timer");
  }
}

// ===================== Worker (Webhook) =====================
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
      const getStubByKey = (key) => env.ROOMS.get(env.ROOMS.idFromName(key));

      // پیام‌های متنی (Commands)
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
          const roomId = shortId();
          const nameKey = `${chat_id}-${roomId}`;
          const stub = getStubByKey(nameKey);

          // ساخت اتاق
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
            inline_keyboard: [
              [
                { text: "۵ سواله (۱ دقیقه‌ای)", callback_data: `m:${rid}:5` },
                { text: "۱۰ سواله (۱ دقیقه‌ای)", callback_data: `m:${rid}:10` },
              ],
              [
                { text: "✅ آماده‌ام", callback_data: `j:${rid}` },
                { text: "🟢 آغاز بازی", callback_data: `s:${rid}` },
              ],
            ],
          };

          await tg.sendMessage(
            env,
            chat_id,
            "🎮 بازی جدید ساخته شد.\nحالت را انتخاب کنید (۵ یا ۱۰ سوال، هر سؤال ۱ دقیقه)؛ شرکت‌کننده‌ها «✅ آماده‌ام» را بزنند؛ شروع‌کننده «🟢 آغاز بازی» را بزند.",
            { reply_markup: kb }
          );

          return new Response("ok", { status: 200 });
        }
      }

      // دکمه‌های Inline
      if (update.callback_query) {
        const cq = update.callback_query;
        const msg = cq.message || {};
        const chat_id = msg.chat?.id;
        const from = cq.from;
        const parts = (cq.data || "").split(":"); // m:<rid>:<5|10> | j:<rid> | s:<rid> | a:<rid>:<qIndex>:<opt>
        const act = parts[0];
        const rid = parts[1];
        const key = `${chat_id}-${rid}`;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(key));

        if (act === "m") {
          const count = Number(parts[2] || 0);
          const r = await stub.fetch("https://do/mode", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id, count }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(
              env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند حالت را انتخاب کند." :
              out.error === "invalid-mode" ? "حالت نامعتبر است." :
              out.error === "already-started" ? "بازی شروع شده." : "خطا",
              true
            );
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, `حالت ${out.modeCount} سواله تنظیم شد.`);
          await tg.sendMessage(env, chat_id, `⚙️ حالت بازی روی ${out.modeCount} سوال تنظیم شد.`);
          return new Response("ok", { status: 200 });
        }

        if (act === "j") {
          const r = await stub.fetch("https://do/join", {
            method: "POST",
            body: JSON.stringify({ user_id: from.id, name: from.first_name }),
          });
          const out = await r.json();
          await tg.answerCallback(env, cq.id, "ثبت شد: آماده‌ای ✅");
          await tg.sendMessage(env, chat_id, `👤 ${from.first_name} آماده شد. (کل آماده‌ها: ${out.readyCount})`);
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
              env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند آغاز کند." :
              out.error === "already-started" ? "بازی قبلاً شروع شده." :
              out.error === "mode-not-set" ? "اول حالت (۵ یا ۱۰ سوال) را انتخاب کنید." :
              out.error === "no-participants" ? "هیچ شرکت‌کننده‌ای آماده نیست." : "خطا",
              true
            );
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "بازی شروع شد! ⏱");
          // سؤال‌ها را خودِ DO ارسال و مدیریت می‌کند
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
