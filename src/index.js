import { tg } from "./bot/tg.js";
import { getCommand, shortId } from "./utils.js";
import {
  ACTIVE_TEMPLATES,
  ALLOWED_TEMPLATES,
  KNOWN_TEMPLATES,
  TEMPLATE_DISABLED_MESSAGE,
  TEMPLATE_KEYS,
} from "./constants.js";
export { RoomDO } from "./room/room-do.js"; // Durable Object کلاس

// ==============================
//   Helpers: کانال اجباری
// ==============================
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

// ==============================
//   R2: دوره‌ها و سؤال‌ها (ادمین)
// ==============================
const COURSES_KEY = "admin/courses.json"; // [{id,title}]
const QUESTIONS_PREFIX = "questions";

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
function makeSlugFromTitle(title) {
  const t = String(title || "").trim();
  const base = t
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "") // اجازهٔ حروف و اعداد همه زبان‌ها + - _
    .toLowerCase();
  const core = base || "course";
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${core}-${suffix}`;
}
function generateQuestionId() {
  return ("Q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
}
function sanitizeQuestionId(id, index, { allowGenerate = false } = {}) {
  let val = String(id || "").trim();
  if (!val) {
    if (allowGenerate) return generateQuestionId();
    throw new Error(`Question ${index + 1}: missing 'id'`);
  }
  const safe = val.replace(/[^A-Za-z0-9_-]+/g, "-");
  if (!safe) {
    if (allowGenerate) return generateQuestionId();
    throw new Error(`Question ${index + 1}: invalid id`);
  }
  return safe;
}
function normalizeQuestionInput(q, index, { allowMissingId = false } = {}) {
  if (!q || typeof q !== "object") throw new Error(`Question ${index + 1}: invalid`);
  const id = sanitizeQuestionId(q.id, index, { allowGenerate: allowMissingId });
  const text = String(q.text || "").trim();
  if (!text) throw new Error(`Question ${index + 1}: missing 'text'`);
  if (!Array.isArray(q.options) || q.options.length !== 4)
    throw new Error(`Question ${index + 1}: options must be 4`);
  const options = q.options.map((opt, optIdx) => {
    const val = String(opt || "").trim();
    if (!val) throw new Error(`Question ${index + 1}: option ${optIdx + 1} empty`);
    return val;
  });
  const correct = Number(q.correct);
  if (!Number.isInteger(correct) || correct < 0 || correct > 3)
    throw new Error(`Question ${index + 1}: correct must be 0..3`);
  const explanation = q.explanation ? String(q.explanation).trim() : undefined;
  const normalized = { id, text, options, correct };
  if (explanation) normalized.explanation = explanation;
  return normalized;
}
function ensureUniqueQuestionIds(questions) {
  const seen = new Set();
  for (const q of questions) {
    const id = q?.id;
    if (!id) continue;
    if (seen.has(id)) throw new Error(`Duplicate id detected: ${id}`);
    seen.add(id);
  }
}
function validateQuestionsPayload(payload) {
  if (!payload || typeof payload !== "object") return { error: "Invalid JSON" };
  const course = String((payload.course || "").trim());
  if (!course) return { error: "Missing 'course'" };
  const template = String((payload.template || "").trim());
  if (!template) return { error: "Missing 'template'" };
  if (!ALLOWED_TEMPLATES.has(template)) return { error: "template must be 'konkoori' or 'taalifi'" };

  let sourceQuestions = [];
  if (Array.isArray(payload.questions)) sourceQuestions = payload.questions;
  else if (payload.question && typeof payload.question === "object") sourceQuestions = [payload.question];
  else if (payload.id && payload.text && payload.options) sourceQuestions = [payload];
  if (!sourceQuestions.length) return { error: "No questions provided" };

  try {
    const normalized = sourceQuestions.map((q, idx) => normalizeQuestionInput(q, idx));
    ensureUniqueQuestionIds(normalized);
    return { course, template, questions: normalized };
  } catch (e) {
    return { error: e.message };
  }
}
function makeQuestionKey(course, template, questionId) {
  return `${QUESTIONS_PREFIX}/${course}/${template}/${questionId}.json`;
}
async function listQuestionObjects(env, { course, template, prefixOnly } = {}) {
  let prefix = `${QUESTIONS_PREFIX}/`;
  if (course) prefix += `${course}/`;
  if (template) prefix += `${template}/`;
  const objects = [];
  let cursor;
  do {
    const res = await env.QUESTIONS.list({ prefix, limit: 1000, cursor });
    const batch = res?.objects || [];
    for (const obj of batch) {
      const parts = obj.key.split("/");
      if (parts.length < 4) continue;
      const questionId = parts[3]?.replace(/\.json$/, "") || "";
      objects.push({
        key: obj.key,
        course: parts[1] || null,
        template: parts[2] || null,
        questionId,
        size: obj.size,
        uploaded: obj.uploaded,
      });
    }
    cursor = res?.truncated ? res.cursor : null;
  } while (cursor);
  if (prefixOnly) {
    const seen = new Map();
    for (const obj of objects) {
      const key = `${obj.course || ""}:${obj.template || ""}`;
      if (!seen.has(key)) seen.set(key, { course: obj.course, template: obj.template });
    }
    return Array.from(seen.values()).sort((a, b) => {
      const courseA = a.course || "";
      const courseB = b.course || "";
      if (courseA === courseB) return (a.template || "").localeCompare(b.template || "");
      return courseA.localeCompare(courseB);
    });
  }
  return objects;
}
async function readQuestionObject(env, key) {
  try {
    const obj = await env.QUESTIONS.get(key);
    if (!obj) return null;
    const txt = await obj.text();
    const parsed = JSON.parse(txt);
    const normalized = normalizeQuestionInput(parsed, 0);
    const parts = key.split("/");
    const fallbackCourse = parts[1] || null;
    const fallbackTemplate = parts[2] || null;
    return {
      ...normalized,
      course: parsed.course || fallbackCourse,
      template: parsed.template || fallbackTemplate,
      savedAt: parsed.savedAt || null,
    };
  } catch (err) {
    console.error("Failed to read question", key, err);
    return null;
  }
}
async function putQuestionsToR2(env, { course, template, questions }, { skipExisting = false } = {}) {
  const keys = [];
  const skipped = [];
  for (const q of questions) {
    const key = makeQuestionKey(course, template, q.id);
    if (skipExisting) {
      const head = await env.QUESTIONS.head(key);
      if (head) {
        skipped.push(key);
        continue;
      }
    }
    const payload = {
      ...q,
      course,
      template,
      savedAt: q.savedAt || new Date().toISOString(),
    };
    await env.QUESTIONS.put(key, JSON.stringify(payload, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    keys.push(key);
  }
  return { keys, skipped };
}
async function migrateLegacySets(env) {
  const results = {
    setsProcessed: 0,
    totalQuestions: 0,
    written: 0,
    skipped: 0,
    writtenKeys: [],
    skippedKeys: [],
    errors: [],
  };
  let cursor;
  do {
    const res = await env.QUESTIONS.list({ prefix: "sets/", limit: 1000, cursor });
    const objects = res?.objects || [];
    for (const obj of objects) {
      results.setsProcessed += 1;
      try {
        const file = await env.QUESTIONS.get(obj.key);
        if (!file) throw new Error("object missing");
        const txt = await file.text();
        const parsed = JSON.parse(txt);
        const { error, course, template, questions } = validateQuestionsPayload(parsed);
        if (error) throw new Error(error);
        results.totalQuestions += questions.length;
        const { keys, skipped } = await putQuestionsToR2(env, { course, template, questions }, { skipExisting: true });
        results.written += keys.length;
        results.skipped += skipped.length;
        results.writtenKeys.push(...keys);
        results.skippedKeys.push(...skipped);
      } catch (err) {
        results.errors.push({ key: obj.key, error: err.message || String(err) });
      }
    }
    cursor = res?.truncated ? res.cursor : null;
  } while (cursor);
  return results;
}

// ==============================
/*   HTML: داشبورد ادمین (admin2) */
// ==============================
function admin2Html({ key }) {
  const k = key ? `?key=${encodeURIComponent(key)}` : "";
  return new Response(
`<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<title>پنل ادمین سؤالات</title>
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
.small{font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border-bottom:1px solid var(--bd);padding:8px;text-align:right}
.pill{display:inline-block;background:#eef6ff;color:#1d4ed8;border-radius:999px;padding:4px 10px;font-size:12px;border:1px solid #dbeafe}
.flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.right{margin-inline-start:auto}
.ok{color:#065f46}.err{color:#991b1b}
kbd{background:#f5f5f5;border:1px solid #e5e5e5;border-bottom-width:3px;border-radius:6px;padding:0 6px}
code{background:#f3f4f6;border-radius:6px;padding:0 6px;font-family:ui-monospace,monospace;font-size:12px}
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
        <div class="small muted">حذف فقط متادیتا را پاک می‌کند؛ فایل‌های سؤال‌ها دست‌نخورده می‌مانند.</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="flex"><div><b>گام ۲:</b> انتخاب قالب</div></div>
    <div class="row3">
      <div>
        <label>قالب سؤال</label>
        <select id="templateSelect">
          <option value="${TEMPLATE_KEYS.KONKOORI}" selected>کنکوری</option>
          <option value="${TEMPLATE_KEYS.TAALIFI}" disabled>تألیفی (فعلاً غیرفعال)</option>
          <option value="${TEMPLATE_KEYS.MIX}" disabled>ترکیبی (فعلاً غیرفعال)</option>
        </select>
        <div class="small muted">قالب‌های تألیفی و ترکیبی <span style="white-space:nowrap;">فعلاً غیرفعال است.</span></div>
      </div>
      <div class="muted small" style="align-self:end">👈 تعداد سؤال را کاربر داخل بازی انتخاب می‌کند.</div>
    </div>
  </div>

  <div class="card">
    <div class="flex"><div><b>گام ۳:</b> ساخت سؤال</div></div>
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
    <div class="flex"><div><b>گام ۳٫۵:</b> درون‌ریزی JSON خام</div></div>
    <label>چسباندن JSON خام</label>
    <textarea id="jsonImport" placeholder='[{"text":"...","options":["A","B","C","D"],"correct":0}]'></textarea>
    <div class="muted small" style="margin-top:6px">ساختار مورد انتظار: آرایه‌ای از اشیای سؤال با فیلدهای <code>id</code> (اختیاری)، <code>text</code>، <code>options</code> (۴ مورد)، <code>correct</code> (۰ تا ۳) و <code>explanation</code> اختیاری.</div>
    <div class="flex" style="margin-top:10px">
      <button id="importJsonBtn" class="btn btn-outline">افزودن از JSON</button>
      <span id="importStatus" class="small muted"></span>
    </div>
  </div>

  <div class="card">
    <div class="flex">
      <div><b>گام ۴:</b> پیش‌نویس سؤال‌ها</div>
      <div class="right"><span class="pill" id="draftCount">۰ سؤال</span></div>
    </div>
    <table id="draftTable">
      <thead><tr><th>#</th><th>شناسه</th><th>سؤال</th><th>صحیح</th><th>عملیات</th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="flex" style="margin-top:10px">
      <button id="saveSet" class="btn btn-green">ذخیره سؤال‌ها در R2</button>
      <button id="clearDraft" class="btn btn-red btn-outline">حذف پیش‌نویس</button>
      <span id="status" class="right muted"></span>
    </div>
  </div>

  <div class="card">
    <div class="flex">
      <div><b>گزارش</b></div>
      <div class="right"><a id="listLink" target="_blank">مشاهدهٔ فهرست سؤال‌ها</a></div>
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
  const importTextarea = document.getElementById("jsonImport");
  const importBtn = document.getElementById("importJsonBtn");
  const importStatus = document.getElementById("importStatus");

  listLink.href = api("/admin/list");

  let courses = []; // [{id,title}]
  let draft = [];

  function log(msg, isErr){
    const p = document.createElement("div");
    p.textContent = msg;
    p.className = isErr ? "err" : "ok";
    logEl.prepend(p);
  }
  function setImportStatus(msg, isErr){
    if(!importStatus) return;
    importStatus.textContent = msg || "";
    importStatus.className = msg ? (isErr ? "small err" : "small ok") : "small muted";
  }
  const generateQuestionId = ${generateQuestionId.toString()};
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
    const base = api("/admin/courses");
    const sep = base.includes("?") ? "&" : "?";
    const r = await fetch(base + sep + "id=" + encodeURIComponent(id), { method:"DELETE" });
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
  document.getElementById("clearForm").addEventListener("click", ()=>{
    qText.value = "";
    opt1.value = ""; opt2.value = ""; opt3.value = ""; opt4.value = "";
    correct.value = "0";
    explanation.value = "";
    qText.focus();
  });
  document.getElementById("addToDraft").addEventListener("click", ()=>{
    const text = (qText.value||"").trim();
    const o1 = (opt1.value||"").trim();
    const o2 = (opt2.value||"").trim();
    const o3 = (opt3.value||"").trim();
    const o4 = (opt4.value||"").trim();
    const c  = Number(correct.value);
    if(!text || !o1 || !o2 || !o3 || !o4){ alert("همه فیلدهای سؤال و گزینه‌ها لازم‌اند"); return; }
    const expl = (explanation.value||"").trim();
    draft.push({
      id: generateQuestionId(),
      text,
      options:[o1,o2,o3,o4],
      correct:c,
      ...(expl ? { explanation: expl } : {})
    });
    refreshDraft();
    qText.value = ""; opt1.value = ""; opt2.value = ""; opt3.value = ""; opt4.value = ""; correct.value = "0"; explanation.value = "";
  });
  document.getElementById("clearDraft").addEventListener("click", ()=>{
    if(confirm("کل پیش‌نویس پاک شود؟")){ draft = []; refreshDraft(); }
  });
  if(importBtn){
    importBtn.addEventListener("click", async ()=>{
      const raw = (importTextarea.value||"").trim();
      if(!raw){ setImportStatus("ابتدا JSON را بچسبانید.", true); return; }
      setImportStatus("در حال ارسال به سرور...", false);
      try{
        const r = await fetch(api("/admin/import-json"), {
          method:"POST",
          headers:{"content-type":"application/json"},
          body: raw
        });
        const j = await r.json().catch(()=>({}));
        if(!r.ok || !j.ok){
          const msg = j && j.error ? j.error : "خطا " + r.status;
          setImportStatus("❌ " + msg, true);
          return;
        }
        const normalized = Array.isArray(j.questions) ? j.questions : [];
        if(!normalized.length){
          setImportStatus("❌ هیچ سؤالی از سرور بازگشت داده نشد.", true);
          return;
        }
        const existing = new Set(draft.map(q=>q.id));
        const added = [];
        normalized.forEach(q=>{
          let newId = q.id || generateQuestionId();
          while(existing.has(newId)){
            newId = generateQuestionId();
          }
          existing.add(newId);
          draft.push({ ...q, id: newId });
          added.push(newId);
        });
        refreshDraft();
        importTextarea.value = "";
        setImportStatus("✅ " + added.length + " سؤال اضافه شد.", false);
        if(added.length){
          log("افزودن از JSON: " + added.join(", "));
        }
      }catch(err){
        setImportStatus("❌ خطا در ارتباط با سرور", true);
      }
    });
  }
  document.getElementById("saveSet").addEventListener("click", async ()=>{
    const courseId = courseSelect.value;
    const template = templateSelect.value;
    if(!courseId){ alert("ابتدا یک درس انتخاب یا اضافه کنید"); return; }
    if(draft.length === 0){ alert("هیچ سؤالی در پیش‌نویس نیست"); return; }
    const payload = { course: courseId, template, questions: draft };
    statusEl.textContent = "در حال ذخیره...";
    const r = await fetch(api("/admin/save-set"), {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if(j.ok){
      const saved = Array.isArray(j.keys) ? j.keys.length : 0;
      const skipped = Array.isArray(j.skipped) ? j.skipped.length : 0;
      statusEl.textContent = "✅ " + saved + " سؤال ذخیره شد" + (skipped ? "، " + skipped + " مورد از قبل وجود داشت" : "") + ".";
      draft = [];
      refreshDraft();
      if(saved){
        log("سؤال‌ها ذخیره شد (" + saved + "): " + j.keys.join(", "));
      }
      if(skipped){
        log("⏭️ " + skipped + " سؤال از قبل در R2 وجود داشت و رد شد.");
      }
    }else{
      statusEl.textContent = "❌ " + (j.error||"خطا در ذخیره");
    }
  });
  loadCourses();
})();
</script>
</body>
</html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ==============================
//   Worker اصلی (Webhook + Admin)
// ==============================
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

      // متن‌ها (کامند)
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

          const kb = {
            inline_keyboard: [
              [{ text: "📚 انتخاب درس", callback_data: `cl:${roomId}` }],
              [
                { text: "کنکوری", callback_data: `t:${roomId}:${TEMPLATE_KEYS.KONKOORI}` },
                { text: "تألیفی (فعلاً غیرفعال)", callback_data: `tdisabled:${roomId}:${TEMPLATE_KEYS.TAALIFI}` },
                { text: "ترکیبی (فعلاً غیرفعال)", callback_data: `tdisabled:${roomId}:${TEMPLATE_KEYS.MIX}` },
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
            "🎮 بازی جدید ساخته شد.\n۱) «📚 انتخاب درس» را بزنید.\n۲) قالب را انتخاب کنید (فعلاً فقط کنکوری فعال است).\n۳) حالت ۵ یا ۱۰ سؤال.\n۴) شرکت‌کننده‌ها «✅ آماده‌ام»، شروع‌کننده «🟢 آغاز بازی»." + joinLine,
            { reply_markup: kb }
          );
          return new Response("ok", { status: 200 });
        }

        // /start برای PV (مرور پاسخ‌ها)
        if (cmd === "/start" && chat_type === "private") {
          const parts = (msg.text || "").trim().split(/\s+/);
          const payload = parts.length > 1 ? parts.slice(1).join(" ") : "";

          if (!payload) {
            await tg.sendMessage(env, chat_id, "سلام! وقتی بازی تمام شد، از لینک «🔍 مرور پاسخ‌ها» داخل گروه وارد شوید.");
            return new Response("ok", { status: 200 });
          }

          if (payload.startsWith("rv:")) {
            const [, encChat, rid] = payload.split(":");
            if (!encChat || !rid) {
              await tg.sendMessage(env, chat_id, "payload نامعتبر است.");
              return new Response("ok", { status: 200 });
            }
            // decode base64url
            function ub64url(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; try{ return atob(s);}catch{return "";} }
            const chatPlain = ub64url(encChat);
            const groupChatId = chatPlain ? Number(chatPlain) : NaN;
            if (!Number.isFinite(groupChatId)) {
              await tg.sendMessage(env, chat_id, "payload نامعتبر است.");
              return new Response("ok", { status: 200 });
            }

            const key = `${groupChatId}-${rid}`;
            const stub = env.ROOMS.get(env.ROOMS.idFromName(key));
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

      // دکمه‌های اینلاین
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

        async function removeInlineKeyboard() {
          if (!chat_id || !msg.message_id) return;
          await tg.call(env, "editMessageReplyMarkup", {
            chat_id,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        }

        if (act === "tdisabled") {
          await tg.answerCallback(env, cq.id, TEMPLATE_DISABLED_MESSAGE, true);
          return new Response("ok", { status: 200 });
        }

        // لیست دروس
        if (act === "cl") {
          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const courses = await getCourses(env); // [{id,title}]
          if (!courses.length) {
            await tg.answerCallback(env, cq.id, "هیچ درسی تعریف نشده.", true);
            return new Response("ok", { status: 200 });
          }
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

        // انتخاب درس
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
              out.error === "already-started" ? "بازی آغاز شده." : "خطا", true);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "درس تنظیم شد.");
          await tg.sendMessage(env, chat_id, `📚 درس انتخابی: <b>${out.courseId}</b>`);
          return new Response("ok", { status: 200 });
        }

        // انتخاب قالب
        if (act === "t") {
          const tpl = parts[2];
          if (!tpl || !KNOWN_TEMPLATES.has(tpl)) {
            await tg.answerCallback(env, cq.id, "خطا", true);
            return new Response("ok", { status: 200 });
          }
          if (!ACTIVE_TEMPLATES.has(tpl)) {
            await tg.answerCallback(env, cq.id, TEMPLATE_DISABLED_MESSAGE, true);
            return new Response("ok", { status: 200 });
          }

          const ok = await ensureMemberOrNotify();
          if (!ok) return new Response("ok", { status: 200 });

          const r = await stub.fetch("https://do/template", {
            method: "POST",
            body: JSON.stringify({ by_user: from.id, template: tpl }),
          });
          const out = await r.json();
          if (!out.ok) {
            await tg.answerCallback(env, cq.id,
              out.error === "only-starter" ? "فقط شروع‌کننده می‌تواند قالب را تعیین کند." :
              out.error === "already-started" ? "بازی آغاز شده." :
              out.error === "template-disabled" ? TEMPLATE_DISABLED_MESSAGE :
              "خطا", true);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "قالب تنظیم شد.");
          await tg.sendMessage(env, chat_id, `🧩 قالب: <b>${out.template}</b>`);
          return new Response("ok", { status: 200 });
        }

        // حالت ۵/۱۰
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

        if (act === "gr") {
          const r = await stub.fetch("https://do/group-review", {
            method: "POST",
            body: JSON.stringify({}),
          });
          const out = await r.json();
          if (!out.ok) {
            const errorMessages = {
              "not-ended": "بازی هنوز تمام نشده است.",
              "no-room": "اتاق پیدا نشد.",
              "no-questions": "سؤالی برای نمایش وجود ندارد.",
            };
            const msgText = errorMessages[out.error] || "خطا در دریافت مرور گروهی.";
            await tg.answerCallback(env, cq.id, msgText, true);
            if (chat_id) await tg.sendMessage(env, chat_id, `⚠️ ${msgText}`);
            return new Response("ok", { status: 200 });
          }
          await tg.answerCallback(env, cq.id, "ارسال شد ✅");
          if (chat_id) await tg.sendMessage(env, chat_id, out.text);
          await removeInlineKeyboard();
          return new Response("ok", { status: 200 });
        }
      }

      return new Response("ok", { status: 200 });
    }

    // ---------- پنل ادمین جدید ----------
    if (url.pathname === "/admin2" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Unauthorized", { status: 401 });
      return admin2Html({ key });
    }

    // لیست سؤال‌ها
    if (url.pathname === "/admin/list" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      const course = url.searchParams.get("course") || "";
      const template = url.searchParams.get("template") || "";
      const prefixOnly = url.searchParams.get("pairs") === "1";
      const items = await listQuestionObjects(env, { course: course || undefined, template: template || undefined, prefixOnly });
      return new Response(JSON.stringify({ ok: true, items }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    // Courses API
    if (url.pathname === "/admin/courses" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      const courses = await getCourses(env);
      return new Response(JSON.stringify({ ok: true, courses }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/admin/courses" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      let body = {}; try { body = await request.json(); } catch {}
      const title = String((body.title||"").trim());
      if (!title)
        return new Response(JSON.stringify({ ok: false, error: "missing title" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      const id = makeSlugFromTitle(title);
      const courses = await getCourses(env);
      courses.push({ id, title });
      await saveCourses(env, courses);
      return new Response(JSON.stringify({ ok: true, courses }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/admin/courses" && request.method === "PUT") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      let body = {}; try { body = await request.json(); } catch {}
      const id = String((body.id||"").trim());
      const title = String((body.title||"").trim());
      if (!id || !title)
        return new Response(JSON.stringify({ ok: false, error: "missing id/title" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      const courses = await getCourses(env);
      const idx = courses.findIndex(c => c.id === id);
      if (idx === -1)
        return new Response(JSON.stringify({ ok: false, error: "course not found" }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      courses[idx].title = title;
      await saveCourses(env, courses);
      return new Response(JSON.stringify({ ok: true, courses }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/admin/courses" && request.method === "DELETE") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      const id = url.searchParams.get("id") || "";
      if (!id)
        return new Response(JSON.stringify({ ok: false, error: "missing id" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      const courses = await getCourses(env);
      const next = courses.filter(c => c.id !== id);
      await saveCourses(env, next);
      return new Response(JSON.stringify({ ok: true, courses: next }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/admin/migrate-sets" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      try {
        const results = await migrateLegacySets(env);
        return new Response(JSON.stringify({ ok: true, ...results }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message || "migration error" }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    }

    if (url.pathname === "/admin/import-json" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      let raw = "";
      try {
        raw = await request.text();
      } catch {}
      let parsed;
      try {
        parsed = JSON.parse(raw || "null");
      } catch {
        return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : null;
      if (!list || !list.length)
        return new Response(JSON.stringify({ ok: false, error: "Expected an array of questions" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      try {
        const normalized = list.map((q, idx) => normalizeQuestionInput(q, idx, { allowMissingId: true }));
        ensureUniqueQuestionIds(normalized);
        return new Response(JSON.stringify({ ok: true, questions: normalized }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message || "validation error" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    }

    // Save questions
    if (url.pathname === "/admin/save-set" && request.method === "POST") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
      let payload = {}; try { payload = await request.json(); } catch {}
      const { error, course, template, questions } = validateQuestionsPayload(payload);
      if (error)
        return new Response(JSON.stringify({ ok: false, error }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
      try {
        const { keys, skipped } = await putQuestionsToR2(env, { course, template, questions });
        return new Response(JSON.stringify({ ok: true, keys, skipped }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: "R2 put error" }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    }

    // ---------- دیباگ تلگرام ----------
    if (url.pathname === "/tg/register") {
      const webhookUrl = new URL("/webhook", request.url).toString();
      const out = await tg.call(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TG_WEBHOOK_SECRET,
        drop_pending_updates: true,
        allowed_updates: ["message", "callback_query"],
      });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });
    }
    if (url.pathname === "/tg/info") {
      const out = await tg.call(env, "getWebhookInfo", {});
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });
    }

    // ---------- Health ----------
    if (url.pathname === "/") return new Response("psynex-exambot: OK", { status: 200 });
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });

    return new Response("Not Found", { status: 404 });
  },
};
