// The rules of record-step.mjs that the walk does not reach (H3, H10, H11, H13): a call that is not
// the plan's or not the second encoder's is kept as a refusal and writes no call file; a reading
// that is not next, or that submitted nothing, or that is of other bytes, is refused; the lead's
// stop of cases a, c and d and its refusals. Over the rehearsal's walk (walk.mjs). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { plan, V, relay } from "./fixtures.mjs";
import { rerunNode } from "./rerun-node.mjs";
import { leadStop, recordCall, recordReading, RecordStepError } from "./record-step.mjs";
import { nextOf } from "./next.mjs";
import { newWalk } from "./walk.mjs";
import { readJson } from "./lib.mjs";
import { signedFile } from "./run.mjs";
import { REPO } from "./lib.mjs";

const ERRORS = readJson(join(REPO, plan.files.errors));
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof RecordStepError && re.test(e.message), re.toString());
async function at(phase) {
  const w = await newWalk(`g19-rs-${phase}`);
  await w.p0();
  if (phase === "p0") return w;
  await w.call("G1", w.node("A1", ["sessions", "nonces", "breakers"]));
  if (phase === "call") return w;
  w.sign("G1");
  return w;
}

test("H3: a grant the tool refused (exit 5, the session active at A2) is kept as a refusal, no call file, and next says stop", async () => {
  const w = await at("p0");
  try {
    await w.use("G1", "call", await w.tape(rerunNode("A2")));
    const c = recordCall(plan, w.run, w.results, "G1");
    assert.equal(c.callText, null);
    assert.match(c.results.steps[0].call.refused, /the tool exited 5 for G1, not 0: imd-flop: a session for this owner and device is stored and active/);
    const n = nextOf(plan, c.results);
    assert.equal(n.word, "stop");
    assert.match(n.why, /call of G1 is refused, nothing is signed/);
  } finally { w.done(); }
});

test("H3: a tool call that differs from the second encoder is kept as a refusal and writes no call file", async () => {
  const w = await at("p0");
  try {
    await w.use("G1", "call", await w.tape(w.node("A1", ["sessions", "nonces", "breakers"])));
    const other = structuredClone(plan);
    other.steps.find((s) => s.id === "G1").second_encoder = other.steps.find((s) => s.id === "G1").second_encoder.map((a) => (a === "$DURATION" ? "86399" : a));
    const c = recordCall(other, w.run, w.results, "G1");
    assert.equal(c.callText, null);
    assert.equal(c.results.steps[0].call.equal, false);
    assert.match(c.results.steps[0].call.refused, /the tool's call 0x5e00.* is not the second encoder's 0x5e00/);
  } finally { w.done(); }
});

