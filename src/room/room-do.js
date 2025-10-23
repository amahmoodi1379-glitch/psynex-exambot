// RoomDO: منطق بازی داخل Durable Object
// - انتخاب course/template/mode
// - شروع بازی و پخش سوال‌ها در گروه
// - تایمر هر سوال 60 ثانیه با alarms
// - ثبت پاسخ‌ها و امتیازدهی و لیدربورد

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  // ====== Utilities ======
  async load() {
    return (await this.storage.get("data")) || null;
  }
  async save(data) {
    await this.storage.put("data", data);
    return data;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  now() {
    return Date.now();
  }

  // Telegram helpers (ساده و لوکال)
  tgApi(method) {
    return `https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`;
  }
  async tgCall(method, payload) {
    const res = await fetch(this.tgApi(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    let j = {};
    try { j = await res.json(); } catch {}
    if (!j.ok) {
      console.error("TG error", method, res.status, JSON.stringify(j));
    }
    return j;
  }
  sendMessage(chat_id, text, extra = {}) {
    return this.tgCall("sendMessage", {
      chat_id, text, parse_mode: "HTML", ...extra,
    });
  }
  editMarkup(chat_id, message_id, reply_markup = null) {
    return this.tgCall("editMessageReplyMarkup", {
      chat_id, message_id, reply_markup,
    });
  }

  // ====== R2: load question sets ======
  async listR2(prefix) {
    const out = await this.env.QUESTIONS.list({ prefix, limit: 1000 });
    return out?.objects || [];
  }
  async getR2Text(key) {
    const obj = await this.env.QUESTIONS.get(key);
    if (!obj) return null;
    return await obj.text();
  }

  async pickRandomSet(courseId, template) {
    const prefix = `sets/${courseId}/${template}/`;
    const files = await this.listR2(prefix);
    if (!files.length) return null;
    const f = files[Math.floor(Math.random() * files.length)];
    const txt = await this.getR2Text(f.key);
    if (!txt) return null;
    let payload = {};
    try { payload = JSON.parse(txt); } catch { return null; }
    if (!Array.isArray(payload.questions)) return null;
    return payload.questions;
  }

  async loadQuestions(courseId, template, count) {
    if (template === "mix") {
      // نصف از کنکوری، نصف از تألیفی (اگر کم بود، از نوع موجود جبران)
      const half = Math.floor(count / 2);
      const rem = count - half;
      const kk = await this.pickRandomSet(courseId, "konkoori") || [];
      const tt = await this.pickRandomSet(courseId, "taalifi") || [];
      let pool = [];
      this.shuffle(kk); this.shuffle(tt);
      pool = kk.slice(0, half).concat(tt.slice(0, rem));
      if (pool.length < count) {
        // جبران از هر چه موجود است
        const extra = kk.concat(tt);
        this.shuffle(extra);
        for (const q of extra) {
          if (pool.length >= count) break;
          if (!pool.includes(q)) pool.push(q);
        }
      }
      if (pool.length < count) return null;
      return this.shuffle(pool).slice(0, count);
    } else {
      const qs = await this.pickRandomSet(courseId, template);
      if (!qs || !qs.length) return null;
      this.shuffle(qs);
      if (qs.length < count) {
        // اگر ست کم بود ولی حداقل ۵ تا داشت، همان مقدار را برمی‌داریم
        if (qs.length >= 5) return qs.slice(0, Math.min(qs.length, count));
        return null;
      }
      return qs.slice(0, count);
    }
  }

  // ====== Game flow ======
  async create({ chat_id, starter_id, starter_name, room_id }) {
    const data = {
      chat_id,
      room_id,
      starter_id,
      starter_name,
      participants: {}, // user_id -> { name, ready, answers[], score, timeMs }
      modeCount: null,
      courseId: null,
      template: null, // "konkoori" | "taalifi" | "mix"
      started: false,
      currentIndex: -1,
      questionDeadline: 0,
      questionMessageId: null,
      questions: [], // normalized: {id, text, options[4], correct, explanation?}
      resultsPosted: false,
    };
    await this.save(data);
    return { ok: true, roomId: room_id };
  }

  async setMode(by_user, count) {
    const data = await this.load();
    if (!data) return { ok: false, error: "no-room" };
    if (data.started) return { ok: false, error: "already-started" };
    if (by_user !== data.starter_id) return { ok: false, error: "only-starter" };
    if (![5, 10].includes(Number(count))) return { ok: false, error: "invalid-mode" };
    data.modeCount = Number(count);
    await this.save(data);
    return { ok: true, modeCount: data.modeCount };
  }

  async setCourse(by_user, courseId) {
    const data = await this.load();
    if (!data) return { ok: false, error: "no-room" };
    if (data.started) return { ok: false, error: "already-started" };
    if (by_user !== data.starter_id) return { ok: false, error: "only-starter" };
    if (!courseId) return { ok: false, error: "invalid-course" };
    data.courseId = String(courseId);
    await this.save(data);
    return { ok: true, courseId: data.courseId };
  }

  async setTemplate(by_user, template) {
    const data = await this.load();
    if (!data) return { ok: false, error: "no-room" };
    if (data.started) return { ok: false, error: "already-started" };
    if (by_user !== data.starter_id) return { ok: false, error: "only-starter" };
    if (!["konkoori", "taalifi", "mix"].includes(template)) return { ok: false, error: "invalid-template" };
    data.template = template;
    await this.save(data);
    return { ok: true, template: data.template };
  }

  async join({ user_id, name }) {
    const data = await this.load();
    if (!data) return { ok: false };
    if (!data.participants[user_id]) {
      data.participants[user_id] = { name, ready: true, answers: [], score: 0, timeMs: 0 };
    } else {
      data.participants[user_id].ready = true;
      if (name) data.participants[user_id].name = name;
    }
    await this.save(data);
    const readyCount = Object.values(data.participants).filter(p => p.ready).length;
    return { ok: true, readyCount };
  }

  async start(by_user) {
    const data = await this.load();
    if (!data) return { ok: false, error: "no-room" };
    if (by_user !== data.starter_id) return { ok: false, error: "only-starter" };
    if (data.started) return { ok: false, error: "already-started" };
    if (!data.modeCount) return { ok: false, error: "mode-not-set" };
    if (!data.courseId) return { ok: false, error: "course-not-set" };
    if (!data.template) return { ok: false, error: "template-not-set" };
    const ready = Object.entries(data.participants).filter(([_, p]) => p.ready);
    if (ready.length === 0) return { ok: false, error: "no-participants" };

    // Load questions from R2
    const qs = await this.loadQuestions(data.courseId, data.template, data.modeCount);
    if (!qs || !qs.length) {
      await this.sendMessage(data.chat_id, "❌ بانک سؤال کافی یافت نشد. لطفاً برای این درس/قالب ست سؤالات بیشتری در R2 آپلود کنید.");
      return { ok: false, error: "no-questions" };
    }

    // Normalize questions
    data.questions = qs.map((q, idx) => ({
      id: q.id || `Q${idx + 1}`,
      text: String(q.text || ""),
      options: Array.isArray(q.options) ? q.options.slice(0,4).map(String) : ["1","2","3","4"],
      correct: Number.isInteger(q.correct) ? q.correct : 0,
      explanation: q.explanation ? String(q.explanation) : undefined,
    }));
    data.started = true;
    data.currentIndex = -1;
    await this.save(data);

    await this.sendMessage(data.chat_id, `🚀 بازی شروع شد!\nدرس: <b>${data.courseId}</b> • قالب: <b>${data.template}</b> • تعداد: <b>${data.modeCount}</b>\n⏱ هر سؤال ۶۰ ثانیه.`);
    await this.nextQuestion();
    return { ok: true };
  }

  async nextQuestion() {
    const data = await this.load();
    if (!data || !data.started) return;

    // بستن دکمه‌های سوال قبلی (اگر وجود دارد)
    if (data.questionMessageId) {
      await this.editMarkup(data.chat_id, data.questionMessageId, { inline_keyboard: [] });
    }

    data.currentIndex += 1;

    if (data.currentIndex >= data.questions.length) {
      // بازی تمام
      await this.finishGame();
      return;
    }

    const q = data.questions[data.currentIndex];
    const n = data.currentIndex + 1;
    const total = data.questions.length;
    const text = [
      `❓ <b>سؤال ${n}/${total}</b>`,
      "",
      q.text,
      "",
      `۱) ${q.options[0]}`,
      `۲) ${q.options[1]}`,
      `۳) ${q.options[2]}`,
      `۴) ${q.options[3]}`
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [
          { text: "۱", callback_data: `a:${data.room_id}:${data.currentIndex}:0` },
          { text: "۲", callback_data: `a:${data.room_id}:${data.currentIndex}:1` },
          { text: "۳", callback_data: `a:${data.room_id}:${data.currentIndex}:2` },
          { text: "۴", callback_data: `a:${data.room_id}:${data.currentIndex}:3` },
        ]
      ]
    };

    const sent = await this.sendMessage(data.chat_id, text, { reply_markup: kb });
    const mid = sent?.result?.message_id || null;
    const deadline = this.now() + 60 * 1000; // 60s per question
    data.questionMessageId = mid;
    data.questionDeadline = deadline;

    // برای اندازه‌گیری سرعت پاسخ: timestamp شروع سؤال
    data.qStartTs = this.now();
    await this.save(data);

    // آلارم برای رفتن به سؤال بعدی
    await this.state.storage.setAlarm(new Date(deadline));
  }

  async finishGame() {
    const data = await this.load();
    if (!data || data.resultsPosted) return;

    // امتیاز: 1 امتیاز برای هر پاسخ صحیح + پاداش سرعت نسبی (ساده)
    // (الان به سادگی فقط تعداد صحیح را می‌گیریم؛ می‌توانیم بعداً فرمول دقیق‌تر بگذاریم)
    const players = Object.entries(data.participants).map(([uid, p]) => {
      const answers = p.answers || [];
      let correct = 0;
      for (const a of answers) if (a && a.ok) correct++;
      return {
        uid,
        name: p.name || ("User"+uid),
        correct,
        timeMs: p.timeMs || 0
      };
    });

    players.sort((a, b) => {
      if (b.correct !== a.correct) return b.correct - a.correct;
      return a.timeMs - b.timeMs; // سریع‌تر بالاتر
    });

    const lines = ["🏁 نتایج نهایی:"];
    players.forEach((pl, i) => {
      const sec = Math.round((pl.timeMs || 0) / 1000);
      lines.push(`${i+1}. ${pl.name} — ✅ ${pl.correct} | ⏱ ${sec}s`);
    });

    await this.sendMessage(data.chat_id, lines.join("\n"));
    data.resultsPosted = true;
    await this.save(data);
  }

  async recordAnswer({ user_id, qIndex, option }) {
    const data = await this.load();
    if (!data || !data.started) return { ok: false, error: "not-started" };
    if (qIndex !== data.currentIndex) return { ok: false, error: "out-of-window" };

    // deadline check
    if (this.now() > data.questionDeadline) {
      return { ok: false, error: "too-late" };
    }

    const p = (data.participants[user_id] ||= { name: "User"+user_id, ready: false, answers: [], score: 0, timeMs: 0 });

    // duplicate check
    if (p.answers[qIndex]) return { ok: true, duplicate: true };

    const q = data.questions[qIndex];
    const ok = Number(option) === Number(q.correct);

    // زمان پاسخ برای سرعت
    const elapsed = Math.max(0, this.now() - (data.qStartTs || this.now()));
    p.timeMs = (p.timeMs || 0) + elapsed;
    p.answers[qIndex] = { option: Number(option), ok, ms: elapsed };

    await this.save(data);
    return { ok: true, duplicate: false };
  }

  // Alarm → رفتن به سؤال بعدی
  async alarm() {
    await this.nextQuestion();
  }

  // ====== Router ======
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/create" && request.method === "POST") {
      const body = await request.json();
      const out = await this.create(body);
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/mode" && request.method === "POST") {
      const { by_user, count } = await request.json();
      const out = await this.setMode(by_user, Number(count));
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/course" && request.method === "POST") {
      const { by_user, courseId } = await request.json();
      const out = await this.setCourse(by_user, courseId);
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/template" && request.method === "POST") {
      const { by_user, template } = await request.json();
      const out = await this.setTemplate(by_user, template);
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/join" && request.method === "POST") {
      const out = await this.join(await request.json());
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/start" && request.method === "POST") {
      const { by_user } = await request.json();
      const out = await this.start(by_user);
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/answer" && request.method === "POST") {
      const { user_id, qIndex, option } = await request.json();
      const out = await this.recordAnswer({ user_id, qIndex: Number(qIndex), option: Number(option) });
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (path === "/review" && request.method === "POST") {
      // (فعلاً ساده: می‌تونیم بعداً مرور تشریحی را اضافه کنیم)
      return new Response(JSON.stringify({ ok: false, error: "not-implemented" }), { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
}
