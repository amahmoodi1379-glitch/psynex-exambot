export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("psynex-exambot: OK", { status: 200 });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, ts: Date.now() }),
        { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } }
      );
    }

    // جای وب‌هوک تلگرام در گام‌های بعدی:
    if (url.pathname.startsWith("/webhook")) {
      return new Response("Webhook placeholder", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
};
