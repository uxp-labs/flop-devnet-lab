// Tests of sign-device.mjs (rules R2, R3, R4 of the first brief; S1 to S7 of the fix brief):
// node --test in this folder. No network. The test key is made here, in a temporary folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERE, REPO, readJson } from "./lib.mjs";
import { loadDeviceSigner, KEY_REFUSAL } from "./device-key.mjs";
import { signStep, takeReads, sendText } from "./sign-device.mjs";
import { plan, V, RUNTIME, makeKey, tempDir, deviceReads, startedRecord, runFolder, sent, explored, asPlanned, relay } from "./fixtures.mjs";

const { readExtrinsic } = await import(pathToFileURL(join(REPO, "imd-flop", "dist", "chain", "reader.js")).href);
const SCRIPT = join(HERE, "sign-device.mjs");
const DIR = tempDir("sign-device-test");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY, seed } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const SECRET_FORMS = [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url"), seed.toString("base64").replace(/=+$/, "")];
const hasSecret = (text) => SECRET_FORMS.some((f) => text.includes(f));
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const BIRTH = 3600010;

function cli(id, run, reads, ...more) {
  const r = spawnSync(process.execPath, [SCRIPT, id, "--run", run, "--key", KEY, "--reads", reads.text, "--reads-sha256", reads.sha, ...more], { encoding: "utf8", cwd: DIR });
  return r;
}
const readX = (run, id, birth = BIRTH) => readExtrinsic(RUNTIME, Uint8Array.from(Buffer.from(readJson(join(run, "signed", `${id}.json`)).extrinsic.slice(2), "hex")), { number: birth, hash: Uint8Array.from(Buffer.from("cd".repeat(32), "hex")) });
/** A run folder whose record is as planned up to a step, and the reads that fit the next step. */
function at(upTo, { outcomes, errors } = {}) {
  const { results, blocks } = upTo ? asPlanned(DEVICE, upTo, { outcomes, errors }) : { results: startedRecord(DEVICE), blocks: {} };
  return { run: runFolder(results, `run-${upTo ?? "start"}`), results, blocks };
}
const t3Reads = (o = {}) => deviceReads(DEVICE, { number: BIRTH, accountNonce: 0, sessionNonce: null, ...o });

test("R2: T3 is a session call around force_open of steps.json, mortal, declaring exactly the escrow", () => {
  const { run } = at("T2");
  const r = cli("T3", run, t3Reads());
  assert.equal(r.status, 0, r.stderr);
  const x = readX(run, "T3");
  assert.equal(hex(x.signer), DEVICE);
  assert.equal(x.call.inner.call, "force_open");
  assert.equal(hex(x.call.inner.miner), V("NAMED"));
  assert.equal(hex(x.call.inner.agent_key), DEVICE, "the agent key is the device");
  assert.equal(x.call.inner.escrow, BigInt(V("ESCROW_1")));
  assert.equal(x.call.spend, BigInt(V("ESCROW_1")), "the declared spend is the escrow");
  assert.equal(hex(x.call.owner), V("OWNER"));
  assert.equal(x.era.period, 64);
  assert.equal(x.lastValidBlock, BIRTH + 63);
  assert.match(r.stderr, /force_open/, "the description goes to stderr");
});

test("S3: two files, the send file exactly {step, extrinsic} with no line end; stdout is the JSON line and then the send file's text", () => {
  const { run } = at("T2");
  const r = cli("T3", run, t3Reads());
  assert.equal(r.status, 0, r.stderr);
  const full = readJson(join(run, "signed", "T3.json"));
  const send = readFileSync(join(run, "signed", "T3.send.json"), "utf8");
  assert.equal(send, JSON.stringify({ step: "T3", extrinsic: full.extrinsic }));
  assert.equal(send, sendText(full));
  assert.doesNotMatch(send, /\n/);
  const lines = r.stdout.split("\n");
  assert.equal(lines.length, 3, "two lines and the end");
  const out = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(out), ["saved", "send_file", "send_sha256", "extrinsic_hash", "last_valid_block", "birth_number"]);
  assert.equal(out.send_sha256, createHash("sha256").update(send).digest("hex"), "the sha256 printed is the send file's");
  assert.equal(out.extrinsic_hash, full.extrinsic_hash);
  assert.equal(out.last_valid_block, BIRTH + 63);
  assert.equal(out.birth_number, BIRTH);
  assert.equal(lines[1], send);
  assert.ok(send.length < 900, `the send file is short: ${send.length}`);
});

