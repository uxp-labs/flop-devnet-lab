// Tests of pane-runner.js (rule R6 of the first brief; X1 to X9 of the fix brief) against a scripted
// node: node --test in this folder. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE, loadPlan, sha256Text } from "./lib.mjs";

const SRC = readFileSync(join(HERE, "pane-runner.js"), "utf8");
const plan = loadPlan();
const EVENTS_KEY = plan.values.EVENTS_KEY.value;

/** The file run as a page runs it: a fresh global with what a browser gives, and nothing else. */
function load(extra = {}) {
  const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(SRC, g);
  return g.paneRunner;
}

const sha = (t) => createHash("sha256").update(t).digest("hex");
const XT = "0x" + "a1".repeat(40);
const BUNDLE = JSON.stringify({ step: "T3", extrinsic: XT });
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const EVENTS = "0x0c" + "00".repeat(30);
const EVENTS_SHA = sha(Buffer.from(EVENTS.slice(2), "hex"));
const plainOf = (x) => JSON.parse(JSON.stringify(x));

/**
 * A scripted node: answers by method from a table, and plays a list of statuses to a watch. Every
 * request and every submission is logged. It reports the write of a submission, as the WebSocket
 * transport does.
 */
function scriptedNode({ statuses = [], refuse = null, blocks = {}, canonical = null, head = 10 } = {}) {
  const log = [], submitted = [];
  const byNumber = (n) => Object.keys(blocks).find((h) => blocks[h].number === n);
  const answers = {
    chain_getFinalizedHead: () => H(head),
    chain_getHeader: ([h]) => ({ number: "0x" + (blocks[h]?.number ?? head).toString(16) }),
    state_getRuntimeVersion: () => ({ specName: plan.values.SPEC_NAME.value, specVersion: 1014020, transactionVersion: 2 }),
    chain_getBlockHash: ([n]) => (n === 0 ? plan.values.GENESIS.value : canonical ?? byNumber(n) ?? H(1000 + n)),
    chain_getBlock: ([h]) => ({ block: { extrinsics: blocks[h]?.extrinsics ?? [] } }),
    state_getStorage: ([k, h]) => (k === EVENTS_KEY ? blocks[h]?.events ?? null : null),
    state_queryStorageAt: ([keys, h]) => [{ block: h, changes: keys.filter((k) => k !== "0xdead").map((k) => [k, k === "0x01" ? null : "0x2a00000000000000"]) }],
    system_accountNextIndex: () => 3,
  };
  const transport = {
    request: async (method, params) => { log.push(method); const f = answers[method]; if (!f) throw { code: -32601, message: `no ${method}` }; return f(params); },
    subscribe: async (method, params, unsub, on, onWrite) => {
      log.push(method);
      submitted.push(params[0]);
      onWrite();
      if (refuse) throw refuse;
      let i = 0;
      const play = () => { if (i < statuses.length) { const s = statuses[i++]; setTimeout(() => { on(s); play(); }, 2); } };
      play();
      return { unsubscribe: () => { log.push(unsub); } };
    },
  };
  return { transport, log, submitted };
}

const memStore = () => { const m = new Set(); return { has: (k) => m.has(k), add: (k) => m.add(k), m }; };
const runner = (node, o = {}) => load().createRunner({ transport: node.transport, store: memStore(), deadlineMs: 1000, ...o });

test("R6 X7: a finalized extrinsic: its block's hash and number, its index, and the sha256 and length of its block's System.Events", async () => {
  const node = scriptedNode({ statuses: ["ready", { inBlock: H(11) }, { finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: ["0x00", "0x01", XT], events: EVENTS } } });
  const lab = runner(node);
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.equal(r.block_hash, H(11));
  assert.equal(r.block_number, 11);
  assert.equal(r.extrinsic_index, 2);
  assert.equal(r.events_sha256, EVENTS_SHA, "the rerun's events_value_sha256: the sha256 of the value's bytes");
  assert.equal(r.events_length, 31);
  assert.equal(r.events_raw, undefined, "the raw events are not in the result");
  assert.equal(lab.last.events_raw, EVENTS, "they stay on the runner for the lead's eyes");
  assert.equal(r.bundle_sha256, sha(BUNDLE), "the result carries the sha256 of the bundle it sent");
  assert.equal(r.extrinsic_sha256, sha(XT));
  assert.equal(r.step, "T3");
  assert.deepEqual(node.submitted, [XT]);
  assert.ok(node.log.includes("author_unwatchExtrinsic"));
});

