// Review 3: tests for the mutants of review3-mutants.json that the tests at a9442dd leave alive by
// behaviour (V9). Each passes on a9442dd. No network. The device key is made here in a temporary folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { webcrypto, createHash } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE, readJson } from "./lib.mjs";
import { loadDeviceSigner } from "./device-key.mjs";
import { leadStop, LeadStopError } from "./lead-stop.mjs";
import { nonceOf } from "./research-signed.mjs";
import { plan, asPlanned, runFolder, sent, makeKey, tempDir, deviceReads } from "./fixtures.mjs";

const DIR = tempDir("review3-kills");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const OTHER = (() => { const d = tempDir("review3-kills-other"); const k = makeKey(d).path; const p = "0x" + Buffer.from(loadDeviceSigner(k).publicKey).toString("hex"); rmSync(d, { recursive: true, force: true }); return p; })();
const cli = (args) => spawnSync(process.execPath, [join(HERE, "sign-device.mjs"), ...args], { encoding: "utf8", cwd: DIR });
const load = (run) => readJson(join(run, "results.json"));
const save = (run, r) => writeFileSync(join(run, "results.json"), JSON.stringify(r, null, 1) + "\n");
const stop = (run, id, o = {}) => leadStop({ plan, run, results: load(run), id, why: "review3 kill", ...o });
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof LeadStopError && re.test(e.message), re.toString());

test("review3 kills RV3-R2: the sweep's nonce is the same before and after T9 is recorded in a finalized block", () => {
  const r = asPlanned(DEVICE, "T8").results;
  const before = nonceOf(plan, r, "T9");
  sent(r, "T9", { block: 3800000 });
  assert.equal(nonceOf(plan, r, "T9"), before);
});

test("review3 kills RV3-L2: case b refuses reads of another account than the device", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const out = cli(["T3", "--run", run, "--key", KEY, ...(() => { const r = deviceReads(DEVICE, { number: 3600020 }); return ["--reads", r.text, "--reads-sha256", r.sha]; })()]);
  assert.equal(out.status, 0, out.stderr);
  const a = readJson(join(run, "signed", "T3.json"));
  const rec = load(run); sent(rec, "T3", { status: "deadline" }); save(run, rec);
  const other = deviceReads(OTHER, { number: a.era.last_valid_block + 1, accountNonce: 0 });
  refused(() => stop(run, "T3", { readsText: other.text, readsSha256: other.sha }), /not the device of results\.json/);
});

test("review3 kills RV3-L3: case a refuses a lone send file with no signed file", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  writeFileSync(join(run, "signed", "T3.send.json"), "{}");
  refused(() => stop(run, "T3"), /send\.json exists without/);
});

test("review3 kills RV3-S1: a socket that opens and closes before the submit is written gives not-sent, not connection-lost", async () => {
  const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync(join(HERE, "pane-runner.js"), "utf8"), g);
  const sockets = [];
  class WS { constructor() { this.readyState = 0; this.sent = []; sockets.push(this); } send(t) { this.sent.push(t); } close() { this.readyState = 3; this.onclose?.(); } }
  const lab = g.paneRunner.createRunner({ transport: g.paneRunner.wsTransport(undefined, WS), store: { has: () => false, add() {} }, deadlineMs: 300 });
  const xt = "0x" + "c3".repeat(40), bundle = JSON.stringify({ step: "T2", extrinsic: xt });
  const p = lab.send(bundle, createHash("sha256").update(bundle).digest("hex"));
  await new Promise((r) => setTimeout(r, 30));
  const ws = sockets[0];
  ws.readyState = 1; ws.onopen(); ws.close(); // opened and lost before the request's turn to write
  const r = await p;
  assert.equal(ws.sent.length, 0);
  assert.equal(r.status, "not-sent");
});
