import { assertCallbackWithinLimit } from "../utils/callback-limit.js";

export const CALLBACK_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes
const DEFAULT_TOKEN_LENGTH = 10;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function ensureStub(env) {
  if (!env?.CALLBACKS || typeof env.CALLBACKS.idFromName !== "function") {
    throw new Error("CALLBACKS Durable Object binding is missing");
  }
  return env.CALLBACKS.get(env.CALLBACKS.idFromName("global"));
}

export function createCallbackStub(env) {
  return ensureStub(env);
}

export function generateCallbackToken(length = DEFAULT_TOKEN_LENGTH) {
  const size = Math.max(8, Math.min(length, 16));
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < size; i++) {
      out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    }
    return out;
  }
  // Fallback for environments without crypto.getRandomValues
  let out = "";
  for (let i = 0; i < size; i++) {
    const rand = Math.floor(Math.random() * TOKEN_ALPHABET.length);
    out += TOKEN_ALPHABET[rand];
  }
  return out;
}

async function postJson(stub, path, body) {
  const res = await stub.fetch(`https://callback${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  return { res, data };
}

export async function registerCallbackPayload(stub, { key, payload, ttlSeconds = CALLBACK_TOKEN_TTL_SECONDS }) {
  if (!stub) throw new Error("Missing callback stub");
  if (!key || typeof key !== "string") throw new Error("callback key must be string");
  assertCallbackWithinLimit(key, "callback");
  const { data } = await postJson(stub, "/put", { key, payload, ttlSeconds });
  if (!data?.ok) {
    const err = data?.error ? ` (${data.error})` : "";
    throw new Error(`Failed to register callback${err}`);
  }
  return key;
}

export async function resolveCallbackPayload(stub, key) {
  if (!stub) throw new Error("Missing callback stub");
  const { data } = await postJson(stub, "/get", { key });
  if (!data?.ok) return { ok: false, error: data?.error || "not-found" };
  return { ok: true, payload: data.payload };
}

export function makeCallbackKey(prefix, token) {
  const cleanedPrefix = String(prefix || "cb").trim();
  const cleanedToken = String(token || "").trim();
  const key = `${cleanedPrefix}:${cleanedToken}`;
  assertCallbackWithinLimit(key, "callback");
  return key;
}

export function buildCallbackKey(prefix, existingToken) {
  const token = existingToken && existingToken.length ? existingToken : generateCallbackToken();
  return { key: makeCallbackKey(prefix, token), token };
}