test("R2: T5 is open_channel with the plan's enclave key, short max_duration and settlement class", () => {
  const { run } = at("T4");
  const r = cli("T5", run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 2, sessionNonce: 2 }));
  assert.equal(r.status, 0, r.stderr);
  const x = readX(run, "T5");
  assert.equal(x.call.inner.call, "open_channel");
  assert.equal(hex(x.call.inner.enclave_key), V("ENCLAVE_KEY"));
  assert.equal(x.call.inner.sla.max_duration, Number(V("MAX_DURATION_D2")));
  assert.equal(x.call.inner.settlement_class, V("SETTLEMENT"));
  assert.equal(x.call.spend, BigInt(V("ESCROW_1")));
  assert.equal(x.call.sessionNonce, 2n);
  assert.equal(x.accountNonce, 2);
});

test("P1: T4, T6 and T7 carry the derived channel ids CH_T3 and CH_T5", () => {
  const t4 = at("T3");
  assert.equal(cli("T4", t4.run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: 1 })).status, 0);
  assert.equal(hex(readX(t4.run, "T4").call.inner.channel_id), V("CH_T3"));
  assert.equal(readX(t4.run, "T4").call.spend, BigInt(V("TOP_UP")), "the top up declares its amount");
  const t6 = at("T5");
  const b6 = Math.max(t6.blocks.T3 + Number(V("ACK_WINDOW")), t6.blocks.T3 + 595) + 1;
  const r6 = cli("T6", t6.run, deviceReads(DEVICE, { number: b6, accountNonce: 3, sessionNonce: 3 }));
  assert.equal(r6.status, 0, r6.stderr);
  assert.equal(hex(readX(t6.run, "T6", b6).call.inner.channel_id), V("CH_T3"));
  const t7 = at("T6");
  const b7 = t7.blocks.T5 + Number(V("MAX_DURATION_D2")) + 1;
  const r7 = cli("T7", t7.run, deviceReads(DEVICE, { number: b7, accountNonce: 4, sessionNonce: 4 }));
  assert.equal(r7.status, 0, r7.stderr);
  assert.equal(hex(readX(t7.run, "T7", b7).call.inner.channel_id), V("CH_T5"));
});

test("S2a: it refuses a step the encoder does not sign, and an id that is no step or no allowed attempt, before it reads any key", () => {
  const { run } = at("T2");
  for (const [id, words] of [["T1", /not signed by the encoder/], ["T2", /not signed by the encoder/], ["T8", /not signed by the encoder/], ["T9", /not signed by the encoder/], ["T10", /no step T10/], ["T3.2", /not an attempt S5 allows/], ["T6.4", /not an attempt S5 allows/]]) {
    const r = spawnSync(process.execPath, [SCRIPT, id, "--run", run, "--key", join(DIR, "no-such-key.json"), "--reads", t3Reads().text, "--reads-sha256", t3Reads().sha], { encoding: "utf8" });
    assert.equal(r.status, 2, id);
    assert.match(r.stderr, words, id);
  }
});

