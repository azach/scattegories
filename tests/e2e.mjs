// End-to-end: real Chrome pages (separate profiles = separate players) against the local
// Worker and page server — see lib.mjs. Raw WebSocket players stand in for a misbehaving or
// out-of-date client where a test needs one.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, done, APP, join, next, none, sleep, derivePid } from "./lib.mjs";

const WORKER_DIR = fileURLToPath(new URL("../worker", import.meta.url));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];

async function player(name) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((n) => { try { localStorage.setItem("lr.name", n); } catch {} }, name);
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept()); // "Finish game?" confirm
  page.on("pageerror", e => errors.push(name + ": " + e.message));
  return { ctx, page, name };
}
const countIs = (p, n, timeout = 15000) =>
  p.page.waitForFunction((n) => document.getElementById("playerCount").textContent.includes(n + " here"), n, { timeout });
const pageState = (p) => p.page.evaluate(() => ({ seed: state.seed, round: state.round, epoch: state.epoch, pid: myPid, status: netStatus }));
const has = (p, cls) => p.page.evaluate((c) => document.body.classList.contains(c), cls);
const buttonCount = (p, sel, text) => p.page.locator(`${sel} button`, { hasText: text }).count();

/* ================= A normal game ================= */
const host = await player("Hosty");
const guest = await player("Guesty");
let link, room;

