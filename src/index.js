import { tg } from "./bot/tg.js";
import { getCommand, shortId, decChatId } from "./utils.js";
export { RoomDO } from "./room/room-do.js"; // کلاس Durable Object از فایل جداگانه

// ---------- عضویت کانال: هِلپرها ----------
function channelLink(env) {
  const ch = env.REQUIRED_CHANNEL || "";
  if (ch.startsWith("@")) return `https://t.me/${ch.slice(1)}`;
  if (/^-?\d+$/.test(ch)) return "📣 کانال (ID عددی) — اگر عمومی‌ست، username بده تا لینک بسازیم";
  return ch || "—";
}

// کش ساده برای chat_id عددی کانال (وقتی username می‌دهیم)
let _resolvedChannelId = null;

async function resolveRequiredChannelId(env) {
  const ch = env.REQUIRED_CHANNEL;
  if (!ch) return null;                     // کانال اجباری تنظیم نشده
  if (/^-?\d+$/.test(ch)) return Number(ch); // عددی است
  if (_resolvedChannelId) return _resolvedChannelId;
  const info = await tg.getChat(env, ch);    // ch مثل "@your_channel"
  const id = info?.result?.id || null;
  if (id) _resolvedChannelId = id;
  return id;
}

async function mustBeMember(env, user_id) {
  const chId = await resolveRequiredChannelId(env);
  if (!chId) return { ok: true }; // محدودیت غیرفعال
  const res = await tg.getChatMember(env, chId, user_id);
  if (res?.ok) {
    const status = res.result?.status;
    const allowed = ["member", "administrator", "creator"];
    return allowed.includes(status) ? { ok: true } : { ok: false, status };
  } else {
    const desc = res?.description || "";
    if (
      desc?.includes?.("bot is not a member") ||
      desc?.includes?.("not enough rights") ||
      desc?.includes?.("USER_NOT_PARTICIPANT")
    ) {
      return { ok: false, admin_issue: true, description: desc };
    }
    return { ok: false, api_error: true, description: desc };
  }
}

// ---------- اعتبارسنجی و ذخیره بانک سؤال در R2 ----------
function validateQuestionSet(payload) {
  // ساختار پیشنهادی:
  // {
  //   "course": "general",
  //   "template": "mix",          // "taalifi" | "konkoori" | "mix"
  //   "questions": [
  //     { "id":"q1","text":"...","options":["a","b","c","d"],"correct":2, "explanation":"..." },
  //     ...
  //   ]
  // }
  if (!payload || typeof payload !== "object") return "Invalid JSON";
  if (!payload.course || typeof payload.course !== "string") return "Missing 'course'";
  if (!payload.template || typeof payload.template !== "string") return "Missing 'template'";
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) return "No questions[]";

  for (let i = 0; i < payload.questions.length; i++) {
    const q = payload.questions[i];
    if (!q || typeof q !== "object") return `Question ${i + 1}: invalid`;
    if (!q.text || typeof q.text !== "string") return `Question ${i + 1}: missing 'text'`;
    if (!Array.isArray(q.options) || q.options.length !== 4) return `Question ${i + 1}: options must be 4`;
    if (typeof q.correct !== "number" || q.correct < 0 || q.correct > 3) return `Question ${i + 1}: correct must be 0..3`;
  }
  return null; // ok
}

async function putQuestionSetToR2(env, payload) {
  // مسیر ذخیره: sets/<course>/<template>/<timestamp>-<rand>.json
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `sets/${payload.course}/${payload.template}/${ts}-${rand}.json`;
  const body = JSON.stringify(payload, null, 2);
  await env.QUESTIONS.put(key, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return key;
}

async function listQuestionSets(env, { course, template, prefixOnly } = {}) {
  let prefix = "sets/";
  if (course) prefix += `${course}/`;
  if (template) prefix += `${template}/`;
  const all = await env.QUESTIONS.list({ prefix, limit: 1000 });
  const items = (all?.objects || []).map(o => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded
  }));
  if (prefixOnly) {
    // استخراج کورس/قالب‌های موجود از key ها
    const set = new Set();
    for (const it of items) {
      const parts = it.key.split("/");
      // sets/<course>/<template>/<file>.json
      if (parts.length >= 4) {
        const c = parts[1], t = parts[2];
        set.add(`${c}:${t}`);
      }
    }
    return Array.from(set).sort().map(s => {
      const [c, t] = s.split(":");
      return { course: c, template: t };
    });
  }
  return items;
}

