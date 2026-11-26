// Relay server behaviour, driven with raw WebSockets. Run against `npm run dev` in worker/.
import assert from "node:assert/strict";
import {
  test, done, session, ticket, connect, join, next, none, sleep, derivePid, newSecret, randomIp, rndRoom, ORIGIN
} from "./lib.mjs";

const welcomed = (r) => typeof r === "object";

/* ---------- Access control ---------- */

await test("session: other origins are refused", async () => {
  assert.equal((await session(randomIp(), "https://evil.example")).status, 403);
});

await test("session: a Turnstile pass yields a unique signed ticket", async () => {
  const r = await session();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  const a = (await r.json()).ticket;
  assert.match(a, /^\d+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.notEqual(await ticket(), a, "two tickets issued in the same second differ");
});

await test("ws: other origins are refused", async () => {
  await assert.rejects(connect(rndRoom(), { ticket: await ticket(), origin: "https://evil.example" }).opened, /403/);
});

await test("ws: a missing, forged or tampered ticket closes with 4401", async () => {
  const t = await ticket();
  const [exp, nonce, sig] = t.split(".");
  const flip = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  for (const bad of ["", `${exp}.${nonce}.AAAA`, `${+exp + 99}.${nonce}.${sig}`, `${exp}.${flip(nonce)}.${sig}`]) {
    assert.equal((await connect(rndRoom(), { ticket: bad }).closed).code, 4401, bad);
  }
});

await test("ws: bad room codes and secrets close with 4400; pre-secret pages get 4426", async () => {
  const t = await ticket();
  assert.equal((await connect("ABCDE", { ticket: t }).closed).code, 4400);
  assert.equal((await connect("abcdef", { ticket: t }).closed).code, 4400);
  assert.equal((await connect(rndRoom(), { ticket: t, secret: "short" }).closed).code, 4400);
  // what an old cached page sends: a self-chosen pid and no secret
  assert.equal((await connect(rndRoom(), { query: `pid=pabcdef12&ticket=${t}` }).closed).code, 4426);
});

/* ---------- Identity ---------- */

await test("player ids are derived from the secret, so nobody can pick someone else's", async () => {
  const room = rndRoom();
  const secret = newSecret();
  const a = await join(room, { secret });
  assert.equal(a.pid, derivePid(room, secret), "server and the documented scheme agree");
  // A pid in the query is ignored; only the secret decides the id.
  const b = connect(room, { query: `secret=${newSecret()}&pid=${a.pid}&ticket=${await ticket()}` });
  const w = await next(b, m => m.t === "_welcome");
  assert.notEqual(w.self, a.pid);
  await none(a, m => m.t === "_x", 300);
  assert.equal(a.readyState, 1, "the original player wasn't booted");
  // The same secret in another room is a different player.
  const c = await join(rndRoom(), { secret });
  assert.notEqual(c.pid, a.pid);
  a.close(); b.close(); c.close();
});

/* ---------- Presence and relay ---------- */

await test("presence, relay, targeting, hello roster, reserved types, ping", async () => {
  const room = rndRoom();
  const a = await join(room);
  assert.deepEqual(a.welcome.peers, []);
  a.send2({ t: "hello", d: { name: "Alice", created: true, dur: 60000 } });
  await sleep(100);

  const b = await join(room);
  assert.equal(b.welcome.peers.length, 1);
  assert.deepEqual(b.welcome.peers[0], { pid: a.pid, info: { name: "Alice", created: true, dur: 60000, pid: a.pid } });
  assert.equal((await next(a, m => m.t === "_join")).pid, b.pid);

  b.send2({ t: "state", d: { x: 1 } });
  assert.deepEqual(await next(a, m => m.t === "state"), { t: "state", d: { x: 1 }, from: b.pid });
  await none(b, m => m.t === "state"); // no echo to the sender

  const c = await join(room);
  await next(a, m => m.t === "_join"); await next(b, m => m.t === "_join");
  a.send2({ t: "sync", d: 2, to: c.pid });
  assert.equal((await next(c, m => m.t === "sync")).from, a.pid);
  await none(b, m => m.t === "sync");

  a.send2({ t: "_leave", pid: b.pid }); // clients can't send the server's own message types
  await none(b, m => m.t === "_leave");

  a.send("ping");
  await next(a, m => m.t === "pong");

  c.close();
  assert.equal((await next(a, m => m.t === "_leave")).pid, c.pid);
  assert.equal((await next(b, m => m.t === "_leave")).pid, c.pid);
  a.close(); b.close();
});

await test("the same player reconnecting replaces the old socket without a leave", async () => {
  const room = rndRoom();
  const a = await join(room);
  const secret = newSecret();
  const b1 = await join(room, { secret });
  await next(a, m => m.t === "_join");
  const b2 = await join(room, { secret });
  assert.equal(b2.pid, b1.pid);
  assert.deepEqual(b2.welcome.peers.map(p => p.pid), [a.pid]);
  assert.equal((await b1.closed).code, 4001);
  await none(a, m => m.t === "_leave", 600);
  a.send2({ t: "state", d: 1 });
  await next(b2, m => m.t === "state");
  a.close(); b2.close();
});

await test("a malformed hello name is stored as empty rather than breaking the room", async () => {
  const room = rndRoom();
  const a = await join(room);
  let deep = []; for (let i = 0; i < 2000; i++) deep = [deep];
  a.send2({ t: "hello", d: { name: { toString: 1 }, created: false } });
  a.send2({ t: "hello", d: { name: deep } });
  a.send2({ t: "ok" });
  const b = await join(room);
  assert.equal(b.welcome.peers[0].info.name, "");
  a.close(); b.close();
});

/* ---------- Caps ---------- */

await test("a room holds 16 players", async () => {
  const room = rndRoom();
  const socks = [];
  for (let i = 0; i < 16; i++) socks.push(await join(room));
  assert.equal(await join(room), 4003);
  socks.forEach(s => s.close());
});

await test("one ticket can hold at most 2 sockets in a room (other rooms are separate)", async () => {
  const t = await ticket();
  const room = rndRoom();
  const a = await join(room, { ticket: t });
  const b = await join(room, { ticket: t });
  assert.ok(welcomed(a) && welcomed(b));
  assert.equal(await join(room, { ticket: t }), 4429);
  assert.ok(welcomed(await join(rndRoom(), { ticket: t })), "a different room is fine");
});

await test("oversized and malformed messages are dropped, not relayed", async () => {
  const room = rndRoom();
  const a = await join(room);
  const b = await join(room);
  a.send("not json");
  a.send2({ t: "x".repeat(40) });
  a.send2({ t: "big", d: "x".repeat(70 * 1024) });
  a.send2({ t: "ok" });
  await next(b, m => m.t === "ok");
  assert.equal(b.inbox.length, 0);
  a.close(); b.close();
});

await test("a socket flooding messages is throttled, then disconnected", async () => {
  const room = rndRoom();
  const a = await join(room);
  const b = await join(room);
  for (let i = 0; i < 200; i++) a.send2({ t: "react", d: i });
  assert.equal((await a.closed).code, 1008);
  await sleep(300);
  const relayed = b.inbox.filter(m => m.t === "react").length;
  assert.ok(relayed <= 80, "relayed " + relayed);
  b.close();
});

/* ---------- Rate limits (60s windows, so each uses its own ticket / IP) ---------- */

await test("session: an IP gets 10 Turnstile checks a minute, then 429", async () => {
  const ip = randomIp();
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await session(ip)).status);
  assert.deepEqual(codes, [...Array(10).fill(200), 429, 429]);
  assert.equal((await session()).status, 200, "a different IP is unaffected");
});

