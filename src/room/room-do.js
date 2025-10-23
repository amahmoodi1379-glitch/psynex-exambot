import { now, encChatId } from "../utils.js";

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
  async save() { await this.state.storage.put("room", this.room); }

  // --- Telegram helpers (داخل DO) ---
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

    await this.tgSendMessage(r.chat_id, this.textForQuestion(qIdx, q), {
      reply_markup: this.kbForQuestion(r.id, qIdx)
    });

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
    const r = await this.load();
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

    // Deep link برای PV: هر شرکت‌کننده خودش را خواهد دید
    if (this.env.BOT_USERNAME) {
      const chatKey = encChatId(r.chat_id);
      const payload = `rv:${chatKey}:${r.id}`;
      const link = `https://t.me/${this.env.BOT_USERNAME}?start=${encodeURIComponent(payload)}`;
      lines.push(`برای مرور پاسخ‌های خود در پیام خصوصی روی لینک زیر بزنید:`);
      lines.push(`<a href="${link}">📥 مرور پاسخ‌ها</a>`);
    } else {
      lines.push("ℹ️ مرور پاسخ‌ها بعداً فعال می‌شود (BOT_USERNAME تنظیم نشده).");
    }

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

  reviewForUser(userId) {
    const r = this.room;
    if (!r || r.status !== "ended") return { ok: false, error: "not-ended" };
    if (!r.participants || !r.participants.includes(String(userId))) {
      return { ok: false, error: "not-participant" };
    }
    const answers = r.answersByUser?.[String(userId)] || {};
    let correct = 0;
    const parts = [];
    parts.push(`📄 مرور پاسخ‌ها (${r.questions.length} سؤال)`);
    parts.push("");

    for (let i = 0; i < r.questions.length; i++) {
      const q = r.questions[i];
      const a = answers[i];
      const isCorrect = a && q.correct === a.opt;
      if (isCorrect) correct++;
      const timeSec = a ? Math.round((a.tMs || 0) / 1000) : null;
      const you = a != null ? (a.opt + 1) : "—";
      const ans = q.correct + 1;
      const mark = isCorrect ? "✅" : (a == null ? "⏳" : "❌");
      parts.push(`${i + 1}) ${mark} پاسخ شما: ${you} — پاسخ صحیح: ${ans}${timeSec != null ? ` — ⏱ ${timeSec}s` : ""}`);
    }
    parts.push("");
    parts.push(`نتیجه: ${correct}/${r.questions.length}`);

    return { ok: true, text: parts.join("\n") };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname; // "/create" | "/join" | "/mode" | "/start" | "/answer" | "/review"
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
        status: "lobby", // lobby | running | ended
        players: { [String(starter_id)]: { name: starter_name || "Starter", ready: true, answers: [] } },
        createdAt: now(),
        qIndex: -1,
        questions: questionsPool, // بعداً با mode برش می‌زنیم
        participants: null,
        qStartAtMs: null,
        qDeadlineMs: null,
        answersByUser: {}, // uid -> { [qIndex]: {opt, tMs} }
        modeCount: null,   // 5 یا 10
      };
      await this.save();
      return new Response(JSON.stringify({ ok: true, roomId: this.room.id }), { status: 200 });
    }

    await this.load();
    if (!this.room) return new Response(JSON.stringify({ ok: false, error: "no-room" }), { status: 404 });

    if (path === "/join") {
      if (this.room.status !== "lobby")
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });

      const { user_id, name } = body;
      const uid = String(user_id);
      if (!this.room.players[uid]) this.room.players[uid] = { name, ready: true, answers: [] };
      else this.room.players[uid].ready = true;
      await this.save();
      const readyCount = Object.values(this.room.players).filter((p) => p.ready).length;
      return new Response(JSON.stringify({ ok: true, readyCount }), { status: 200 });
    }

    if (path === "/mode") {
      const { by_user, count } = body; // 5 یا 10
      if (String(by_user) !== String(this.room.starter_id))
        return new Response(JSON.stringify({ ok: false, error: "only-starter" }), { status: 403 });
      if (this.room.status !== "lobby")
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });

      const n = Number(count);
      if (![5, 10].includes(n))
        return new Response(JSON.stringify({ ok: false, error: "invalid-mode" }), { status: 400 });

      this.room.questions = this.room.questions.slice(0, n);
      this.room.modeCount = n;
      await this.save();
      return new Response(JSON.stringify({ ok: true, modeCount: n }), { status: 200 });
    }

    if (path === "/start") {
      const { by_user } = body;
      if (String(by_user) !== String(this.room.starter_id))
        return new Response(JSON.stringify({ ok: false, error: "only-starter" }), { status: 403 });
      if (this.room.status !== "lobby")
        return new Response(JSON.stringify({ ok: false, error: "already-started" }), { status: 400 });
      if (!this.room.modeCount)
        return new Response(JSON.stringify({ ok: false, error: "mode-not-set" }), { status: 400 });

      const participants = Object.entries(this.room.players).filter(([, p]) => p.ready).map(([uid]) => uid);
      if (participants.length === 0)
        return new Response(JSON.stringify({ ok: false, error: "no-participants" }), { status: 400 });

      this.room.participants = participants;
      this.room.status = "running";
      this.room.qIndex = 0;
      await this.save();
      await this.startQuestion();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (path === "/answer") {
      if (this.room.status !== "running")
        return new Response(JSON.stringify({ ok: false, error: "not-running" }), { status: 400 });

      const { user_id, qIndex, option } = body;
      const uid = String(user_id);
      if (!this.room.participants || !this.room.participants.includes(uid))
        return new Response(JSON.stringify({ ok: false, error: "not-in-participants" }), { status: 403 });
      if (qIndex !== this.room.qIndex)
        return new Response(JSON.stringify({ ok: false, error: "stale-question" }), { status: 409 });

      const userAns = (this.room.answersByUser[uid] = this.room.answersByUser[uid] || {});
      if (userAns[qIndex] != null)
        return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 });

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

    if (path === "/review") {
      const { user_id } = body;
      const rep = this.reviewForUser(user_id);
      return new Response(JSON.stringify(rep), { status: 200 });
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
