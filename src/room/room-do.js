// RoomDO: منطق بازی داخل Durable Object

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  // ====== Utilities ======
  async load() { return (await this.storage.get("data")) || null; }
  async save(data) { await this.storage.put("data", data); return data; }
  shuffle(arr) { for (let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} return arr; }
  now() { return Date.now(); }

  // Telegram helpers
  tgApi(method) { return `https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`; }
  async tgCall(method, payload) {
    const res = await fetch(this.tgApi(method), { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
    let j = {}; try { j = await res.json(); } catch {}
    if (!j.ok) console.error("TG error", method, res.status, JSON.stringify(j));
    return j;
  }
  sendMessage(chat_id, text, extra = {}) {
    return this.tgCall("sendMessage", { chat_id, text, parse_mode:"HTML", ...extra });
  }
  editMarkup(chat_id, message_id, reply_markup = null) {
    return this.tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
  }
  async getBotUsername() {
    if (this._me && this._meUsername) return this._meUsername;
    const me = await this.tgCall("getMe", {});
    this._me = me;
    this._meUsername = me?.result?.username || "";
    return this._meUsername;
  }

  // ====== R2: load question sets ======
  async listR2(prefix) { const out = await this.env.QUESTIONS.list({ prefix, limit:1000 }); return out?.objects || []; }
  async getR2Text(key) { const obj = await this.env.QUESTIONS.get(key); if (!obj) return null; return await obj.text(); }

  async pickRandomSet(courseId, template) {
    const prefix = `sets/${courseId}/${template}/`;
    const files = await this.listR2(prefix);
    if (!files.length) return null;
    const f = files[Math.floor(Math.random() * files.length)];
    const txt = await this.getR2Text(f.key);
    if (!txt) return null;
    let payload = {}; try { payload = JSON.parse(txt); } catch { return null; }
    if (!Array.isArray(payload.questions)) return null;
    return payload.questions;
  }

  async loadQuestions(courseId, template, count) {
    if (template === "mix") {
      const half = Math.floor(count/2), rem = count - half;
      const kk = await this.pickRandomSet(courseId, "konkoori") || [];
      const tt = await this.pickRandomSet(courseId, "taalifi") || [];
      this.shuffle(kk); this.shuffle(tt);
      let pool = kk.slice(0, half).concat(tt.slice(0, rem));
      if (pool.length < count) {
        const extra = kk.concat(tt); this.shuffle(extra);
        for (const q of extra) { if (pool.length >= count) break; if (!pool.includes(q)) pool.push(q); }
      }
      if (pool.length < count) return null;
      return this.shuffle(pool).slice(0, count);
    } else {
      const qs = await this.pickRandomSet(courseId, template);
      if (!qs || !qs.length) return null;
      this.shuffle(qs);
      if (qs.length < count) { if (qs.length >= 5) return qs.slice(0, Math.min(qs.length, count)); return null; }
      return qs.slice(0, count);
    }
  }

  // ====== Game flow ======
  async create({ chat_id, starter_id, starter_name, room_id }) {
    const data = {
      chat_id, room_id, starter_id, starter_name,
      participants: {}, // user_id -> { name, ready, answers[], timeMs }
      allowedUsers: null, // فریز بعد از start
      modeCount: null,
      courseId: null,
      template: null, // konkoori | taalifi | mix (فقط در بازی)
      started: false,
      currentIndex: -1,
      questionDeadline: 0,
      questionMessageId: null,
      qStartTs: 0,
      questions: [], // {id,text,options[4],correct,explanation?}
      resultsPosted: false,
    };
    await this.save(data);
    return { ok: true, roomId: room_id };
  }

  async setMode(by_user, count) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started) return { ok:false, error:"already-started" };
    if (by_user !== data.starter_id) return { ok:false, error:"only-starter" };
    if (![5,10].includes(Number(count))) return { ok:false, error:"invalid-mode" };
    data.modeCount = Number(count);
    await this.save(data);
    return { ok:true, modeCount:data.modeCount };
  }

  async setCourse(by_user, courseId) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started) return { ok:false, error:"already-started" };
    if (by_user !== data.starter_id) return { ok:false, error:"only-starter" };
    if (!courseId) return { ok:false, error:"invalid-course" };
    data.courseId = String(courseId);
    await this.save(data);
    return { ok:true, courseId:data.courseId };
  }

  async setTemplate(by_user, template) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started) return { ok:false, error:"already-started" };
    if (by_user !== data.starter_id) return { ok:false, error:"only-starter" };
    if (!["konkoori","taalifi","mix"].includes(template)) return { ok:false, error:"invalid-template" };
    data.template = template;
    await this.save(data);
    return { ok:true, template:data.template };
  }

  async join({ user_id, name }) {
    const data = await this.load();
    if (!data) return { ok:false };
    if (!data.participants[user_id]) {
      data.participants[user_id] = { name, ready:true, answers:[], timeMs:0 };
    } else {
      data.participants[user_id].ready = true;
      if (name) data.participants[user_id].name = name;
    }
    await this.save(data);
    const readyCount = Object.values(data.participants).filter(p => p.ready).length;
    return { ok:true, readyCount };
  }

  async start(by_user) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (by_user !== data.starter_id) return { ok:false, error:"only-starter" };
    if (data.started) return { ok:false, error:"already-started" };
    if (!data.modeCount) return { ok:false, error:"mode-not-set" };
    if (!data.courseId) return { ok:false, error:"course-not-set" };
    if (!data.template) return { ok:false, error:"template-not-set" };

    const readyEntries = Object.entries(data.participants).filter(([_, p]) => p.ready);
    if (!readyEntries.length) return { ok:false, error:"no-participants" };

    // Freeze roster
    data.allowedUsers = readyEntries.map(([uid]) => String(uid));

    const qs = await this.loadQuestions(data.courseId, data.template, data.modeCount);
    if (!qs || !qs.length) {
      await this.sendMessage(data.chat_id, "❌ بانک سؤال کافی یافت نشد. برای این درس/قالب ست بیشتری در R2 آپلود کنید.");
      return { ok:false, error:"no-questions" };
    }

    data.questions = qs.map((q, idx) => ({
      id: q.id || `Q${idx+1}`,
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
    return { ok:true };
  }

  async nextQuestion() {
    const data = await this.load();
    if (!data || !data.started) return;

    // بستن کیبورد سؤال قبلی
    if (data.questionMessageId) {
      await this.editMarkup(data.chat_id, data.questionMessageId, { inline_keyboard: [] });
    }

    data.currentIndex += 1;

    if (data.currentIndex >= data.questions.length) {
      await this.finishGame();
      return;
    }

    const q = data.questions[data.currentIndex];
    const n = data.currentIndex + 1, total = data.questions.length;
    const text = [
      `❓ <b>سؤال ${n}/${total}</b>`, "",
      q.text, "",
      `۱) ${q.options[0]}`,
      `۲) ${q.options[1]}`,
      `۳) ${q.options[2]}`,
      `۴) ${q.options[3]}`
    ].join("\n");

    const kb = { inline_keyboard: [[
      { text:"۱", callback_data:`a:${data.room_id}:${data.currentIndex}:0` },
      { text:"۲", callback_data:`a:${data.room_id}:${data.currentIndex}:1` },
      { text:"۳", callback_data:`a:${data.room_id}:${data.currentIndex}:2` },
      { text:"۴", callback_data:`a:${data.room_id}:${data.currentIndex}:3` },
    ]]};

    const sent = await this.sendMessage(data.chat_id, text, { reply_markup: kb });
    const mid = sent?.result?.message_id || null;
    const deadline = this.now() + 60*1000;

    data.questionMessageId = mid;
    data.questionDeadline = deadline;
    data.qStartTs = this.now();
    await this.save(data);

    await this.state.storage.setAlarm(new Date(deadline));
  }

  async finishGame() {
    const data = await this.load();
    if (!data || data.resultsPosted) return;

    // امتیاز: فقط تعداد صحیح + تقدم زمان
    const players = Object.entries(data.participants).map(([uid, p]) => {
      const answers = p.answers || [];
      let correct = 0; for (const a of answers) if (a && a.ok) correct++;
      return { uid, name: p.name || ("User"+uid), correct, timeMs: p.timeMs || 0 };
    });
    players.sort((a,b)=> (b.correct-a.correct) || (a.timeMs-b.timeMs) );

    const lines = ["🏁 نتایج نهایی:"];
    players.forEach((pl, i) => {
      const sec = Math.round((pl.timeMs||0)/1000);
      lines.push(`${i+1}. ${pl.name} — ✅ ${pl.correct} | ⏱ ${sec}s`);
    });

    // لینک مرور پاسخ‌ها در PV
    const username = await this.getBotUsername();
    const encChat = this.b64url(String(data.chat_id));
    const reviewLink = username ? `https://t.me/${username}?start=rv:${encChat}:${data.room_id}` : "";

    if (reviewLink) lines.push(`\n🔍 <b>مرور پاسخ‌ها (خصوصی):</b>\n${reviewLink}`);

    await this.sendMessage(data.chat_id, lines.join("\n"));
    data.resultsPosted = true;
    await this.save(data);
  }

  b64url(s) {
    const b = btoa(s);
    return b.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  ub64url(s) {
    s = s.replace(/-/g,"+").replace(/_/g,"/"); while (s.length%4) s += "="; return atob(s);
  }

  async recordAnswer({ user_id, qIndex, option }) {
    const data = await this.load();
    if (!data || !data.started) return { ok:false, error:"not-started" };
    if (qIndex !== data.currentIndex) return { ok:false, error:"out-of-window" };
    if (this.now() > data.questionDeadline) return { ok:false, error:"too-late" };

    // ضدتقلب: فقط کاربران فریز‌شده
    const allow = (data.allowedUsers || []).includes(String(user_id));
    if (!allow) return { ok:false, error:"not-allowed" };

    const p = (data.participants[user_id] ||= { name: "User"+user_id, ready:false, answers:[], timeMs:0 });

    // جلوگیری از پاسخ تکراری
    if (p.answers[qIndex]) return { ok:true, duplicate:true };

    const q = data.questions[qIndex];
    const ok = Number(option) === Number(q.correct);

    const elapsed = Math.max(0, this.now() - (data.qStartTs || this.now()));
    p.timeMs = (p.timeMs || 0) + elapsed;
    p.answers[qIndex] = { option: Number(option), ok, ms: elapsed };

    await this.save(data);

    const allAnswered = Array.isArray(data.allowedUsers)
      && data.allowedUsers.every(uid => {
        const participant = data.participants[uid];
        return participant?.answers?.[qIndex];
      });

    if (allAnswered) {
      await this.nextQuestion();
    }

    return { ok:true, duplicate:false };
  }

  async buildReviewText(user_id) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (!data.resultsPosted) return { ok:false, error:"not-ended" };

    const p = data.participants[user_id];
    if (!p) return { ok:false, error:"not-participant" };

    const lines = [`🧾 مرور پاسخ‌های شما — اتاق ${data.room_id}`, ""];
    data.questions.forEach((q, i) => {
      const a = p.answers[i];
      const num = i+1;
      if (!a) {
        lines.push(`سؤال ${num}: ⏳ بدون پاسخ`);
        return;
      }
      const ok = a.ok ? "✅ درست" : "❌ غلط";
      const your = (a.option+1);
      const corr = (q.correct+1);
      lines.push(`سؤال ${num}: ${ok} — شما: ${your} • درست: ${corr}`);
      if (q.explanation) lines.push(`➕ توضیح: ${q.explanation}`);
    });
    return { ok:true, text: lines.join("\n") };
  }

  // Alarm → سوال بعدی
  async alarm() { await this.nextQuestion(); }

  // ====== Router ======
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/create" && request.method === "POST") {
      const body = await request.json(); const out = await this.create(body);
      return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/mode" && request.method === "POST") {
      const { by_user, count } = await request.json(); const out = await this.setMode(by_user, Number(count));
      return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/course" && request.method === "POST") {
      const { by_user, courseId } = await request.json(); const out = await this.setCourse(by_user, courseId);
      return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/template" && request.method === "POST") {
      const { by_user, template } = await request.json(); const out = await this.setTemplate(by_user, template);
      return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/join" && request.method === "POST") {
      const out = await this.join(await request.json()); return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/start" && request.method === "POST") {
      const { by_user } = await request.json(); const out = await this.start(by_user);
      return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/answer" && request.method === "POST") {
      const { user_id, qIndex, option } = await request.json();
      const out = await this.recordAnswer({ user_id, qIndex: Number(qIndex), option: Number(option) });
      return new Response(JSON.stringify(out), { status:200 });
    }
    if (path === "/review" && request.method === "POST") {
      const { user_id } = await request.json();
      const out = await this.buildReviewText(String(user_id));
      return new Response(JSON.stringify(out), { status:200 });
    }

    return new Response("Not Found", { status:404 });
  }
}