test("S1: --run is required, --results and --out-dir are gone, and no path is taken from the working folder", () => {
  const { run } = at("T2");
  const reads = t3Reads();
  const without = spawnSync(process.execPath, [SCRIPT, "T3", "--key", KEY, "--reads", reads.text, "--reads-sha256", reads.sha], { encoding: "utf8", cwd: run });
  assert.equal(without.status, 2);
  assert.match(without.stderr, /--run <run folder> is required/);
  for (const old of ["--results", "--out-dir"]) {
    const r = cli("T3", run, reads, old, join(DIR, "x"));
    assert.equal(r.status, 2, old);
    assert.match(r.stderr, /is not a flag of this script/);
  }
  const elsewhere = join(DIR, "cwd-elsewhere"); mkdirSync(elsewhere, { recursive: true });
  const ok = spawnSync(process.execPath, [SCRIPT, "T3", "--run", run, "--key", KEY, "--reads", reads.text, "--reads-sha256", reads.sha], { encoding: "utf8", cwd: elsewhere });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(existsSync(join(elsewhere, "signed")), false, "nothing in the working folder");
  assert.ok(existsSync(join(run, "signed", "T3.json")));
  const second = spawnSync(process.execPath, [SCRIPT, "T3", "--run", run, "--key", KEY, "--reads", reads.text, "--reads-sha256", reads.sha], { encoding: "utf8", cwd: DIR });
  assert.equal(second.status, 2, "a second copy from another working folder is refused");
});

test("S2b: the reads need their sha256, and a text that changed on its way is refused", () => {
  const { run } = at("T2");
  const reads = t3Reads();
  const none = spawnSync(process.execPath, [SCRIPT, "T3", "--run", run, "--key", KEY, "--reads", reads.text], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--reads-sha256 is required/);
  const changed = cli("T3", run, { text: reads.text.replace('"account_nonce":0', '"account_nonce":0 '), sha: reads.sha });
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /changed on its way/);
});

test("S2c: only the next step by the record is signed: not T4 before T3, not T3 before T2, nothing while the judge waits", () => {
  const t2 = at("T2");
  const r = cli("T4", t2.run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 0 }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /T4 is not next by the record: go on T3/);
  const t1 = at("T1");
  assert.match(cli("T3", t1.run, t3Reads()).stderr, /not next by the record: go on T2/);
  const waiting = asPlanned(DEVICE, "T3").results;
  waiting.steps.find((s) => s.step === "T3").run_time.explorer = null;
  const w = cli("T4", runFolder(waiting), deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: 1 }));
  assert.match(w.stderr, /not next by the record: wait T3: the explorer reading of T3/);
});

test("S2d: a step the record holds as included is never signed again, even with its files moved aside", () => {
  const { run } = at("T3");
  const r = cli("T3", run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: 1 }), "--again");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /T3 is not next by the record/);
  const rec = asPlanned(DEVICE, "T3").results;
  rec.steps.find((s) => s.step === "T3").run_time.explorer = null;
  const only = cli("T3", runFolder(rec), deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: 1 }), "--again");
  assert.equal(only.status, 2);
  assert.match(only.stderr, /not next by the record: wait T3: the explorer reading/);
});

test("S2e: the device's next nonce must be the number of device transactions the record holds as finalized", () => {
  const { run } = at("T2");
  const r = cli("T3", run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 1 }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a device transaction the record does not hold is in the pool or on chain/);
  assert.equal(existsSync(join(run, "signed", "T3.json")), false);
  const t3 = at("T3");
  assert.match(cli("T4", t3.run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 2, sessionNonce: 1 })).stderr, /in the pool or on chain/);
});

test("S2f: the session nonce must be the number of session calls the record holds as succeeded; a raw null counts as 0 only then", () => {
  const t2 = at("T2");
  assert.match(cli("T3", t2.run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 0, sessionNonce: 1 })).stderr, /the session nonce in the reads is 1, the record holds 0 session calls as succeeded/);
  const t3 = at("T3");
  assert.match(cli("T4", t3.run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: null })).stderr, /is not stored, the record holds 1 session calls/);
  assert.equal(cli("T4", t3.run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: 1 })).status, 0);
  const refused = asPlanned(DEVICE, "T4", { outcomes: { T4: "ComputeChannel.BadState" }, errors: readJson(join(REPO, "research/2026-11-12-session-rerun-1014020/errors-1014020.json")) });
  const run = runFolder(refused.results);
  assert.equal(cli("T5", run, deviceReads(DEVICE, { number: BIRTH, accountNonce: 2, sessionNonce: 1 })).status, 0, "a refused session call does not move the session nonce");
});

