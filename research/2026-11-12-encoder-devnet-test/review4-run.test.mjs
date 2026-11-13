// Review 4 (list 5), second look at ce42572: the run folder run-2026-11-13. No network, no key.
// R5 states a promise that fails at ce42572. R6 held and stays as a guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const RUN = join(HERE, "run-2026-11-13");
const RESULTS = JSON.parse(readFileSync(join(HERE, "results.json"), "utf8"));

test("R5: the run folder is held 'byte for byte' by a pin outside itself: some test of this folder other than review files names the sha256 of its SHA256SUMS", () => {
  const sums = createHash("sha256").update(readFileSync(join(RUN, "SHA256SUMS"))).digest("hex");
  const pinned = readdirSync(HERE).filter((f) => f.endsWith(".test.mjs") && !f.startsWith("review")).filter((f) => readFileSync(join(HERE, f), "utf8").includes(sums));
  // At ce42572 nothing pins it: change a byte of a signed file that no assertion reads (its
  // description), recompute SHA256SUMS, and every test of the folder still passes.
  assert.notDeepEqual(pinned, [], `no test pins sha256 ${sums} of run-2026-11-13/SHA256SUMS`);
});

test("R6: the era of each sent step's signed file is the era its extrinsic bytes carry (period, and birth_number modulo period as the phase)", () => {
  for (const s of RESULTS.steps.filter((x) => x.run_time !== null)) {
    const f = JSON.parse(readFileSync(join(RUN, "signed", `${s.step}.json`), "utf8"));
    const b = Buffer.from(f.extrinsic.slice(2), "hex");
    const m = b[0] & 3;
    assert.ok(m < 3, s.step);
    let p = [1, 2, 4][m];
    assert.equal(b[p], 0x84, `${s.step}: signed, version 4`);
    p += 1;
    assert.equal(b[p], 0, `${s.step}: MultiAddress::Id`);
    p += 33;
    assert.equal(b[p], 0, `${s.step}: an Ed25519 signature, 64 bytes`);
    p += 65;
    if (b[p] === 0) { assert.equal(f.era, "immortal", s.step); continue; }
    const e = b[p] | (b[p + 1] << 8);
    const period = 2 << (e % 16);
    const phase = (e >> 4) * Math.max(period >> 12, 1);
    assert.deepEqual([f.era.period, f.era.birth_number % f.era.period], [period, phase], s.step);
  }
});

test("R7: the README says the node reported T3's extrinsic hash; the record carries a node report of it", () => {
  const t = readFileSync(join(HERE, "README.md"), "utf8").replace(/\s+/g, " ");
  const rt = RESULTS.steps[2].run_time;
  // run_time.extrinsic_hash is the signed file's hash (results.json run_time_form); the node's relay
  // (run_time.sent.extrinsic_hash) is null; only the explorer (run_time.explorer.hash) reported it.
  assert.equal(rt.explorer.hash, rt.extrinsic_hash);
  assert.ok(!t.includes("the hash the node and the explorer reported for T3") || rt.sent.extrinsic_hash === rt.extrinsic_hash, "the README says the node reported the hash, but steps.2.run_time.sent.extrinsic_hash is null");
});