test("X8: send, sendSame, find, accountReads and deviceReads return the exact text to relay and its sha256", async () => {
  const node = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } }, head: 11 });
  const lab = runner(node);
  const results = [await lab.send(BUNDLE, sha(BUNDLE)), await lab.sendSame(BUNDLE, sha(BUNDLE)), await lab.find(XT, 5), await lab.accountReads("5Owner"), await lab.deviceReads("5Device", "0x02")];
  for (const r of results) {
    const { relay, relay_sha256, ...value } = r;
    assert.equal(relay, JSON.stringify(value), "the relay text is the value");
    assert.equal(relay_sha256, sha256Text(relay));
    assert.ok(relay.length < 900, `short: ${relay.length}`);
  }
});

test("R6: a bundle whose sha256 is not the one given is refused and nothing is sent", async () => {
  const node = scriptedNode({ statuses: [{ finalized: H(11) }] });
  const lab = runner(node);
  const r = await lab.send(BUNDLE, sha(BUNDLE + " "));
  assert.equal(r.status, "refused-bundle");
  assert.deepEqual(node.submitted, []);
  const bad = JSON.stringify({ step: "T3" });
  assert.equal((await lab.send(bad, sha(bad))).status, "refused-bundle");
  assert.equal((await lab.sendSame(BUNDLE, sha(BUNDLE + " "))).status, "refused-bundle");
  assert.deepEqual(node.submitted, []);
});

test("R6: the same extrinsic is never sent twice by send, even after a refusal or a deadline", async () => {
  const store = memStore();
  const node = scriptedNode({ refuse: { code: 1010, message: "Invalid Transaction", data: "Transaction is outdated" } });
  const lab = load().createRunner({ transport: node.transport, store, deadlineMs: 50 });
  assert.equal((await lab.send(BUNDLE, sha(BUNDLE))).status, "refused-at-submission");
  const again = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(again.status, "already-sent");
  const lab2 = load().createRunner({ transport: node.transport, store, deadlineMs: 50 });
  assert.equal((await lab2.send(BUNDLE, sha(BUNDLE))).status, "already-sent", "a new runner on the same store does not send it either");
  assert.equal(node.submitted.length, 1);
});

test("R6: the page's localStorage keeps what was sent across a reload of the runner", async () => {
  const items = {};
  const localStorage = { getItem: (k) => (k in items ? items[k] : null), setItem: (k, v) => { items[k] = v; } };
  const node = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } } });
  assert.equal((await load({ localStorage }).createRunner({ transport: node.transport }).send(BUNDLE, sha(BUNDLE))).status, "finalized");
  assert.equal((await load({ localStorage }).createRunner({ transport: node.transport }).send(BUNDLE, sha(BUNDLE))).status, "already-sent");
  assert.equal(node.submitted.length, 1);
});

