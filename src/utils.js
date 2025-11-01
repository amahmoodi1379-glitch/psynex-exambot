// ----- Utils (مشترک) -----
export const now = () => Date.now();

export const shortId = () =>
  now().toString(36).slice(-6) +
  Math.floor(Math.random() * 2176782336).toString(36).slice(-2);

const enc = new TextEncoder();

export const byteLen = (value) => {
  if (value === undefined || value === null) return 0;
  return enc.encode(String(value)).length;
};

async function ensureCrypto() {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  try {
    const { webcrypto } = await import("node:crypto");
    if (webcrypto?.subtle) {
      globalThis.crypto = webcrypto;
      return webcrypto;
    }
  } catch (_) {
    // ignore – Cloudflare محیط already provides crypto
  }
  throw new Error("Web Crypto API is not available");
}

export async function shortIdFrom(str, bytes = 6) {
  const crypto = await ensureCrypto();
  const d = await crypto.subtle.digest("SHA-256", enc.encode(String(str ?? "")));
  const v = new Uint8Array(d).slice(0, bytes);
  const b64 = btoa(String.fromCharCode(...v))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return b64;
}

function getBucket(env) {
  const bucket = env?.QUESTIONS;
  if (!bucket) throw new Error("QUESTIONS bucket is not configured");
  return bucket;
}

export async function ensureIdMap(env, sid, longKey) {
  const safeSid = String(sid || "").trim();
  const keyValue = String(longKey || "").trim();
  if (!safeSid || !keyValue) throw new Error("Missing sid or longKey for id map");

  const bucket = getBucket(env);
  const mapKey = `idmap/${safeSid}.json`;
  const mapValue = JSON.stringify({ key: keyValue });
  const httpMetadata = { contentType: "application/json; charset=utf-8" };

  const obj = await bucket.put(mapKey, mapValue, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata,
  });

  if (obj !== null) {
    return mapKey;
  }

  const existing = await bucket.get(mapKey);
  if (!existing) {
    throw new Error(`idmap race condition for ${safeSid}. Please retry.`);
  }

  let data;
  try {
    data = await existing.json();
  } catch (err) {
    console.error("Failed to validate idmap", mapKey, err);
    throw err;
  }

  if (data?.key && data.key !== keyValue) {
    throw new Error(`idmap collision for ${safeSid}`);
  }

  return mapKey;
}

export async function resolveIdMap(env, sid) {
  const safeSid = String(sid || "").trim();
  if (!safeSid) return null;
  const bucket = getBucket(env);
  const mapKey = `idmap/${safeSid}.json`;
  const obj = await bucket.get(mapKey);
  if (!obj) return null;
  try {
    const data = await obj.json();
    if (data && typeof data === "object" && typeof data.key === "string") {
      return { mapKey, key: data.key };
    }
  } catch (err) {
    console.error("Failed to parse idmap", mapKey, err);
  }
  return null;
}

export function validateInlineKeyboard(markup) {
  if (!markup) return;
  const rows = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (!btn || typeof btn !== "object") continue;
      const combos = ["url", "web_app", "callback_data"].filter((key) => key in btn);
      if (combos.length > 1) {
        throw new Error(`Incompatible button fields: ${combos.join(",")}`);
      }
      if ("callback_data" in btn) {
        if (typeof btn.callback_data !== "string") {
          throw new Error("callback_data must be string");
        }
        const L = byteLen(btn.callback_data);
        if (L < 1 || L > 64) {
          throw new Error(`callback_data exceeds 64 bytes (${L})`);
        }
        if (/\n/.test(btn.callback_data)) {
          throw new Error("callback_data contains newline");
        }
      }
    }
  }
}

// استخراج امن دستور حتی با @username
export function getCommand(msg) {
  const text = msg?.text || "";
  const entities = msg?.entities || [];
  const cmdEnt = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!cmdEnt) return null;
  const raw = text.substring(cmdEnt.offset, cmdEnt.offset + cmdEnt.length).toLowerCase();
  return raw.split("@")[0]; // "/startgame" | "/start"
}

// Deep-link encoder/decoder برای chat_id گروه
export function encChatId(chatId) {
  const n = Number(chatId);
  return n < 0 ? "n" + (-n).toString(36) : "p" + n.toString(36);
}
export function decChatId(s) {
  if (!s || typeof s !== "string") return null;
  if (s[0] === "n") return -parseInt(s.slice(1), 36);
  if (s[0] === "p") return parseInt(s.slice(1), 36);
  return null;
}