await test("host creates a room and connects with a player id derived from its secret", async () => {
  await host.page.goto(APP);
  await host.page.click("#newGame");
  await countIs(host, 1);
  link = host.page.url();
  room = link.match(/#room=([a-z]{5})$/)[1];
  const secret = await host.page.evaluate((r) => localStorage.getItem("lr.secret." + r), room);
  assert.equal((await pageState(host)).pid, derivePid(room, secret));
});

await test("guest joins via link; both see 2 here with names and the host badge", async () => {
  await guest.page.goto(link);
  await countIs(guest, 2);
  await countIs(host, 2);
  const roster = await guest.page.locator("#roster").innerText();
  assert.match(roster, /Hosty/); assert.match(roster, /Guesty/); assert.match(roster, /host/i);
  assert.equal(await buttonCount(guest, "#lobbyControls", "Start round"), 0, "guest can't start");
});

await test("host picks 1 min; the guest's selector follows", async () => {
  await host.page.click('#durationSeg button[data-ms="60000"]');
  await guest.page.waitForSelector('#durationSeg button[data-ms="60000"].on', { timeout: 5000 });
});

await test("a round starts for both with the same letter and categories", async () => {
  await host.page.click("#lobbyControls button:has-text('Start round')");
  for (const p of [host, guest]) await p.page.waitForFunction(() => /^[A-Z]$/.test(document.getElementById("letter").textContent), null, { timeout: 10000 });
  assert.equal(await host.page.locator("#letter").textContent(), await guest.page.locator("#letter").textContent());
  assert.deepEqual(await host.page.locator(".item .cat").allTextContents(), await guest.page.locator(".item .cat").allTextContents());
  await host.page.fill("#ans0", "Hostanswer");
  await guest.page.fill("#ans0", "Guestanswer");
  await host.page.fill("#ans1", "The Beatles");
  await guest.page.fill("#ans1", "beatles!");
});

await test("Enter moves to the next answer; answers are capped at 60 characters", async () => {
  await guest.page.focus("#ans2");
  await guest.page.keyboard.press("Enter");
  assert.equal(await guest.page.evaluate(() => document.activeElement.id), "ans3");
  await guest.page.fill("#ans3", "x".repeat(80));
  assert.equal((await guest.page.inputValue("#ans3")).length, 60);
  await guest.page.fill("#ans3", "");
});

await test("guest refreshes mid-round and lands back in the same round", async () => {
  const letter = await guest.page.locator("#letter").textContent();
  await guest.page.reload();
  await countIs(guest, 2);
  await guest.page.waitForFunction((l) => document.getElementById("letter").textContent === l, letter, { timeout: 5000 });
  assert.equal(await guest.page.inputValue("#ans0"), "Guestanswer");
});

await test("host ends early; both review; 'The Beatles' and 'beatles!' count as duplicates", async () => {
  await host.page.click("#controls button:has-text('End round')");
  for (const p of [host, guest]) {
    await p.page.waitForFunction(() => document.body.classList.contains("review"), null, { timeout: 5000 });
    await p.page.waitForFunction(() => document.querySelectorAll('.ansrow[data-cat="0"]').length === 2, null, { timeout: 5000 });
  }
  const first = await guest.page.locator(".item").first().innerText();
  assert.match(first, /Hostanswer/); assert.match(first, /Guestanswer/);
  assert.equal(await host.page.locator('.ansrow.dupe[data-cat="1"]').count(), 2);
});

await test("guest claims a point; the host's scoreboard updates", async () => {
  await guest.page.locator(".item").first().locator(".scorebtn").click();
  await host.page.waitForFunction(() => /Guesty[\s\S]*1/.test(document.getElementById("scoreboard").innerText), null, { timeout: 5000 });
});

await test("a second tab takes over; the first is blocked until 'Use this tab' reloads it", async () => {
  const tab2 = await guest.ctx.newPage();
  tab2.on("pageerror", e => errors.push("tab2: " + e.message));
  await tab2.goto(link);
  await tab2.waitForFunction(() => document.getElementById("playerCount").textContent.includes("2 here"), null, { timeout: 15000 });
  await guest.page.waitForSelector("#blocker:not([hidden])", { timeout: 5000 });
  assert.equal(await guest.page.evaluate(() => document.getElementById("game").inert), true, "the game underneath is inert");
  assert.equal(await guest.page.evaluate(() => isHost()), false);
  await countIs(host, 2); // still 2, not 3
  await guest.page.click("#blockerBtn");
  await countIs(guest, 2);
  await tab2.waitForSelector("#blocker:not([hidden])", { timeout: 5000 });
  await tab2.close();
  await countIs(host, 2); // the original tab is the guest again
});

await test("server restart: both show reconnecting, then recover on their own", async () => {
  await countIs(guest, 2);
  execSync('pkill -f "wrangler dev"; sleep 1; pkill -f workerd; true');
  await host.page.waitForFunction(() => /reconnecting/.test(document.getElementById("playerCount").textContent), null, { timeout: 15000 });
  assert.match(await host.page.locator("#connStatus").innerText(), /Lost connection/);
  spawn("npx", ["wrangler", "dev", "--port", "8787"], { cwd: WORKER_DIR, stdio: "ignore", detached: true }).unref();
  await countIs(host, 2, 45000);
  await countIs(guest, 2, 45000);
  assert.equal(await host.page.locator('.ansrow[data-cat="0"]').count(), 2, "review intact");
});

const late = await player("Latey");
await test("a late joiner mid-review gets the round, answers and scores", async () => {
  await late.page.goto(link);
  await countIs(late, 3);
  await late.page.waitForFunction(() => document.body.classList.contains("review") && document.querySelectorAll('.ansrow[data-cat="0"]').length >= 2, null, { timeout: 8000 });
  await late.page.waitForFunction(() => /Guesty[\s\S]*1/.test(document.getElementById("scoreboard").innerText), null, { timeout: 5000 });
});

await test("when the host leaves mid-review a stand-in gets the controls, and gives them back", async () => {
  await host.page.click("#brandHome");
  await countIs(guest, 2);
  // exactly one of the two remaining players (the lower id) now has "New round"
  await guest.page.waitForTimeout(300);
  const counts = [await buttonCount(guest, "#reviewControls", "New round"), await buttonCount(late, "#reviewControls", "New round")];
  assert.deepEqual(counts.sort(), [0, 1], "stand-in buttons " + counts);
  await host.page.goto(link);
  await countIs(host, 3);
  await host.page.waitForSelector("#reviewControls button:has-text('New round')", { timeout: 5000 });
  await guest.page.waitForTimeout(300);
  assert.equal(await buttonCount(guest, "#reviewControls", "New round") + await buttonCount(late, "#reviewControls", "New round"), 0);
});

await test("new round + finish game (after confirming) reach everyone", async () => {
  await host.page.click("#reviewControls button:has-text('New round')");
  await guest.page.waitForFunction(() => !document.body.classList.contains("review"), null, { timeout: 5000 });
  await host.page.click("#controls button:has-text('End round')");
  await guest.page.waitForFunction(() => document.body.classList.contains("review"), null, { timeout: 5000 });
  await host.page.click("#reviewControls button:has-text('Finish game')");
  await guest.page.waitForFunction(() => document.body.classList.contains("insummary"), null, { timeout: 5000 });
  assert.match(await guest.page.locator("#summaryWinner").innerText(), /Guesty wins/);
});

await test("a player still on an old round can't pull summary viewers back into it", async () => {
  const st = await pageState(guest);
  const lagger = await join(room);
  lagger.send2({ t: "sync", d: { epoch: st.epoch, scores: {}, summary: false, round: { seed: "lagseed", startAt: Date.now() - 1000, round: st.round + 5, durationMs: 60000, ended: false, customCats: [] } } });
  lagger.send2({ t: "state", d: { seed: "lagseed", startAt: Date.now(), round: st.round + 6, durationMs: 60000, epoch: st.epoch } });
  await sleep(800);
  assert.equal(await has(guest, "insummary"), true);
  lagger.close();
});

await test("an invalid room link goes home", async () => {
  await late.page.goto(APP + "#room=toolongcode");
  await late.page.waitForFunction(() => document.getElementById("home").style.display === "block", null, { timeout: 3000 });
});

/* ================= Messages from a misbehaving player ================= */
const victim = await player("Victim");
let vroom, mallory;
const START = () => Date.now() + 2000;

await test("setup: a raw client joins a fresh room", async () => {
  await victim.page.goto(APP);
  await victim.page.click("#newGame");
  await countIs(victim, 1);
  vroom = victim.page.url().match(/#room=([a-z]{5})$/)[1];
  mallory = await join(vroom);
  mallory.send2({ t: "hello", d: { name: "Mallory" } }); // real clients announce themselves on join
  await countIs(victim, 2);
});

await test("a custom category can't inject markup", async () => {
  mallory.send2({ t: "state", d: { seed: "m1", startAt: START(), round: 1, durationMs: 60000, epoch: 0, customCats: ['<img src=x onerror="window.__xss=1">'] } });
  await victim.page.waitForFunction(() => state.seed === "m1", null, { timeout: 5000 });
  await sleep(300);
  assert.equal(await victim.page.evaluate(() => window.__xss), undefined);
  assert.ok((await victim.page.locator(".item .cat").allTextContents()).some(t => t.includes("<img")), "shown as text");
});

await test("non-numeric scores and a __proto__ key can't inject markup or pollute objects", async () => {
  mallory.send2({ t: "endnow", d: { seed: "m1" } });
  await victim.page.waitForFunction(() => document.body.classList.contains("review"), null, { timeout: 5000 });
  mallory.send2({ t: "score", d: { score: '<img src=x onerror="window.__xss2=1">', seed: "m1", epoch: 0, ts: Date.now() } });
  mallory.send2({ t: "sync", d: { epoch: 0, scores: JSON.parse(`{"__proto__":{"name":"x","rounds":{"1":5},"ts":{"1":1}},"${mallory.pid}":{"name":"<b>M</b>","rounds":{"1":"<img src=x onerror=\\"window.__xss3=1\\">"}}}`) } });
  await sleep(500);
  assert.deepEqual(await victim.page.evaluate(() => [window.__xss2, window.__xss3, ({}).ts, ({}).name]), [undefined, undefined, undefined, undefined]);
  assert.doesNotMatch(await victim.page.locator("#scoreboard").innerText(), /img/);
});

await test("answers for another board or an older game are ignored", async () => {
  mallory.send2({ t: "ans", d: { name: "M", seed: "other", epoch: 0, answers: { 0: "WRONGBOARD" } } });
  mallory.send2({ t: "ans", d: { name: "M", seed: "m1", epoch: -1, answers: { 0: "OLDGAME" } } });
  mallory.send2({ t: "ans", d: { name: "M", seed: "m1", epoch: 0, answers: { 0: "RIGHT" } } });
  await victim.page.waitForFunction(() => document.getElementById("sheet").innerText.includes("RIGHT"), null, { timeout: 5000 });
  const sheet = await victim.page.locator("#sheet").innerText();
  assert.doesNotMatch(sheet, /WRONGBOARD|OLDGAME/);
});

await test("two boards for one round settle on the earlier start, and the loser is told", async () => {
  const t0 = Date.now() + 3000;
  mallory.send2({ t: "state", d: { seed: "bbb", startAt: t0, round: 2, durationMs: 60000, epoch: 0 } });
  await victim.page.waitForFunction(() => state.seed === "bbb", null, { timeout: 5000 });
  mallory.send2({ t: "state", d: { seed: "aaa", startAt: t0 - 500, round: 2, durationMs: 60000, epoch: 0 } });
  await victim.page.waitForFunction(() => state.seed === "aaa", null, { timeout: 5000 });
  mallory.inbox.length = 0;
  mallory.send2({ t: "state", d: { seed: "ccc", startAt: t0 + 500, round: 2, durationMs: 60000, epoch: 0 } });
  const reply = await next(mallory, m => m.t === "sync");
  assert.equal(reply.d.round.seed, "aaa");
  assert.equal((await pageState(victim)).seed, "aaa");
});

await test("a quiet hello updates the roster without a sync reply; a normal one gets one", async () => {
  mallory.inbox.length = 0;
  mallory.send2({ t: "hello", d: { name: "Renamed", quiet: true } });
  await victim.page.waitForFunction(() => document.getElementById("roster").textContent.includes("Renamed"), null, { timeout: 3000 });
  await none(mallory, m => m.t === "sync", 600);
  mallory.send2({ t: "hello", d: { name: "Renamed" } });
  await next(mallory, m => m.t === "sync");
});

await test("typing a name sends one quiet hello once typing pauses, not one per key", async () => {
  await victim.page.evaluate(() => resetToLobby(state.epoch + 1)); // back to the lobby, where the name field is
  mallory.inbox.length = 0;
  await victim.page.fill("#nameInput", "");
  await victim.page.type("#nameInput", "Brand New Name", { delay: 30 });
  await sleep(900);
  const hellos = mallory.inbox.filter(m => m.t === "hello");
  assert.equal(hellos.length, 1, "hellos " + hellos.length);
  assert.equal(hellos[0].d.quiet, true);
  assert.equal(hellos[0].d.name, "Brand New Name");
});
mallory && mallory.close && mallory.close();

/* ================= Connection states ================= */
await test("with no connection there's no solo play: Start is disabled until it connects", async () => {
  const solo = await player("Offliney");
  await solo.page.route("**/session", r => r.abort());
  await solo.page.goto(APP);
  await solo.page.click("#newGame");
  await solo.page.waitForFunction(() => netStatus === "offline", null, { timeout: 20000 });
  assert.equal(await solo.page.locator("#lobbyControls button:has-text('Start round')").isDisabled(), true);
  assert.match(await solo.page.locator("#lobbyHint").innerText(), /once you're connected/);
  await solo.page.unroute("**/session");
  await solo.page.click("#offlineNote .linkbtn"); // Retry now
  await countIs(solo, 1);
  assert.equal(await solo.page.locator("#lobbyControls button:has-text('Start round')").isDisabled(), false);
  await solo.ctx.close();
});

await test("a tab paused in the background disconnects and reconnects when looked at", async () => {
  const a = await player("Pausey"), b = await player("Watchy");
  await a.page.goto(APP); await a.page.click("#newGame"); await countIs(a, 1);
  await b.page.goto(a.page.url()); await countIs(b, 2);
  await a.page.evaluate(() => pauseNet());
  assert.equal((await pageState(a)).status, "paused");
  await countIs(b, 1);
  await a.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await countIs(a, 2); await countIs(b, 2);
  await a.ctx.close(); await b.ctx.close();
});

await test("no page errors", async () => { assert.deepEqual(errors, []); });

await browser.close();
done();