test("S2: the reads must be of the device of the record, and of the device's own key", () => {
  const { run } = at("T2");
  const other = deviceReads("0x" + "77".repeat(32), { number: BIRTH, accountNonce: 0 });
  assert.match(cli("T3", run, other).stderr, /not the device of results.json/);
  const foreign = runFolder(asPlanned("0x" + "77".repeat(32), "T2").results);
  const r = cli("T3", foreign, deviceReads("0x" + "77".repeat(32), { number: BIRTH, accountNonce: 0 }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the key file is not the device of results.json/);
});

test("S7: T6 waits for the greater of T3's block plus the ack window and the explorer's ack deadline; T7 for T5's block plus MAX_DURATION_D2", () => {
  const t6 = asPlanned(DEVICE, "T5");
  const t3 = t6.blocks.T3;
  const ev = t6.results.steps.find((s) => s.step === "T3").run_time.explorer.events.find((e) => e.name === "ForceOpenRequested");
  ev.fields.ack_deadline = String(t3 + 700);
  const run = runFolder(t6.results);
  const early = cli("T6", run, deviceReads(DEVICE, { number: t3 + 700, accountNonce: 3, sessionNonce: 3 }));
  assert.equal(early.status, 2);
  assert.match(early.stderr, new RegExp(`signed only from a birth block above ${t3 + 700}: the birth block is ${t3 + 700}, 1 blocks left`));
  assert.equal(cli("T6", run, deviceReads(DEVICE, { number: t3 + 701, accountNonce: 3, sessionNonce: 3 })).status, 0);
  ev.fields.ack_deadline = String(t3 + 10);
  const run2 = runFolder(t6.results);
  assert.match(cli("T6", run2, deviceReads(DEVICE, { number: t3 + 600, accountNonce: 3, sessionNonce: 3 })).stderr, new RegExp(`above ${t3 + 600}`), "the ack window binds when the deadline is earlier");
  const t7 = asPlanned(DEVICE, "T6");
  const run7 = runFolder(t7.results);
  const at7 = t7.blocks.T5 + Number(V("MAX_DURATION_D2"));
  assert.match(cli("T7", run7, deviceReads(DEVICE, { number: at7, accountNonce: 4, sessionNonce: 4 })).stderr, new RegExp(`above ${at7}`));
  assert.equal(cli("T7", run7, deviceReads(DEVICE, { number: at7 + 1, accountNonce: 4, sessionNonce: 4 })).status, 0);
});

test("S4: --again signs a second copy only when the earlier copy's era is over and S2 holds; the earlier files become dead-<n>", () => {
  const { results } = asPlanned(DEVICE, "T2");
  const run = runFolder(results);
  assert.equal(cli("T3", run, t3Reads()).status, 0);
  const first = readJson(join(run, "signed", "T3.json"));
  assert.match(cli("T3", run, t3Reads({ number: BIRTH + 100 })).stderr, /exists: a signed step is never replaced/, "without --again an existing file refuses");
  assert.match(cli("T3", run, t3Reads({ number: BIRTH + 63 }), "--again").stderr, new RegExp(`valid to block ${BIRTH + 63}.*its era is not over`));
  assert.match(cli("T3", run, t3Reads({ number: BIRTH + 64, accountNonce: 1 }), "--again").stderr, /in the pool or on chain/, "e above all");
  const again = cli("T3", run, t3Reads({ number: BIRTH + 64, hash: "0x" + "ce".repeat(32) }), "--again");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(readdirSync(join(run, "signed")).sort(), ["T3.dead-1.json", "T3.dead-1.send.json", "T3.json", "T3.send.json"]);
  assert.deepEqual(readJson(join(run, "signed", "T3.dead-1.json")), first);
  const second = readJson(join(run, "signed", "T3.json"));
  assert.deepEqual(second.earlier_copies, [{ file: "signed/T3.dead-1.json", send_file: "signed/T3.dead-1.send.json", extrinsic_hash: first.extrinsic_hash, last_valid_block: BIRTH + 63 }]);
  assert.notEqual(second.extrinsic_hash, first.extrinsic_hash);
  assert.match(cli("T4", runFolder(asPlanned(DEVICE, "T3").results), deviceReads(DEVICE, { number: BIRTH, accountNonce: 1, sessionNonce: 1 }), "--again").stderr, /--again needs signed\/T4.json/);
  // after a recorded reading that holds no finalized block, the judge waits for T3's inclusion: --again is still the way
  const waited = asPlanned(DEVICE, "T2").results;
  sent(waited, "T3", { status: "deadline" });
  const wrun = runFolder(waited);
  mkdirSync(join(wrun, "signed"), { recursive: true });
  writeFileSync(join(wrun, "signed", "T3.json"), JSON.stringify(first));
  assert.match(cli("T3", wrun, t3Reads({ number: BIRTH + 100 })).stderr, /not next by the record: wait T3/);
  assert.equal(cli("T3", wrun, t3Reads({ number: BIRTH + 100 }), "--again").status, 0);
  const third = cli("T3", wrun, t3Reads({ number: BIRTH + 200 }), "--again");
  assert.equal(third.status, 0, third.stderr);
  assert.equal(readJson(join(wrun, "signed", "T3.json")).earlier_copies.length, 2, "the earlier copies accumulate");
});

test("S5: a cleanup step included with an error may be attempted twice more, as T6.2 and T6.3, and no other step has attempts", () => {
  const errors = readJson(join(REPO, "research/2026-11-12-session-rerun-1014020/errors-1014020.json"));
  const { results, blocks } = asPlanned(DEVICE, "T6", { outcomes: { T6: "ComputeChannel.AckWindowNotElapsed" }, errors });
  const run = runFolder(results);
  const b = blocks.T3 + 700;
  assert.match(cli("T7", run, deviceReads(DEVICE, { number: b, accountNonce: 4, sessionNonce: 3 })).stderr, /T7 is not next by the record: go on T6.2/);
  const r = cli("T6.2", run, deviceReads(DEVICE, { number: b, accountNonce: 4, sessionNonce: 3 }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(run, "signed", "T6.2.json")) && existsSync(join(run, "signed", "T6.2.send.json")));
  assert.equal(readJson(join(run, "signed", "T6.2.json")).step, "T6.2");
  assert.equal(readFileSync(join(run, "signed", "T6.2.send.json"), "utf8"), JSON.stringify({ step: "T6.2", extrinsic: readJson(join(run, "signed", "T6.2.json")).extrinsic }));
  assert.equal(readX(run, "T6.2", b).call.inner.call, "expire_force_open");
});

test("S6: the key file must be exactly what flop-sign.mjs keygen writes; anything else gets the one fixed message", () => {
  const src = readFileSync(join(REPO, "research/2026-11-11-session-deny-list/flop-sign.mjs"), "utf8");
  assert.match(src, /JSON\.stringify\(\{ v: 0, alg: "ed25519", seed_b64: base64\.encode\(seed\) \}\) \+ "\\n"/, "the format checked is keygen's");
  const { run } = at("T2");
  const b64 = seed.toString("base64");
  const cases = {
    "alg sr25519": JSON.stringify({ v: 0, alg: "sr25519", seed_b64: b64 }) + "\n",
    "v 1": JSON.stringify({ v: 1, alg: "ed25519", seed_b64: b64 }) + "\n",
    "v as text": JSON.stringify({ v: "0", alg: "ed25519", seed_b64: b64 }) + "\n",
    "no alg": JSON.stringify({ v: 0, seed_b64: b64 }) + "\n",
    "an extra field": JSON.stringify({ v: 0, alg: "ed25519", seed_b64: b64, note: "x" }) + "\n",
    "fields in another order": JSON.stringify({ alg: "ed25519", v: 0, seed_b64: b64 }) + "\n",
    "no line end": JSON.stringify({ v: 0, alg: "ed25519", seed_b64: b64 }),
    "pretty printed": JSON.stringify({ v: 0, alg: "ed25519", seed_b64: b64 }, null, 1) + "\n",
    "seed as hex": JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.toString("hex") }) + "\n",
    "seed of 31 bytes": JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.subarray(0, 31).toString("base64") }) + "\n",
    "not json": `{"v":0,"alg":"ed25519","seed_b64":"${b64.slice(0, 40)}"`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const k = join(DIR, `key-${name.replace(/ /g, "-")}.json`); writeFileSync(k, text);
    const r = spawnSync(process.execPath, [SCRIPT, "T3", "--run", run, "--key", k, "--reads", t3Reads().text, "--reads-sha256", t3Reads().sha], { encoding: "utf8" });
    assert.equal(r.status, 2, name);
    assert.equal(r.stderr, `sign-device: ${KEY_REFUSAL}\n`, name);
    assert.equal(hasSecret(r.stdout + r.stderr), false, name);
  }
  assert.equal(existsSync(join(run, "signed", "T3.json")), false);
});