// ---------- صفحه HTML ساده ادمین ----------
function adminHtml({ ok, key, msg, sample }) {
  const k = key ? `?key=${encodeURIComponent(key)}` : "";
  return new Response(
`<!doctype html>
<html dir="rtl" lang="fa">
<head>
  <meta charset="utf-8" />
  <title>پنل ادمین سوالات - psynex</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
  body{font-family:ui-sans-serif,system-ui,Tahoma;max-width:840px;margin:32px auto;padding:0 16px;line-height:1.7}
  header{display:flex;justify-content:space-between;align-items:center}
  textarea{width:100%;min-height:220px}
  .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:16px 0}
  .ok{color:#0a7a2f}.err{color:#b20000}
  code,kbd{background:#f5f5f5;border-radius:6px;padding:2px 6px}
  table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:8px;text-align:right}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  .row > *{flex:1}
  </style>
</head>
<body>
<header>
  <h1>📚 پنل ادمین بانک سؤالات</h1>
  <nav><a href="/admin${k}">آپلود</a> • <a href="/admin/list${k}">فهرست</a></nav>
</header>

<div class="card">
  <h3>آپلود JSON</h3>
  <p>ساختار:<br><code>{ course, template, questions[] }</code> — هر سؤال ۴ گزینه و <code>correct</code> بین ۰..۳.</p>
  <form method="POST" action="/admin/upload${k}" enctype="multipart/form-data">
    <div class="row">
      <div>
        <label>Course (مثلاً: <code>general</code>)</label>
        <input name="course" placeholder="general" style="width:100%;padding:8px" />
      </div>
      <div>
        <label>Template (مثلاً: <code>mix</code> یا <code>konkoori</code> یا <code>taalifi</code>)</label>
        <input name="template" placeholder="mix" style="width:100%;padding:8px" />
      </div>
    </div>
    <p>۱) فایل JSON آپلود کن:</p>
    <input type="file" name="file" accept="application/json" />
    <p>یا ۲) اینجا پیست کن:</p>
    <textarea name="json" placeholder='${sample.replace(/'/g,"&#39;")}'></textarea>
    <p><button type="submit" style="padding:10px 16px">آپلود به R2</button></p>
  </form>
  ${ok === true ? `<p class="ok">آپلود موفق: ${msg || ""}</p>` : ok === false ? `<p class="err">${msg || "خطا"}</p>` : ""}
</div>

<div class="card">
  <h3>نمونه JSON</h3>
  <pre><code>${sample.replace(/</g,"&lt;")}</code></pre>
</div>

<footer style="margin:24px 0;color:#777">R2: ذخیره در مسیر <code>sets/&lt;course&gt;/&lt;template&gt;/&lt;file&gt;.json</code></footer>
</body>
</html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

const SAMPLE_JSON = JSON.stringify({
  course: "general",
  template: "mix",
  questions: [
    { id: "Q1", text: "کدام گزینه صحیح است؟", options: ["۱","۲","۳","۴"], correct: 1, explanation: "نمونه." },
    { id: "Q2", text: "روان‌شناسی کدام است؟", options: ["الف","ب","ج","د"], correct: 0 },
    { id: "Q3", text: "نمونه سؤال سوم", options: ["A","B","C","D"], correct: 2 },
    { id: "Q4", text: "نمونه سؤال چهارم", options: ["I","II","III","IV"], correct: 3 },
    { id: "Q5", text: "نمونه سؤال پنجم", options: ["گزینه۱","گزینه۲","گزینه۳","گزینه۴"], correct: 0 },
    { id: "Q6", text: "نمونه سؤال ششم", options: ["opt1","opt2","opt3","opt4"], correct: 1 },
    { id: "Q7", text: "نمونه سؤال هفتم", options: ["opt1","opt2","opt3","opt4"], correct: 2 },
    { id: "Q8", text: "نمونه سؤال هشتم", options: ["opt1","opt2","opt3","opt4"], correct: 3 },
    { id: "Q9", text: "نمونه سؤال نهم", options: ["opt1","opt2","opt3","opt4"], correct: 1 },
    { id: "Q10", text: "نمونه سؤال دهم", options: ["opt1","opt2","opt3","opt4"], correct: 2 }
  ]
}, null, 2);

// ---------- Worker اصلی ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Telegram webhook ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!secret || secret !== env.TG_WEBHOOK_SECRET)
        return new Response("unauthorized", { status: 401 });

      const update = await request.json().catch(() => ({}));
      const getStubByKey = (key) => env.ROOMS.get(env.ROOMS.idFromName(key));

      // پیام‌های متنی (Commands)
      if (update.message?.text) {
        const msg = update.message;
        const chat = msg.chat || {};
        const chat_id = chat.id;
        const chat_type = chat.type || "private";
        const from = msg.from;
        const cmd = getCommand(msg);

        // تست سریع عضویت
        if (cmd === "/check") {
          const chk = await mustBeMember(env, from.id);
          if (chk.ok) {
            await tg.sendMessage(env, chat_id, "✅ عضو کانال هستی. عالی!");
          } else if (chk.admin_issue) {
            await tg.sendMessage(env, chat_id, `❌ ربات باید <b>ادمین کانال</b> باشد تا عضویت را بررسی کند.\nکانال: ${channelLink(env)}`);
          } else {
            await tg.sendMessage(env, chat_id, `❌ برای استفاده باید عضو کانال باشید:\n${channelLink(env)}`);
          }
          return new Response("ok", { status: 200 });
        }

        if (cmd === "/ping") {
          await tg.sendMessage(env, chat_id, "pong ✅", { reply_to_message_id: msg.message_id });
          return new Response("ok", { status: 200 });
        }

        if (cmd === "/newgame") {
          if (chat_type !== "group" && chat_type !== "supergroup") {
            await tg.sendMessage(env, chat_id, "این دستور فقط در گروه کار می‌کند.", { reply_to_message_id: msg.message_id });
            return new Response("ok", { status: 200 });
          }

          // (سخت‌گیرانه) سازنده باید عضو کانال باشد
          const chk = await mustBeMember(env, from.id);
          if (!chk.ok) {
            if (chk.admin_issue) {
              await tg.sendMessage(env, chat_id, `❌ ربات باید <b>ادمین کانال</b> باشد.\nکانال: ${channelLink(env)}`);
            } else {
              await tg.sendMessage(env, chat_id, `❌ برای ساخت بازی باید عضو کانال باشید:\n${channelLink(env)}`);
            }
            return new Response("ok", { status: 200 });
          }

          // ساخت اتاق
          const roomId = shortId();
          const key = `${chat_id}-${roomId}`;
          const stub = getStubByKey(key);

          const res = await stub.fetch("https://do/create", {
            method: "POST",
            body: JSON.stringify({
              chat_id,
              starter_id: from.id,
              starter_name: from.first_name,
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
          const joinLine = env.REQUIRED_CHANNEL
            ? `\n\n🔒 برای شرکت، اول عضو کانال باشید: ${channelLink(env)}`
            : "";
          await tg.sendMessage(
            env,
            chat_id,
            "🎮 بازی جدید ساخته شد.\nحالت را انتخاب کنید (۵ یا ۱۰ سؤال، هر سؤال ۱ دقیقه)؛ شرکت‌کننده‌ها «✅ آماده‌ام» را بزنند؛ شروع‌کننده «🟢 آغاز بازی» را بزند." +
              joinLine,
            { reply_markup: kb }
          );
          return new Response("ok", { status: 200 });
        }

        // /start (PV) با payload مرور پاسخ‌ها
        if (cmd === "/start" && chat_type === "private") {
          const parts = (msg.text || "").trim().split(/\s+/);
          const payload = parts.length > 1 ? parts.slice(1).join(" ") : "";
          if (!payload) {
            await tg.sendMessage(env, chat_id, "سلام! برای مرور پاسخ‌ها از لینک داخل گروه استفاده کن.");
            return new Response("ok", { status: 200 });
          }
          if (payload.startsWith("rv:")) {
            const [, encChat, rid] = payload.split(":");
            const groupChatId = decChatId(encChat);
            if (!groupChatId || !rid) {
              await tg.sendMessage(env, chat_id, "payload نامعتبر است.");
              return new Response("ok", { status: 200 });
            }
            const key = `${groupChatId}-${rid}`;
            const stub = getStubByKey(key);
            const r = await stub.fetch("https://do/review", {
              method: "POST",
              body: JSON.stringify({ user_id: from.id }),
            });
            const out = await r.json();
            if (!out.ok) {
              const m =
                out.error === "not-ended" ? "بازی هنوز تمام نشده است." :
                out.error === "not-participant" ? "شما در این بازی شرکت نکرده‌اید." :
                "خطا در دریافت مرور.";
              await tg.sendMessage(env, chat_id, m);
              return new Response("ok", { status: 200 });
            }
            await tg.sendMessage(env, chat_id, out.text);
            return new Response("ok", { status: 200 });
          }
          await tg.sendMessage(env, chat_id, "سلام! برای مرور پاسخ‌ها از لینک داخل گروه استفاده کن.");
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
        const stub = getStubByKey(key);

        // قبل از هر اکشن مشارکتی، عضویت چک می‌شود
        async function ensureMemberOrNotify() {
          const chk = await mustBeMember(env, from.id);
          if (chk.ok) return true;
          if (chk.admin_issue) {
            await tg.answerCallback(env, cq.id, "بات باید ادمین کانال باشد.", true);
            await tg.sendMessage(env, chat_id, `برای ادامه، ربات را ادمین کانال کنید:\n${channelLink(env)}`);
          } else {
            await tg.answerCallback(env, cq.id, "برای شرکت باید عضو کانال باشید.", true);
            await tg.sendMessage(env, chat_id, `برای شرکت، ابتدا عضو کانال شوید:\n${channelLink(env)}`);
          }
          return false;
        }

        if (act === "m") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const count = Number(parts[2] || 0);
          const r = await stub.fetch("https://do/mode", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id, count }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(
              env,
              cq.id,
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
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

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
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

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
              out.error === "already-started" ? "بازی قبلاً شروع شده." :
              out.error === "mode-not-set" ? "اول حالت (۵ یا ۱۰ سؤال) را انتخاب کنید." :
              out.error === "no-participants" ? "هیچ شرکت‌کننده‌ای آماده نیست." : "خطا",
              true
            );
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "بازی شروع شد! ⏱");
          return new Response("ok", { status: 200 });
        }

        if (act === "a") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

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

    // ---------- پنل ادمین (R2) ----------
    if (url.pathname === "/admin" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return adminHtml({ ok: false, key: "", msg: "دسترسی ندارید (key نامعتبر است).", sample: SAMPLE_JSON });
      }
      return adminHtml({ ok: null, key, msg: "", sample: SAMPLE_JSON });
    }

    if (url.pathname === "/admin/upload" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return adminHtml({ ok: false, key: "", msg: "دسترسی ندارید (key نامعتبر است).", sample: SAMPLE_JSON });
      }
      const form = await request.formData();
      let txt = "";
      const file = form.get("file");
      if (file && typeof file.text === "function") {
        txt = await file.text();
      } else {
        txt = String(form.get("json") || "").trim();
      }

      let payload = null;
      try { payload = txt ? JSON.parse(txt) : {}; } catch (e) {
        return adminHtml({ ok: false, key, msg: "JSON نامعتبر است.", sample: SAMPLE_JSON });
      }

      // اگر course/template در فرم داده شده بود و در payload نیست، تزریق کن
      const course = String(form.get("course") || "").trim();
      const template = String(form.get("template") || "").trim();
      if (!payload.course && course) payload.course = course;
      if (!payload.template && template) payload.template = template;

      const err = validateQuestionSet(payload);
      if (err) return adminHtml({ ok: false, key, msg: `❌ ${err}`, sample: SAMPLE_JSON });

      try {
        const savedKey = await putQuestionSetToR2(env, payload);
        return adminHtml({ ok: true, key, msg: `✅ ذخیره شد: ${savedKey}`, sample: SAMPLE_JSON });
      } catch (e) {
        return adminHtml({ ok: false, key, msg: "خطا در ذخیره R2", sample: SAMPLE_JSON });
      }
    }

    if (url.pathname === "/admin/list" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      const course = url.searchParams.get("course") || "";
      const template = url.searchParams.get("template") || "";
      const prefixOnly = url.searchParams.get("pairs") === "1";
      const items = await listQuestionSets(env, {
        course: course || undefined,
        template: template || undefined,
        prefixOnly
      });
      return new Response(JSON.stringify({ ok: true, items }, null, 2), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // --- ابزارهای دیباگ ---
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

    // --- Health ---
    if (url.pathname === "/") return new Response("psynex-exambot: OK", { status: 200 });
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });

    return new Response("Not Found", { status: 404 });
  },
};
