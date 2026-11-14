// Review of G-19, attack 1 (G1): session-reads.js only reads. Adversarial inputs and lying nodes,
// over pane-runner.js wsTransport and a fake WebSocket fed from the rerun's recording. Every method
// that reaches the socket is listed and held to the read set. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { paneKeys } from "./lib.mjs";
import { plan, V, runWithSeat, writeRecord, relayOf } from "./fixtures.mjs";
import { readerOver, plain } from "./pane.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { atR1Call } from "./records.mjs";
import { runTool, ToolRunError } from "./tool-run.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const K = await paneKeys(plan, V("OWNER"), DEV1);
const SK = () => ({ lru: K.lru, sessions: K.sessions, nonces: K.nonces, breakers: K.breakers, session_count: K.session_count, rotation_history: K.rotation_history });
const READS = new Set(["chain_getBlockHash", "chain_getFinalizedHead", "chain_getHeader", "state_getStorage", "state_getMetadata"]);
const tick = () => new Promise((r) => setTimeout(r, 20));
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });

/** A node of the recording at A6 whose answers a lie may change. */
function lying(lie = {}) {
  const n = rerunNode("A6");
  const base = n.answer;
  n.sent = [];
  n.answer = (m, p) => { n.sent.push({ method: m, params: p }); return lie[m] ? lie[m](p, () => base(m, p)) : base(m, p); };
  return n;
}
const methods = (node) => (node.sent ?? node.log).map((c) => c.method);
const onlyReads = (node, what) => { for (const m of methods(node)) assert.ok(READS.has(m), `${what}: ${m} reached the socket`); };

test("HOLDS: no input handed to sessionTape, blockTape or probe sends a method outside the read set, or anything before it is checked", async () => {
  const bad = [
    ["a key that is not hex", () => ({ ...SK(), sessions: "0xzz" + K.sessions.slice(4) })],
    ["a key that is an object with toString", () => ({ ...SK(), sessions: { toString: () => K.sessions } })],
    ["a method name in a key", () => ({ ...SK(), sessions: "state_call" })],
    ["a key of 31 bytes", () => ({ ...SK(), lru: "0x" + "ab".repeat(31) })],
    ["a key in upper case", () => ({ ...SK(), lru: K.lru.toUpperCase().replace("0X", "0x") })],
    ["a key more, named method", () => ({ ...SK(), method: "author_submitExtrinsic" })],
    ["a key missing", () => { const k = SK(); delete k.nonces; return k; }],
    ["keys that are an array", () => [K.lru]],
    ["keys that are null", () => null],
  ];
  for (const [what, keys] of bad) {
    const node = rerunNode("A6");
    const { reader } = readerOver(node);
    assert.throws(() => reader.sessionTape(keys()), /session-reads/, what);
    await tick();
    assert.equal(node.log.length, 0, `${what}: nothing is asked`);
  }
  for (const [what, args] of [["a negative block", [-1]], ["a huge block", [2 ** 60]], ["a block as text", ["5"]], ["NaN", [NaN]], ["a hash in upper case", [1, null, true]]]) {
    const node = rerunNode("A6");
    const { reader } = readerOver(node);
    const hash = args[2] ? node.head.toUpperCase().replace("0X", "0x") : node.head;
    assert.throws(() => reader.blockTape({ lru: K.lru, events: K.events }, args[0], hash), /session-reads/, what);
    await tick();
    assert.equal(node.log.length, 0, what);
  }
  for (const back of [0, -1, 1.5, Infinity, "1000", 2 ** 60, 2 ** 40]) {
    const node = rerunNode("A6");
    const { reader } = readerOver(node);
    if (back === 2 ** 40) {
      const r = plain(await reader.probe(back));
      assert.equal(r.answered, false);
      assert.ok(!methods(node).includes("state_call"), "a depth above the head sends no state_call");
    } else {
      assert.throws(() => reader.probe(back), /session-reads/, String(back));
      await tick();
      assert.equal(node.log.length, 0, String(back));
    }
  }
  // a key whose getter gives the checked value once and another value after: still only state_getStorage
  const node = rerunNode("A6");
  const { reader } = readerOver(node);
  let reads = 0;
  const k = SK();
  Object.defineProperty(k, "sessions", { enumerable: true, get: () => (reads++ < 2 ? K.sessions : "author_submitExtrinsic") });
  await reader.sessionTape(k);
  onlyReads(node, "a key with a changing getter");
});

