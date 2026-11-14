// Review of G-19, attacks 5 (G5) and 6 of the brief's list (G6): the fence by the review's own
// arithmetic over steps.json, and every value of steps.json read again from its file and field by
// the review's own reader (not the last batch's fromSource). No network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, plan } from "./fixtures.mjs";
import { costs } from "./plan.mjs";

const file = (name) => join(REPO, plan.files[name]);
/** The review's own path reader: a.b[2].c and a["x.y"]. */
function at(obj, path) {
  const parts = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]|\["([^"]+)"\]/g)].map((m) => m[3] ?? (m[2] !== undefined ? Number(m[2]) : m[1]));
  return parts.reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}
function source(from) {
  const text = readFileSync(file(from.file), "utf8");
  if (from.re) { const m = new RegExp(from.re).exec(text); return m ? m[1] : undefined; }
  return at(JSON.parse(text), from.path);
}
const big = (name) => BigInt(plan.values[name].value);

test("HOLDS (G6): every value of steps.json that names a file and a field is that field, and every same_as is too", () => {
  let n = 0;
  for (const [k, v] of Object.entries(plan.values)) {
    if (v.from) { assert.equal(String(source(v.from)), v.value, k); n++; }
    if (v.same_as) { assert.equal(String(source(v.same_as)), v.value, `${k} same_as`); n++; }
    if (!v.from && !v.computed) assert.ok(v.decided, `${k} has neither a file nor a decision`);
  }
  assert.ok(n >= 25, `${n} values held`);
});

test("HOLDS (G6): every computed value is its computation, by the review's own arithmetic", () => {
  assert.equal(plan.values.SPENDING_CAP.value, (big("A_DAILY") * big("DAYS")).toString());
  assert.equal(plan.values.DURATION.value, (big("EPOCH_BLOCKS") * big("DAYS")).toString());
  assert.equal(plan.values.SESSION_COUNT_STOP.value, (big("MAX_SESSIONS_PER_OWNER") - 1n).toString());
  assert.equal(plan.values.A_DAILY_FLOP.value, "0.025");
  assert.equal(BigInt(Math.round(Number(plan.values.A_DAILY_FLOP.value) * 1e6)) * 10n ** 12n, big("A_DAILY"));
  assert.equal(BigInt(Math.round(Number(plan.values.A_PER_TX_FLOP.value) * 1e6)) * 10n ** 12n, big("A_PER_TX"));
});

test("HOLDS (G5): nothing moves, each step's fee has a most, and the worst case by the review's count is at or under the fence", () => {
  const owner = plan.steps.filter((s) => s.signer === "owner");
  assert.deepEqual(owner.map((s) => s.id), ["G1", "R1", "G2", "R2"]);
  for (const s of plan.steps) assert.deepEqual(s.moves ?? [], [], `${s.id} moves nothing`);
  assert.deepEqual(plan.steps.filter((s) => s.cleanup).map((s) => s.id), ["R1", "R2"]);
  const sends = 1 + 3 + 1 + 3;
  const worst = BigInt(sends) * big("MAX_FEE");
  assert.equal(worst, 84467887880000000n);
  assert.ok(worst <= big("FENCE"));
  assert.equal(costs(plan).worst, worst);
  assert.equal(costs(plan).expected_taken, 2n * big("FEE_GRANT") + 2n * big("FEE_REVOKE"));
  assert.equal(costs(plan).expected_taken, 20638783460000000n);
});

test("HOLDS (G5): MAX_FEE is at or above every fee the rerun and the last batch recorded, as steps.json says", () => {
  const rerun = JSON.parse(readFileSync(file("rerun"), "utf8")).steps.map((s) => s.fee_raw);
  const enc = JSON.parse(readFileSync(file("encoder_final"), "utf8")).steps.map((s) => s.fee_raw);
  const fees = [...rerun, ...enc].filter((f) => /^[0-9]+$/.test(f ?? "")).map(BigInt);
  assert.ok(fees.length >= 30);
  for (const f of fees) assert.ok(f <= big("MAX_FEE"), String(f));
});
