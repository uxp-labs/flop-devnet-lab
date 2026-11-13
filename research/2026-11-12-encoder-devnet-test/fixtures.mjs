// Fixtures for the tests of this folder: a run folder in a temporary place, a run time record in the
// form record-step.mjs writes (record-step.test.mjs holds the two equal), keys made inside a test,
// and relay texts with their sha256 as the pane gives them. Not a test file itself. No network.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, sha256Text, ss58, substitute } from "./lib.mjs";
import { template } from "./plan.mjs";

export const plan = loadPlan();
export const V = (n) => plan.values[n].value;
export const H = (n) => "0x" + n.toString(16).padStart(64, "0");
export const RUNTIME = { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") };

/** A key file exactly as flop-sign.mjs keygen writes it, in a new temporary folder, with its seed. */
export function makeKey(dir) {
  const seed = randomBytes(32);
  const path = join(dir, "device.json");
  writeFileSync(path, JSON.stringify({ v: 0, alg: "ed25519", seed_b64: seed.toString("base64") }) + "\n", { mode: 0o600 });
  return { path, seed };
}

/** A new empty temporary folder. */
export const tempDir = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

/** A text and its sha256, as the pane relays them. */
export const relay = (value) => { const text = JSON.stringify(value); return { text, sha: sha256Text(text) }; };

/** The device's reads as lab.deviceReads relays them. */
export function deviceReads(device, { number = 3600010, accountNonce = 0, sessionNonce = null, hash = "0x" + "cd".repeat(32) } = {}) {
  const raw = sessionNonce === null ? null : "0x" + Buffer.from(new BigUint64Array([BigInt(sessionNonce)]).buffer).toString("hex");
  return relay({ account: ss58(device), runtime: RUNTIME, birth: { number, hash }, account_nonce: accountNonce, session_nonce_raw: raw });
}

/** A run time record as record-step.mjs start makes it, for a device. */
export function startedRecord(device, { ownerNonce = V("OWNER_NONCE_AFTER_RERUN"), head = 3599990 } = {}) {
  const r = template(plan);
  r.accounts = { owner: { public_key: V("OWNER"), ss58: ss58(V("OWNER")) }, device: { public_key: device, ss58: ss58(device) } };
  r.owner_account_nonce_at_start = String(ownerNonce);
  r.chain.spec_name_at_start = RUNTIME.specName; r.chain.spec_version_at_start = RUNTIME.specVersion; r.chain.transaction_version_at_start = RUNTIME.transactionVersion;
  r.start = { finalized: { number: head, hash: H(head) }, reads_sha256: "00".repeat(32) };
  return r;
}

/** Writes a record into a new run folder (with signed/) and returns the folder. */
export function runFolder(results, name = "run") {
  const run = tempDir(name);
  mkdirSync(join(run, "signed"));
  writeFileSync(join(run, "results.json"), JSON.stringify(results, null, 1) + "\n");
  return run;
}

/** The entry of an id, made when the record has none (an attempt). */
function entry(r, id) {
  let e = r.steps.find((s) => s.step === id);
  if (!e) { e = { step: id, run_time: null }; r.steps.push(e); }
  return e;
}

/** Records a runner reading for an id: finalized at a block unless another status is given. */
export function sent(r, id, { block, status = "finalized", index = 2 } = {}) {
  const e = entry(r, id);
  const reading = status === "finalized"
    ? { status, step: id, block_hash: H(block), block_number: block, extrinsic_index: index, events_sha256: "11".repeat(32), events_length: 600, bundle_sha256: "22".repeat(32) }
    : { status, step: id, bundle_sha256: "22".repeat(32) };
  e.run_time = { extrinsic_hash: "0x" + sha256Text(`extrinsic of ${id}`), bundle_sha256: "22".repeat(32), sent: reading, sent_sha256: "33".repeat(32), explorer: null, earlier_readings: [], earlier_copies: [] };
  return r;
}

/** Records an explorer reading of an id in the record's form. */
export function explored(r, id, { success = true, error = null, events = [], names } = {}) {
  const e = entry(r, id);
  const ev = events.map(([pallet, name, fields]) => ({ pallet, name, fields }));
  e.run_time.explorer = {
    source: `${V("EXPLORER")}/api/transactions/${e.run_time.extrinsic_hash}`, read_utc: "2026-11-13T02:00:00.000Z",
    hash: e.run_time.extrinsic_hash, block_hash: e.run_time.sent.block_hash, success, error,
    names: names ?? [...ev.map((x) => `${x.pallet}.${x.name}`), success ? "System.ExtrinsicSuccess" : "System.ExtrinsicFailed"],
    events: ev, relay_sha256: "44".repeat(32),
  };
  return r;
}

/** The error of a name in the record's form. */
export function errorOf(errors, name) {
  const [p, n] = name.split(".");
  const e = errors.errors.find((x) => x.pallet === p && x.name === n);
  return { pallet_index: e.pallet_index, error_index: e.error_index, name };
}

/**
 * The run as planned, up to and with a step: each step finalized, three blocks apart, with the
 * outcome and the events the plan expects of ComputeChannel and FlopSessionKeys. T4 and T5 succeed
 * unless given. Returns the record and the block of each step.
 */
export function asPlanned(device, upTo, { from = 3600000, outcomes = {}, errors = null } = {}) {
  const r = startedRecord(device);
  const ids = plan.steps.map((s) => s.id);
  const blocks = {};
  let block = from, spent = 0n;
  for (const st of plan.steps.slice(0, ids.indexOf(upTo) + 1)) {
    if (st.id === "T6") block = Math.max(block, blocks.T3 + Number(V("ACK_WINDOW")));
    if (st.id === "T7") block = Math.max(block, blocks.T5 + Number(V("MAX_DURATION_D2")));
    block += 3;
    blocks[st.id] = block;
    sent(r, st.id, { block });
    const o = outcomes[st.id] ?? "success";
    if (o !== "success") { explored(r, st.id, { success: false, error: errorOf(errors, o) }); continue; }
    if (st.tool === "encoder") spent += BigInt(substitute(st.declared, plan, null, true));
    const exec = ["FlopSessionKeys", "SessionCallExecuted", { owner: V("OWNER"), delegate: device, spent: String(spent), epoch_spent: String(spent) }];
    const ev = {
      T1: [], T2: [["FlopSessionKeys", "SessionCreated", { owner: V("OWNER"), delegate: device, spending_cap: V("A_CAP"), per_tx_limit: V("A_PER_TX"), daily_cap: V("A_DAILY"), expires_at: String(block + 7200) }]],
      T3: [["ComputeChannel", "ForceOpenRequested", { channel_id: V("CH_T3"), agent: V("OWNER"), miner: V("NAMED"), escrow: V("ESCROW_1"), ack_deadline: String(block + 595) }], exec],
      T4: [["ComputeChannel", "EscrowToppedUp", { channel_id: V("CH_T3"), added: V("TOP_UP"), total: "11000000000000000" }], exec],
      T5: [["ComputeChannel", "ChannelOpened", { channel_id: V("CH_T5"), agent: V("OWNER"), miner: V("NAMED"), escrow: V("ESCROW_1"), measured_root: V("ROOT") }], exec],
      T6: [["ComputeChannel", "ForceOpenExpired", { channel_id: V("CH_T3"), miner: V("NAMED"), refunded: "11000000000000000", failed_acks: "0" }], exec],
      T7: [["ComputeChannel", "TimedOutRefunded", { channel_id: V("CH_T5"), refunded: V("ESCROW_1") }], exec],
      T8: [["FlopSessionKeys", "SessionRevoked", { owner: V("OWNER"), delegate: device }]],
      T9: [],
    }[st.id];
    const extra = { T1: ["Balances.Transfer"], T9: ["System.KilledAccount", "Balances.Transfer"], T3: ["Balances.Transfer"] }[st.id] ?? [];
    explored(r, st.id, { events: ev, names: [...extra, ...ev.map(([p, n]) => `${p}.${n}`), "System.ExtrinsicSuccess"] });
  }
  return { results: r, blocks };
}

/** An explorer answer of the shape the lead described (lead-measurements-2026-11-13.json), made up here: numbers as strings with commas, accounts as SS58 text. */
export function explorerAnswer({ hash = "0x" + "ab".repeat(32), blockHash = "0x" + "cd".repeat(32), success = true, failedWith = null, events: given = null, extra = [] } = {}) {
  const events = given ? [...given, ...extra] : [
    { id: "1-0", section: "balances", method: "Withdraw", data: { who: "5Device", amount: "9,422,731,810,000,000" } },
    { id: "1-1", section: "balances", method: "Transfer", data: { from: "5Owner", to: "5Pallet", amount: "10,000,000,000,000,000" } },
    { id: "1-2", section: "computeChannel", method: "ForceOpenRequested", data: { channelId: "0x" + "77".repeat(32), agent: "5Owner", miner: "5Named", escrow: "10,000,000,000,000,000", ackDeadline: "3,553,433" } },
    { id: "1-3", section: "flopSessionKeys", method: "SessionCallExecuted", data: { owner: "5Owner", delegate: "5Device", spent: "10,000,000,000,000,000", epochSpent: "10,000,000,000,000,000" } },
    ...extra,
  ];
  events.push(
    success ? { id: "1-9", section: "system", method: "ExtrinsicSuccess", data: { dispatchInfo: {} } } : { id: "1-9", section: "system", method: "ExtrinsicFailed", data: { dispatchError: failedWith, dispatchInfo: {} } });
  return { hash, blockHash, method: "executeViaSession", section: "flopSessionKeys", sender: "5Device", params: {}, success, events, timestamp: "1763000000000" };
}
