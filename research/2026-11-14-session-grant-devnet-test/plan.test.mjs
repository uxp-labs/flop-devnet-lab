// H8, H9, H12 and H17: steps.json holds every value to its committed file and field (rule 6 of
// CLAUDE.md); plan.md's printed blocks are plan.mjs's; the README's lines and numbers are what
// plan.mjs prints; and the seat lines plan.mjs prints make the seat with the tool itself. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HERE, REPO, computed, deviceOfSeat, fromSource, readJson } from "./lib.mjs";
import { plan, V, tempDir } from "./fixtures.mjs";
import { blocksIn, costs, nextText, pastedSha256, printedBlocks } from "./plan.mjs";

const README = readFileSync(join(HERE, "README.md"), "utf8");
const DIR = tempDir("g19-plan");
after(() => rmSync(DIR, { recursive: true, force: true }));

test("H9 rule 6: every value of steps.json is its source's, or its computation's, or decided with its reason", () => {
  for (const [k, v] of Object.entries(plan.values)) {
    if (v.from) assert.equal(fromSource(plan, v.from), v.value, k);
    if (v.computed) assert.equal(computed(plan, v.computed), v.value, k);
    if (v.same_as) assert.equal(fromSource(plan, v.same_as), v.value, `${k} same_as`);
    if (!v.from && !v.computed) assert.ok(typeof v.decided === "string" && /^(B-\d+|H\d+|one epoch)/.test(v.decided), `${k} is decided with its reason`);
  }
});

test("H9: each owner step's fee is a value from a recorded fee of the same call", () => {
  for (const s of plan.steps.filter((x) => x.signer === "owner")) {
    const name = s.fee.replace(/^\$/, "");
    assert.ok(plan.values[name].from, `${s.id} ${name}`);
    assert.match(plan.values[name].from.path, /fee_raw$/);
  }
});

test("H17: plan.md's printed blocks are what plan.mjs prints", () => {
  const md = blocksIn(readFileSync(join(HERE, "plan.md"), "utf8"));
  const printed = printedBlocks(plan);
  assert.deepEqual(Object.keys(md).sort(), Object.keys(printed).sort());
  for (const k of Object.keys(printed)) assert.equal(md[k], printed[k], k);
});

test("H17 H12: the README's fence numbers are plan.mjs's", () => {
  const c = costs(plan);
  assert.ok(README.includes(`expected fees ${c.expected_taken} raw`));
  assert.ok(README.includes(`${c.tries} sends at the most per step, ${c.worst} raw`));
});

test("H4: the pasted files' sha256 are printed by plan.mjs, and pane-runner.js and explorer-reader.js are the last batch's", () => {
  const s = pastedSha256();
  const last = readFileSync(join(REPO, "research/2026-11-12-encoder-devnet-test/README.md"), "utf8");
  assert.ok(last.includes(s["pane-runner.js"]) && last.includes(s["explorer-reader.js"]));
  assert.match(s["session-reads.js"], /^[0-9a-f]{64}$/);
});

test("H8 H9: the seat lines plan.mjs prints are the README's, and running them makes the seat with the plan's caps through the tool", async () => {
  const text = await nextText(plan, "$RUN", null);
  const lines = text.split("\n").filter((l) => !l.startsWith("#") && l.length > 0);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(README.includes(l), l);
  const run = join(DIR, "run");
  const sh = lines.map((l) => l.replaceAll("$RUN", run).replaceAll("$LAB", REPO)).join("\n");
  execSync(sh, { shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] });
  const cfg = readJson(join(run, "seat", "config.json"));
  assert.deepEqual(cfg.caps[V("SEAT")], { daily: Number(V("A_DAILY_FLOP")), perCall: Number(V("A_PER_TX_FLOP")) });
  assert.ok(existsSync(join(run, "seat", "seats", V("SEAT"), "identity.json")));
  const device = await deviceOfSeat(join(run, "seat"), V("SEAT"));
  assert.match(device, /^0x[0-9a-f]{64}$/);
  const p0 = await nextText(plan, run, null);
  assert.match(p0, /reads\.sessionTape\(\{"lru":"0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8"/);
  assert.ok(p0.includes(device.slice(2)), "the keys name the device made by init");
  assert.match(p0, /record-step\.mjs" start --run/);
});