test("R2: the declared spend is checked against steps.json after the encoder, and a difference writes nothing", () => {
  const changed = structuredClone(plan);
  changed.steps.find((s) => s.id === "T3").declared = "$TOP_UP";
  const signer = loadDeviceSigner(KEY);
  const reads = takeReads(t3Reads().text, t3Reads().sha);
  const results = startedRecord(DEVICE);
  assert.throws(() => signStep({ plan: changed, id: "T3", step: changed.steps[2], reads, results, signer }), /the encoder declares 10000000000000000, steps.json says 1000000000000000/);
  assert.equal(signStep({ plan, id: "T3", step: plan.steps[2], reads, results, signer }).declared_spend_raw, V("ESCROW_1"));
  signer.wipe();
});

test("R2: a runtime the encoder's table does not have is refused, and nothing is written", () => {
  const { run } = at("T2");
  const reads = relay({ ...JSON.parse(t3Reads().text), runtime: { ...RUNTIME, specVersion: 1014021 } });
  const r = cli("T3", run, reads);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /RUNTIME_UNKNOWN/);
  assert.equal(existsSync(join(run, "signed", "T3.json")), false);
});

test("R4: the reads are the runner's relay text; the raw session nonce is read as a little endian u64; a typed session nonce is refused", () => {
  const base = JSON.parse(t3Reads().text);
  const take = (o) => { const r = relay({ ...base, ...o }); return takeReads(r.text, r.sha); };
  assert.equal(take({ session_nonce_raw: "0x0200000000000000" }).sessionNonce, 2n);
  assert.equal(take({ session_nonce_raw: "0x0201000000000000" }).sessionNonce, 258n);
  assert.equal(take({ session_nonce_raw: null }).sessionNonce, null);
  assert.throws(() => take({ session_nonce: "0" }), /does not take/);
  assert.throws(() => take({ extra: 1 }), /does not take/);
  const { account, ...noAccount } = base;
  assert.throws(() => { const r = relay(noAccount); takeReads(r.text, r.sha); }, /needs account/);
});