test("R6: a refusal at submission is reported with the node's words and not retried", async () => {
  const node = scriptedNode({ refuse: { code: 1010, message: "Invalid Transaction", data: "Transaction has a bad signature" } });
  const r = await runner(node, { deadlineMs: 200 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "refused-at-submission");
  assert.deepEqual({ ...r.node }, { code: 1010, message: "Invalid Transaction", data: "Transaction has a bad signature" });
  assert.equal(node.log.filter((m) => m === "author_submitAndWatchExtrinsic").length, 1);
});

test("R6: no block before the deadline is reported as such, not final", async () => {
  const r = await runner(scriptedNode({ statuses: ["ready"] }), { deadlineMs: 40 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "deadline");
  assert.equal(r.in_block, null);
  assert.equal(r.final, false);
});

test("R6: an extrinsic in a block that never becomes final is reported with that block, not final", async () => {
  const r = await runner(scriptedNode({ statuses: ["ready", { inBlock: H(12) }] }), { deadlineMs: 60 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "deadline");
  assert.equal(r.in_block, H(12));
  assert.equal(r.final, false);
  assert.equal(r.block_hash, undefined, "no block is named as its block");
});

test("X1: one table of statuses: future, ready, broadcast, inBlock and retracted go on; usurped, finalityTimeout, dropped and invalid end with the node's word", async () => {
  const pr = load();
  assert.deepEqual(plainOf(pr.STATUSES), { future: "watch", ready: "watch", broadcast: "watch", inBlock: "remember", retracted: "forget", finalized: "final", usurped: "end", finalityTimeout: "end", dropped: "end", invalid: "end" });
  assert.match(SRC, /no committed file of this repo shows them/, "the file says where the shapes come from");
  const fin = { blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } } };
  for (const s of ["future", "ready", { broadcast: ["peer1", "peer2"] }, { inBlock: H(12) }, { retracted: H(12) }]) {
    const r = await runner(scriptedNode({ statuses: [s, { finalized: H(11) }], ...fin })).send(BUNDLE, sha(BUNDLE));
    assert.equal(r.status, "finalized", JSON.stringify(s));
  }
  for (const s of ["dropped", "invalid", { usurped: H(5) }, { finalityTimeout: H(12) }]) {
    const r = await runner(scriptedNode({ statuses: ["ready", s, { finalized: H(11) }], ...fin })).send(BUNDLE, sha(BUNDLE));
    assert.equal(r.status, "ended", JSON.stringify(s));
    assert.equal(r.node_status, typeof s === "string" ? s : Object.keys(s)[0]);
  }
  const r = await runner(scriptedNode({ statuses: [{ inBlock: H(12) }, { retracted: H(12) }, { dropped: null }] })).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.in_block, null, "a retracted block is forgotten");
});

test("X1: a status not in the table is kept in statuses and never ends the watch", async () => {
  const odd = [{ somethingNew: 1 }, "weird", 7, { a: 1, b: 2 }];
  const node = scriptedNode({ statuses: [...odd, { finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } } });
  const lab = runner(node);
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.deepEqual(plainOf(r.statuses), [...odd, "finalized"]);
  const w = await runner(scriptedNode({ statuses: [{ somethingNew: 1 }] }), { deadlineMs: 40 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(w.status, "deadline");
});

test("R6: a finalized block that does not hold the extrinsic, or is not at its height, is not passed as found", async () => {
  const a = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: ["0x00"], events: EVENTS } } });
  const r1 = await runner(a).send(BUNDLE, sha(BUNDLE));
  assert.equal(r1.status, "finalized-not-found");
  assert.equal(r1.extrinsic_index, null);
  const b = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } }, canonical: H(99) });
  assert.equal((await runner(b).send(BUNDLE, sha(BUNDLE))).status, "finalized-not-canonical");
});

test("R6: heads, reads, the owner's reads and the device's reads: the node's answers, raw", async () => {
  const node = scriptedNode();
  const lab = runner(node);
  const h = await lab.heads();
  assert.deepEqual(plainOf(h), { runtime: { specName: plan.values.SPEC_NAME.value, specVersion: 1014020, transactionVersion: 2, genesisHash: plan.values.GENESIS.value }, finalized: { number: 10, hash: H(10) } });
  const r = await lab.read(["0x01", "0x02", "0xdead"], H(10));
  assert.deepEqual(plainOf(r), { block_hash: H(10), values: { "0x01": null, "0x02": "0x2a00000000000000" }, not_answered: ["0xdead"] });
  const d = await lab.deviceReads("5Device", "0x02");
  assert.deepEqual(JSON.parse(d.relay), { account: "5Device", runtime: plainOf(h.runtime), birth: { number: 10, hash: H(10) }, account_nonce: 3, session_nonce_raw: "0x2a00000000000000" });
  const n = await lab.deviceReads("5Device", "0x01");
  assert.equal(JSON.parse(n.relay).session_nonce_raw, null, "a session nonce not stored is null, raw");
  await assert.rejects(lab.deviceReads("5Device", "0xdead"), /did not answer/);
  const o = await lab.accountReads("5Owner");
  assert.deepEqual(JSON.parse(o.relay), { account: "5Owner", runtime: plainOf(h.runtime), finalized: { number: 10, hash: H(10) }, account_nonce: 3 });
});

