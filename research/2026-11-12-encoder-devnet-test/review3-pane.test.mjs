// Review 3, attack C: the runner's submit and its WebSocket transport (V5). A fake WebSocket that
// we drive by hand counts every write; a store counts every mark. No network. No source file is changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto, createHash } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE } from "./lib.mjs";

const SRC = readFileSync(join(HERE, "pane-runner.js"), "utf8");
const load = () => { const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout }; vm.runInNewContext(SRC, g); return g.paneRunner; };
const sha = (t) => createHash("sha256").update(t).digest("hex");
const XT = "0x" + "b2".repeat(40);
const BUNDLE = JSON.stringify({ step: "T2", extrinsic: XT });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A WebSocket we drive: open(), answer(), close(); every send is logged; throwOnSend makes send throw. */
function fakeSocketClass() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.throwOnSend = false; sockets.push(this); }
    send(text) { if (this.throwOnSend) throw new Error("boom"); this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    answer(id, body) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, ...body }) }); }
    notify(sub, result) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "author_extrinsicUpdate", params: { subscription: sub, result } }) }); }
  }
  return { FakeWS, sockets };
}
const countingStore = () => { const adds = []; const m = new Set(); return { has: (k) => m.has(k), add: (k) => { adds.push(k); m.add(k); }, adds }; };
const submissions = (ws) => ws.sent.filter((m) => m.method === "author_submitAndWatchExtrinsic").length;

function setup(deadlineMs = 200) {
  const pr = load();
  const { FakeWS, sockets } = fakeSocketClass();
  const transport = pr.wsTransport(undefined, FakeWS);
  const store = countingStore();
  const lab = pr.createRunner({ transport, store, deadlineMs });
  return { lab, ws: sockets[0], store };
}

test("review3 C HELD: a close between the write and the answer: one write, one mark, connection-lost, from send", async () => {
  const { lab, ws, store } = setup();
  ws.open();
  const p = lab.send(BUNDLE, sha(BUNDLE));
  await wait(20);
  assert.equal(submissions(ws), 1);
  ws.close();
  const r = await p;
  assert.equal(r.status, "connection-lost");
  assert.equal(r.sent_by, "send");
  assert.equal(store.adds.length, 1);
  assert.equal(submissions(ws), 1);
});

test("review3 C HELD: a socket that opens late, before the deadline: one write, one mark, then the node's refusal", async () => {
  const { lab, ws, store } = setup(500);
  const p = lab.send(BUNDLE, sha(BUNDLE));
  await wait(30);
  assert.equal(submissions(ws), 0);
  assert.equal(store.adds.length, 0);
  ws.open();
  await wait(20);
  assert.equal(submissions(ws), 1);
  assert.equal(store.adds.length, 1, "marked after the write");
  ws.answer(ws.sent[0].id, { error: { code: 1010, message: "Invalid Transaction", data: "bad" } });
  const r = await p;
  assert.equal(r.status, "refused-at-submission");
  assert.equal(r.node.code, 1010);
});

test("review3 C HELD: a write that throws: no mark, not-sent, and a later send of the same bytes is still a first send", async () => {
  const { lab, ws, store } = setup();
  ws.open();
  ws.throwOnSend = true;
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "not-sent");
  assert.equal(store.adds.length, 0);
  ws.throwOnSend = false;
  const p = lab.send(BUNDLE, sha(BUNDLE));
  await wait(20);
  assert.equal(submissions(ws), 1);
  assert.equal(store.adds.length, 1);
  ws.answer(ws.sent[0].id, { error: { code: 1012, message: "x" } });
  assert.equal((await p).status, "refused-at-submission");
});

test("review3 C HELD: finalized, then the block read never answers: finalized-unread at the deadline, nothing written after it", async () => {
  const { lab, ws, store } = setup(150);
  ws.open();
  const p = lab.send(BUNDLE, sha(BUNDLE));
  await wait(10);
  ws.answer(ws.sent[0].id, { result: "sub1" });
  await wait(10);
  ws.notify("sub1", { finalized: "0x" + "cc".repeat(32) });
  const r = await p;
  assert.equal(r.status, "finalized-unread");
  assert.equal(r.block_hash, "0x" + "cc".repeat(32));
  const writes = ws.sent.length;
  await wait(50);
  assert.equal(ws.sent.length, writes, "nothing written after the end");
  assert.equal(store.adds.length, 1);
});

test("review3 C HELD: sendSame after a deadline writes once more and marks nothing new, and names itself", async () => {
  const { lab, ws, store } = setup(60);
  ws.open();
  const first = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(first.status, "deadline");
  const again = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(again.status, "already-sent");
  assert.equal(submissions(ws), 1);
  const p = lab.sendSame(BUNDLE, sha(BUNDLE));
  await wait(10);
  assert.equal(submissions(ws), 2);
  ws.answer(ws.sent.filter((m) => m.method === "author_submitAndWatchExtrinsic")[1].id, { error: { code: 1010, message: "Invalid Transaction", data: "Transaction is outdated" } });
  const r = await p;
  assert.equal(r.sent_by, "sendSame");
  assert.equal(store.adds.length, 1);
});

test("review3 C DEFECT low (V5): the results of send and sendSame that submit nothing do not say which call made them", async () => {
  const { lab, ws } = setup(60);
  ws.open();
  const bad = await lab.send(BUNDLE, "00".repeat(32));
  const notIn = await lab.sendSame(BUNDLE, sha(BUNDLE));
  await lab.send(BUNDLE, sha(BUNDLE));
  const already = await lab.send(BUNDLE, sha(BUNDLE));
  assert.deepEqual([bad.status, notIn.status, already.status], ["refused-bundle", "not-in-sent-list", "already-sent"]);
  const named = [bad, notIn, already].filter((r) => typeof r.sent_by === "string").length;
  assert.equal(named, 3, `each result names its call (V5): ${named} of 3 do`);
});
