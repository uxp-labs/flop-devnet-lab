// H14: events.mjs takes one extrinsic's events, its outcome and its fee from the decoder's reading.
// Over made events in the record's form. Pure, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feeOf, outcomeOf, recordFormOf, extrinsicEvents } from "./events.mjs";
import { join } from "node:path";
import { REPO, readJson } from "./lib.mjs";
import { plan } from "./fixtures.mjs";

const ERRORS = readJson(join(REPO, plan.files.errors));
const paid = (who, fee = "5") => ({ pallet: "TransactionPayment", name: "TransactionFeePaid", fields: { who, actual_fee: fee, tip: "0" } });

test("H14: the fee is the one TransactionFeePaid of the payer; another payer's, none or two is unknown", () => {
  const S = "0x" + "11".repeat(32), O = "0x" + "22".repeat(32);
  assert.equal(feeOf([paid(S)], S), "5");
  assert.equal(feeOf([paid(O)], S), null);
  assert.equal(feeOf([], S), null);
  assert.equal(feeOf([paid(S), paid(S)], S), null);
});

test("H14: the outcome names a module error by the 1014020 table, and neither or both is unknown", () => {
  const failed = { pallet: "System", name: "ExtrinsicFailed", fields: { dispatch_error: { type: "Module", value: { index: 94, error: "0x00000000" } } } };
  assert.deepEqual(outcomeOf([failed], ERRORS), { success: false, error: { pallet_index: 94, error_index: 0, name: "FlopSessionKeys.SessionAlreadyExists" } });
  assert.deepEqual(outcomeOf([{ pallet: "System", name: "ExtrinsicSuccess", fields: {} }], ERRORS), { success: true, error: null });
  assert.equal(outcomeOf([], ERRORS).success, null);
  assert.equal(outcomeOf([failed, { pallet: "System", name: "ExtrinsicSuccess", fields: {} }], ERRORS).success, null);
});

test("H14: only the extrinsic's own phase is taken, in the record's form", () => {
  const e = (i, name) => ({ phase: { variant: "ApplyExtrinsic", fields: i }, pallet: "System", event: name, fields: { x: { variant: "A", fields: null } } });
  const got = extrinsicEvents({ events: [e(1, "A"), e(2, "B"), { phase: { variant: "Finalization", fields: null }, pallet: "System", event: "C", fields: {} }] }, 2);
  assert.deepEqual(got, [{ pallet: "System", name: "B", fields: { x: { type: "A", value: null } } }]);
  assert.deepEqual(recordFormOf([{ variant: "V", fields: [1] }]), [{ type: "V", value: [1] }]);
});
