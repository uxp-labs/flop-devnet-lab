// Tests of sign-device.mjs (rules R2, R3, R4): node --test in this folder. No network. The key is
// made inside the test, in a temporary folder that is removed after.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERE, REPO, loadPlan } from "./lib.mjs";
import { signStep, loadDeviceSigner, takeReads } from "./sign-device.mjs";

const { readExtrinsic } = await import(pathToFileURL(join(REPO, "imd-flop", "dist", "chain", "reader.js")).href);
const plan = loadPlan();
const SCRIPT = join(HERE, "sign-device.mjs");
const DIR = mkdtempSync(join(tmpdir(), "sign-device-test-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const seed = randomBytes(32);
const KEY = join(DIR, "device.json");
writeFileSync(KEY, JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.toString("base64") }) + "\n", { mode: 0o600 });
const SECRET_FORMS = [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url"), seed.toString("base64").replace(/=+$/, "")];
const hasSecret = (text) => SECRET_FORMS.some((f) => text.includes(f));

const RUNTIME = { specName: plan.values.SPEC_NAME.value, specVersion: Number(plan.values.SPEC.value), transactionVersion: Number(plan.values.TXV.value), genesisHash: plan.values.GENESIS.value };
const BIRTH = { number: 3600010, hash: "0x" + "cd".repeat(32) };
const READS = { runtime: RUNTIME, birth: BIRTH, account_nonce: 0, session_nonce: "0" };
const CH3 = "0x" + "31".repeat(32), CH5 = "0x" + "35".repeat(32);
const RESULTS = { steps: [
  { step: "T3", events: [{ pallet: "ComputeChannel", name: "ForceOpenRequested", fields: { channel_id: CH3 } }] },
  { step: "T5", events: [{ pallet: "ComputeChannel", name: "ChannelOpened", fields: { channel_id: CH5 } }] }] };
const RESULTS_FILE = join(DIR, "results.json");
writeFileSync(RESULTS_FILE, JSON.stringify(RESULTS));

let run = 0;
function cli(args, outDir = join(DIR, `out-${run++}`)) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--out-dir", outDir], { encoding: "utf8", cwd: DIR });
  return { ...r, outDir };
}
const fileOf = (r, id) => join(r.outDir, `${id}.json`);
const read = (r, id) => readExtrinsic(RUNTIME, Uint8Array.from(Buffer.from(JSON.parse(readFileSync(fileOf(r, id), "utf8")).extrinsic.slice(2), "hex")), { number: BIRTH.number, hash: Uint8Array.from(Buffer.from(BIRTH.hash.slice(2), "hex")) });
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

test("R2: T3 is a session call around force_open of steps.json, mortal, declaring exactly the escrow", () => {
  const r = cli(["T3", "--key", KEY, "--reads", JSON.stringify(READS)]);
  assert.equal(r.status, 0, r.stderr);
  const x = read(r, "T3");
  const pub = hex(loadDeviceSigner(KEY).publicKey);
  assert.equal(hex(x.signer), pub);
  assert.equal(x.call.inner.call, "force_open");
  assert.equal(hex(x.call.inner.miner), plan.values.NAMED.value);
  assert.equal(hex(x.call.inner.agent_key), pub, "the agent key is the device");
  assert.equal(x.call.inner.escrow, BigInt(plan.values.ESCROW_1.value));
  assert.equal(x.call.spend, BigInt(plan.values.ESCROW_1.value), "the declared spend is the escrow");
  assert.equal(hex(x.call.owner), plan.values.OWNER.value);
  assert.equal(x.era.period, 64);
  assert.equal(x.lastValidBlock, BIRTH.number + 63);
  const out = JSON.parse(r.stdout);
  assert.equal(out.sha256, createHash("sha256").update(readFileSync(fileOf(r, "T3"))).digest("hex"), "stdout gives the sha256 of the signed file");
  assert.equal(out.last_valid_block, BIRTH.number + 63);
  assert.match(r.stderr, /force_open/, "the description goes to stderr");
});

test("R2: T5 is open_channel with the plan's enclave key, short max_duration and settlement class", () => {
  const r = cli(["T5", "--key", KEY, "--reads", JSON.stringify({ ...READS, account_nonce: 2, session_nonce: "1" })]);
  assert.equal(r.status, 0, r.stderr);
  const x = read(r, "T5");
  assert.equal(x.call.inner.call, "open_channel");
  assert.equal(hex(x.call.inner.enclave_key), plan.values.ENCLAVE_KEY.value);
  assert.equal(x.call.inner.sla.max_duration, Number(plan.values.MAX_DURATION_D2.value));
  assert.equal(x.call.inner.settlement_class, plan.values.SETTLEMENT.value);
  assert.equal(x.call.spend, BigInt(plan.values.ESCROW_1.value));
  assert.equal(x.call.sessionNonce, 1n);
  assert.equal(x.accountNonce, 2);
});

