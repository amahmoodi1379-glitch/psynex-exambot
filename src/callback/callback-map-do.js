import { CALLBACK_TOKEN_TTL_SECONDS } from "./token-service.js";

export class CallbackMapDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  now() {
    return Date.now();
  }

  jsonResponse(body, { status = 200 } = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  async handlePut(request) {
    let payload = null;
    try {
      payload = await request.json();
    } catch (err) {
      return this.jsonResponse({ ok: false, error: "invalid-json" });
    }
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    const value = payload?.payload;
    const ttlSeconds = Number(payload?.ttlSeconds || CALLBACK_TOKEN_TTL_SECONDS);
    if (!key) return this.jsonResponse({ ok: false, error: "missing-key" });
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return this.jsonResponse({ ok: false, error: "invalid-ttl" });
    }
    const expiresAt = this.now() + Math.min(ttlSeconds, CALLBACK_TOKEN_TTL_SECONDS) * 1000;
    try {
      await this.storage.put(key, { payload: value, expiresAt }, {
        expiration: Math.floor(expiresAt / 1000),
      });
    } catch (err) {
      console.error("callback-map put error", err);
      return this.jsonResponse({ ok: false, error: "storage-failed" });
    }
    return this.jsonResponse({ ok: true, expiresAt });
  }

  async handleGet(request) {
    let payload = null;
    try {
      payload = await request.json();
    } catch (err) {
      return this.jsonResponse({ ok: false, error: "invalid-json" });
    }
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    if (!key) return this.jsonResponse({ ok: false, error: "missing-key" });
    let stored;
    try {
      stored = await this.storage.get(key);
    } catch (err) {
      console.error("callback-map get error", err);
      return this.jsonResponse({ ok: false, error: "storage-failed" });
    }
    if (!stored) {
      return this.jsonResponse({ ok: false, error: "missing" });
    }
    const expiresAt = Number(stored?.expiresAt) || 0;
    if (expiresAt && expiresAt <= this.now()) {
      try {
        await this.storage.delete(key);
      } catch (err) {
        console.error("callback-map delete error", err);
      }
      return this.jsonResponse({ ok: false, error: "expired" });
    }
    return this.jsonResponse({ ok: true, payload: stored.payload, expiresAt });
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/put") {
        return await this.handlePut(request);
      }
      if (request.method === "POST" && url.pathname === "/get") {
        return await this.handleGet(request);
      }
      return this.jsonResponse({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      console.error("callback-map fetch error", err);
      return this.jsonResponse({ ok: false, error: "exception" });
    }
  }
}
