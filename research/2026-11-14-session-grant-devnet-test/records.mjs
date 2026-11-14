// Made run time records, in the form record-step.mjs writes (record-flow.test.mjs holds the two
// equal by writing a record with record-step.mjs itself), for the tests of next.mjs and judge.mjs.
// Every value is the plan's or a block number made here: a made record is said to be made. Not a
// test file. No network, no key.
import { plan, V, publicOf } from "./fixtures.mjs";
import { ss58 } from "./lib.mjs";
import { idsOf, planStepOf } from "./run.mjs";

export const DEVICE = publicOf("records-device");
export const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const START = 4000000;
const OWNER = V("OWNER");

/** A record right after a good P0; options change one thing. */
export function started({ nonce = "20", count = { raw: null, value: 0, stored: false }, session = { state: "none", value: null }, exit = 0, chain = {} } = {}) {
  return {
    record: "run-time", schema: "g19-run-time-1",
    accounts: { owner: { public_key: OWNER, ss58: ss58(OWNER) }, device: { public_key: DEVICE, ss58: ss58(DEVICE) } },
    owner_account_nonce_at_start: nonce,
    chain: { spec_name_at_start: V("SPEC_NAME"), spec_version_at_start: Number(V("SPEC")), transaction_version_at_start: Number(V("TXV")), genesis_at_start: V("GENESIS"), ...chain },
    start: { finalized: { number: START, hash: H(START) } },
    probe: { answered: false, length: null, refusal: { code: -32601, message: "made" } },
    p0: { exit, head: { number: START, hash: H(START) }, runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")) }, session, session_count: count },
    steps: [],
  };
}

const created = (block, o = {}) => ({ pallet: "FlopSessionKeys", name: "SessionCreated", fields: { owner: OWNER, delegate: DEVICE, spending_cap: V("SPENDING_CAP"), per_tx_limit: V("A_PER_TX"), daily_cap: V("A_DAILY"), expires_at: block + Number(V("DURATION")), ...o } });
const revoked = () => ({ pallet: "FlopSessionKeys", name: "SessionRevoked", fields: { owner: OWNER, delegate: DEVICE } });
const paid = (fee) => ({ pallet: "TransactionPayment", name: "TransactionFeePaid", fields: { who: OWNER, actual_fee: fee, tip: "0" } });
const outcome = (ok, error) => (ok ? { pallet: "System", name: "ExtrinsicSuccess", fields: {} } : { pallet: "System", name: "ExtrinsicFailed", fields: { dispatch_error: { type: "Module", value: error } } });

/**
 * One owner id of a made record, as far as `upTo` (call, sign, send, final, block, after; the last
 * is the whole step). ok: success or failed in its block; error: the name of a failed one; fee; and
 * fields of SessionCreated to change; after: what show after says (active, revoked, or exit).
 */
export function step(r, id, { upTo = "after", ok = true, error = null, fee = null, fields = {}, after = null, block = null, callRefused = null, signedRefused = null, sent = null, explorer = null } = {}) {
  const st = planStepOf(plan, id);
  const n = r.steps.length;
  const b = block ?? START + 10 * (n + 1);
  const e = { step: id, run_time: null };
  r.steps.push(e);
  e.call = { tool_file: `tool/${id}.call.json`, call_hex: "0x5e00", refused: callRefused };
  if (upTo === "call" || callRefused) return r;
  e.signed_check = signedRefused ? { refused: signedRefused } : { extrinsic_hash: H(0xe000 + n), nonce: String(BigInt(r.owner_account_nonce_at_start) + BigInt(r.steps.filter((x) => x.run_time?.sent?.status === "finalized").length)), refused: null };
  if (upTo === "sign" || signedRefused) return r;
  e.run_time = { extrinsic_hash: H(0xe000 + n), bundle_sha256: "00".repeat(32), sent: sent ?? { status: "finalized", sent_by: "send", block_number: b, block_hash: H(b), extrinsic_index: 1 }, sent_sha256: "11".repeat(32), explorer, earlier_readings: [], earlier_copies: [] };
  if (upTo === "send" || (sent && sent.status !== "finalized")) return r;
  if (upTo === "final") return r;
  const err = error ? { index: 94, error: "0x00000000" } : null;
  const events = [paid(fee ?? (st.command === "grant" ? V("FEE_GRANT") : V("FEE_REVOKE"))), outcome(ok, err)];
  if (ok) events.unshift(st.command === "grant" ? created(b, fields) : revoked());
  e.decoder = { exit: 0, block: { number: b, hash: H(b) }, extrinsic_index: 1, events, names: events.map((x) => `${x.pallet}.${x.name}`), success: ok, error: ok ? null : { pallet_index: 94, error_index: 0, name: error }, fee_raw: fee ?? (st.command === "grant" ? V("FEE_GRANT") : V("FEE_REVOKE")) };
  if (upTo === "block") return r;
  const active = after ?? (st.command === "grant" ? (ok ? "active" : "revoked") : ok ? "revoked" : "active");
  e.after = active === "exit"
    ? { exit: 1, runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")) }, session: { state: "unknown", value: null } }
    : { exit: 0, head: { number: b + 5, hash: H(b + 5) }, runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")) }, session: { state: "stored", value: { spending_cap: V("SPENDING_CAP"), per_tx_limit: V("A_PER_TX"), daily_cap: V("A_DAILY"), active: active === "active" } } };
  return r;
}

/** An explorer reading that agrees with an entry's decoder reading, as record-step.mjs keeps it. */
export function agreeingExplorer(e) {
  const kept = e.decoder.events.filter((x) => x.pallet === "FlopSessionKeys" || x.pallet === "ComputeChannel");
  e.run_time.explorer = { source: "made", success: e.decoder.success, error: e.decoder.error ? { ...e.decoder.error } : null, names: e.decoder.names, events: structuredClone(kept), channel_mismatch: [], source_kind: "second, weaker: FLOP's explorer API" };
  e.sources_differ = [];
  return e;
}

/** The whole batch as planned: G2 taken (then R2) or refused with SessionAlreadyExists, each step with an agreeing explorer reading, and the owner's balances. */
export function asPlanned(branch = "taken") {
  const r = started();
  step(r, "G1"); step(r, "R1");
  if (branch === "taken") { step(r, "G2"); step(r, "R2"); }
  else step(r, "G2", { ok: false, error: `FlopSessionKeys.${V("ALREADY_EXISTS")}`, fee: V("MAX_FEE") });
  for (const e of r.steps) agreeingExplorer(e);
  const fees = r.steps.reduce((a, e) => a + BigInt(e.decoder.fee_raw), 0n);
  r.balances = { owner_free_before: "24000000000000000000", owner_free_after: (24000000000000000000n - fees).toString(), source: "made" };
  return r;
}

export { idsOf };