test("R2: T4, T6 and T7 take the channel id from the earlier step's record, and refuse without it", () => {
  for (const [id, ch, call] of [["T4", CH3, "top_up_escrow"], ["T6", CH3, "expire_force_open"], ["T7", CH5, "timeout"]]) {
    const r = cli([id, "--key", KEY, "--results", RESULTS_FILE, "--reads", JSON.stringify(READS)]);
    assert.equal(r.status, 0, r.stderr);
    const x = read(r, id);
    assert.equal(x.call.inner.call, call);
    assert.equal(hex(x.call.inner.channel_id), ch, id);
    const without = cli([id, "--key", KEY, "--reads", JSON.stringify(READS)]);
    assert.equal(without.status, 2);
    assert.match(without.stderr, /is not known yet/);
    assert.equal(existsSync(fileOf(without, id)), false);
  }
  const r = cli(["T4", "--key", KEY, "--results", RESULTS_FILE, "--reads", JSON.stringify(READS)]);
  assert.equal(read(r, "T4").call.spend, BigInt(plan.values.TOP_UP.value), "the top up declares its amount");
});

test("R2: it refuses a step the encoder does not sign, before it reads any key", () => {
  for (const id of ["T1", "T2", "T8", "T9"]) {
    const r = cli([id, "--key", join(DIR, "no-such-key.json"), "--reads", JSON.stringify(READS)]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not signed by the encoder/, id);
  }
});

test("R2: it refuses to sign a step whose file exists, and leaves the file as it was", () => {
  const outDir = join(DIR, "exists");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "T3.json"), "kept\n");
  const r = cli(["T3", "--key", join(DIR, "no-such-key.json"), "--reads", JSON.stringify(READS)], outDir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exists/);
  assert.equal(readFileSync(join(outDir, "T3.json"), "utf8"), "kept\n");
});

test("R2: the declared spend is checked against steps.json after the encoder, and a difference writes nothing", () => {
  const changed = structuredClone(plan);
  changed.steps.find((s) => s.id === "T3").declared = "$TOP_UP";
  const signer = loadDeviceSigner(KEY);
  assert.throws(() => signStep({ plan: changed, stepId: "T3", reads: READS, results: null, signer }), /the encoder declares 10000000000000000, steps.json says 1000000000000000/);
  assert.equal(signStep({ plan, stepId: "T3", reads: READS, results: null, signer }).declared_spend_raw, plan.values.ESCROW_1.value);
  signer.wipe();
});

test("R2: a runtime the encoder's table does not have is refused, and nothing is written", () => {
  const r = cli(["T3", "--key", KEY, "--reads", JSON.stringify({ ...READS, runtime: { ...RUNTIME, specVersion: 1014021 } })]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /RUNTIME_UNKNOWN/);
  assert.equal(existsSync(fileOf(r, "T3")), false);
});

test("R2: a key that is not the device of results.json is refused", () => {
  const other = join(DIR, "results-other.json");
  writeFileSync(other, JSON.stringify({ ...RESULTS, accounts: { device: { public_key: "0x" + "77".repeat(32) } } }));
  const r = cli(["T4", "--key", KEY, "--results", other, "--reads", JSON.stringify(READS)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not the device of results.json/);
});

test("R4: the reads are one JSON argument; the raw session nonce is read as a little endian u64", () => {
  assert.equal(takeReads({ runtime: RUNTIME, birth: BIRTH, account_nonce: 0, session_nonce_raw: "0x0200000000000000" }).sessionNonce, 2n);
  assert.equal(takeReads({ runtime: RUNTIME, birth: BIRTH, account_nonce: 0, session_nonce_raw: "0x0201000000000000" }).sessionNonce, 258n);
  assert.throws(() => takeReads({ runtime: RUNTIME, birth: BIRTH, account_nonce: 0, session_nonce_raw: null }), /holds no session nonce/);
  assert.throws(() => takeReads({ ...READS, session_nonce_raw: "0x0000000000000000" }), /exactly one/);
  assert.throws(() => takeReads({ ...READS, extra: 1 }), /does not take/);
});

test("R3: no output, no signed file and no error holds the seed in any form", () => {
  const outs = [];
  const ok = cli(["T3", "--key", KEY, "--reads", JSON.stringify(READS)]);
  outs.push(ok.stdout, ok.stderr, readFileSync(fileOf(ok, "T3"), "utf8"));
  const refused = cli(["T4", "--key", KEY, "--reads", JSON.stringify(READS)]);
  outs.push(refused.stdout, refused.stderr);
  const bad = join(DIR, "bad.json");
  for (const text of [`{"seed_b64":"${seed.toString("base64").slice(0, 40)}"`, JSON.stringify({ seed_b64: seed.toString("hex") }), JSON.stringify({ seed_b64: seed.toString("base64url") })]) {
    writeFileSync(bad, text);
    const r = cli(["T3", "--key", bad, "--reads", JSON.stringify(READS)]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot be read as the research signer's key format/);
    outs.push(r.stdout, r.stderr);
  }
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

test("R2: the script builds no call bytes of its own: it imports only the encoder, its table and @noble/curves", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const statics = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(statics, ["node:fs", "node:crypto", "node:module", "node:path", "node:url", "./lib.mjs"]);
  assert.deepEqual([...src.matchAll(/chain\("([^"]+)"\)/g)].map((m) => m[1]), ["extrinsic.js", "table.js"]);
  assert.match(src, /resolve\("@noble\/curves\/ed25519\.js"\)/);
  assert.doesNotMatch(src, /Uint8Array\.of\(/, "no hand built bytes");
  assert.equal([...src.matchAll(/signSessionCall\(/g)].length, 1);
});