/** A fake WebSocket: opens, answers the node's methods, and can be told to close. */
function fakeSocket({ neverOpen = false, closeAfterSubmit = false, statuses = [{ finalized: H(11) }] } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); if (!neverOpen) setTimeout(() => { this.readyState = 1; this.onopen(); }, 1); else setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); }, 1); }
    send(text) {
      if (this.readyState !== 1) throw new Error("a send on a socket that is not open");
      const m = JSON.parse(text);
      this.sent.push(m);
      const reply = (o) => setTimeout(() => this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", ...o }) }), 1);
      if (m.method === "author_submitAndWatchExtrinsic") {
        this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", method: "author_extrinsicUpdate", params: { subscription: "s1", result: "ready" } }) });
        reply({ id: m.id, result: "s1" });
        if (closeAfterSubmit) setTimeout(() => { this.readyState = 3; this.onclose({ code: 1006 }); }, 4);
        else statuses.forEach((s, i) => setTimeout(() => this.onmessage({ data: JSON.stringify({ method: "author_extrinsicUpdate", params: { subscription: "s1", result: s } }) }), 5 + i));
      } else if (m.method === "chain_getHeader") reply({ id: m.id, result: { number: "0xb" } });
      else if (m.method === "chain_getFinalizedHead") reply({ id: m.id, result: H(11) });
      else if (m.method === "chain_getBlock") reply({ id: m.id, result: { block: { extrinsics: [XT] } } });
      else if (m.method === "chain_getBlockHash") reply({ id: m.id, result: H(11) });
      else if (m.method === "state_getStorage") reply({ id: m.id, result: EVENTS });
      else if (m.method === "author_unwatchExtrinsic") reply({ id: m.id, result: true });
      else reply({ id: m.id, error: { code: -32601, message: "Method not found" } });
    }
    close() { this.readyState = 3; }
  }
  return { FakeSocket, sockets };
}

test("R6 X3: the WebSocket transport speaks JSON-RPC to the one node of the file; another address is refused", async () => {
  const { FakeSocket, sockets } = fakeSocket();
  const pr = load();
  const lab = pr.createRunner({ transport: pr.wsTransport(plan.values.RPC.value, FakeSocket), store: memStore() });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.equal(lab.last.events_raw, EVENTS);
  assert.equal(sockets[0].url, plan.values.RPC.value);
  assert.deepEqual(r.statuses[0], "ready", "a notification that came before the subscription id is not lost");
  assert.ok(sockets[0].sent.every((m) => m.jsonrpc === "2.0" && Number.isInteger(m.id)));
  await assert.rejects(pr.wsTransport(undefined, FakeSocket).request("nope", []), (e) => e.code === -32601);
  assert.throws(() => pr.wsTransport("wss://other.example", FakeSocket), /talks only to/);
});

test("X3: the node's address and the events key are constants of the file, equal to steps.json; in the pane the runner is made with no argument", () => {
  const pr = load({ WebSocket: fakeSocket().FakeSocket });
  assert.equal(pr.RPC, plan.values.RPC.value);
  assert.equal(pr.EVENTS_KEY, plan.values.EVENTS_KEY.value);
  assert.equal([...SRC.matchAll(/wss:\/\//g)].length, 1, "one address in the file");
  const lab = pr.createRunner();
  assert.equal(typeof lab.send, "function");
  assert.throws(() => pr.createRunner({ transport: scriptedNode().transport, eventsKey: "0x00" }), /the events key is the constant/);
});

test("X2: a lost connection is its own outcome: the watch ends as connection-lost, and later reads fail with that word at once", async () => {
  const { FakeSocket } = fakeSocket({ closeAfterSubmit: true });
  const pr = load();
  const store = memStore();
  const lab = pr.createRunner({ transport: pr.wsTransport(plan.values.RPC.value, FakeSocket), store, deadlineMs: 2000 });
  const t0 = Date.now();
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "connection-lost");
  assert.ok(Date.now() - t0 < 1000, "not a wait until the deadline");
  assert.ok(store.has(XT), "it was written, so it is marked as sent");
  for (const call of [() => lab.heads(), () => lab.read(["0x01"], H(1)), () => lab.deviceReads("5D", "0x01"), () => lab.accountReads("5D")]) {
    await assert.rejects(call(), (e) => e.message === "connection-lost");
  }
});

test("X2: a waiting request is rejected with the fixed word when the connection is lost", async () => {
  class Silent { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen(); }, 1); } send() { setTimeout(() => { this.readyState = 3; this.onclose({}); }, 3); } close() {} }
  const pr = load();
  await assert.rejects(pr.wsTransport(undefined, Silent).request("chain_getFinalizedHead", []), (e) => e.message === "connection-lost" && e.written === true);
});

