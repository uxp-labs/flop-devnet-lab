// Reviewer's tests of sign-device.mjs (P1, P2, P3, P9). No network. The test key is made here, in a
// temporary folder that is removed after. Tests named "DEFECT" fail on fcfb8b5.
// Adapted by the builder of the fix round to the interface of S1 to S3 (--run, --reads with
// --reads-sha256, the run time record): each test still shows what it showed. See the report.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, loadPlan, ss58, sha256Text } from "./lib.mjs";
import { asPlanned, runFolder, relay, deviceReads } from "./fixtures.mjs";

const plan = loadPlan();
const V = (n) => plan.values[n].value;
const SCRIPT = join(HERE, "sign-device.mjs");
const DIR = mkdtempSync(join(tmpdir(), "review-sign-device-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const seed = randomBytes(32);
const keyText = (o) => JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.toString("base64"), ...o }) + "\n";
const KEY = join(DIR, "device.json");
writeFileSync(KEY, keyText({}), { mode: 0o600 });
const FORMS = [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url"), seed.toString("base64").replace(/=+$/, ""),
  seed.toString("hex").slice(0, 16), seed.toString("base64").slice(0, 12), Array.from(seed).join(","), Array.from(seed).join(", "), Array.from(seed.subarray(0, 6)).join(",")];
const leaks = (text) => FORMS.filter((f) => text.includes(f));

