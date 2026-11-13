// Tests of pane-runner.js (rule R6) against a scripted node: node --test in this folder. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE, loadPlan } from "./lib.mjs";

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
const BUNDLE = JSON.stringify({ step: "T3", extrinsic: XT, extrinsic_hash: "0x" + "ee".repeat(32) });
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const EVENTS = "0x0c" + "00".repeat(30);

/**
 * A scripted node: answers by method from a table, and plays a list of statuses to a watch. Every
 * request and every submission is logged.
 */
function scriptedNode({ statuses = [], refuse = null, blocks = {}, canonical = null } = {}) {
  const log = [], submitted = [];
  const answers = {
    chain_getFinalizedHead: () => H(10),
    chain_getHeader: ([h]) => ({ number: "0x" + (blocks[h]?.number ?? 10).toString(16) }),
    state_getRuntimeVersion: () => ({ specName: plan.values.SPEC_NAME.value, specVersion: 1014020, transactionVersion: 2 }),
    chain_getBlockHash: ([n]) => (n === 0 ? plan.values.GENESIS.value : canonical ?? Object.keys(blocks).find((h) => blocks[h].number === n)),
    chain_getBlock: ([h]) => ({ block: { extrinsics: blocks[h]?.extrinsics ?? [] } }),
    state_getStorage: ([k, h]) => (k === EVENTS_KEY ? blocks[h]?.events ?? null : null),
    state_queryStorageAt: ([keys, h]) => [{ block: h, changes: keys.filter((k) => k !== "0xdead").map((k) => [k, k === "0x01" ? null : "0x2a00000000000000"]) }],
    system_accountNextIndex: () => 3,
  };
  const transport = {
    request: async (method, params) => { log.push(method); const f = answers[method]; if (!f) throw { code: -32601, message: `no ${method}` }; return f(params); },
    subscribe: async (method, params, unsub, on) => {
      log.push(method);
      submitted.push(params[0]);
      if (refuse) throw refuse;
      let i = 0;
      const play = () => { if (i < statuses.length) { const s = statuses[i++]; setTimeout(() => { on(s); play(); }, 2); } };
      play();
      return { unsubscribe: () => { log.push(unsub); } };
    },
  };
  return { transport, log, submitted };
}

const memStore = () => { const m = new Set(); return { has: (k) => m.has(k), add: (k) => m.add(k) }; };

test("R6: a finalized extrinsic: its block's hash and number, its index and the raw System.Events, as the node gave them", async () => {
  const node = scriptedNode({ statuses: ["ready", { inBlock: H(11) }, { finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: ["0x00", "0x01", XT], events: EVENTS } } });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 1000 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.equal(r.block_hash, H(11));
  assert.equal(r.block_number, 11);
  assert.equal(r.extrinsic_index, 2);
  assert.equal(r.events_raw, EVENTS, "the events are the node's bytes, not decoded");
  assert.equal(r.step, "T3");
  assert.deepEqual(node.submitted, [XT]);
  assert.ok(node.log.includes("author_unwatchExtrinsic"));
});

test("R6: a bundle whose sha256 is not the one given is refused and nothing is sent", async () => {
  const node = scriptedNode({ statuses: [{ finalized: H(11) }] });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore() });
  const r = await lab.send(BUNDLE, sha(BUNDLE + " "));
  assert.equal(r.status, "refused-bundle");
  assert.deepEqual(node.submitted, []);
  const bad = JSON.stringify({ step: "T3" });
  assert.equal((await lab.send(bad, sha(bad))).status, "refused-bundle");
  assert.deepEqual(node.submitted, []);
});

test("R6: the same extrinsic is never sent twice, even after a refusal or a deadline", async () => {
  const store = memStore();
  const node = scriptedNode({ refuse: { code: 1010, message: "Invalid Transaction", data: "Transaction is outdated" } });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store, deadlineMs: 50 });
  assert.equal((await lab.send(BUNDLE, sha(BUNDLE))).status, "refused-at-submission");
  const again = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(again.status, "already-sent");
  const lab2 = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store, deadlineMs: 50 });
  assert.equal((await lab2.send(BUNDLE, sha(BUNDLE))).status, "already-sent", "a new runner on the same store does not send it either");
  assert.equal(node.submitted.length, 1);
});

test("R6: the page's localStorage keeps what was sent across a reload of the runner", async () => {
  const items = {};
  const localStorage = { getItem: (k) => (k in items ? items[k] : null), setItem: (k, v) => { items[k] = v; } };
  const node = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } } });
  assert.equal((await load({ localStorage }).createRunner({ transport: node.transport, eventsKey: EVENTS_KEY }).send(BUNDLE, sha(BUNDLE))).status, "finalized");
  assert.equal((await load({ localStorage }).createRunner({ transport: node.transport, eventsKey: EVENTS_KEY }).send(BUNDLE, sha(BUNDLE))).status, "already-sent");
  assert.equal(node.submitted.length, 1);
});

test("R6: a refusal at submission is reported with the node's words and not retried", async () => {
  const node = scriptedNode({ refuse: { code: 1010, message: "Invalid Transaction", data: "Transaction has a bad signature" } });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 200 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "refused-at-submission");
  assert.deepEqual({ ...r.node }, { code: 1010, message: "Invalid Transaction", data: "Transaction has a bad signature" });
  assert.equal(node.log.filter((m) => m === "author_submitAndWatchExtrinsic").length, 1);
});

test("R6: no block before the deadline is reported as such, not final", async () => {
  const node = scriptedNode({ statuses: ["ready"] });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 40 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "deadline");
  assert.equal(r.in_block, null);
  assert.equal(r.final, false);
});