await test("ws: a ticket gets 30 connections a minute — counted per ticket, not per string", async () => {
  const t = await ticket();
  // The signature's last base64url character has spare bits, so altering it still verifies.
  // Those variants must share the original's budget.
  const last = t.slice(-1), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const variant = t.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
  const results = [];
  for (let i = 0; i < 32; i++) {
    const s = await join(rndRoom(), { ticket: i % 2 ? variant : t });
    results.push(welcomed(s) ? "ok" : s);
    if (welcomed(s)) s.close();
  }
  assert.deepEqual(results, [...Array(30).fill("ok"), 4429, 4429]);
  assert.ok(welcomed(await join(rndRoom())), "another ticket is unaffected");
});

await test("ws: an IP gets 100 connection attempts a minute, then 4429", async () => {
  // checked before the ticket, so attempts with junk tickets still count
  const ip = randomIp();
  const codes = [];
  for (let i = 0; i < 102; i++) codes.push((await connect(rndRoom(), { ip, ticket: "junk" }).closed).code);
  assert.deepEqual(codes, [...Array(100).fill(4401), 4429, 4429]);
});

await test("a ticket gets 400 relayed messages a minute across all its sockets", async () => {
  // Six sockets on one ticket (two per room — the cap) each stay under the per-socket limit,
  // but together they pass the ticket's budget, so some get disconnected.
  const t = await ticket();
  const socks = [];
  for (let r = 0; r < 3; r++) { const room = rndRoom(); socks.push(await join(room, { ticket: t }), await join(room, { ticket: t })); }
  socks.forEach(s => { for (let i = 0; i < 75; i++) s.send2({ t: "react", d: i }); });
  const codes = await Promise.all(socks.map(s => Promise.race([s.closed.then(c => c.code), sleep(3000).then(() => "open")])));
  assert.ok(codes.includes(1008), "codes " + codes.join(","));
  socks.forEach(s => s.close());
});

done();