test("HOLDS: a node that lies makes session-reads.js send no other method, and the tool or tool-run then refuses", async () => {
  const lies = {
    "a finalized head whose header names another number": { chain_getHeader: (p, base) => { const h = base(); return h && p[0] === rerunNode("A6").head ? { ...h, number: "0x" + (parseInt(h.number, 16) + 7).toString(16) } : h; } },
    "a canonical hash at the head's number that is not the head": { chain_getBlockHash: (p, base) => (p[0] === 0 ? base() : "0x" + "77".repeat(32)) },
    "an error object for the finalized head": { chain_getFinalizedHead: () => { throw { code: -32000, message: "lie" }; } },
    "a header of another type": { chain_getHeader: () => 12 },
    "a header number that parseInt reads in part": { chain_getHeader: (p, base) => { const h = base(); return h ? { ...h, number: h.number + "zz" } : h; } },
    "a very large header": { chain_getHeader: (p, base) => { const h = base(); return h ? { ...h, digest: { logs: ["0x" + "ab".repeat(200000)] } } : h; } },
    "a metadata of another length": { state_getMetadata: (p, base) => base().slice(0, -2) },
    "a storage answer of another type": { state_getStorage: () => ({ not: "hex" }) },
  };
  for (const [what, lie] of Object.entries(lies)) {
    const node = lying(lie);
    const r = plain(await readerOver(node).reader.sessionTape(SK()));
    onlyReads(node, what);
    const run = runWithSeat(DEV1);
    runs.push(run);
    // a record at R1's call, so the refusal is the tape's or the tool's and not the phase's (F10)
    writeRecord(run, atR1Call(DEV1, rerunStep("A1").finalized_in_block));
    const t = relayOf(r);
    let refused = false;
    try {
      const o = await runTool({ plan, run, id: "R1", purpose: "call", tapeText: t.text, tapeSha256: t.sha });
      refused = o.output.exit !== 0;
    } catch (e) { refused = (e instanceof ToolRunError && !/is not what the record is at/.test(e.message)) || /tape/.test(String(e?.message)); }
    assert.ok(refused, `${what}: the tool or tool-run refuses`);
  }
});

test("HOLDS: a block tape over a lying node sends only the read set", async () => {
  const node = lying({ chain_getHeader: () => ({ number: "0x1", parentHash: 5 }) });
  const b = rerunNode("A6").blockOf("A2");
  await readerOver(node).reader.blockTape({ lru: K.lru, events: K.events }, b.number, b.hash);
  onlyReads(node, "a block tape");
});

test("HOLDS: RG19-1: the probe sends state_call only at a 32 byte block hash, and says answered only for a call at the block PROBE_BACK below the head", async () => {
  for (const at of [null, "0xdead", { hash: "x" }]) {
    const node = lying({ chain_getBlockHash: (p, base) => (p[0] === 0 ? base() : at), state_call: () => "0x" + "ab".repeat(70) });
    const r = plain(await readerOver(node).reader.probe(Number(V("PROBE_BACK"))));
    const calls = node.sent.filter((c) => c.method === "state_call");
    assert.equal(calls.length, 0, `state_call was sent at ${JSON.stringify(at)}: ${JSON.stringify(calls.map((c) => c.params))}`);
    assert.equal(r.answered, false, `the relay says answered at ${JSON.stringify(r.at)}`);
  }
});