test("H3: a tool call whose caps are not the plan's derived caps is refused before the second encoder", async () => {
  const w = await at("p0");
  try {
    await w.use("G1", "call", await w.tape(w.node("A1", ["sessions", "nonces", "breakers"])));
    const other = structuredClone(plan);
    other.values.A_DAILY.value = "30000000000000000";
    const c = recordCall(other, w.run, w.results, "G1");
    assert.match(c.results.steps[0].call.refused, /the caps is .*the plan's is/);
    assert.equal(c.results.steps[0].call.second_encoder, undefined);
  } finally { w.done(); }
});

test("H3: G2's call must carry the stored record line; G1's must carry none", async () => {
  const { plannedStored } = await import("./owner-call.mjs");
  assert.equal(plannedStored(plan, "G1"), null);
  assert.equal(plannedStored(plan, "G2"), `A record is stored for this pair, revoked. ${V("STORED_RECORD_LINE")}`);
});

test("H13: a reading is refused when it is not next, when it submitted nothing, or when it is of other bytes", async () => {
  const w = await at("call");
  try {
    const sent = relay({ status: "finalized", sent_by: "send", block_number: 1, block_hash: "0x" + "00".repeat(32), extrinsic_index: 1 });
    refused(() => recordReading({ plan, run: w.run, results: w.results, id: "G1", sent: JSON.parse(sent.text), sentSha256: sent.sha, errors: ERRORS }), /G1 send or wait is not next by the record: go G1 sign/);
    w.sign("G1");
    refused(() => recordReading({ plan, run: w.run, results: w.results, id: "G1", sent: { status: "not-sent" }, sentSha256: "00", errors: ERRORS }), /nothing was submitted by that call/);
    refused(() => recordReading({ plan, run: w.run, results: w.results, id: "G1", sent: { status: "finalized", extrinsic_sha256: "00".repeat(32), block_number: 1, block_hash: "0x" + "00".repeat(32), extrinsic_index: 1 }, sentSha256: "00", errors: ERRORS }), /not the one of signed\/G1.json/);
    refused(() => recordReading({ plan, run: w.run, results: w.results, id: "G1", explorer: {}, explorerSha256: "00", errors: ERRORS }), /no finalized block for G1/);
  } finally { w.done(); }
});

test("H11: the lead's stop: case a with nothing signed; case d with a signed copy and the owner's next nonce equal to the copy's", async () => {
  const w = await at("call");
  try {
    const nonce = Number(w.results.owner_account_nonce_at_start);
    const a = leadStop({ plan, run: w.run, results: w.results, id: "G1", why: "the lead stops before signing" });
    assert.equal(a.steps[0].lead_stop.case, "a");
    assert.match(nextOf(plan, a).why, /the lead stopped G1 \(case a\)/);
    w.sign("G1");
    const reads = (n) => relay({ account: V("OWNER_SS58"), runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") }, finalized: { number: 3552800, hash: "0x" + "ab".repeat(32) }, account_nonce: n });
    refused(() => leadStop({ plan, run: w.run, results: w.results, id: "G1", why: "x", readsText: reads(nonce + 1).text, readsSha256: reads(nonce + 1).sha }), /the owner's next nonce is \d+, not the copy's \d+: the nonce is used/);
    refused(() => leadStop({ plan, run: w.run, results: w.results, id: "G1", why: "x", readsText: reads(nonce - 1).text, readsSha256: reads(nonce - 1).sha }), /the record and the chain disagree/);
    refused(() => leadStop({ plan, run: w.run, results: w.results, id: "G1", why: "" }), /--why/);
    const d = leadStop({ plan, run: w.run, results: w.results, id: "G1", why: "never sent", readsText: reads(nonce).text, readsSha256: reads(nonce).sha });
    assert.equal(d.steps[0].lead_stop.case, "d");
    assert.deepEqual(d.steps[0].lead_stop.unsent, ["signed/G1.json", "signed/G1.send.json"]);
    assert.equal(d.steps[0].lead_stop.evidence.extrinsic_hash, readJson(signedFile(w.run, "G1")).extrinsic_hash);
  } finally { w.done(); }
});

test("H11: case c only after a first send refused with 1010; a deadline or a 1013 is no stop", async () => {
  const w = await at("sign");
  try {
    const nonce = Number(w.results.owner_account_nonce_at_start);
    const reads = relay({ account: V("OWNER_SS58"), runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") }, finalized: { number: 3552800, hash: "0x" + "ab".repeat(32) }, account_nonce: nonce });
    const signed = readJson(signedFile(w.run, "G1"));
    const { sha256Text } = await import("./lib.mjs");
    const reading = (o) => ({ step: "G1", extrinsic_sha256: sha256Text(signed.extrinsic), sent_by: "send", ...o });
    const after = (o) => recordReading({ plan, run: w.run, results: w.results, id: "G1", sent: reading(o), sentSha256: "00", errors: ERRORS });
    const c = leadStop({ plan, run: w.run, results: after({ status: "refused-at-submission", node: { code: 1010, message: "Invalid" } }), id: "G1", why: "refused", readsText: reads.text, readsSha256: reads.sha });
    assert.equal(c.steps[0].lead_stop.case, "c");
    refused(() => leadStop({ plan, run: w.run, results: after({ status: "deadline" }), id: "G1", why: "x", readsText: reads.text, readsSha256: reads.sha }), /its last runner reading is deadline; its copy may still land/);
    refused(() => leadStop({ plan, run: w.run, results: after({ status: "refused-at-submission", node: { code: 1013 } }), id: "G1", why: "x", readsText: reads.text, readsSha256: reads.sha }), /its copy may still land/);
    refused(() => leadStop({ plan, run: w.run, results: after({ status: "already-sent" }), id: "G1", why: "x", readsText: reads.text, readsSha256: reads.sha }), /sent list held these bytes/);
  } finally { w.done(); }
});

test("H3: a grant printed without the stored record line is refused at G2 (U1 is asked only over the revoked record)", async () => {
  const w = await at("p0");
  try {
    await w.use("G1", "call", await w.tape(w.node("A1", ["sessions", "nonces", "breakers"])));
    const { copyFileSync } = await import("node:fs");
    copyFileSync(join(w.run, "tool", "G1.call.json"), join(w.run, "tool", "G2.call.json"));
    const { toolCall, OwnerCallError } = await import("./owner-call.mjs");
    assert.throws(() => toolCall(plan, w.run, w.results, "G2"), (e) => e instanceof OwnerCallError && /the stored record line is null, the plan's is "A record is stored for this pair, revoked/.test(e.message));
    assert.equal(toolCall(plan, w.run, w.results, "G1").call_hex.slice(0, 6), "0x5e00");
  } finally { w.done(); }
});

test("H14: an after reading whose tape's head is below the step's block is refused", async () => {
  const w = await newWalk("g19-rs-after");
  try {
    await w.p0();
    await w.call("G1", w.node("A1", ["sessions", "nonces", "breakers"]));
    w.sign("G1"); w.sent("G1", "A2");
    await w.block("G1", rerunNode("A6"), "A2");
    await w.use("G1", "after", await w.tape(rerunNode("A6")));
    const { writeFileSync } = await import("node:fs");
    const f = join(w.run, "tool", "G1.after.json");
    const o = readJson(f);
    o.tape_head.number = 1;
    writeFileSync(f, JSON.stringify(o));
    const { recordTool } = await import("./record-step.mjs");
    refused(() => recordTool(plan, w.run, w.results, "G1", "after", ERRORS), /the after tape's head 1 is below G1's block 3552729/);
  } finally { w.done(); }
});
