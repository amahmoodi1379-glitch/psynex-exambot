import { tg } from "./bot/tg.js";
import { getCommand, shortId, decChatId } from "./utils.js";
export { RoomDO } from "./room/room-do.js";

// ---------- عضویت کانال ----------
function channelLink(env) {
  const ch = env.REQUIRED_CHANNEL || "";
  if (ch.startsWith("@")) return `https://t.me/${ch.slice(1)}`;
  if (/^-?\d+$/.test(ch)) return "📣 کانال (ID عددی)";
  return ch || "—";
}
let _resolvedChannelId = null;
async function resolveRequiredChannelId(env) {
  const ch = env.REQUIRED_CHANNEL;
  if (!ch) return null;
  if (/^-?\d+$/.test(ch)) return Number(ch);
  if (_resolvedChannelId) return _resolvedChannelId;
  const info = await tg.getChat(env, ch);
  const id = info?.result?.id || null;
  if (id) _resolvedChannelId = id;
  return id;
}
async function mustBeMember(env, user_id) {
  const chId = await resolveRequiredChannelId(env);
  if (!chId) return { ok: true };
  const res = await tg.getChatMember(env, chId, user_id);
  if (res?.ok) {
    const status = res.result?.status;
    const ok = ["member", "administrator", "creator"].includes(status);
    return ok ? { ok: true } : { ok: false, status };
  }
  const desc = res?.description || "";
  if (desc.includes("bot is not a member") || desc.includes("not enough rights") || desc.includes("USER_NOT_PARTICIPANT"))
    return { ok: false, admin_issue: true, description: desc };
  return { ok: false, api_error: true, description: desc };
}

// ---------- R2 (Admin courses) ----------
const COURSES_KEY = "admin/courses.json";
async function loadCourses(env) {
  try {
    const obj = await env.QUESTIONS.get(COURSES_KEY);
    if (!obj) return [];
    const txt = await obj.text();
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return [];
    // arr: [{id,title}]
    return arr;
  } catch {
    return [];
  }
}

