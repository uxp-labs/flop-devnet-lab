// Review of G-19, attack 2 (G2): the owner signed check over files made wrong in every way the
// review could think of, with test keys from fixed seeds; the second encoder over a grid; and the
// call file and the send file read again after they were checked. The plan's OWNER is a test key in
// a copy held in memory. No network, no real key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { REPO, plan as realPlan, V, tempDir, testKey, seedOf, writeRecord } from "./fixtures.mjs";
import { blake2b256Hex, ss58, loadTool } from "./lib.mjs";
import { RERUN } from "./rerun-node.mjs";
import { checkOwnerSigned, OwnerCallError, signedPayload } from "./owner-call.mjs";
import { compact, partsOf } from "../2026-11-12-encoder-devnet-test/research-signed.mjs";
import { recordSigned } from "./record-step.mjs";
import { nextText } from "./plan.mjs";
import { started, step } from "./records.mjs";
import { callFile, sendFile, signedFile } from "./run.mjs";

const lib = (n) => import(pathToFileURL(createRequire(join(REPO, "imd-flop", "package.json")).resolve(n)).href);
const { ed25519 } = await lib("@noble/curves/ed25519.js");
const DIR = tempDir("g19-review-signed");
after(() => rmSync(DIR, { recursive: true, force: true }));
const owner = testKey(DIR, "review-owner"), other = testKey(DIR, "review-other");
const plan = structuredClone(realPlan);
plan.values.OWNER.value = owner.public_key;
plan.values.OWNER_SS58.value = ss58(owner.public_key);
const DEV1 = RERUN.accounts.dev1.public_key;
const SIGNER = join(REPO, plan.files.signer);
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const flopSign = (args, signer = SIGNER) => JSON.parse(execFileSync(process.execPath, [signer, ...args, "--libs", join(REPO, "imd-flop")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const second = (args) => flopSign(["call", ...args]).call;
const CALL = second(["create-session", "--delegate", DEV1, "--cap", V("SPENDING_CAP"), "--per-tx", V("A_PER_TX"), "--daily", V("A_DAILY"), "--blocks", V("DURATION"), "--allow", V("ALLOW")]);
const results = { record: "run-time", owner_account_nonce_at_start: "5", accounts: { owner: { public_key: owner.public_key }, device: { public_key: DEV1 } }, steps: [] };

let n = 0;
/** A file flop-sign.mjs sign writes. */
function signed({ key = owner, call = CALL, nonce = "5", spec = V("SPEC"), txv = V("TXV"), genesis = V("GENESIS") } = {}) {
  const out = join(DIR, `s${n++}.json`);
  flopSign(["sign", "--key", key.path, "--call", call, "--nonce", nonce, "--out", out, "--spec", spec, "--txv", txv, "--genesis", genesis]);
  return JSON.parse(readFileSync(out, "utf8"));
}
/** A file whose extrinsic is the given bytes, its hash made right. */
const withExtrinsic = (s, b) => ({ ...s, extrinsic: hex(b), extrinsic_hash: blake2b256Hex(b) });
/** An envelope made by hand: era bytes, tip, signed by a seed over the payload of those extensions. */
function byHand({ era = Buffer.of(0), tip = 0, nonce = 5, genesis = V("GENESIS"), sign = true } = {}) {
  const call = Buffer.from(CALL.slice(2), "hex");
  const g = Buffer.from(genesis.slice(2), "hex");
  const extra = Buffer.concat([era, compact(nonce), compact(tip), Buffer.of(0)]);
  const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32LE(x); return b; };
  const block = era.length === 1 ? g : Buffer.alloc(32, 7);
  const payload = Buffer.concat([call, extra, u32(Number(V("SPEC"))), u32(Number(V("TXV"))), g, block, Buffer.of(0)]);
  const sig = sign ? ed25519.sign(payload, seedOf("review-owner")) : Buffer.alloc(64);
  const body = Buffer.concat([Buffer.of(0x84, 0), Buffer.from(owner.public_key.slice(2), "hex"), Buffer.of(0), Buffer.from(sig), extra, call]);
  return withExtrinsic(signed(), Buffer.concat([compact(body.length), body]));
}
const refuses = (s, what) => assert.throws(() => checkOwnerSigned(plan, results, "G1", s, CALL), OwnerCallError, what);

test("HOLDS: the file flop-sign.mjs signs for the plan's owner, nonce and call passes", () => {
  assert.equal(checkOwnerSigned(plan, results, "G1", signed(), CALL).nonce, "5");
  assert.doesNotThrow(() => checkOwnerSigned(plan, results, "G1", byHand(), CALL), "the hand made envelope is the signer's");
});

test("HOLDS: every wrong signed file the review made is refused", () => {
  const good = signed();
  const b = Buffer.from(good.extrinsic.slice(2), "hex");
  const otherCaps = second(["create-session", "--delegate", DEV1, "--cap", V("SPENDING_CAP"), "--per-tx", V("A_PER_TX"), "--daily", V("A_DAILY"), "--blocks", "86399", "--allow", V("ALLOW")]);
  const revoke = second(["revoke", "--delegate", DEV1]);
  const flipped = Buffer.from(CALL.slice(2), "hex"); flipped[40] ^= 1;
  const sigBad = Buffer.from(b); sigBad[1 + 1 + 1 + 32 + 1 + 3] ^= 1;
  const p = partsOf(b);
  const bodyLen = Number(p.length);
  const plusByte = Buffer.concat([compact(bodyLen + 1), b.subarray(b.length - bodyLen), Buffer.of(0)]);
  const wrongLen = Buffer.concat([compact(bodyLen + 1), b.subarray(b.length - bodyLen)]);
  const cases = [
    ["another signer", signed({ key: other })],
    ["another nonce", signed({ nonce: "6" })],
    ["a nonce below", signed({ nonce: "4" })],
    ["another call of the same pallet (revoke)", signed({ call: revoke })],
    ["another create_session (86399 blocks)", signed({ call: otherCaps })],
    ["the call with one byte changed", signed({ call: hex(flipped) })],
    ["bytes added after the call, the length made right", withExtrinsic(good, plusByte)],
    ["a wrong length prefix", withExtrinsic(good, wrongLen)],
    ["two extrinsics in one file", withExtrinsic(good, Buffer.concat([b, b]))],
    ["a mortal era", byHand({ era: Buffer.of(0x15, 0x00) })],
    ["a tip", byHand({ tip: 1 })],
    ["a signature over another genesis, the file's fields the plan's", { ...signed({ genesis: "0x" + "11".repeat(32) }), genesis: V("GENESIS") }],
    ["a signature over another spec, the file's fields the plan's", { ...signed({ spec: "1014014" }), spec_version: Number(V("SPEC")) }],
    ["a signature over another transaction version, the file's fields the plan's", { ...signed({ txv: "1" }), transaction_version: Number(V("TXV")) }],
    ["another genesis, said in the file", signed({ genesis: "0x" + "11".repeat(32) })],
    ["a signature that does not verify", withExtrinsic(good, sigBad)],
    ["a signature of zeros", byHand({ sign: false })],
    ["the hex in upper case", { ...good, extrinsic: "0x" + good.extrinsic.slice(2).toUpperCase() }],
    ["an extrinsic_hash that is not its extrinsic's", { ...good, extrinsic_hash: "0x" + "00".repeat(32) }],
    ["no extrinsic", { ...good, extrinsic: undefined }],
  ];
  for (const [what, s] of cases) refuses(s, what);
  assert.equal(cases.length, 20);
});

test("DEFECT RG19-2: a signed file with a field more than flop-sign.mjs sign writes is refused", () => {
  const s = { ...signed(), extrinsic_2: signed({ nonce: "6" }).extrinsic };
  assert.throws(() => checkOwnerSigned(plan, results, "G1", s, CALL), OwnerCallError);
});

test("HOLDS: the tool's encoder and the second encoder give the same bytes over a grid of devices and caps", async () => {
  const { encodeOwnerCall } = await import(pathToFileURL(join(REPO, "imd-flop", "dist", "chain", "owner-calls.js")).href);
  const runtime = { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") };
  const devices = [DEV1, "0x" + "00".repeat(32), "0x" + "ff".repeat(32), owner.public_key];
  const caps = [["1", "1", "1", 1], [V("SPENDING_CAP"), V("A_PER_TX"), V("A_DAILY"), Number(V("DURATION"))], ["1000000000000000000", "999999999999999999", "1000000000000000000", 86400], ["50000000000000000", "20000000000000000", "25000000000000000", 63]];
  let count = 0;
  for (const d of devices) {
    assert.equal(hex(encodeOwnerCall({ runtime, call: "revoke_session", delegate: Uint8Array.from(Buffer.from(d.slice(2), "hex")) })), second(["revoke", "--delegate", d]));
    count++;
    for (const [cap, per, daily, blocks] of caps) {
      const tool = hex(encodeOwnerCall({ runtime, call: "create_session", delegate: Uint8Array.from(Buffer.from(d.slice(2), "hex")), spending_cap: BigInt(cap), per_tx_limit: BigInt(per), daily_cap: BigInt(daily), duration_blocks: blocks }));
      assert.equal(tool, second(["create-session", "--delegate", d, "--cap", cap, "--per-tx", per, "--daily", daily, "--blocks", String(blocks), "--allow", V("ALLOW")]), `${d} ${cap} ${blocks}`);
      count++;
    }
  }
  assert.equal(count, 20);
});

/** A run folder at G1's sign: the record holds the tool's call, and calls/G1.json is written. */
function atSign(callInFile) {
  const run = join(DIR, `run${n++}`);
  mkdirSync(join(run, "calls"), { recursive: true });
  mkdirSync(join(run, "signed"), { recursive: true });
  const r = step(started({ nonce: "5" }), "G1", { upTo: "call" });
  r.accounts.device.public_key = DEV1;
  r.steps[0].call.call_hex = CALL;
  writeRecord(run, r);
  writeFileSync(callFile(run, "G1"), JSON.stringify({ call: callInFile }) + "\n");
  return { run, r };
}

test("HOLDS: RG19-3: send-file holds the signed file to the tool's call the record holds, not to whatever calls/<id>.json says when it is read", () => {
  const otherCall = second(["create-session", "--delegate", DEV1, "--cap", "1000000000000000000", "--per-tx", "1000000000000000000", "--daily", "1000000000000000000", "--blocks", "86400", "--allow", V("ALLOW")]);
  const { run, r } = atSign(otherCall);
  writeFileSync(signedFile(run, "G1"), JSON.stringify(signed({ call: otherCall })));
  const out = recordSigned(plan, run, r, "G1");
  assert.equal(out.sendText, null, `a send file was made for a call that is not the tool's: ${out.results.steps[0].signed_check.refused ?? "accepted"}`);
});

test("HOLDS: RG19-4: plan.mjs next prints no send line for a send file whose extrinsic is not the one send-file checked", async () => {
  const { run, r } = atSign(CALL);
  writeFileSync(signedFile(run, "G1"), JSON.stringify(signed()));
  const s = recordSigned(plan, run, r, "G1");
  assert.ok(s.sendText);
  writeFileSync(sendFile(run, "G1"), JSON.stringify({ step: "G1", extrinsic: signed({ nonce: "6" }).extrinsic }));
  const text = await nextText(plan, run, s.results);
  assert.doesNotMatch(text, /lab\.send\(/, "a send line is printed for bytes no check held");
});