test("X4: an extrinsic is marked as sent when its submit request is written; a socket that never opened gives not-sent, nothing marked, and a later send works", async () => {
  const store = memStore();
  const pr = load();
  const never = fakeSocket({ neverOpen: true });
  const r = await pr.createRunner({ transport: pr.wsTransport(undefined, never.FakeSocket), store, deadlineMs: 500 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "not-sent");
  assert.equal(store.has(XT), false, "nothing is marked");
  assert.equal(never.sockets[0].sent.length, 0);
  const ok = fakeSocket();
  const r2 = await pr.createRunner({ transport: pr.wsTransport(undefined, ok.FakeSocket), store }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r2.status, "finalized", "a plain send of it works later");
  assert.equal(store.has(XT), true);
  let markedAtWrite = null;
  const watching = { has: () => false, add: () => { markedAtWrite = node.submitted.length; } };
  const node = scriptedNode({ statuses: ["ready"] });
  const orig = node.transport.subscribe;
  node.transport.subscribe = async (m, p, u, on, onWrite) => { assert.equal(markedAtWrite, null, "not marked before the write"); return orig(m, p, u, on, onWrite); };
  await runner(node, { store: watching, deadlineMs: 30 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(markedAtWrite, 1, "marked at the write");
});

test("X5: sendSame submits again an extrinsic the sent list holds, with the same outcomes, and refuses one it does not hold", async () => {
  const store = memStore();
  const fin = { blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } } };
  const node = scriptedNode({ statuses: ["ready"], ...fin });
  const lab = runner(node, { store, deadlineMs: 30 });
  assert.equal((await lab.sendSame(BUNDLE, sha(BUNDLE))).status, "not-in-sent-list");
  assert.deepEqual(node.submitted, []);
  assert.equal((await lab.send(BUNDLE, sha(BUNDLE))).status, "deadline");
  const node2 = scriptedNode({ statuses: [{ finalized: H(11) }], ...fin });
  const r = await runner(node2, { store }).sendSame(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.deepEqual(node2.submitted, [XT], "the same bytes");
  assert.match(SRC, /the same bytes carry the same account nonce, so the chain can include them once at\s+\* most/);
});

test("X6: find reads finalized blocks from a number up to the head, at most 400 a call, and returns what send returns, or not-found with the range", async () => {
  const fin = scriptedNode({ blocks: { [H(7)]: { number: 7, extrinsics: ["0x00", XT], events: EVENTS } }, head: 9 });
  const r = await runner(fin).find(XT, 3);
  assert.equal(r.status, "finalized");
  assert.equal(r.block_number, 7);
  assert.equal(r.extrinsic_index, 1);
  assert.equal(r.events_sha256, EVENTS_SHA);
  assert.equal(r.extrinsic_sha256, sha(XT));
  const none = scriptedNode({ head: 1000 });
  const n = await runner(none).find(XT, 100);
  assert.equal(n.status, "not-found");
  assert.deepEqual([n.from, n.to, n.head], [100, 499, 1000]);
  assert.equal(none.log.filter((m) => m === "chain_getBlock").length, 400);
  const below = await runner(scriptedNode({ head: 5 })).find(XT, 9);
  assert.equal(below.status, "not-found");
  assert.equal(below.to, null);
  assert.deepEqual(none.submitted, [], "find submits nothing");
});

test("X9 R6: one file with no import, no require and no export, that decodes nothing and names one node", () => {
  assert.doesNotMatch(SRC, /^\s*import\b|\bimport\(|\brequire\(|^\s*export\b/m);
  const methods = [...new Set([...SRC.matchAll(/"((?:chain|state|author|system)_[A-Za-z]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(methods, ["author_submitAndWatchExtrinsic", "author_unwatchExtrinsic", "chain_getBlock", "chain_getBlockHash", "chain_getFinalizedHead", "chain_getHeader", "state_getRuntimeVersion", "state_getStorage", "state_queryStorageAt", "system_accountNextIndex"]);
  assert.doesNotMatch(SRC, /author_submitExtrinsic"/, "one way to submit");
  assert.equal([...SRC.matchAll(/parseInt\(/g)].length, 2, "only the header's block number, a JSON-RPC hex number, is read");
  assert.ok([...SRC.matchAll(/(?:https?|wss?):\/\/[^\s"',)]+/g)].every((m) => /^(https|wss):\/\/rpc\.devnet\.flop\.network\/?$/.test(m[0])), "no other host");
  assert.doesNotMatch(SRC, /\bfetch\(/);
});

test("F4: a status word that is a name of Object.prototype is unknown: kept in statuses, and the watch goes on to finalized", async () => {
  const blocks = { [H(7)]: { number: 7, extrinsics: [XT], events: EVENTS } };
  const node = scriptedNode({ statuses: ["constructor", "__proto__", { toString: H(3) }, { finalized: H(7) }], blocks });
  const r = await runner(node).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.deepEqual(plainOf(r.statuses).slice(0, 2), ["constructor", "__proto__"]);
});

test("F5: the deadline covers the locate step: a finalized status with no answer to the block read ends as finalized-unread with that block", async () => {
  const node = scriptedNode({ statuses: [{ finalized: H(7) }] });
  const req = node.transport.request;
  node.transport.request = (m, p) => (m === "chain_getBlock" ? new Promise(() => {}) : req(m, p));
  const t0 = Date.now();
  const r = await runner(node, { deadlineMs: 100 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized-unread");
  assert.equal(r.block_hash, H(7));
  assert.ok(Date.now() - t0 < 1000);
});

test("F7 F8: a write that throws marks nothing and gives not-sent; a deadline before the socket opens writes nothing later and gives not-sent", async () => {
  const pr = load();
  class Throws { constructor() { this.readyState = 0; this.sent = []; setTimeout(() => { this.readyState = 1; this.onopen(); }, 1); } send() { throw new Error("InvalidStateError"); } close() {} }
  const store = memStore();
  const r = await pr.createRunner({ transport: pr.wsTransport(undefined, Throws), store, deadlineMs: 300 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "not-sent");
  assert.equal(store.has(XT), false);
  let socket = null;
  class Late { constructor() { socket = this; this.readyState = 0; this.sent = []; setTimeout(() => { this.readyState = 1; this.onopen(); }, 150); } send(m) { this.sent.push(m); } close() {} }
  const store2 = memStore();
  const r2 = await pr.createRunner({ transport: pr.wsTransport(undefined, Late), store: store2, deadlineMs: 50 }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r2.status, "not-sent");
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(socket.sent.length, 0, "nothing of the ended call is written");
  assert.equal(store2.has(XT), false);
});

test("F5: a status that comes while the finalized block is read does not end the call", async () => {
  const blocks = { [H(7)]: { number: 7, extrinsics: [XT], events: EVENTS } };
  const node = scriptedNode({ statuses: [{ finalized: H(7) }, "dropped"], blocks });
  const req = node.transport.request;
  node.transport.request = (m, p) => (m === "chain_getBlock" ? new Promise((res) => setTimeout(() => res(req(m, p)), 40)) : req(m, p));
  const r = await runner(node).send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.equal(r.block_hash, H(7));
});

test("F3c: send, sendSame and find name their call in sent_by", async () => {
  const blocks = { [H(7)]: { number: 7, extrinsics: [XT], events: EVENTS } };
  const node = scriptedNode({ statuses: [{ finalized: H(7) }], blocks, head: 7 });
  const lab = runner(node);
  assert.equal((await lab.send(BUNDLE, sha(BUNDLE))).sent_by, "send");
  assert.equal(JSON.parse((await lab.sendSame(BUNDLE, sha(BUNDLE))).relay).sent_by, "sendSame");
  assert.equal((await lab.find(XT, 7)).sent_by, "find");
});

// ---- fix round 3 ------------------------------------------------------------------------------

test("H7: every result of send, sendSame and find names its call, also those that submit nothing", async () => {
  const node = scriptedNode({ statuses: ["ready"] });
  const lab = runner(node, { deadlineMs: 30 });
  const r = [await lab.send(BUNDLE, "00".repeat(32)), await lab.sendSame(BUNDLE, "00".repeat(32)), await lab.sendSame(BUNDLE, sha(BUNDLE)), await lab.send(BUNDLE, sha(BUNDLE)), await lab.send(BUNDLE, sha(BUNDLE)), await lab.find("xx", 1), await lab.find(XT, -1)];
  assert.deepEqual(r.map((x) => [x.status, x.sent_by]), [["refused-bundle", "send"], ["refused-bundle", "sendSame"], ["not-in-sent-list", "sendSame"], ["deadline", "send"], ["already-sent", "send"], ["refused-bundle", "find"], ["refused-bundle", "find"]]);
  for (const x of r) assert.equal(JSON.parse(x.relay).sent_by, x.sent_by, "the relay text carries it");
  assert.match(r[4].problem, /sent list holds these bytes: they were written to a socket before/);
});

test("H10: find ends within the runner's deadline: find-deadline with the blocks it read, and nothing is asked of the node after it", async () => {
  const node = scriptedNode({ head: 1000 });
  const slow = { request: (m, p) => new Promise((res, rej) => setTimeout(() => node.transport.request(m, p).then(res, rej), m === "chain_getBlock" ? 12 : 0)), subscribe: node.transport.subscribe };
  const lab = load().createRunner({ transport: slow, store: memStore(), deadlineMs: 60 });
  const r = await lab.find(XT, 100);
  assert.equal(r.status, "find-deadline");
  assert.equal(r.sent_by, "find");
  assert.equal(r.from, 100);
  assert.equal(r.head, 1000);
  assert.ok(Number.isInteger(r.to) && r.to >= 119 && r.to < 499 && (r.to - 99) % 20 === 0, `to ${r.to}: a whole number of chunks of 20 read`);
  assert.match(r.problem, new RegExp(`it read the finalized blocks 100 to ${r.to} and the extrinsic is not in them`));
  assert.equal(r.extrinsic_sha256, sha(XT), "record-step can match it to the signed file");
  const asked = node.log.length;
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(node.log.length - asked <= 20, "at most the blocks of the chunk in flight are answered after the deadline");
  const later = node.log.length;
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(node.log.length, later, "no new chunk is asked after the deadline");
  // a node that never answers the head: find-deadline with no block read
  const mute = load().createRunner({ transport: { request: () => new Promise(() => {}), subscribe: node.transport.subscribe }, store: memStore(), deadlineMs: 30 });
  const m = await mute.find(XT, 5);
  assert.deepEqual([m.status, m.to, m.head], ["find-deadline", null, null]);
  assert.match(m.problem, /read no block/);
});

test("H10: a block find found and could not read before the deadline is finalized-unread with its hash", async () => {
  const node = scriptedNode({ blocks: { [H(7)]: { number: 7, extrinsics: [XT], events: EVENTS } }, head: 9 });
  const t = { request: (m, p) => (m === "state_getStorage" ? new Promise(() => {}) : node.transport.request(m, p)), subscribe: node.transport.subscribe };
  const r = await load().createRunner({ transport: t, store: memStore(), deadlineMs: 80 }).find(XT, 3);
  assert.deepEqual([r.status, r.block_hash, r.sent_by], ["finalized-unread", H(7), "find"]);
});

test("H11: the not-sent words after a write that threw say that the write failed", async () => {
  const pr = load();
  const sockets = [];
  class WS { constructor() { this.readyState = 0; sockets.push(this); } send() { throw new Error("boom"); } close() {} }
  const lab = pr.createRunner({ transport: pr.wsTransport(undefined, WS), store: memStore(), deadlineMs: 300 });
  const p = lab.send(BUNDLE, sha(BUNDLE));
  await new Promise((res) => setTimeout(res, 10));
  sockets[0].readyState = 1; sockets[0].onopen();
  const r = await p;
  assert.equal(r.status, "not-sent");
  assert.match(r.problem, /^the write to the socket failed: nothing was written, nothing is marked as sent$/);
  assert.doesNotMatch(r.problem, /not open/);
});
