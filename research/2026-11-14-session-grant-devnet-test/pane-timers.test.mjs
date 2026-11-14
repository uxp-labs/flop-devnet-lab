// F8 and F15: session-reads.js run as the page runs it (pane.mjs), over a transport stub and a
// clock this test moves. Each question has a limit of 12 s, kept in the tape as "no answer in 12 s";
// a whole sessionTape, blockTape or probe ends within 40 s whatever the node does; the probe sends
// state_call only at a 32 byte hash of the block it means. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneKeys } from "./lib.mjs";
import { plan, V } from "./fixtures.mjs";
import { page, plain } from "./pane.mjs";
import { rerunNode, RERUN } from "./rerun-node.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const K = await paneKeys(plan, V("OWNER"), DEV1);
const SK = { lru: K.lru, sessions: K.sessions, nonces: K.nonces, breakers: K.breakers, session_count: K.session_count, rotation_history: K.rotation_history };
const turn = () => new Promise((r) => setTimeout(r, 1));

/** A clock for the page: setTimeout and clearTimeout that run only when the test moves the time. */
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (i) => { timers.delete(i); },
    now: () => now,
    /** Moves the time by ms, one timer at a time, letting the page's promises run between. */
    async move(ms) {
      const end = now + ms;
      for (;;) {
        for (let i = 0; i < 5; i++) await turn();
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = end;
      for (let i = 0; i < 5; i++) await turn();
    },
  };
}

/** A transport over the recorded node at A6 that never answers the methods (or params) a test names. */
function transport(silent = () => false) {
  const node = rerunNode("A6"), asked = [];
  return { asked, node, request: (m, p) => { asked.push({ m, p }); if (silent(m, p)) return new Promise(() => {}); try { return Promise.resolve(node.answer(m, p)); } catch (e) { return Promise.reject(e); } } };
}

const reader = (t, c) => page().sessionReads.createReader({ transport: t, nowIso: () => "2026-11-14T00:00:00.000Z", setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
const settle = async (p, c, ms) => { let v = null; p.then((x) => { v = x; }); await c.move(ms); return v; };

test("F15: the limits are 12 s a question and 40 s a read", () => {
  const g = page();
  assert.equal(g.sessionReads.QUESTION_MS, 12000);
  assert.equal(g.sessionReads.WHOLE_MS, 40000);
});

test("F15: a question with no answer in 12 s is kept as such in the tape, and the read goes on", async () => {
  const c = clock();
  const t = transport((m, p) => m === "state_getStorage" && p[0] === K.nonces);
  const p = reader(t, c).sessionTape(SK);
  const r = plain(await settle(p, c, 12000));
  assert.ok(r, "the tape is done after one limit of 12 s");
  const e = r.tape.find((x) => x.params[0] === K.nonces);
  assert.deepEqual(e, { method: "state_getStorage", params: [K.nonces, r.head.hash], no_answer: "no answer in 12 s" });
  assert.ok(r.tape.some((x) => x.params[0] === K.breakers), "the next question is asked");
  assert.equal(r.deadline, undefined);
});

test("F15: a node that answers each question after 11 s: each read ends within 40 s, marked not finished, and asks nothing after", async () => {
  for (const what of ["sessionTape", "blockTape", "probe"]) {
    const c = clock();
    const node = rerunNode("A6"), asked = [];
    const t = { request: (m, p) => { asked.push(m); return new Promise((res, rej) => c.setTimeout(() => { try { res(node.answer(m, p)); } catch (e) { rej(e); } }, 11000)); } };
    const rd = reader(t, c);
    const b = node.blockOf("A2");
    const p = what === "sessionTape" ? rd.sessionTape(SK) : what === "blockTape" ? rd.blockTape({ lru: K.lru, events: K.events }, b.number, b.hash) : rd.probe(Number(V("PROBE_BACK")));
    assert.equal(await settle(p, c, 39999), null, `${what}: not before 40 s`);
    const r = plain(await settle(p, c, 1));
    assert.ok(r, `${what} ended at 40 s`);
    if (what === "probe") { assert.equal(r.answered, false); assert.equal(r.refusal.message, "not finished in 40 s"); }
    else { assert.equal(r.deadline, "not finished in 40 s"); assert.ok(r.tape.length >= 3 && r.tape.every((x) => "result" in x || "error" in x), JSON.stringify(r.tape)); }
    const n = asked.length;
    await c.move(120000);
    assert.equal(asked.length, n, `${what}: no question after the end`);
  }
});

test("F15: a node that answers a question after its 12 s: the late answer is not taken", async () => {
  const c = clock();
  const node = rerunNode("A6");
  let late = null;
  const t = { request: (m, p) => (m === "chain_getFinalizedHead" ? new Promise((res) => { late = () => res(node.answer(m, p)); }) : Promise.resolve(node.answer(m, p))) };
  const p = reader(t, c).sessionTape(SK);
  await c.move(12000);
  late();
  const r = plain(await p);
  assert.deepEqual(r.tape.find((x) => x.method === "chain_getFinalizedHead"), { method: "chain_getFinalizedHead", params: [], no_answer: "no answer in 12 s" });
  assert.equal(r.head.hash, null);
});

test("F8: the probe sends state_call only at a 32 byte hash for the block it means; answered only for that call", async () => {
  for (const at of [null, "0xdead", 7, "0x" + "AB".repeat(32)]) {
    const c = clock();
    const t = transport();
    const base = t.request;
    t.request = (m, p) => (m === "chain_getBlockHash" && p[0] !== 0 && typeof p[0] === "number" && p[0] < 3552838 ? (t.asked.push({ m, p }), Promise.resolve(at)) : m === "state_call" ? (t.asked.push({ m, p }), Promise.resolve("0x00")) : base(m, p));
    const r = plain(await reader(t, c).probe(Number(V("PROBE_BACK"))));
    assert.ok(!t.asked.some((x) => x.m === "state_call"), JSON.stringify(at));
    assert.equal(r.answered, false);
    assert.match(r.refusal.message, /is not a 32 byte hash: no state_call is sent/);
  }
  const c = clock();
  const t = transport();
  const base = t.request, OLD = "0x" + "0b".repeat(32);
  t.request = (m, p) => (m === "chain_getBlockHash" && p[0] === 3552838 - 1000 ? Promise.resolve(OLD) : m === "state_call" ? (t.asked.push({ m, p }), Promise.resolve("0x0102")) : base(m, p));
  const r = plain(await reader(t, c).probe(1000));
  assert.deepEqual(plain(t.asked.find((x) => x.m === "state_call").p), ["Core_version", "0x", OLD]);
  assert.deepEqual(r.at, { number: 3552838 - 1000, hash: OLD });
  assert.equal(r.answered, true);
  assert.equal(r.length, 2);
});
