// The Letter Round — room relay.
//
// One Durable Object per room code. Every player holds a single WebSocket to their room's
// object, which tracks who's present and relays game messages between them. The object
// doesn't interpret game state — the clients' existing merge/sync logic does that — it just
// makes delivery and presence reliable, which is the part peer-to-peer couldn't.
//
// Abuse protection, outermost first:
//   1. Origin allowlist — browsers can't forge Origin, so no other site can use this backend.
//   2. Turnstile — POST /session exchanges a Turnstile token for a signed ticket (HMAC, 7 days),
//      and every WebSocket upgrade must carry a valid ticket. Scripts can't get one without
//      passing a challenge.
//   3. Strict room codes / player ids — junk URLs never instantiate a Durable Object.
//   4. Per-room caps inside the object — player count, message size, message rate.

import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[a-z]{5}$/;
const PID_RE = /^p[a-z0-9]{4,16}$/;
const TICKET_TTL_S = 7 * 24 * 60 * 60;
const MAX_PLAYERS = 16;
const MAX_MSG_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_DROP = 150;    // messages per window before we start dropping
const RATE_KICK = 400;    // ...and before we disconnect the socket outright
const SWEEP_MS = 45_000;  // how often a live room checks for silently-dead sockets
const STALE_MS = 150_000; // no ping for this long = gone (allows for background-tab timer throttling)

// Application close codes the client understands.
const CLOSE_REPLACED = 4001; // same player connected again (refresh / another tab)
const CLOSE_FULL = 4003;
const CLOSE_STALE = 4008;
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_AUTH = 4401;     // missing/expired ticket — client should re-verify and retry