// ---------- Worker ----------
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

      // پیام‌های متنی
      if (update.message?.text) {
        const msg = update.message;
        const chat = msg.chat || {};
        const chat_id = chat.id;
        const chat_type = chat.type || "private";
        const from = msg.from;
        const cmd = getCommand(msg);

        if (cmd === "/check") {
          const chk = await mustBeMember(env, from.id);
          if (chk.ok) await tg.sendMessage(env, chat_id, "✅ عضو کانال هستی.");
          else if (chk.admin_issue) await tg.sendMessage(env, chat_id, `❌ بات را ادمین کانال کنید.\n${channelLink(env)}`);
          else await tg.sendMessage(env, chat_id, `❌ ابتدا عضو کانال شوید:\n${channelLink(env)}`);
          return new Response("ok", { status: 200 });
        }

        if (cmd === "/ping") {
          await tg.sendMessage(env, chat_id, "pong ✅", { reply_to_message_id: msg.message_id });
          return new Response("ok", { status: 200 });
        }

        if (cmd === "/newgame") {
          if (!["group", "supergroup"].includes(chat_type)) {
            await tg.sendMessage(env, chat_id, "این دستور فقط در گروه کار می‌کند.", { reply_to_message_id: msg.message_id });
            return new Response("ok", { status: 200 });
          }

          const chk = await mustBeMember(env, from.id);
          if (!chk.ok) {
            if (chk.admin_issue) await tg.sendMessage(env, chat_id, `❌ ربات باید ادمین کانال باشد.\n${channelLink(env)}`);
            else await tg.sendMessage(env, chat_id, `❌ برای ساخت بازی عضو کانال شوید:\n${channelLink(env)}`);
            return new Response("ok", { status: 200 });
          }

          const roomId = shortId();
          const key = `${chat_id}-${roomId}`;
          const stub = getStubByKey(key);

          await stub.fetch("https://do/create", {
            method: "POST",
            body: JSON.stringify({
              chat_id,
              starter_id: from.id,
              starter_name: from.first_name,
              room_id: roomId,
            }),
          });

          // کیبورد اولیه: انتخاب قالب + انتخاب درس + حالت + آماده/آغاز
          const kb = {
            inline_keyboard: [
              [
                { text: "📚 انتخاب درس", callback_data: `cl:${roomId}` },
              ],
              [
                { text: "کنکوری", callback_data: `t:${roomId}:konkoori` },
                { text: "تألیفی", callback_data: `t:${roomId}:taalifi` },
                { text: "ترکیبی", callback_data: `t:${roomId}:mix` },
              ],
              [
                { text: "۵ سواله", callback_data: `m:${roomId}:5` },
                { text: "۱۰ سواله", callback_data: `m:${roomId}:10` },
              ],
              [
                { text: "✅ آماده‌ام", callback_data: `j:${roomId}` },
                { text: "🟢 آغاز بازی", callback_data: `s:${roomId}` },
              ],
            ],
          };

          const joinLine = env.REQUIRED_CHANNEL ? `\n\n🔒 عضو کانال باشید: ${channelLink(env)}` : "";
          await tg.sendMessage(
            env,
            chat_id,
            "🎮 بازی جدید ساخته شد.\n۱) «📚 انتخاب درس» را بزنید.\n۲) قالب را انتخاب کنید (کنکوری/تألیفی/ترکیبی).\n۳) حالت ۵ یا ۱۰ سؤال.\n۴) شرکت‌کننده‌ها «✅ آماده‌ام»، شروع‌کننده «🟢 آغاز بازی»." + joinLine,
            { reply_markup: kb }
          );
          return new Response("ok", { status: 200 });
        }

        // /start PV review (بعداً کامل می‌کنیم)
        if (cmd === "/start" && chat_type === "private") {
          await tg.sendMessage(env, chat_id, "سلام! مرور پاسخ‌ها بعداً فعال می‌شود.");
          return new Response("ok", { status: 200 });
        }
      }

      // دکمه‌ها
      if (update.callback_query) {
        const cq = update.callback_query;
        const msg = cq.message || {};
        const chat_id = msg.chat?.id;
        const from = cq.from;
        const parts = (cq.data || "").split(":"); // cl:<rid> | c:<rid>:<courseId> | t:<rid>:<tpl> | m:<rid>:5 | j:<rid> | s:<rid> | a:<rid>:<qIndex>:<opt>
        const act = parts[0];
        const rid = parts[1];
        const key = `${chat_id}-${rid}`;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(key));

        async function ensureMemberOrNotify() {
          const chk = await mustBeMember(env, from.id);
          if (chk.ok) return true;
          if (chk.admin_issue) {
            await tg.answerCallback(env, cq.id, "بات باید ادمین کانال باشد.", true);
            await tg.sendMessage(env, chat_id, `بات را ادمین کانال کنید:\n${channelLink(env)}`);
          } else {
            await tg.answerCallback(env, cq.id, "برای شرکت باید عضو کانال باشید.", true);
            await tg.sendMessage(env, chat_id, `ابتدا عضو کانال شوید:\n${channelLink(env)}`);
          }
          return false;
        }

        // لیست دروس از R2
        if (act === "cl") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const courses = await loadCourses(env); // [{id,title}]
          if (!courses.length) {
            await tg.answerCallback(env, cq.id, "هیچ درسی تعریف نشده.", true);
            return new Response("ok", { status: 200 });
          }
          // ساخت کیبورد (حداکثر 3 در هر ردیف)
          const rows = [];
          let row = [];
          for (const c of courses) {
            row.push({ text: c.title, callback_data: `c:${rid}:${c.id}` });
            if (row.length === 3) { rows.push(row); row = []; }
          }
          if (row.length) rows.push(row);

          await tg.answerCallback(env, cq.id, "لیست درس‌ها");
          await tg.sendMessage(env, chat_id, "🎓 یک درس را انتخاب کنید:", { reply_markup: { inline_keyboard: rows } });
          return new Response("ok", { status: 200 });
        }

        // انتخاب course
        if (act === "c") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const courseId = parts[2];
          const r = await stub.fetch("https://do/course", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id, courseId }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند درس را تعیین کند." :
              out.error === "already-started" ? "بازی آغاز شده." :
              "خطا", true);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "درس تنظیم شد.");
          await tg.sendMessage(env, chat_id, `📚 درس انتخابی: <b>${out.courseId}</b>`);
          return new Response("ok", { status: 200 });
        }

        // انتخاب template
        if (act === "t") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const tpl = parts[2];
          const r = await stub.fetch("https://do/template", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id, template: tpl }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند قالب را تعیین کند." :
              out.error === "already-started" ? "بازی آغاز شده." :
              "خطا", true);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "قالب تنظیم شد.");
          await tg.sendMessage(env, chat_id, `🧩 قالب: <b>${out.template}</b>`);
          return new Response("ok", { status: 200 });
        }

        // انتخاب mode 5/10
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
            await tg.answerCallback(env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند حالت را انتخاب کند." :
              out.error === "invalid-mode" ? "حالت نامعتبر است." :
              out.error === "already-started" ? "بازی شروع شده." : "خطا", true);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, `روی ${out.modeCount} سوال تنظیم شد.`);
          await tg.sendMessage(env, chat_id, `⚙️ حالت بازی: ${out.modeCount} سوال.`);
          return new Response("ok", { status: 200 });
        }

        // Join
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

        // Start
        if (act === "s") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const r = await stub.fetch("https://do/start", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند آغاز کند." :
              out.error === "already-started" ? "بازی قبلاً شروع شده." :
              out.error === "mode-not-set" ? "اول حالت (۵ یا ۱۰ سؤال) را انتخاب کنید." :
              out.error === "course-not-set" ? "اول درس را انتخاب کنید." :
              out.error === "template-not-set" ? "قالب را انتخاب کنید." :
              out.error === "no-participants" ? "هیچ شرکت‌کننده‌ای آماده نیست." :
              out.error === "no-questions" ? "بانک سؤال کافی نیست." : "خطا", true);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "بازی شروع شد! ⏱");
          return new Response("ok", { status: 200 });
        }

        // Answer
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
          if (out.ok && out.duplicate) await tg.answerCallback(env, cq.id, "قبلاً ثبت شده بود.");
          else if (out.ok) await tg.answerCallback(env, cq.id, "پاسخ ثبت شد ✅");
          else await tg.answerCallback(env, cq.id, "زمان یا حالت نامعتبر", true);
          return new Response("ok", { status: 200 });
        }
      }

      return new Response("ok", { status: 200 });
    }

    // ---------- پنل ادمین (نسخه‌ی قبلیِ شما: admin2 و APIها) ----------
    // (همان فایل قبلی شما که داشبورد ادمین داشت اینجا سرجایش است؛
    // اگر همین index.js را جایگزین می‌کنی و قبلی را از دست می‌دهی، به من بگو تا نسخه‌ی کامل admin2 را هم ضمیمه کنم.)
    // برای جلوگیری از طولانی‌شدن پیام، فرض می‌کنیم بخش admin2 قبلاً سرجایش مانده است.

    // Health
    if (url.pathname === "/") return new Response("psynex-exambot: OK", { status: 200 });
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
