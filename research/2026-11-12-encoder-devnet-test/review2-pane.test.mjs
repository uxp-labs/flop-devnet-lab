// Review 2 (Q5, Q6): pane-runner.js and explorer-reader.js run as a page runs them, against a node
// and an explorer scripted here. No network: the WebSocket and fetch are stand ins of this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE } from "./lib.mjs";

const load = (file, extra = {}) => { const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, ...extra }; vm.runInNewContext(readFileSync(join(HERE, file), "utf8"), g); return g; };
const sha = (t) => createHash("sha256").update(t).digest("hex");
const XT = "0x" + "b2".repeat(40);
const BUNDLE = JSON.stringify({ step: "T3", extrinsic: XT });
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memStore = () => { const m = new Set(); return { has: (k) => m.has(k), add: (k) => m.add(k), m }; };
const plain = (x) => JSON.parse(JSON.stringify(x));

/** A transport that plays statuses to a watch and answers requests with a table; a method may hang. */
function transport({ statuses = [], hang = [] } = {}) {
  const submitted = [];
  return {
    submitted,
    request: (method, params) => (hang.includes(method) ? new Promise(() => {}) : Promise.resolve({ chain_getHeader: { number: "0x10" }, chain_getBlock: { block: { extrinsics: [XT] } }, chain_getBlockHash: H(1), state_getStorage: "0x00" }[method] ?? null)),
    subscribe: (method, params, unsub, on, onWrite) => {
      submitted.push(params[0]); onWrite();
      let i = 0; const play = () => { if (i < statuses.length) { const s = statuses[i++]; setTimeout(() => { on(s); play(); }, 2); } }; play();
      return Promise.resolve({ unsubscribe: () => Promise.resolve(null) });
    },
  };
}

for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
  test(`review2 Q5 DEFECT: the status ${JSON.stringify(word)}, which is not in the table, ends the watch`, async () => {
    const g = load("pane-runner.js");
    const lab = g.paneRunner.createRunner({ transport: transport({ statuses: ["ready", word] }), deadlineMs: 150, store: memStore() });
    const out = plain(await lab.send(BUNDLE, sha(BUNDLE)));
    assert.equal(out.status, "deadline", `the watch ended as ${out.status} (${out.node_status}) on a status the table does not hold`);
  });
}

test("review2 Q5 DEFECT: the status object { toString: hash }, not in the table, ends the watch", async () => {
  const g = load("pane-runner.js");
  const lab = g.paneRunner.createRunner({ transport: transport({ statuses: [JSON.parse(`{"toString":"${H(5)}"}`)] }), deadlineMs: 150, store: memStore() });
  const out = plain(await lab.send(BUNDLE, sha(BUNDLE)));
  assert.equal(out.status, "deadline", `ended as ${out.status} (${out.node_status})`);
});

test("review2 Q5 DEFECT: after a finalized status a node that does not answer chain_getBlock makes send wait forever", async () => {
  const g = load("pane-runner.js");
  const lab = g.paneRunner.createRunner({ transport: transport({ statuses: ["ready", { finalized: H(7) }], hang: ["chain_getBlock"] }), deadlineMs: 150, store: memStore() });
  const out = await Promise.race([lab.send(BUNDLE, sha(BUNDLE)).then(plain), sleep(1500).then(() => "still waiting 10 deadlines later")]);
  assert.notEqual(out, "still waiting 10 deadlines later", "the deadline was cleared at finalized and locate has none");
});

/** A WebSocket stand in: opens after openMs (or never), records what is sent; send may throw. */
function fakeWs({ openMs = 0, sendThrows = false } = {}) {
  const sent = [];
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; if (openMs !== null) setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, openMs); }
    send(m) { if (sendThrows) throw new Error("InvalidStateError"); sent.push(JSON.parse(m)); }
    close() {}
  }
  return { WS, sent };
}

test("review2 Q5 DEFECT: a socket that opens after the deadline gets the extrinsic written after send has said deadline", async () => {
  const g = load("pane-runner.js");
  const { WS, sent } = fakeWs({ openMs: 300 });
  const store = memStore();
  const lab = g.paneRunner.createRunner({ transport: g.paneRunner.wsTransport(undefined, WS), deadlineMs: 100, store });
  const out = plain(await lab.send(BUNDLE, sha(BUNDLE)));
  assert.equal(out.status, "not-sent"); // adapted by the builder: F7 names this outcome not-sent, not deadline
  await sleep(500);
  const submits = sent.filter((m) => m.method === "author_submitAndWatchExtrinsic");
  assert.equal(submits.length, 0, `the extrinsic was written ${submits.length} time(s) after the call had ended with deadline, and marked as sent: ${store.has(XT)}`);
});

test("review2 Q5 DEFECT: ws.send that throws leaves the extrinsic marked as sent and calls it refused at submission", async () => {
  const g = load("pane-runner.js");
  const { WS, sent } = fakeWs({ openMs: 0, sendThrows: true });
  const store = memStore();
  const lab = g.paneRunner.createRunner({ transport: g.paneRunner.wsTransport(undefined, WS), deadlineMs: 200, store });
  const out = plain(await lab.send(BUNDLE, sha(BUNDLE)));
  assert.equal(sent.length, 0); // nothing reached the socket
  assert.equal(store.has(XT), false, `marked as sent though nothing was written; the outcome said ${out.status}`);
});

// ---- the explorer reader ---------------------------------------------------------------------

const HX = "0x" + "ab".repeat(32);
const answer = { hash: HX, blockHash: "0x" + "cd".repeat(32), method: "x", section: "y", sender: "5x", params: {}, success: true, events: [{ id: "1", section: "system", method: "ExtrinsicSuccess", data: {} }], timestamp: "1" };

test("review2 Q6 DEFECT: the explorer reader follows a redirect to another host and reports found", async () => {
  // a fetch stand in that honours init.redirect as a browser does: "error" rejects, "manual" gives an opaque redirect
  const fetch = (url, init = {}) => {
    if (init.redirect === "error") return Promise.reject(new TypeError("redirect"));
    if (init.redirect === "manual") return Promise.resolve({ status: 0, type: "opaqueredirect", url, redirected: false, json: () => Promise.reject(new Error("opaque")) });
    return Promise.resolve({ status: 200, url: "https://explorer.elsewhere.example/api/transactions/" + HX, redirected: true, json: () => Promise.resolve(answer) });
  };
  const g = load("explorer-reader.js", { fetch });
  const out = plain(await g.explorerReader.createReader().read(HX));
  assert.notEqual(out.status, "found", "an answer of another host was taken as the explorer's");
});
