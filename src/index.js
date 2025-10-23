import { tg } from "./bot/tg.js";
import { getCommand, shortId, decChatId } from "./utils.js";
export { RoomDO } from "./room/room-do.js"; // DO کلاس

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

// ---------- R2: بانک سؤال / دوره‌ها ----------
// courses.json به شکل آرایه‌ای از آبجکت‌ها ذخیره می‌شود: [{ id: "slug-...", title: "نام فارسی" }, ...]
const COURSES_KEY = "admin/courses.json";

async function getCourses(env) {
  try {
    const obj = await env.QUESTIONS.get(COURSES_KEY);
    if (!obj) return [];
    const txt = await obj.text();
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function saveCourses(env, courses) {
  const body = JSON.stringify(courses, null, 2);
  await env.QUESTIONS.put(COURSES_KEY, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return true;
}

// ساخت slug/id پایدار از عنوان فارسی (حافظه‌امن: فقط برای id داخلی استفاده می‌شود)
function makeSlugFromTitle(title) {
  // 1) فاصله‌ها به -  2) حذف کاراکترهای غیرمجاز برای کلید R2  3) fallback اگر خالی شد
  const t = String(title || "").trim();
  const base = t
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "") // فقط حروف/اعداد همه‌زبان‌ها + - _
    .toLowerCase();
  const core = base || "course";
  // یکتا کردن با suffix کوتاه
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${core}-${suffix}`;
}
const ALLOWED_TEMPLATES = new Set(["konkoori", "taalifi"]);

function validateQuestionSet(payload) {
  // { course, template, questions: [{id,text, options[4], correct(0..3), explanation?}, ...] }
  if (!payload || typeof payload !== "object") return "Invalid JSON";
  if (!payload.course || typeof payload.course !== "string") return "Missing 'course'";
  if (!payload.template || typeof payload.template !== "string") return "Missing 'template'";
  if (!ALLOWED_TEMPLATES.has(payload.template)) {
  return "template must be 'konkoori' or 'taalifi'";
}
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) return "No questions[]";
  for (let i = 0; i < payload.questions.length; i++) {
    const q = payload.questions[i];
    if (!q || typeof q !== "object") return `Question ${i + 1}: invalid`;
    if (!q.id || typeof q.id !== "string") return `Question ${i + 1}: missing 'id'`;
    if (!q.text || typeof q.text !== "string") return `Question ${i + 1}: missing 'text'`;
    if (!Array.isArray(q.options) || q.options.length !== 4) return `Question ${i + 1}: options must be 4`;
    if (typeof q.correct !== "number" || q.correct < 0 || q.correct > 3) return `Question ${i + 1}: correct must be 0..3`;
  }
  return null;
}

async function putQuestionSetToR2(env, payload) {
  // sets/<courseId>/<template>/<timestamp>-<rand>.json
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `sets/${payload.course}/${payload.template}/${ts}-${rand}.json`;
  const body = JSON.stringify(payload, null, 2);
  await env.QUESTIONS.put(key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return key;
}

async function listQuestionSets(env, { course, template, prefixOnly } = {}) {
  let prefix = "sets/";
  if (course) prefix += `${course}/`;
  if (template) prefix += `${template}/`;
  const all = await env.QUESTIONS.list({ prefix, limit: 1000 });
  const items = (all?.objects || []).map((o) => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded,
  }));
  if (prefixOnly) {
    const set = new Set();
    for (const it of items) {
      const parts = it.key.split("/");
      if (parts.length >= 4) set.add(`${parts[1]}:${parts[2]}`);
    }
    return Array.from(set)
      .sort()
      .map((s) => {
        const [c, t] = s.split(":");
        return { course: c, template: t };
      });
  }
  return items;
}

// ---------- HTML داشبورد جدید (admin2) ----------
function admin2Html({ key }) {
  const k = key ? `?key=${encodeURIComponent(key)}` : "";
  return new Response(
`<!doctype html>
<html dir="rtl" lang="fa">
<head>
  <meta charset="utf-8" />
  <title>پنل ادمین سؤالات (ساده اما حرفه‌ای)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root{--b:#0ea5e9;--g:#10b981;--r:#ef4444;--bg:#fafafa;--bd:#e5e7eb}
    *{box-sizing:border-box}
    body{font-family:ui-sans-serif,system-ui,Tahoma;background:var(--bg);margin:0;padding:24px}
    .wrap{max-width:980px;margin:0 auto}
    h1{margin:0 0 16px 0}
    .card{background:#fff;border:1px solid var(--bd);border-radius:14px;padding:16px;margin:16px 0;box-shadow:0 2px 10px rgba(0,0,0,.04)}
    label{display:block;font-weight:600;margin:8px 0 6px}
    input[type=text], textarea, select{width:100%;padding:10px;border:1px solid var(--bd);border-radius:10px}
    textarea{min-height:120px}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
    .btn{background:var(--b);border:none;color:#fff;padding:10px 14px;border-radius:10px;cursor:pointer}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-outline{background:#fff;color:#111;border:1px solid var(--bd)}
    .btn-green{background:var(--g)}
    .btn-red{background:var(--r)}
    .muted{color:#6b7280}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border-bottom:1px solid var(--bd);padding:8px;text-align:right}
    .pill{display:inline-block;background:#eef6ff;color:#1d4ed8;border-radius:999px;padding:4px 10px;font-size:12px;border:1px solid #dbeafe}
    .flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .right{margin-inline-start:auto}
    .ok{color:#065f46}.err{color:#991b1b}
    kbd{background:#f5f5f5;border:1px solid #e5e5e5;border-bottom-width:3px;border-radius:6px;padding:0 6px}
    .small{font-size:12px}
  </style>
</head>
<body>
<div class="wrap">
  <h1>📚 پنل ادمین سؤالات</h1>

  <div class="card">
    <div class="flex">
      <div><b>گام ۱:</b> انتخاب/افزودن/ویرایش درس</div>
      <div class="right muted small">کلید دسترسی در URL بماند (<kbd>?key=...</kbd>)</div>
    </div>
    <div class="row">
      <div>
        <label>درس (منوی آبشاری)</label>
        <select id="courseSelect"></select>
        <div class="small muted" id="courseIdHint"></div>
      </div>
      <div>
        <label>افزودن درس جدید (عنوان فارسی)</label>
        <div class="flex">
          <input id="courseInput" type="text" placeholder="مثلاً: رشد، آمار، عصب‌روان‌شناسی"/>
          <button id="addCourseBtn" class="btn">افزودن</button>
        </div>
        <div class="muted small" style="margin-top:6px">برای هر عنوان، یک شناسهٔ پایدار ساخته می‌شود و با آن ذخیره می‌گردد.</div>
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <div>
        <label>ویرایش نام درس انتخابی</label>
        <div class="flex">
          <input id="renameInput" type="text" placeholder="نام جدید فارسی"/>
          <button id="renameBtn" class="btn btn-outline">تغییر نام</button>
        </div>
      </div>
      <div>
        <label>حذف درس</label>
        <div class="flex">
          <button id="deleteCourseBtn" class="btn btn-red btn-outline">حذف این درس</button>
        </div>
        <div class="small muted">حذف فقط متادیتا را پاک می‌کند؛ فایل‌های ست قبلی حذف نمی‌شوند.</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="flex">
      <div><b>گام ۲:</b> انتخاب قالب</div>
    </div>
    <div class="row3">
      <div>
        <label>قالب سؤال</label>
        <select id="templateSelect">
          <option value="konkoori">کنکوری</option>
          <option value="taalifi">تألیفی</option>
        </select>
      </div>
      <div class="muted small" style="align-self:end">👈 تعداد سؤالاتِ ست را کاربر داخل بازی انتخاب می‌کند.</div>
    </div>
  </div>

  <div class="card">
    <div class="flex">
      <div><b>گام ۳:</b> ساخت سؤال</div>
    </div>
    <label>متن سؤال</label>
    <textarea id="qText" placeholder="متن سؤال را بنویسید..."></textarea>

    <div class="row">
      <div><label>گزینه ۱</label><input id="opt1" type="text" /></div>
      <div><label>گزینه ۲</label><input id="opt2" type="text" /></div>
      <div><label>گزینه ۳</label><input id="opt3" type="text" /></div>
      <div><label>گزینه ۴</label><input id="opt4" type="text" /></div>
    </div>

    <div class="row">
      <div>
        <label>گزینه صحیح</label>
        <select id="correct">
          <option value="0">۱</option>
          <option value="1">۲</option>
          <option value="2">۳</option>
          <option value="3">۴</option>
        </select>
      </div>
      <div>
        <label>توضیح/پاسخ تشریحی (اختیاری)</label>
        <input id="explanation" type="text" placeholder="اختیاری"/>
      </div>
    </div>

    <div class="flex" style="margin-top:10px">
      <button id="addToDraft" class="btn">افزودن به پیش‌نویس</button>
      <button id="clearForm" class="btn btn-outline">پاک‌کردن فرم</button>
      <div class="right muted">پیش‌نویس پایین نمایش داده می‌شود.</div>
    </div>
  </div>

  <div class="card">
    <div class="flex">
      <div><b>گام ۴:</b> پیش‌نویس ست</div>
      <div class="right"><span class="pill" id="draftCount">۰ سؤال</span></div>
    </div>
    <table id="draftTable">
      <thead><tr><th>#</th><th>شناسه</th><th>سؤال</th><th>صحیح</th><th>عملیات</th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="flex" style="margin-top:10px">
      <button id="saveSet" class="btn btn-green">ذخیره در R2 (JSON)</button>
      <button id="clearDraft" class="btn btn-red btn-outline">حذف پیش‌نویس</button>
      <span id="status" class="right muted"></span>
    </div>
  </div>

  <div class="card">
    <div class="flex">
      <div><b>گزارش</b></div>
      <div class="right"><a id="listLink" target="_blank">مشاهدهٔ فهرست ست‌ها</a></div>
    </div>
    <div id="log" class="muted"></div>
  </div>
</div>

<script>
(function(){
  const qs = new URLSearchParams(location.search);
  const KEY = qs.get("key") || "";
  const api = (p) => KEY ? p + "?key=" + encodeURIComponent(KEY) : p;

  const courseSelect = document.getElementById("courseSelect");
  const courseIdHint  = document.getElementById("courseIdHint");
  const courseInput  = document.getElementById("courseInput");
  const addCourseBtn = document.getElementById("addCourseBtn");
  const renameInput  = document.getElementById("renameInput");
  const renameBtn    = document.getElementById("renameBtn");
  const deleteCourseBtn = document.getElementById("deleteCourseBtn");

  const templateSelect = document.getElementById("templateSelect");

  const qText = document.getElementById("qText");
  const opt1  = document.getElementById("opt1");
  const opt2  = document.getElementById("opt2");
  const opt3  = document.getElementById("opt3");
  const opt4  = document.getElementById("opt4");
  const correct = document.getElementById("correct");
  const explanation = document.getElementById("explanation");

  const addToDraft = document.getElementById("addToDraft");
  const clearForm  = document.getElementById("clearForm");
  const draftTable = document.getElementById("draftTable").querySelector("tbody");
  const draftCount = document.getElementById("draftCount");
  const saveSet    = document.getElementById("saveSet");
  const clearDraft = document.getElementById("clearDraft");
  const statusEl   = document.getElementById("status");
  const listLink   = document.getElementById("listLink");
  const logEl      = document.getElementById("log");

  listLink.href = api("/admin/list");

  let courses = []; // [{id,title}]
  let draft = [];

  function log(msg, isErr){
    const p = document.createElement("div");
    p.textContent = msg;
    p.className = isErr ? "err" : "ok";
    logEl.prepend(p);
  }

  function safeId(){
    return ("Q" + Date.now().toString(36) + Math.random().toString(36).slice(2,6)).toUpperCase();
  }

  function refreshCoursesUI(){
    courseSelect.innerHTML = "";
    if(courses.length === 0){
      courseSelect.innerHTML = '<option value="">— ابتدا درس اضافه کنید —</option>';
      courseIdHint.textContent = "";
      renameInput.value = "";
      return;
    }
    courses.forEach(c=>{
      const op = document.createElement("option");
      op.value = c.id;
      op.textContent = c.title;
      courseSelect.appendChild(op);
    });
    const cur = courses.find(c=>c.id===courseSelect.value) || courses[0];
    courseSelect.value = cur.id;
    courseIdHint.textContent = "شناسه: " + cur.id;
    renameInput.value = cur.title;
  }

  async function loadCourses(){
    try{
      const r = await fetch(api("/admin/courses"));
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || "courses fetch error");
      courses = j.courses || [];
      refreshCoursesUI();
    }catch(e){
      courseSelect.innerHTML = '<option value="">خطا در دریافت فهرست دروس</option>';
    }
  }

  courseSelect.addEventListener("change", ()=>{
    const cur = courses.find(c=>c.id===courseSelect.value);
    if(cur){
      courseIdHint.textContent = "شناسه: " + cur.id;
      renameInput.value = cur.title;
    }
  });

  addCourseBtn.addEventListener("click", async ()=>{
    const title = (courseInput.value || "").trim();
    if(!title){ alert("نام درس را وارد کنید"); return; }
    // فارسی مجاز است؛ id را سرور تولید می‌کند
    const r = await fetch(api("/admin/courses"), {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({ title })
    });
    const j = await r.json();
    if(j.ok){
      log("درس اضافه شد: " + title);
      courseInput.value = "";
      courses = j.courses || [];
      refreshCoursesUI();
    }else{
      alert("خطا: " + (j.error||""));
    }
  });

  renameBtn.addEventListener("click", async ()=>{
    const id = courseSelect.value;
    if(!id){ alert("درسی انتخاب نشده."); return; }
    const title = (renameInput.value||"").trim();
    if(!title){ alert("نام جدید را وارد کنید."); return; }
    const r = await fetch(api("/admin/courses"), {
      method:"PUT",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({ id, title })
    });
    const j = await r.json();
    if(j.ok){
      log("نام درس تغییر کرد.");
      courses = j.courses || [];
      refreshCoursesUI();
    }else{
      alert("خطا: " + (j.error||""));
    }
  });

  deleteCourseBtn.addEventListener("click", async ()=>{
    const id = courseSelect.value;
    if(!id){ alert("درسی انتخاب نشده."); return; }
    if(!confirm("درس حذف شود؟ (فقط متادیتا حذف می‌شود؛ فایل‌های R2 دست‌نخورده می‌مانند)")) return;
    const r = await fetch(api("/admin/courses&id="+encodeURIComponent(id)), { method:"DELETE" });
    const j = await r.json();
    if(j.ok){
      log("درس حذف شد.");
      courses = j.courses || [];
      refreshCoursesUI();
    }else{
      alert("خطا: " + (j.error||""));
    }
  });

  function refreshDraft(){
    draftTable.innerHTML = "";
    draft.forEach((q, i) => {
      const tr = document.createElement("tr");
      const sh = q.text.length > 60 ? q.text.slice(0,60) + "…" : q.text;
      tr.innerHTML = \`<td>\${i+1}</td><td class="small">\${q.id}</td><td>\${sh}</td><td>\${q.correct+1}</td>
        <td><button data-i="\${i}" class="rm btn btn-outline btn-red">حذف</button></td>\`;
      draftTable.appendChild(tr);
    });
    draftCount.textContent = \`\${draft.length} سؤال\`;
  }

  draftTable.addEventListener("click", (e)=>{
    const t = e.target.closest(".rm");
    if(!t) return;
    const i = Number(t.getAttribute("data-i"));
    draft.splice(i,1);
    refreshDraft();
  });

  function clearQuestionForm(){
    qText.value = "";
    opt1.value = ""; opt2.value = ""; opt3.value = ""; opt4.value = "";
    correct.value = "0";
    explanation.value = "";
    qText.focus();
  }

  document.getElementById("clearForm").addEventListener("click", clearQuestionForm);

  document.getElementById("addToDraft").addEventListener("click", ()=>{
    const text = (qText.value||"").trim();
    const o1 = (opt1.value||"").trim();
    const o2 = (opt2.value||"").trim();
    const o3 = (opt3.value||"").trim();
    const o4 = (opt4.value||"").trim();
    const c  = Number(correct.value);
    if(!text || !o1 || !o2 || !o3 || !o4){ alert("همه فیلدهای سؤال و گزینه‌ها لازم‌اند"); return; }
    draft.push({
      id: safeId(), // شناسهٔ یکتای سؤال
      text, options:[o1,o2,o3,o4], correct:c,
      ...(explanation.value ? { explanation: explanation.value } : {})
    });
    refreshDraft();
    clearQuestionForm();
  });

  document.getElementById("clearDraft").addEventListener("click", ()=>{
    if(confirm("کل پیش‌نویس پاک شود؟")){ draft = []; refreshDraft(); }
  });

  document.getElementById("saveSet").addEventListener("click", async ()=>{
    const courseId = courseSelect.value;
    const template = templateSelect.value;
    if(!courseId){ alert("ابتدا یک درس انتخاب یا اضافه کنید"); return; }
    if(draft.length === 0){ alert("هیچ سؤالی در پیش‌نویس نیست"); return; }

    const payload = { course: courseId, template, questions: draft };
    document.getElementById("status").textContent = "در حال ذخیره...";
    const r = await fetch(api("/admin/save-set"), {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if(j.ok){
      document.getElementById("status").textContent = "✅ ذخیره شد: " + j.key;
      log("ست ذخیره شد: " + j.key);
    }else{
      document.getElementById("status").textContent = "❌ " + (j.error||"خطا در ذخیره");
    }
  });

  // init
  loadCourses();
})();
</script>
</body>
</html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

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

    // ---------- پنل ادمین جدید ----------
    if (url.pathname === "/admin2" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      return admin2Html({ key });
    }

    // لیست ست‌ها (برای لینک داخل صفحه)
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

    // API: Courses - GET
    if (url.pathname === "/admin/courses" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      const courses = await getCourses(env);
      return new Response(JSON.stringify({ ok: true, courses }, null, 2), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // API: Courses - POST (add) — ورودی: { title }
    if (url.pathname === "/admin/courses" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      let body = {};
      try { body = await request.json(); } catch {}
      const title = String((body.title||"").trim());
      if (!title) {
        return new Response(JSON.stringify({ ok: false, error: "missing title" }), {
          status: 400, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      // ساخت id امن
      const id = makeSlugFromTitle(title);
      const courses = await getCourses(env);
      courses.push({ id, title });
      await saveCourses(env, courses);
      return new Response(JSON.stringify({ ok: true, courses }, null, 2), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // API: Courses - PUT (rename) — ورودی: { id, title }
    if (url.pathname === "/admin/courses" && request.method === "PUT") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      let body = {};
      try { body = await request.json(); } catch {}
      const id = String((body.id||"").trim());
      const title = String((body.title||"").trim());
      if (!id || !title) {
        return new Response(JSON.stringify({ ok: false, error: "missing id/title" }), {
          status: 400, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      const courses = await getCourses(env);
      const idx = courses.findIndex(c => c.id === id);
      if (idx === -1) {
        return new Response(JSON.stringify({ ok: false, error: "course not found" }), {
          status: 404, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      courses[idx].title = title; // فقط عنوان عوض می‌شود؛ id ثابت می‌ماند
      await saveCourses(env, courses);
      return new Response(JSON.stringify({ ok: true, courses }, null, 2), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // API: Courses - DELETE ?key=...&id=...
    if (url.pathname.startsWith("/admin/courses") && request.method === "DELETE") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      const id = url.searchParams.get("id") || "";
      if (!id) {
        return new Response(JSON.stringify({ ok: false, error: "missing id" }), {
          status: 400, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      const courses = await getCourses(env);
      const next = courses.filter(c => c.id !== id);
      await saveCourses(env, next);
      return new Response(JSON.stringify({ ok: true, courses: next }, null, 2), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // API: Save set
    if (url.pathname === "/admin/save-set" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      let payload = {};
      try { payload = await request.json(); } catch {}
      const err = validateQuestionSet(payload);
      if (err) {
        return new Response(JSON.stringify({ ok: false, error: err }), {
          status: 400, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      try {
        const keySaved = await putQuestionSetToR2(env, payload);
        return new Response(JSON.stringify({ ok: true, key: keySaved }, null, 2), {
          status: 200, headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: "R2 put error" }), {
          status: 500, headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
    }

    // ---------- ابزارهای دیباگ تلگرام ----------
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
