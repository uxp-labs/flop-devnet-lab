// Reviewer's tests of pane-runner.js (P3, P4). No network: a scripted node and a fake WebSocket.
// Each test states what the promise needs; on fcfb8b5 the ones named "DEFECT" fail.
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
const RPC = plan.values.RPC.value;
const load = () => { const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout }; vm.runInNewContext(SRC, g); return g.paneRunner; };
const sha = (t) => createHash("sha256").update(t).digest("hex");
const XT = "0x" + "b2".repeat(40);
const BUNDLE = JSON.stringify({ step: "T4", extrinsic: XT, extrinsic_hash: "0x" + "ef".repeat(32) });
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const memStore = () => { const m = new Set(); return { has: (k) => m.has(k), add: (k) => m.add(k) }; };

/** A scripted node whose block 12 holds XT at index 1 and is canonical. */
function node(statuses) {
  const submitted = [];
  const answers = {
    chain_getHeader: () => ({ number: "0xc" }),
    chain_getBlock: () => ({ block: { extrinsics: ["0x00", XT] } }),
    chain_getBlockHash: () => H(12),
    state_getStorage: () => "0x04",
  };
  return {
    submitted,
    transport: {
      request: async (m, p) => answers[m](p),
      subscribe: async (m, p, u, on) => {
        submitted.push(p[0]);
        let i = 0;
        const play = () => { if (i < statuses.length) { const s = statuses[i++]; setTimeout(() => { on(s); play(); }, 2); } };
        play();
        return { unsubscribe: () => {} };
      },
    },
  };
}

// Substrate's TransactionStatus is serde externally tagged and camelCase: unit variants are strings
// ("future", "ready", "dropped", "invalid"), newtype variants are objects ({ broadcast: [peers] },
// { inBlock }, { retracted }, { finalityTimeout }, { finalized }, { usurped }). This is the
// reviewer's knowledge of sc-transaction-pool-api, not a committed file of this repo.
test("review DEFECT P4: a broadcast status (an object with the peers) is not the end of the watch; the step goes on to its finalized block", async () => {
  const n = node(["ready", { broadcast: ["12D3KooWpeer"] }, { inBlock: H(12) }, { finalized: H(12) }]);
  const lab = load().createRunner({ transport: n.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 2000 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(n.submitted.length, 1);
  assert.equal(r.status, "finalized", `the runner ended with ${r.status} ${r.node_status ?? ""} while the extrinsic was live in the pool`);
  assert.equal(r.extrinsic_index, 1);
});

test("review DEFECT P4: a dropped or invalid status (a string) ends the watch with the node's word, not a wait until the deadline", async () => {
  for (const word of ["dropped", "invalid"]) {
    const n = node(["ready", word]);
    const lab = load().createRunner({ transport: n.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 300 });
    const r = await lab.send(BUNDLE, sha(BUNDLE));
    assert.equal(r.node_status, word, `${word}: ended as ${r.status}: ${r.problem ?? ""}`);
  }
});

/** A fake WebSocket that answers the submission with a subscription id and then closes. */
function closingSocket(log) {
  return class {
    constructor(url) { log.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
    send(text) {
      log.sent.push(text);
      if (this.readyState !== 1) return; // a browser drops a send on a closed socket
      const m = JSON.parse(text);
      if (m.method === "author_submitAndWatchExtrinsic") setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "sub1" }) });
        this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "author_extrinsicUpdate", params: { subscription: "sub1", result: "ready" } }) });
        setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); }, 2);
      }, 1);
    }
    close() { this.readyState = 3; }
  };
}

test("review DEFECT P4: a socket that closes after the node took the extrinsic ends in a stated lost connection, not in 'not in any block'", async () => {
  const log = { sent: [] };
  const pr = load();
  const lab = pr.createRunner({ transport: pr.wsTransport(RPC, closingSocket(log)), eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 300 });
  const r = await lab.send(BUNDLE, sha(BUNDLE));
  assert.equal(log.sent.filter((t) => JSON.parse(t).method === "author_submitAndWatchExtrinsic").length, 1);
  assert.doesNotMatch(String(r.problem), /not in any block/, `the node took it and the socket closed, yet the runner says: ${r.problem}`);
});

test("review DEFECT P4: a read after the socket closed ends with a stated outcome, not a silent wait", async () => {
  const log = { sent: [] };
  const pr = load();
  const transport = pr.wsTransport(RPC, closingSocket(log));
  const lab = pr.createRunner({ transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 200 });
  await lab.send(BUNDLE, sha(BUNDLE));
  const outcome = await Promise.race([lab.heads().then(() => "answered", () => "rejected"), new Promise((r) => setTimeout(() => r("silent"), 500))]);
  assert.notEqual(outcome, "silent", "heads() waits forever on a closed socket");
});

test("review DEFECT P4: the runner talks only to the devnet node of steps.json; another host is refused", () => {
  const log = { sent: [] };
  const pr = load();
  assert.throws(() => pr.createRunner({ transport: pr.wsTransport("wss://other.example.org", closingSocket(log)), eventsKey: EVENTS_KEY, store: memStore() }));
});

test("review held P3: one submission whatever the node answers after it, and a second send of the same text is refused before the node", async () => {
  for (const statuses of [[{ usurped: H(1) }], [{ inBlock: H(12) }, { finalityTimeout: H(12) }], []]) {
    const n = node(statuses);
    const lab = load().createRunner({ transport: n.transport, eventsKey: EVENTS_KEY, store: memStore(), deadlineMs: 100 });
    const a = await lab.send(BUNDLE, sha(BUNDLE));
    const b = await lab.send(BUNDLE, sha(BUNDLE));
    assert.equal(n.submitted.length, 1);
    assert.notEqual(a.status, "finalized");
    assert.equal(b.status, "already-sent");
  }
});
