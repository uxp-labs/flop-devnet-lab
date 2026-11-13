// Review 2 (Q12): tests that pass on e18e725 and kill mutants of review2-mutants.json that the
// builder's tests leave alive. No network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE } from "./lib.mjs";
import { nextOf } from "./judge.mjs";
import { plan, V, asPlanned } from "./fixtures.mjs";

const H = (n) => "0x" + n.toString(16).padStart(64, "0");

test("review2 kills RV2-N3: a cleanup step that succeeded with wrong events gets no attempt; what is wrong is left", () => {
  const { results } = asPlanned("0x" + "d2".repeat(32), "T6");
  const ex = results.steps.find((s) => s.step === "T6").run_time.explorer;
  ex.events.find((e) => e.name === "ForceOpenExpired").fields.channel_id = "0x" + "e6".repeat(32); // the run time judge checks the channel, not the refund
  const n = nextOf(plan, results);
  assert.notEqual(n.step, "T6.2", `${n.word} ${n.step}: an attempt after a success`);
  assert.match(n.left.join("\n"), /T6 was included and succeeded, but/);
});

test("review2 kills RV2-X4: find reads the finalized head itself, and finds an extrinsic there", async () => {
  const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync(join(HERE, "pane-runner.js"), "utf8"), g);
  const XT = "0x" + "c4".repeat(40), HEAD = 40; // 21 blocks from 20: one chunk of 20, then the head alone
  const answers = {
    chain_getFinalizedHead: () => H(HEAD),
    chain_getHeader: ([h]) => ({ number: "0x" + parseInt(h.slice(2), 16).toString(16) }),
    state_getRuntimeVersion: () => ({ specName: V("SPEC_NAME"), specVersion: 1014020, transactionVersion: 2 }),
    chain_getBlockHash: ([n]) => (n === 0 ? V("GENESIS") : H(n)),
    chain_getBlock: ([h]) => ({ block: { extrinsics: h === H(HEAD) ? ["0x00", XT] : [] } }),
    state_getStorage: () => "0x00",
  };
  const transport = { request: async (m, p) => answers[m](p), subscribe: async () => { throw new Error("find submits nothing"); } };
  const lab = g.paneRunner.createRunner({ transport, store: { has: () => false, add: () => {} } });
  const out = JSON.parse(JSON.stringify(await lab.find(XT, 20)));
  assert.equal(out.status, "finalized", JSON.stringify(out));
  assert.equal(out.block_number, HEAD);
  assert.equal(out.extrinsic_index, 1);
});