const RUNTIME = { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") };
const pub = JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadDeviceSigner } from ${JSON.stringify(join(HERE, "device-key.mjs"))}; console.log(JSON.stringify("0x" + Buffer.from(loadDeviceSigner(${JSON.stringify(KEY)}).publicKey).toString("hex")))`], { encoding: "utf8" }).stdout);
const READ = (o = {}) => ({ account: ss58(pub), runtime: RUNTIME, birth: { number: 3600010, hash: "0x" + "cd".repeat(32) }, account_nonce: 0, session_nonce_raw: null, ...o });
const READS = READ();
const t2Run = () => runFolder(asPlanned(pub, "T2").results);

function cli(args, { cwd = DIR, run = t2Run(), reads = READS, readsText } = {}) {
  const r = relay(reads);
  const text = readsText ?? r.text;
  const r2 = spawnSync(process.execPath, [SCRIPT, ...args, "--run", run, "--reads", text, "--reads-sha256", readsText === undefined ? r.sha : sha256Text(text)], { encoding: "utf8", cwd });
  r2.run = run;
  return r2;
}
const allFiles = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map((f) => join(d, f)).filter((f) => { try { return readFileSync(f) && true; } catch { return false; } }) : []);

test("review held P1: no form of the seed, whole or in part, in stdout, stderr or any file written, on the good and the failing paths", () => {
  const bad = join(DIR, "bad"); mkdirSync(bad);
  const w = (n, t) => { const p = join(bad, n); writeFileSync(p, t); return p; };
  const unreadable = w("unreadable.json", keyText({})); chmodSync(unreadable, 0o000);
  const keyAsRecord = runFolder(asPlanned(pub, "T2").results); writeFileSync(join(keyAsRecord, "results.json"), keyText({}));
  const cases = [
    ["good", ["T3", "--key", KEY], {}],
    ["missing key", ["T3", "--key", join(bad, "none.json")], {}],
    ["key is a folder", ["T3", "--key", bad], {}],
    ["malformed key", ["T3", "--key", w("trunc.json", keyText({}).slice(0, 40))], {}],
    ["short seed", ["T3", "--key", w("short.json", JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.subarray(0, 31).toString("base64") }))], {}],
    ["seed as hex", ["T3", "--key", w("hex.json", JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.toString("hex") }))], {}],
    ["unreadable key", ["T3", "--key", unreadable], {}],
    ["bad reads", ["T3", "--key", KEY], { readsText: "{not json" }],
    ["reads is the key file", ["T3", "--key", KEY], { readsText: keyText({}) }],
    ["results is the key file", ["T4", "--key", KEY], { run: keyAsRecord }],
    ["wrong runtime", ["T3", "--key", KEY], { reads: READ({ runtime: { ...RUNTIME, specVersion: 1014021 } }) }],
    ["bad birth hash", ["T3", "--key", KEY], { reads: READ({ birth: { number: 1, hash: "0x12" } }) }],
  ];
  for (const [name, args, o] of cases) {
    const r = cli(args, o);
    if (name === "good") assert.equal(r.status, 0, r.stderr); else assert.notEqual(r.status, 0, `${name} signed`);
    const files = allFiles(join(r.run, "signed")).map((f) => readFileSync(f, "utf8")).join("\n");
    assert.deepEqual(leaks(r.stdout + r.stderr + files), [], `${name}: ${r.stderr}`);
  }
});

test("review DEFECT P3: a second run of T3 from another working folder is refused before the key is read", () => {
  const a = join(DIR, "cwd-a"), b = join(DIR, "cwd-b"); mkdirSync(a); mkdirSync(b);
  const run = t2Run();
  assert.equal(cli(["T3", "--key", KEY], { cwd: a, run }).status, 0);
  const second = cli(["T3", "--key", join(DIR, "no-key-read.json")], { cwd: b, run });
  assert.notEqual(second.status, 0, "T3 was signed a second time because signed/ is taken from the working folder");
  assert.doesNotMatch(second.stderr, /key file/, "refused before the key is read");
});

test("review DEFECT P3: a step that results.json records as sent is not signed again, even after its file is moved aside", () => {
  const run = runFolder(asPlanned(pub, "T3").results);
  const r = cli(["T3", "--key", KEY], { run, reads: READ({ account_nonce: 1, session_nonce_raw: "0x0100000000000000" }) });
  assert.notEqual(r.status, 0, "T3 was signed though results.json holds it in a finalized block");
  assert.match(r.stderr, /T3 is not next by the record/);
});

test("review DEFECT P9: T6 is refused when its whole era ends before T3's ack deadline (a sure refusal and a lost fee)", () => {
  const { results } = asPlanned(pub, "T5", { from: 3599000 });
  const t3 = results.steps.find((s) => s.step === "T3");
  t3.run_time.explorer.events.find((e) => e.name === "ForceOpenRequested").fields.ack_deadline = "3601000";
  const r = cli(["T6", "--key", KEY], { run: runFolder(results), reads: READ({ account_nonce: 3, session_nonce_raw: "0x0300000000000000" }) });
  assert.match(r.stderr, /signed only from a birth block above 3601000/);
  assert.notEqual(r.status, 0, `T6 signed with birth 3600010, valid to 3600073, ack deadline 3601000: ${r.stdout}`);
});

test("review DEFECT P9: T7 is refused when its whole era ends before T5's block plus MAX_DURATION_D2", () => {
  const { results, blocks } = asPlanned(pub, "T6", { from: 3599985 });
  const r = cli(["T7", "--key", KEY], { run: runFolder(results), reads: READ({ account_nonce: 4, session_nonce_raw: "0x0400000000000000" }) });
  assert.equal(blocks.T5, 3600000);
  assert.match(r.stderr, new RegExp(`above ${3600000 + Number(V("MAX_DURATION_D2"))}`));
  assert.notEqual(r.status, 0, `T7 signed valid to 3600073, but timeout needs a block after ${3600000 + Number(V("MAX_DURATION_D2"))}`);
});

test("review DEFECT P2 (low): a key file of another algorithm is refused, not signed as ed25519", () => {
  const k = join(DIR, "sr.json"); writeFileSync(k, keyText({ alg: "sr25519" }));
  const r = cli(["T3", "--key", k]);
  assert.notEqual(r.status, 0, "a key file that says sr25519 was used as an ed25519 seed");
});

test("review held P2: a steps.json in the working folder is not followed; the amount is the committed plan's", () => {
  const w = join(DIR, "fake-plan"); mkdirSync(w);
  const fake = structuredClone(plan); fake.values.ESCROW_1.value = "999"; fake.steps.push({ ...fake.steps[2], id: "T10" });
  writeFileSync(join(w, "steps.json"), JSON.stringify(fake));
  assert.notEqual(cli(["T10", "--key", KEY], { cwd: w }).status, 0);
  const r = cli(["T3", "--key", KEY], { cwd: w });
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(readFileSync(join(r.run, "signed", "T3.json"), "utf8"));
  assert.equal(rec.declared_spend_raw, V("ESCROW_1"));
  assert.equal(rec.fields.owner, V("OWNER"));
});