test("R3: no output, no signed file and no error holds the seed in any form", () => {
  const outs = [];
  const { run } = at("T2");
  const ok = cli("T3", run, t3Reads());
  assert.equal(ok.status, 0, ok.stderr);
  outs.push(ok.stdout, ok.stderr, readFileSync(join(run, "signed", "T3.json"), "utf8"), readFileSync(join(run, "signed", "T3.send.json"), "utf8"));
  const refused = cli("T4", run, t3Reads());
  outs.push(refused.stdout, refused.stderr);
  for (const o of outs) assert.equal(hasSecret(o), false, "an output holds the seed");
  assert.ok(readFileSync(KEY, "utf8").includes(seed.toString("base64")), "the search would find the seed: the test key file holds it");
});

test("R3: the signer's seed is gone after wipe", () => {
  const s = loadDeviceSigner(KEY);
  assert.equal(s.sign(new Uint8Array(4)).length, 64);
  s.wipe();
  assert.throws(() => s.sign(new Uint8Array(4)));
  assert.match(readFileSync(SCRIPT, "utf8"), /finally \{ signer\.wipe\(\); \}/, "main wipes the seed whether signing succeeds or not");
});

test("R2: the script builds no call bytes of its own: it imports only the encoder, its table, and this folder's modules", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const statics = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(statics, ["node:fs", "node:path", "node:url", "./lib.mjs", "./device-key.mjs", "./record.mjs", "./judge.mjs"]);
  assert.deepEqual([...src.matchAll(/chain\("([^"]+)"\)/g)].map((m) => m[1]), ["extrinsic.js", "reader.js", "table.js"]);
  assert.match(readFileSync(join(HERE, "device-key.mjs"), "utf8"), /resolve\("@noble\/curves\/ed25519\.js"\)/);
  assert.doesNotMatch(src, /Uint8Array\.of\(/, "no hand built bytes");
  assert.equal([...src.matchAll(/signSessionCall\(/g)].length, 1);
});

test("F6: a declared spend that is not steps.json's, a runtime the encoder's table does not hold and one that is not the plan's are refused in preflight, which takes no key", async () => {
  const { preflight, SignDeviceError } = await import("./sign-device.mjs");
  const { run } = at("T2");
  const r = t3Reads();
  const wrong = structuredClone(plan); wrong.steps.find((s) => s.id === "T3").declared = "1";
  assert.throws(() => preflight({ plan: wrong, run, id: "T3", readsText: r.text, readsSha256: r.sha }), (e) => e instanceof SignDeviceError && /the encoder declares 10000000000000000, steps.json says 1: not signed/.test(e.message));
  const unknown = deviceReads(DEVICE, { number: BIRTH }); const u = JSON.parse(unknown.text); u.runtime.specVersion += 1;
  assert.throws(() => preflight({ plan, run, id: "T3", readsText: JSON.stringify(u), readsSha256: createHash("sha256").update(JSON.stringify(u)).digest("hex") }), (e) => e.refusal === "RUNTIME_UNKNOWN");
  const other = structuredClone(plan); other.values.SPEC_NAME.value = "another-runtime";
  assert.throws(() => preflight({ plan: other, run, id: "T3", readsText: r.text, readsSha256: r.sha }), (e) => e instanceof SignDeviceError && /specName tzkv-runtime, steps.json has another-runtime/.test(e.message));
  assert.match(preflight({ plan, run, id: "T3", readsText: r.text, readsSha256: r.sha }).call, /^0x5e02/);
});

test("F10: earlier_copies is made from the dead files in signed/; with dead files and no signed file only --again signs, by the newest dead copy's era", () => {
  const { run } = at("T2");
  assert.equal(cli("T3", run, t3Reads()).status, 0);
  const a = readJson(join(run, "signed", "T3.json"));
  assert.deepEqual(a.earlier_copies, []);
  const last = a.era.last_valid_block;
  // a second copy by --again lists the first
  assert.equal(cli("T3", run, t3Reads({ number: last + 1 }), "--again").status, 0);
  const b = readJson(join(run, "signed", "T3.json"));
  assert.deepEqual(b.earlier_copies.map((c) => c.extrinsic_hash), [a.extrinsic_hash]);
  // both files of b moved away by hand (a stop after both renames of retire): dead-1 and dead-2, no signed file
  for (const [f, t] of [["T3.json", "T3.dead-2.json"], ["T3.send.json", "T3.dead-2.send.json"]]) writeFileSync(join(run, "signed", t), readFileSync(join(run, "signed", f))), rmSync(join(run, "signed", f));
  const plain = cli("T3", run, t3Reads({ number: b.era.last_valid_block + 1 }));
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /holds 2 dead copies of T3 and no signed\/T3.json: sign it only with --again/);
  const early = cli("T3", run, t3Reads({ number: b.era.last_valid_block }), "--again");
  assert.match(early.stderr, new RegExp(`the earlier copy is valid to block ${b.era.last_valid_block}`), "the newest dead copy's era is checked");
  assert.equal(cli("T3", run, t3Reads({ number: b.era.last_valid_block + 1 }), "--again").status, 0);
  const c = readJson(join(run, "signed", "T3.json"));
  assert.deepEqual(c.earlier_copies.map((x) => x.extrinsic_hash), [a.extrinsic_hash, b.extrinsic_hash]);
  assert.deepEqual(c.earlier_copies.map((x) => x.file), ["signed/T3.dead-1.json", "signed/T3.dead-2.json"]);
});