test("R6: an extrinsic in a block that never becomes final is reported with that block, not final", async () => {
  const node = scriptedNode({ statuses: ["ready", { inBlock: H(12) }] });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 60 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "deadline");
  assert.equal(r.in_block, H(12));
  assert.equal(r.final, false);
  assert.equal(r.block_hash, undefined, "no block is named as its block");
});

test("R6: a retracted block is forgotten, and an ended watch is reported with the node's status word", async () => {
  const node = scriptedNode({ statuses: [{ inBlock: H(12) }, { retracted: H(12) }, { dropped: null }] });
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 500 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "ended");
  assert.equal(r.node_status, "dropped");
  assert.equal(r.in_block, null);
});

test("R6: a finalized block that does not hold the extrinsic, or is not at its height, is not passed as found", async () => {
  const a = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: ["0x00"], events: EVENTS } } });
  const r1 = await load().createRunner({ transport: a.transport, eventsKey: EVENTS_KEY, store: memStore() }).send(BUNDLE, sha(BUNDLE));
  assert.equal(r1.status, "finalized-not-found");
  assert.equal(r1.extrinsic_index, null);
  const b = scriptedNode({ statuses: [{ finalized: H(11) }], blocks: { [H(11)]: { number: 11, extrinsics: [XT], events: EVENTS } }, canonical: H(99) });
  assert.equal((await load().createRunner({ transport: b.transport, eventsKey: EVENTS_KEY, store: memStore() }).send(BUNDLE, sha(BUNDLE))).status, "finalized-not-canonical");
});

test("R6: heads, reads and the device's reads: the node's answers, raw", async () => {
  const node = scriptedNode();
  const lab = load().createRunner({ transport: node.transport, eventsKey: EVENTS_KEY, store: memStore() });
  const h = await lab.heads();
  assert.deepEqual(JSON.parse(JSON.stringify(h)), { runtime: { specName: plan.values.SPEC_NAME.value, specVersion: 1014020, transactionVersion: 2, genesisHash: plan.values.GENESIS.value }, finalized: { number: 10, hash: H(10) } });
  const r = await lab.read(["0x01", "0x02", "0xdead"], H(10));
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { block_hash: H(10), values: { "0x01": null, "0x02": "0x2a00000000000000" }, not_answered: ["0xdead"] });
  const d = await lab.deviceReads("5Device", "0x02");
  assert.deepEqual(JSON.parse(JSON.stringify(d)), { runtime: JSON.parse(JSON.stringify(h.runtime)), birth: { number: 10, hash: H(10) }, account_nonce: 3, session_nonce_raw: "0x2a00000000000000" });
  await assert.rejects(lab.deviceReads("5Device", "0xdead"), /did not answer/);
});

test("R6: the WebSocket transport speaks JSON-RPC: ids for requests, subscription ids for notifications", async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); setTimeout(() => this.onopen(), 1); }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      const reply = (o) => setTimeout(() => this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", ...o }) }), 1);
      if (m.method === "author_submitAndWatchExtrinsic") {
        this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", method: "author_extrinsicUpdate", params: { subscription: "s1", result: "ready" } }) });
        reply({ id: m.id, result: "s1" });
        setTimeout(() => this.onmessage({ data: JSON.stringify({ method: "author_extrinsicUpdate", params: { subscription: "s1", result: { finalized: H(11) } } }) }), 5);
      } else if (m.method === "chain_getHeader") reply({ id: m.id, result: { number: "0xb" } });
      else if (m.method === "chain_getBlock") reply({ id: m.id, result: { block: { extrinsics: [XT] } } });
      else if (m.method === "chain_getBlockHash") reply({ id: m.id, result: H(11) });
      else if (m.method === "state_getStorage") reply({ id: m.id, result: EVENTS });
      else if (m.method === "author_unwatchExtrinsic") reply({ id: m.id, result: true });
      else reply({ id: m.id, error: { code: -32601, message: "Method not found" } });
    }
    close() {}
  }
  const pr = load();
  const lab = pr.createRunner({ transport: pr.wsTransport(plan.values.RPC.value, FakeSocket), eventsKey: EVENTS_KEY, store: memStore() });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(r.status, "finalized");
  assert.equal(r.events_raw, EVENTS);
  assert.equal(sockets[0].url, plan.values.RPC.value);
  assert.deepEqual(r.statuses[0], "ready", "a notification that came before the subscription id is not lost");
  assert.ok(sockets[0].sent.every((m) => m.jsonrpc === "2.0" && Number.isInteger(m.id)));
  await assert.rejects(pr.wsTransport("x", FakeSocket).request("nope", []), (e) => e.code === -32601);
});

test("R6: one file with no import, no require and no export, that decodes nothing", () => {
  assert.doesNotMatch(SRC, /^\s*import\b|\bimport\(|\brequire\(|^\s*export\b/m);
  const methods = [...new Set([...SRC.matchAll(/"((?:chain|state|author|system)_[A-Za-z]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(methods, ["author_submitAndWatchExtrinsic", "author_unwatchExtrinsic", "chain_getBlock", "chain_getBlockHash", "chain_getFinalizedHead", "chain_getHeader", "state_getRuntimeVersion", "state_getStorage", "state_queryStorageAt", "system_accountNextIndex"]);
  assert.doesNotMatch(SRC, /author_submitExtrinsic"/, "one way to submit");
  assert.equal([...SRC.matchAll(/parseInt\(/g)].length, 2, "only the header's block number, a JSON-RPC hex number, is read");
});
