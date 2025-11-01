// RoomDO: منطق بازی داخل Durable Object

import { ACTIVE_TEMPLATES, KNOWN_TEMPLATES, TEMPLATE_KEYS } from "../constants.js";
import { encChatId } from "../utils.js";

const COURSES_KEY = "admin/courses.json";

const TEMPLATE_LABELS = {
  [TEMPLATE_KEYS.KONKOORI]: "قالب کنکوری",
  [TEMPLATE_KEYS.TAALIFI]: "قالب تألیفی",
  [TEMPLATE_KEYS.MIX]: "قالب ترکیبی",
};

const MODE_LABELS = {
  5: "۵ سوالی",
  10: "۱۰ سوالی",
};

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function channelLink(env) {
  const ch = env.REQUIRED_CHANNEL || "";
  if (ch.startsWith("@")) return `https://t.me/${ch.slice(1)}`;
  if (/^-?\d+$/.test(ch)) return "📣 کانال (ID عددی)";
  return ch || "";
}

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this._advancing = false;
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
  editMessageText(chat_id, message_id, text, extra = {}) {
    return this.tgCall("editMessageText", {
      chat_id,
      message_id,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  }
  editMarkup(chat_id, message_id, reply_markup = null) {
    return this.tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
  }
  // ====== R2: load questions ======
  async getR2Text(key) { const obj = await this.env.QUESTIONS.get(key); if (!obj) return null; return await obj.text(); }
  normalizeStoredQuestion(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim();
    const text = String(raw.text || "").trim();
    if (!id || !text) return null;
    if (!Array.isArray(raw.options) || raw.options.length !== 4) return null;
    const options = raw.options.map(opt => String(opt || "").trim());
    if (options.some(opt => !opt)) return null;
    const correct = Number(raw.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) return null;
    const question = { id, text, options, correct };
    if (raw.explanation) {
      const explanation = String(raw.explanation).trim();
      if (explanation) question.explanation = explanation;
    }
    return question;
  }
  async listQuestionKeys(courseId, template) {
    const prefix = `questions/${courseId}/${template}/`;
    const keys = [];
    let cursor;
    do {
      const res = await this.env.QUESTIONS.list({ prefix, limit: 1000, cursor });
      const objs = res?.objects || [];
      for (const obj of objs) keys.push(obj.key);
      cursor = res?.truncated ? res.cursor : null;
    } while (cursor);
    return keys;
  }
  async readQuestionByKey(key, courseId, template) {
    try {
      const txt = await this.getR2Text(key);
      if (!txt) return null;
      const parsed = JSON.parse(txt);
      if (parsed.course && parsed.course !== courseId) return null;
      if (parsed.template && parsed.template !== template && template !== "mix") return null;
      return this.normalizeStoredQuestion(parsed);
    } catch (err) {
      console.error("Failed to parse question", key, err);
      return null;
    }
  }
  async loadQuestions(courseId, template, count) {
    const templateList = template === "mix" ? ["konkoori", "taalifi"] : [template];
    let keyPool = [];
    for (const tpl of templateList) {
      const keys = await this.listQuestionKeys(courseId, tpl);
      keyPool = keyPool.concat(keys.map(k => ({ key: k, template: tpl })));
    }
    const seen = new Set();
    keyPool = keyPool.filter(({ key }) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (keyPool.length < count) return null;
    this.shuffle(keyPool);
    const questions = [];
    let idx = 0;
    while (questions.length < count && idx < keyPool.length) {
      const entry = keyPool[idx++];
      const q = await this.readQuestionByKey(entry.key, courseId, template === "mix" ? entry.template : template);
      if (!q) continue;
      questions.push(q);
    }
    if (questions.length < count) return null;
    return questions.slice(0, count);
  }

  templateLabel(template) {
    if (!template) return null;
    return TEMPLATE_LABELS[template] || template;
  }

  modeLabel(count) {
    if (!count) return null;
    return MODE_LABELS[count] || `${count} سوالی`;
  }

  hostSuffix(data) {
    if (!data || data.chat_type !== "private") return "";
    const encoded = encChatId(data.chat_id);
    return encoded ? `:host${encoded}` : "";
  }

  withHost(data, base) {
    const suffix = this.hostSuffix(data);
    return suffix ? `${base}${suffix}` : base;
  }

  templateButton(data, templateKey) {
    const rid = data?.room_id;
    const label = this.templateLabel(templateKey) || templateKey;
    const emoji =
      templateKey === TEMPLATE_KEYS.KONKOORI ? "🎯" :
      templateKey === TEMPLATE_KEYS.TAALIFI ? "📝" :
      "🔀";
    if (!ACTIVE_TEMPLATES.has(templateKey)) {
      return {
        text: `${emoji} ${label} 🚫`,
        callback_data: this.withHost(data, `tdisabled:${rid}:${templateKey}`),
      };
    }
    const selected = data?.template === templateKey ? " ✅" : "";
    return {
      text: `${emoji} ${label}${selected}`,
      callback_data: this.withHost(data, `t:${rid}:${templateKey}`),
    };
  }

  ensureParticipantOrder(data) {
    if (!data) return [];
    if (!data.participants || typeof data.participants !== "object") {
      data.participants = {};
    }
    const map = data.participants;
    const base = Array.isArray(data.participantOrder)
      ? data.participantOrder.map((id) => String(id))
      : [];
    const seen = new Set();
    const ordered = [];
    for (const rawId of base) {
      const uid = String(rawId);
      if (seen.has(uid)) continue;
      if (!map[uid]) continue;
      ordered.push(uid);
      seen.add(uid);
    }
    for (const key of Object.keys(map)) {
      const uid = String(key);
      if (seen.has(uid)) continue;
      ordered.push(uid);
      seen.add(uid);
    }
    data.participantOrder = ordered;
    return ordered;
  }

  readyParticipantEntries(data) {
    const order = this.ensureParticipantOrder(data);
    const participants = data?.participants || {};
    const entries = [];
    for (const uid of order) {
      const p = participants[uid];
      if (p && p.ready) entries.push([uid, p]);
    }
    return entries;
  }

  countReadyParticipants(data) {
    return this.readyParticipantEntries(data).length;
  }

  participantLines(data) {
    const lines = [];
    const order = this.ensureParticipantOrder(data);
    const participants = data?.participants || {};
    for (const uid of order) {
      const p = participants[uid];
      if (!p) continue;
      const name = escapeHtml((String(p.name ?? "").trim() || `کاربر ${uid}`));
      const isStarter = String(uid) === String(data?.starter_id);
      const statusEmoji = p.ready ? "✅" : "⏳";
      const roleEmoji = isStarter ? "👑" : "👤";
      lines.push(`${statusEmoji} ${roleEmoji} ${name}`);
    }
    return lines;
  }

  buildSetupKeyboard(data) {
    if (!data || data.started || data.resultsPosted) return null;
    const rid = data.room_id;
    const rows = [];

    const courseSelected = Boolean(data.courseId);
    rows.push([
      {
        text: courseSelected ? "📚 انتخاب درس ✅" : "📚 انتخاب درس",
        callback_data: this.withHost(data, `cl:${rid}`),
      },
    ]);

    rows.push([this.templateButton(data, TEMPLATE_KEYS.KONKOORI)]);
    rows.push([this.templateButton(data, TEMPLATE_KEYS.TAALIFI)]);
    rows.push([this.templateButton(data, TEMPLATE_KEYS.MIX)]);

    const modeRow = [5, 10].map((count) => {
      const label = this.modeLabel(count);
      const selected = Number(data.modeCount) === count ? " ✅" : "";
      const prefix = count === 5 ? "5️⃣" : "🔟";
      return {
        text: `${prefix} ${label}${selected}`,
        callback_data: this.withHost(data, `m:${rid}:${count}`),
      };
    });
    rows.push(modeRow);

    rows.push([
      { text: "✨ آماده‌ام", callback_data: this.withHost(data, `j:${rid}`) },
      { text: "🚀 آغاز بازی", callback_data: this.withHost(data, `s:${rid}`) },
    ]);

    return { inline_keyboard: rows };
  }

  buildSetupText(data) {
    const lines = [];
    const isPrivate = data?.chat_type === "private";
    lines.push(isPrivate ? "🎮 <b>اتاق بازی دونفره</b>" : "🎮 <b>اتاق بازی گروهی</b>");
    const statusLine = data.resultsPosted
      ? "🏁 وضعیت: <b>بازی به پایان رسید</b>"
      : data.started
      ? "🔥 وضعیت: <b>بازی در حال برگزاری است</b>"
      : "⏳ وضعیت: <b>در انتظار شروع</b>";
    lines.push(statusLine);

    const starterName = escapeHtml(String(data?.starter_name ?? "") || "بدون نام");
    lines.push(`👑 آغازگر: <b>${starterName}</b>`);

    const courseDisplay = data.courseTitle
      ? `<b>${escapeHtml(data.courseTitle)}</b>`
      : data.courseId
      ? `<b>${escapeHtml(data.courseId)}</b>`
      : "<i>انتخاب نشده</i>";
    lines.push(`📚 درس: ${courseDisplay}`);

    const tplLabel = this.templateLabel(data.template);
    const templateDisplay = tplLabel
      ? `<b>${escapeHtml(tplLabel)}</b>`
      : "<i>انتخاب نشده</i>";
    lines.push(`🧩 قالب: ${templateDisplay}`);

    const modeLabel = this.modeLabel(data.modeCount);
    const modeDisplay = modeLabel
      ? `<b>${escapeHtml(modeLabel)}</b>`
      : "<i>انتخاب نشده</i>";
    lines.push(`📝 تعداد سؤال: ${modeDisplay}`);

    lines.push("");
    lines.push("👥 اعضای آماده:");
    const participantLines = this.participantLines(data);
    if (participantLines.length) lines.push(...participantLines);
    else lines.push("• هنوز کسی آماده نشده است.");

    if (!data.started && !data.resultsPosted) {
      lines.push("");
      lines.push("📌 راهنما:");
      lines.push("۱️⃣ درس را از «📚 انتخاب درس» انتخاب کنید.");
      lines.push("۲️⃣ یکی از قالب‌ها را برگزینید.");
      lines.push("۳️⃣ حالت ۵ یا ۱۰ سوالی را تعیین کنید.");
      lines.push("۴️⃣ شرکت‌کننده‌ها «✨ آماده‌ام» و آغازگر «🚀 آغاز بازی» را فشار دهد.");
      if (isPrivate) {
        lines.push("۵️⃣ برای دعوت دوست، این پیام را برای او فوروارد کنید تا دکمه‌ها را بزند.");
      }
    } else if (data.started && !data.resultsPosted) {
      lines.push("");
      lines.push("🔥 بازی آغاز شده است؛ موفق باشید!");
    } else if (data.resultsPosted) {
      lines.push("");
      lines.push("🏁 بازی به پایان رسیده است. برای شروع دوباره از /startgame استفاده کنید.");
    }

    if (this.env.REQUIRED_CHANNEL) {
      const link = channelLink(this.env);
      if (link) {
        lines.push("");
        lines.push(`🔒 عضویت در کانال الزامی: ${link}`);
      }
    }

    return lines.join("\n");
  }

  buildSetupState(data) {
    const text = this.buildSetupText(data);
    const markup = this.buildSetupKeyboard(data);
    const hash = JSON.stringify({ text, markup: markup || null });
    return { text, markup, hash };
  }

  async saveAndRefresh(data, { forceUpdate = false } = {}) {
    const state = this.buildSetupState(data);
    const shouldUpdate = forceUpdate || state.hash !== data.setupHash;
    data.setupHash = state.hash;
    await this.save(data);
    if (shouldUpdate && data.chat_id && data.setupMessageId) {
      const extra = state.markup
        ? { reply_markup: state.markup }
        : { reply_markup: { inline_keyboard: [] } };
      try {
        await this.editMessageText(data.chat_id, data.setupMessageId, state.text, extra);
      } catch (err) {
        console.error("Failed to update setup message", err);
      }
    }
    return state;
  }

  async findCourse(courseId) {
    if (!courseId) return null;
    try {
      const obj = await this.env.QUESTIONS.get(COURSES_KEY);
      if (!obj) return null;
      const txt = await obj.text();
      const list = JSON.parse(txt);
      if (!Array.isArray(list)) return null;
      return list.find((c) => c?.id === courseId) || null;
    } catch (err) {
      console.error("Failed to load courses", err);
      return null;
    }
  }

  // ====== Game flow ======
  async create({ chat_id, chat_type, starter_id, starter_name, room_id }) {
    const starterId = String(starter_id);
    const starterName = (String(starter_name ?? "").trim() || "بدون نام");
    const data = {
      chat_id,
      chat_type: chat_type || "group",
      room_id,
      starter_id: starterId,
      starter_name: starterName,
      participants: {
        [starterId]: { name: starterName, ready: true, answers: [], timeMs: 0 },
      },
      participantOrder: [starterId],
      allowedUsers: null, // فریز بعد از start
      modeCount: null,
      courseId: null,
      courseTitle: null,
      template: null, // konkoori | taalifi | mix (فقط در بازی)
      started: false,
      currentIndex: -1,
      questionDeadline: 0,
      questionMessageId: null,
      qStartTs: 0,
      questions: [], // {id,text,options[4],correct,explanation?}
      resultsPosted: false,
      setupMessageId: null,
      setupHash: null,
    };

    const state = this.buildSetupState(data);
    const extra = state.markup ? { reply_markup: state.markup } : {};
    const sent = await this.sendMessage(chat_id, state.text, extra);
    const messageId = sent?.result?.message_id || null;
    if (!sent?.ok || !messageId) {
      return { ok: false, error: "send-failed" };
    }
    data.setupMessageId = messageId;
    data.setupHash = state.hash;
    await this.save(data);

    return { ok: true, roomId: room_id, messageId };
  }

  async setMode(by_user, count) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started || data.resultsPosted) return { ok:false, error:"already-started" };
    const by = String(by_user);
    const starterId = String(data.starter_id);
    data.starter_id = starterId;
    if (by !== starterId) return { ok:false, error:"only-starter" };
    if (![5,10].includes(Number(count))) return { ok:false, error:"invalid-mode" };
    data.modeCount = Number(count);
    await this.saveAndRefresh(data);
    return { ok:true, modeCount:data.modeCount };
  }

  async setCourse(by_user, courseId) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started || data.resultsPosted) return { ok:false, error:"already-started" };
    const by = String(by_user);
    const starterId = String(data.starter_id);
    data.starter_id = starterId;
    if (by !== starterId) return { ok:false, error:"only-starter" };
    if (!courseId) return { ok:false, error:"invalid-course" };
    const info = await this.findCourse(String(courseId));
    if (!info) return { ok:false, error:"invalid-course" };
    data.courseId = String(info.id);
    data.courseTitle = String(info.title || info.id || "").trim() || data.courseId;
    await this.saveAndRefresh(data);
    return { ok:true, courseId:data.courseId, courseTitle:data.courseTitle };
  }

  async setTemplate(by_user, template) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started || data.resultsPosted) return { ok:false, error:"already-started" };
    const by = String(by_user);
    const starterId = String(data.starter_id);
    data.starter_id = starterId;
    if (by !== starterId) return { ok:false, error:"only-starter" };
    if (!KNOWN_TEMPLATES.has(template)) return { ok:false, error:"invalid-template" };
    if (!ACTIVE_TEMPLATES.has(template)) return { ok:false, error:"template-disabled" };
    data.template = template;
    await this.saveAndRefresh(data);
    return { ok:true, template:data.template };
  }

  async join({ user_id, name }) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (data.started || data.resultsPosted) return { ok:false, error:"already-started" };

    const uid = String(user_id);
    const displayName = String(name ?? "").trim() || "بازیکن";
    const participants = data.participants || (data.participants = {});
    const existing = participants[uid];
    const wasReady = Boolean(existing?.ready);

    if (!existing) {
      participants[uid] = { name: displayName, ready: true, answers: [], timeMs: 0 };
    } else {
      existing.ready = true;
      if (displayName) existing.name = displayName;
      if (!Array.isArray(existing.answers)) existing.answers = [];
      if (typeof existing.timeMs !== "number") existing.timeMs = Number(existing.timeMs) || 0;
    }

    if (!Array.isArray(data.participantOrder)) data.participantOrder = [];
    if (!data.participantOrder.includes(uid)) data.participantOrder.push(uid);

    const readyCount = this.countReadyParticipants(data);
    await this.saveAndRefresh(data);
    return { ok:true, readyCount, alreadyReady: wasReady };
  }

  async start(by_user) {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    const by = String(by_user);
    const starterId = String(data.starter_id);
    data.starter_id = starterId;
    if (by !== starterId) return { ok:false, error:"only-starter" };
    if (data.started) return { ok:false, error:"already-started" };
    if (data.resultsPosted) return { ok:false, error:"already-started" };
    if (!data.modeCount) return { ok:false, error:"mode-not-set" };
    if (!data.courseId) return { ok:false, error:"course-not-set" };
    if (!data.template) return { ok:false, error:"template-not-set" };

    const readyEntries = this.readyParticipantEntries(data);
    if (!readyEntries.length) return { ok:false, error:"no-participants" };

    // Freeze roster
    data.allowedUsers = readyEntries.map(([uid]) => String(uid));

    const qs = await this.loadQuestions(data.courseId, data.template, data.modeCount);
    if (!qs || !qs.length) {
      await this.sendMessage(data.chat_id, "❌ بانک سؤال کافی یافت نشد. برای این درس/قالب سؤال‌های بیشتری در R2 ذخیره کنید.");
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
    await this.saveAndRefresh(data);

    const courseName = escapeHtml(data.courseTitle || data.courseId || "—");
    const templateName = escapeHtml(this.templateLabel(data.template) || data.template || "—");
    const modeName = escapeHtml(this.modeLabel(data.modeCount) || `${data.modeCount} سوال`);
    const startText = [
      "🚀 بازی شروع شد!",
      `📚 درس: <b>${courseName}</b>`,
      `🧩 قالب: <b>${templateName}</b>`,
      `📝 تعداد سؤال: <b>${modeName}</b>`,
      "⏱ هر سؤال ۶۰ ثانیه.",
    ].join("\n");
    await this.sendMessage(data.chat_id, startText);
    await this.nextQuestion();
    return { ok:true };
  }

  async nextQuestion() {
    if (this._advancing) return;
    this._advancing = true;
    try {
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

      const hostSuffix = this.hostSuffix(data);
      const kb = { inline_keyboard: [[
        { text:"۱", callback_data:`a:${data.room_id}:${data.currentIndex}:0${hostSuffix}` },
        { text:"۲", callback_data:`a:${data.room_id}:${data.currentIndex}:1${hostSuffix}` },
        { text:"۳", callback_data:`a:${data.room_id}:${data.currentIndex}:2${hostSuffix}` },
        { text:"۴", callback_data:`a:${data.room_id}:${data.currentIndex}:3${hostSuffix}` },
      ]]};

      const sent = await this.sendMessage(data.chat_id, text, { reply_markup: kb });
      const mid = sent?.result?.message_id || null;
      const deadline = this.now() + 60*1000;

      data.questionMessageId = mid;
      data.questionDeadline = deadline;
      data.qStartTs = this.now();
      await this.save(data);

      await this.state.storage.setAlarm(new Date(deadline));
    } finally {
      this._advancing = false;
    }
  }

  async finishGame() {
    const data = await this.load();
    if (!data || data.resultsPosted) return;

    // امتیاز: فقط تعداد صحیح + تقدم زمان
    const participants = data.participants || {};
    const orderedIds = this.ensureParticipantOrder(data);
    const players = orderedIds.map((uid) => {
      const p = participants[uid] || {};
      const answers = Array.isArray(p.answers) ? p.answers : [];
      let correct = 0;
      for (const a of answers) if (a && a.ok) correct++;
      return {
        uid,
        name: String(p.name ?? "بازیکن"),
        correct,
        timeMs: Number(p.timeMs) || 0,
      };
    });
    players.sort((a, b) => (b.correct - a.correct) || (a.timeMs - b.timeMs));

    const courseName = escapeHtml(data.courseTitle || data.courseId || "—");
    const templateName = escapeHtml(this.templateLabel(data.template) || data.template || "—");
    const totalQuestions = Array.isArray(data.questions) ? data.questions.length : data.modeCount || 0;

    const lines = [
      "🏁 <b>پایان بازی!</b>",
      `📚 درس: <b>${courseName}</b>`,
      `🧩 قالب: <b>${templateName}</b>`,
      `📝 تعداد سؤال: <b>${totalQuestions}</b>`,
      "",
      "🎉 نتایج:",
    ];

    if (players.length) {
      players.forEach((pl, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        const sec = Math.round((pl.timeMs || 0) / 1000);
        lines.push(`${medal} <b>${escapeHtml(pl.name)}</b> — ✅ ${pl.correct} | ⏱ ${sec} ثانیه`);
      });
    } else {
      lines.push("هیچ پاسخی ثبت نشد.");
    }

    lines.push("", "🔁 برای مرور گروهی از دکمهٔ زیر استفاده کنید.");

    const replyMarkup = {
      inline_keyboard: [[{ text: "🧾 مرور گروهی", callback_data: this.withHost(data, `gr:${data.room_id}`) }]],
    };

    await this.sendMessage(data.chat_id, lines.join("\n"), { reply_markup: replyMarkup });
    data.resultsPosted = true;
    await this.saveAndRefresh(data);
  }

  async recordAnswer({ user_id, qIndex, option }) {
    const data = await this.load();
    if (!data || !data.started || data.resultsPosted) return { ok:false, error:"not-started" };
    if (qIndex !== data.currentIndex) return { ok:false, error:"out-of-window" };
    if (this.now() > data.questionDeadline) return { ok:false, error:"too-late" };

    // ضدتقلب: فقط کاربران فریز‌شده
    const uid = String(user_id);
    const allow = (data.allowedUsers || []).includes(uid);
    if (!allow) return { ok:false, error:"not-allowed" };

    const participants = data.participants || (data.participants = {});
    const p = (participants[uid] ||= { name: "User"+uid, ready:false, answers:[], timeMs:0 });

    // جلوگیری از پاسخ تکراری
    if (p.answers[qIndex]) return { ok:true, duplicate:true };

    const q = data.questions[qIndex];
    const ok = Number(option) === Number(q.correct);

    const elapsed = Math.max(0, this.now() - (data.qStartTs || this.now()));
    p.timeMs = (p.timeMs || 0) + elapsed;
    p.answers[qIndex] = { option: Number(option), ok, ms: elapsed };

    await this.save(data);

    const participantsMap = data && typeof data.participants === "object" ? data.participants : {};
    const allowedUsers = Array.isArray(data.allowedUsers) ? data.allowedUsers : [];
    const answeredCount = allowedUsers.reduce((count, id) => {
      const answers = participantsMap?.[id]?.answers;
      return Array.isArray(answers) && answers[qIndex] ? count + 1 : count;
    }, 0);
    const allAnswered = allowedUsers.length > 0 && answeredCount === allowedUsers.length;

    if (allAnswered && !this._advancing) {
      await this.nextQuestion();
    }

    return { ok:true, duplicate:false };
  }

  async buildReviewText(user_id) {
    return { ok:false, error:"disabled" };
  }

  async buildGroupReviewText() {
    const data = await this.load();
    if (!data) return { ok:false, error:"no-room" };
    if (!data.resultsPosted) return { ok:false, error:"not-ended" };
    if (!Array.isArray(data.questions) || !data.questions.length) return { ok:false, error:"no-questions" };

    const lines = [`🧾 مرور گروهی — اتاق ${data.room_id}`, ""];
    data.questions.forEach((q, i) => {
      const correct = Number.isInteger(q?.correct) ? Number(q.correct) + 1 : 1;
      lines.push(`سؤال ${i+1}: گزینه ${correct}`);
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
    if (path === "/group-review" && request.method === "POST") {
      const out = await this.buildGroupReviewText();
      return new Response(JSON.stringify(out), { status:200 });
    }

    return new Response("Not Found", { status:404 });
  }
}
