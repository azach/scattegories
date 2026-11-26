// Shared helpers for the protocol and browser tests. Both expect the local stack:
//   cd worker && cp .dev.vars.example .dev.vars && npm run dev    (Worker on :8787)
//   python3 -m http.server 8000                                     (repo root, page on :8000)
import WebSocket from "ws";
import { createHash, randomBytes } from "node:crypto";

export const BASE = "http://localhost:8787";
export const APP = "http://localhost:8000/index.html";
export const ORIGIN = "http://localhost:8000";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // what Cloudflare's always-pass test key yields

let failures = 0;
export async function test(name, fn) {
  try { await fn(); console.log("ok   ", name); }
  catch (e) { failures++; console.log("FAIL ", name, "-", String(e.message).split("\n")[0]); }
}
export function done() {
  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

// Locally the Worker trusts a client-sent CF-Connecting-IP (in production Cloudflare sets it),
// so each test can be its own "IP" and rate-limit counters don't leak between tests.
export const randomIp = () => `10.${r255()}.${r255()}.${r255()}`;
const r255 = () => Math.floor(Math.random() * 255);
export const rndRoom = () => Array.from({ length: 5 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
export const newSecret = () => randomBytes(16).toString("base64url");

export function session(ip = randomIp(), origin = ORIGIN) {
  return fetch(BASE + "/session", { method: "POST", body: DUMMY_TOKEN, headers: { Origin: origin, "CF-Connecting-IP": ip } });
}
export async function ticket(ip) { return (await (await session(ip)).json()).ticket; }

// Independent re-implementation of the id scheme (base32 of SHA-256), so a test can check
// the server and page agree with it rather than with each other.
export function derivePid(room, secret) {
  const hash = createHash("sha256").update(room + ":" + secret).digest();
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const b of hash) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < 60; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return "p" + out;
}

// A raw WebSocket player. `query` is appended verbatim, for tests that send malformed params.
export function connect(room, { secret = newSecret(), ticket: tk, ip = randomIp(), origin = ORIGIN, query } = {}) {
  const qs = query ?? `secret=${encodeURIComponent(secret)}&ticket=${encodeURIComponent(tk || "")}`;
  const ws = new WebSocket(`ws://localhost:8787/room/${room}?${qs}`, { headers: { Origin: origin, "CF-Connecting-IP": ip } });
  ws.secret = secret;
  ws.inbox = [];
  ws.waiters = [];
  ws.on("message", (d) => {
    const s = d.toString();
    const m = s === "pong" ? { t: "pong" } : JSON.parse(s);
    ws.inbox.push(m);
    ws.waiters = ws.waiters.filter(w => !w(m));
  });
  ws.closed = new Promise(res => ws.on("close", (code, reason) => res({ code, reason: reason.toString() })));
  ws.opened = new Promise((res, rej) => {
    ws.on("open", res); ws.on("error", rej);
    ws.on("unexpected-response", (_, r) => rej(new Error("HTTP " + r.statusCode)));
  });
  ws.send2 = (o) => ws.send(JSON.stringify(o));
  return ws;
}
// Connects with a fresh ticket and waits for the welcome. Resolves to the socket, or to the
// close code if the server refused it.
export async function join(room, opts = {}) {
  const ws = connect(room, { ...opts, ticket: opts.ticket || await ticket() });
  const r = await Promise.race([next(ws, m => m.t === "_welcome").then(w => { ws.pid = w.self; ws.welcome = w; return ws; }), ws.closed.then(c => c.code)]);
  return r;
}

export function next(ws, pred, ms = 4000) {
  const found = ws.inbox.find(pred);
  if (found) { ws.inbox.splice(ws.inbox.indexOf(found), 1); return Promise.resolve(found); }
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
    ws.waiters.push(m => { if (pred(m)) { clearTimeout(t); ws.inbox.splice(ws.inbox.indexOf(m), 1); res(m); return true; } return false; });
  });
}
export const none = (ws, pred, ms = 500) =>
  new Promise((res, rej) => setTimeout(() => (ws.inbox.find(pred) ? rej(new Error("unexpected message")) : res()), ms));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
