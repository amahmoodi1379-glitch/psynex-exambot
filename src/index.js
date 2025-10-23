import { tg } from "./bot/tg.js";
import { getCommand, shortId, decChatId } from "./utils.js";
export { RoomDO } from "./room/room-do.js";

// ---- helpers عضویت
function channelLink(env) {
  const ch = env.REQUIRED_CHANNEL || "";
  if (ch.startsWith("@")) return `https://t.me/${ch.slice(1)}`;
  if (/^-?\d+$/.test(ch)) return "📣 کانال تنظیم‌شده (ID عددی) — اگر عمومی‌ست، username بده تا لینک بسازیم";
  return ch || "—";
}

// کش ساده در حافظهٔ پردازه برای id کانال
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
  if (!chId) return { ok: true }; // کانالی تعریف نشده → آزاد

  const res = await tg.getChatMember(env, chId, user_id);
  if (res?.ok) {
    const status = res.result?.status;
    const allowed = ["member", "administrator", "creator"];
    return allowed.includes(status) ? { ok: true } : { ok: false, status };
  } else {
    const desc = res?.description || "";
    // شایع‌ترین سناریو: بات ادمین کانال نیست
    if (desc.includes("bot is not a member") || desc.includes("not enough rights") || desc.includes("USER_NOT_PARTICIPANT")) {
      return { ok: false, admin_issue: true, description: desc };
    }
    // سایر خطاها (کانال خصوصی و username نداریم، یا نام اشتباه)
    return { ok: false, api_error: true, description: desc };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- Telegram webhook ----------
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

        // تست سریع عضویت (اختیاری)
        if (cmd === "/check") {
          const chk = await mustBeMember(env, from.id);
          if (chk.ok) {
            await tg.sendMessage(env, chat_id, "✅ عضو کانال هستی. عالی!");
          } else {
            await tg.sendMessage(
              env,
              chat_id,
              `❌ برای استفاده باید عضو کانال باشی:\n${channelLink(env)}`
            );
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
          // (اختیاری) حتی می‌تونی سازنده را هم مجبور کنی عضو باشد:
          const chk = await mustBeMember(env, from.id);
          if (!chk.ok) {
            await tg.sendMessage(env, chat_id, `برای ساخت بازی باید عضو کانال باشی:\n${channelLink(env)}`);
            return new Response("ok", { status: 200 });
          }

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
            "🎮 بازی جدید ساخته شد.\nحالت را انتخاب کنید (۵ یا ۱۰ سؤال، هر سؤال ۱ دقیقه)؛ شرکت‌کننده‌ها «✅ آماده‌ام» را بزنند؛ شروع‌کننده «🟢 آغاز بازی» را بزند."
              + joinLine,
            { reply_markup: kb }
          );
          return new Response("ok", { status: 200 });
        }

        // /start (PV) با payload مرور (بدون تغییر نسبت به نسخهٔ قبل)
        if (cmd === "/start" && chat_type === "private") {
          const parts = (msg.text || "").trim().split(/\s+/);
          const payload = parts.length > 1 ? parts.slice(1).join(" ") : "";
          if (!payload) {
            await tg.sendMessage(env, chat_id, "سلام! برای مرور پاسخ‌ها از لینک داخل گروه استفاده کن.");
            return new Response("ok", { status: 200 });
          }
          // payload: rv:<encChat>:<rid>
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

        // قبل از هر اکشنِ مشارکتی، عضویت چک می‌شود
        async function ensureMemberOrNotify() {
          const chk = await mustBeMember(env, from.id);
          if (chk.ok) return true;
          // نوتیف کوتاه و لینک کانال
          await tg.answerCallback(env, cq.id, "برای شرکت باید عضو کانال باشید.", true);
          await tg.sendMessage(env, chat_id, `برای شرکت، ابتدا عضو کانال شوید:\n${channelLink(env)}`);
          return false;
        }

        if (act === "m") {
          // فقط استارتر باید عضو باشد؟ فعلاً سخت‌گیرانه: همه
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
              env, cq.id,
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