/* ---------------- Worker entry ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const originOk = allowedOrigins(env).includes(origin);

    if (url.pathname === "/session") {
      if (!originOk) return new Response("forbidden", { status: 403 });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders(origin) });
      return handleSession(request, env, origin);
    }

    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (m) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      if (!originOk) return new Response("forbidden", { status: 403 });
      const room = m[1];
      const pid = url.searchParams.get("pid") || "";
      // Rejections after this point are sent as a WebSocket close code, not an HTTP status:
      // browsers hide the HTTP status of a failed upgrade, so a close code is the only way
      // the client can tell "re-verify" from "bad link" from "server unreachable".
      if (!ROOM_RE.test(room) || !PID_RE.test(pid)) return closedSocket(CLOSE_BAD_REQUEST, "bad room or player id");
      if (!(await verifyTicket(env, url.searchParams.get("ticket") || ""))) return closedSocket(CLOSE_AUTH, "verification required");
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  }
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

function closedSocket(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/* ---------------- Turnstile → session ticket ---------------- */
async function handleSession(request, env, origin) {
  if (!env.TURNSTILE_SECRET || !env.SESSION_SECRET) return json({ error: "server not configured" }, 500, origin);
  // Sent as text/plain so the browser treats it as a "simple" request and skips the CORS
  // preflight — that halves the Worker requests each verification costs.
  const token = (await request.text()).trim();
  if (!token || token.length > 4096) return json({ error: "missing token" }, 400, origin);

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  let outcome;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    outcome = await r.json();
  } catch {
    return json({ error: "verification unavailable" }, 502, origin);
  }
  if (!outcome || outcome.success !== true) {
    // Turnstile's error codes (e.g. "invalid-input-secret") say whether the fault is the
    // visitor's token or this server's config, and reveal nothing secret.
    const codes = (outcome && outcome["error-codes"]) || [];
    console.log("turnstile rejected", JSON.stringify({ codes, hostname: outcome && outcome.hostname }));
    return json({ error: "verification failed", codes }, 403, origin);
  }

  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_S;
  const ticket = exp + "." + b64url(await hmac(env.SESSION_SECRET, String(exp)));
  return json({ ticket, exp }, 200, origin);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function hmac(secret, data) {
  return crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
}
async function verifyTicket(env, ticket) {
  if (!env.SESSION_SECRET) return false;
  const dot = ticket.indexOf(".");
  if (dot < 1) return false;
  const expStr = ticket.slice(0, dot);
  const exp = parseInt(expStr, 10);
  if (!/^\d+$/.test(expStr) || exp < Date.now() / 1000) return false;
  let sig;
  try { sig = unb64url(ticket.slice(dot + 1)); } catch { return false; }
  // subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), sig, new TextEncoder().encode(expStr));
}
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/* ---------------- Room ---------------- */
// Uses the WebSocket Hibernation API: between messages the object is evicted from memory
// and costs nothing, and the client's keepalive "ping" is answered by Cloudflare's edge
// without waking it at all. Anything that must survive hibernation lives in each socket's
// attachment; in-memory fields (rate counters) are best-effort and fine to lose.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.rates = new WeakMap(); // ws -> { start, count }
    this.gone = new WeakSet(); // sockets we've already announced as left
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pid = url.searchParams.get("pid");

    // A player reconnecting (refresh, network blip, second tab) replaces their old socket
    // instead of appearing twice — and the old one is closed right away rather than
    // lingering as a ghost until it times out.
    const others = [];
    for (const ws of this.live()) {
      const a = ws.deserializeAttachment();
      if (a.pid === pid) {
        a.replaced = true;
        try { ws.serializeAttachment(a); } catch {}
        this.gone.add(ws);
        try { ws.close(CLOSE_REPLACED, "connected elsewhere"); } catch {}
      } else {
        others.push(ws);
      }
    }
    if (others.length >= MAX_PLAYERS) return closedSocket(CLOSE_FULL, "room full");

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid, info: null, joinedAt: Date.now() });
    server.send(JSON.stringify({
      t: "_welcome",
      self: pid,
      peers: others.map(ws => { const a = ws.deserializeAttachment(); return { pid: a.pid, info: a.info }; })
    }));
    this.send(others, { t: "_join", pid });

    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (this.gone.has(ws)) return; // already closed by us — drop anything still queued from it
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return;
    if (!this.allow(ws)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string" || !msg.t || msg.t.length > 16 || msg.t[0] === "_") return;

    const a = ws.deserializeAttachment();
    // Remember each player's latest hello so newcomers get the full roster in _welcome,
    // without waiting for everyone to re-announce.
    if (msg.t === "hello" && msg.d && typeof msg.d === "object") {
      a.info = {
        name: String(msg.d.name || "").slice(0, 20),
        created: !!msg.d.created,
        dur: Number.isFinite(msg.d.dur) ? msg.d.dur : null,
        pid: a.pid
      };
      ws.serializeAttachment(a);
    }

    const out = { t: msg.t, d: msg.d, from: a.pid };
    const targets = this.live().filter(o => o !== ws && (typeof msg.to !== "string" || o.deserializeAttachment().pid === msg.to));
    this.send(targets, out);
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    this.leave(ws);
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  // Periodic sweep for sockets that died without a close frame (phone lost signal, laptop
  // slept) — otherwise they'd sit in everyone's roster, and if the ghost was the host, nobody
  // could start a round. Stops rescheduling itself once the room is empty.
  async alarm() {
    const now = Date.now();
    for (const ws of this.live()) {
      const a = ws.deserializeAttachment();
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(a.joinedAt || 0, pinged ? pinged.getTime() : 0);
      if (now - last > STALE_MS) {
        try { ws.close(CLOSE_STALE, "timed out"); } catch {}
        this.leave(ws);
      }
    }
    if (this.live().length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  live() {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN && !this.gone.has(ws));
  }

  send(sockets, obj) {
    const s = JSON.stringify(obj);
    for (const ws of sockets) { try { ws.send(s); } catch {} }
  }

  leave(ws) {
    if (this.gone.has(ws)) return;
    this.gone.add(ws);
    let a;
    try { a = ws.deserializeAttachment(); } catch { return; }
    if (!a || a.replaced) return;
    if (this.live().some(o => o.deserializeAttachment().pid === a.pid)) return; // they're still here on another socket
    this.send(this.live(), { t: "_leave", pid: a.pid });
  }

  allow(ws) {
    const now = Date.now();
    let r = this.rates.get(ws);
    if (!r || now - r.start > RATE_WINDOW_MS) { r = { start: now, count: 0 }; this.rates.set(ws, r); }
    r.count++;
    if (r.count > RATE_KICK) {
      try { ws.close(1008, "rate limit"); } catch {}
      this.leave(ws);
      return false;
    }
    return r.count <= RATE_DROP;
  }
}
