// H16: the tool runs again over each committed tape of each committed run folder (replay.mjs
// COMMITTED), offline, and the record's values are held to it. The first data is the rehearsal's
// run folder (walk.mjs). Each check is shown to catch a change in a copy. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, tempDir } from "./fixtures.mjs";
import { sha256Text } from "./lib.mjs";
import { COMMITTED, committedFolder, isCommitted, replay } from "./replay.mjs";

const copies = [];
after(() => { for (const c of copies) rmSync(c, { recursive: true, force: true }); });
const copyOf = (name) => { const d = join(tempDir("g19-replay"), name); cpSync(committedFolder(name), d, { recursive: true }); copies.push(join(d, "..")); return d; };
const edit = (dir, f, change) => { const p = join(dir, f); const v = JSON.parse(readFileSync(p, "utf8")); change(v); writeFileSync(p, JSON.stringify(v, null, 1) + "\n"); };

for (const name of COMMITTED) {
  test(`H16: ${name}: the tool gives again what each committed output and the record hold`, async () => {
    assert.ok(isCommitted(name), `${name} is committed in this folder`);
    const r = await replay(plan, committedFolder(name));
    assert.deepEqual(r.problems, []);
    assert.ok(r.checked >= 7, `${r.checked} outputs replayed`);
  });
}

test("H16: a changed value of the record, a changed tape, a changed output and a key file are each found", async () => {
  const cases = [
    ["results.json", (v) => { v.steps[0].decoder.fee_raw = "1"; }, /G1 decoder is not the tool's readBlockEvents/],
    ["results.json", (v) => { v.steps[0].call.call_hex = "0x5e00"; }, /G1 call is not the tool's printed call/],
    ["results.json", (v) => { v.steps[1].after.session.value.active = true; }, /R1 after is not the tool's session show/],
    ["results.json", (v) => { v.p0.session_count.value = 3; }, /p0.session_count is not/],
    ["tool/G1.after.json", (v) => { v.json.session.value.spent = "1"; }, /G1\.after\.json: the tool prints other JSON now/],
    ["tool/R1.call.json", (v) => { v.exit = 5; }, /R1\.call\.json: the tool exits 0 now, the output says 5/],
    ["tapes/G1.block.json", (v) => { v.read_utc = "x"; }, /G1\.block\.json: its tape's sha256 is/],
  ];
  for (const [f, change, re] of cases) {
    const d = copyOf("rehearsal-run");
    edit(d, f, change);
    const r = await replay(plan, d);
    assert.ok(r.problems.some((p) => re.test(p)), `${f} ${re}: ${r.problems.join(" | ")}`);
  }
  const d = copyOf("rehearsal-run");
  writeFileSync(join(d, "seat", "seats", "unassigned", "flop.key"), "not read");
  const r = await replay(plan, d);
  assert.deepEqual(r.problems, ["seat/seats/unassigned/flop.key is not a file a committed run folder holds (only results.json, the seat's config.json and identity.json, tapes and tool outputs)"]);
  assert.equal(r.checked, 0);
});

test("F11: replay holds each runner reading to its sent_sha256 and each block tape to the record's block", async () => {
  const cases = [
    [(v) => { v.steps[0].run_time.sent.extrinsic_index = 7; }, /G1 runner reading 0: its text has sha256/],
    [(v) => { v.steps[1].run_time.sent.block_hash = "0x" + "77".repeat(32); }, /R1 runner reading 0|R1: its block tape is of block/],
    [(v) => { const s = v.steps[1].run_time; s.sent.block_number += 1; s.sent_sha256 = sha256Text(JSON.stringify(s.sent)); }, /R1: its block tape is of block \d+ 0x[0-9a-f]{64} \(read \d+ 0x[0-9a-f]{64}\), not the record's block/],
    [(v) => { v.steps[0].run_time.earlier_readings = [{ sent: { status: "deadline" }, sent_sha256: "00".repeat(32) }]; }, /G1 runner reading 0: its text has sha256/],
  ];
  for (const [change, re] of cases) {
    const d = copyOf("rehearsal-run");
    edit(d, "results.json", change);
    const r = await replay(plan, d);
    assert.ok(r.problems.some((p) => re.test(p)), `${re}: ${r.problems.join(" | ")}`);
  }
});
