// The shared part of plan.mjs and check.mjs: reads steps.json and the files it names, resolves each
// $NAME, and judges one recorded transaction against what steps.json expects. No network, no key.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const loadPlan = (dir = HERE) => readJson(join(dir, "steps.json"));
export const loadErrors = (dir = HERE) => readJson(join(dir, "errors-1014020.json"));
export const loadFacts = (dir = HERE) => readJson(join(dir, "facts-1014020.json"));

/** Reads a path like steps[4].what or force_open.sla.max_turns out of a JSON value. */
export function atPath(obj, path) {
  let v = obj;
  for (const part of path.match(/[^.[\]]+/g)) {
    if (v === null || typeof v !== "object" || !(part in v)) throw new Error(`no ${path}`);
    v = v[part];
  }
  return v;
}

/** The value a values entry names in its source file: the field, or the regex group in it. Arrays are joined with commas. */
export function fromSource(plan, from, repo = REPO) {
  let v = atPath(readJson(join(repo, plan.files[from.file])), from.path);
  if (Array.isArray(v)) v = v.join(",");
  v = String(v);
  if (from.re) {
    const m = new RegExp(from.re).exec(v);
    if (!m) throw new Error(`${from.file} ${from.path} does not match ${from.re}`);
    v = m[1];
  }
  return v;
}

const TOKEN = /\$([A-Z][A-Z0-9_]*(?:\.[A-Za-z]+\.[A-Za-z]+\.[a-z_]+)?)/g;

/**
 * Replaces each $NAME in a text. A NAME is a value of steps.json, DEV1 or DEV2 (from the recorded
 * accounts), or step.Pallet.Event.field (from the events recorded for that step). An unknown name is
 * left as it is, so plan.mjs can print it as a placeholder, unless strict is set.
 */
export function substitute(text, plan, results, strict = false) {
  return text.replace(TOKEN, (whole, name) => {
    let v;
    if (name.includes(".")) {
      const [step, pallet, event, field] = name.split(".");
      const rec = results?.steps?.find((s) => s.step === step);
      const ev = rec?.events?.find((e) => e.pallet === pallet && e.name === event);
      v = ev?.fields?.[field];
    } else if (name === "DEV1" || name === "DEV2") v = results?.accounts?.[name.toLowerCase()]?.public_key;
    else v = plan.values[name]?.value;
    if (v === undefined || v === null || v === "") { if (strict) throw new Error(`${whole} is not known`); return whole; }
    return String(v);
  });
}

export const ROLES = { owner: "owner", dev1: "dev1", dev2: "dev2" };
/** On an expected refusal none of these may appear: the call must be rolled back whole. */
export const ROLLBACK_FORBIDS = ["Balances.Transfer", "Balances.Reserved", "Balances.Held", "FlopSessionKeys.SessionCallExecuted", "ComputeChannel.*"];
export const READ_KEYS = ["session_active", "session_nonce", "spent_raw", "epoch_spent_raw", "breaker_tx_count", "failed_acks_of_named", "delegate_sessions_of_device"];
const HASH = /^0x[0-9a-f]{64}$/;

const errorName = (errors, pallet, index) => errors.errors.find((e) => e.pallet_index === pallet && e.error_index === index);
const matches = (pattern, ev) => pattern.endsWith(".*") ? ev.pallet === pattern.slice(0, -2) : `${ev.pallet}.${ev.name}` === pattern;

/** The error a recorded ExtrinsicFailed names, as "Pallet.Name", read through the 1014020 table; or why it cannot be named. */
export function failedWith(ev, errors) {
  const d = ev.fields?.dispatch_error;
  if (!d || d.type !== "Module" || !d.value) return { error: null, why: `not a module error: ${JSON.stringify(d)}` };
  const pallet = d.value.index, raw = d.value.error;
  if (!Number.isInteger(pallet) || typeof raw !== "string" || !/^0x[0-9a-f]{8}$/.test(raw)) return { error: null, why: `a module error needs an index and four error bytes: ${JSON.stringify(d.value)}` };
  const index = parseInt(raw.slice(2, 4), 16);
  const hit = errorName(errors, pallet, index);
  return hit ? { error: `${hit.pallet}.${hit.name}`, pallet, index } : { error: null, why: `pallet ${pallet} error ${index} is not in errors-1014020.json` };
}

/**
 * Judges one recorded transaction. Returns { status, problems, info } where status is pass,
 * differs (it ran and something is not as expected), incomplete (a field or a read is missing)
 * or not run.
 */
export function judgeStep(step, rec, ctx) {
  const { plan, results, errors, facts, earlier } = ctx;
  const problems = [], missing = [], info = [];
  if (!rec) return { status: "not run", problems, info };
  const sub = (t) => substitute(String(t), plan, results);
  const unresolved = (t) => /\$[A-Z]/.test(t);

  for (const [k, ok] of [["block_hash", HASH.test(rec.block_hash ?? "")], ["extrinsic_hash", HASH.test(rec.extrinsic_hash ?? "")],
    ["finalized_in_block", Number.isInteger(rec.finalized_in_block)], ["extrinsic_index", Number.isInteger(rec.extrinsic_index)],
    ["events", Array.isArray(rec.events) && rec.events.length > 0], ["fee_raw", /^(0|[1-9][0-9]*)$/.test(rec.fee_raw ?? "")],
    ["last_runtime_upgrade_spec", Number.isInteger(rec.last_runtime_upgrade_spec)], ["account_nonce", /^(0|[1-9][0-9]*)$/.test(rec.account_nonce ?? "")]]) if (!ok) missing.push(k);
  if (missing.length) return { status: "incomplete", problems: missing.map((k) => `${k} is missing or malformed`), info };

  if (rec.last_runtime_upgrade_spec !== plan.spec_version) problems.push(`the block was executed by spec ${rec.last_runtime_upgrade_spec}, not ${plan.spec_version}: the error table does not apply`);
  const signer = results.accounts?.[step.signer]?.public_key;
  if (rec.signer !== signer) problems.push(`signed by ${rec.signer}, expected the ${step.signer} key ${signer}`);
  const start = step.signer === "owner" ? results.owner_account_nonce_at_start : "0";
  if (/^(0|[1-9][0-9]*)$/.test(start ?? "") && rec.account_nonce !== String(BigInt(start) + BigInt(step.nonce))) problems.push(`account nonce ${rec.account_nonce}, expected ${BigInt(start) + BigInt(step.nonce)}`);
  else if (!/^(0|[1-9][0-9]*)$/.test(start ?? "")) missing.push("owner_account_nonce_at_start");

  // every event must be one the 1014020 metadata has, with exactly its field names
  for (const ev of rec.events) {
    const p = facts.events[ev.pallet];
    const known = p?.events.find((e) => e.name === ev.name);
    if (!known) { problems.push(`event ${ev.pallet}.${ev.name} is not in the 1014020 metadata`); continue; }
    const got = Object.keys(ev.fields ?? {});
    if (known.fields.some((f) => f === null) ? got.length !== 0 : got.join(",") !== known.fields.join(",")) problems.push(`event ${ev.pallet}.${ev.name} has fields ${got.join(",") || "(none)"}, the metadata says ${known.fields.join(",")}`);
  }
  const ok = rec.events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
  const failed = rec.events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
  if (ok.length + failed.length !== 1) problems.push(`expected one ExtrinsicSuccess or ExtrinsicFailed, found ${ok.length} and ${failed.length}`);
  else if (step.expect === "success") {
    if (failed.length) { const f = failedWith(failed[0], errors); problems.push(`expected success, failed with ${f.error ?? f.why}`); }
  } else if (ok.length) problems.push(`expected ${step.expect}, it succeeded`);
  else {
    const f = failedWith(failed[0], errors);
    if (f.error !== step.expect) problems.push(`expected ${step.expect}, failed with ${f.error ?? f.why}`);
    else info.push(`refused with ${f.error} (pallet ${f.pallet}, error ${f.index})`);
    for (const ev of rec.events) if (ROLLBACK_FORBIDS.some((p) => matches(p, ev))) problems.push(`a refused call must be rolled back whole, but it carries ${ev.pallet}.${ev.name}`);
  }
  for (const pattern of step.forbid ?? []) for (const ev of rec.events) if (matches(pattern, ev)) problems.push(`${ev.pallet}.${ev.name} must not appear`);
  for (const want of step.events ?? []) {
    const [pallet, name] = want.event.split(".");
    const fields = Object.fromEntries(Object.entries(want.fields).map(([k, v]) => [k, sub(v)]));
    if (Object.values(fields).some(unresolved)) { missing.push(`a value for ${want.event}: ${JSON.stringify(fields)}`); continue; }
    const hit = rec.events.find((e) => e.pallet === pallet && e.name === name && Object.entries(fields).every(([k, v]) => String(e.fields?.[k]) === v));
    if (!hit) problems.push(`no ${want.event} with ${JSON.stringify(fields)}`);
  }
  const fee = rec.events.filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid");
  if (fee.length !== 1) problems.push(`expected one TransactionFeePaid, found ${fee.length}`);
  else {
    if (fee[0].fields.who !== signer) problems.push(`the fee was paid by ${fee[0].fields.who}, not the signer`);
    if (String(fee[0].fields.actual_fee) !== rec.fee_raw) problems.push(`fee_raw ${rec.fee_raw} is not the TransactionFeePaid actual_fee ${fee[0].fields.actual_fee}`);
    const before = earlier?.(step.fee_like);
    if (before) info.push(`fee ${rec.fee_raw}, at spec 1014014 ${before} (${BigInt(rec.fee_raw) - BigInt(before)} raw apart)`);
  }
  if (step.after_block) {
    const after = sub(step.after_block);
    if (unresolved(after)) missing.push(`the block it must follow (${step.after_block})`);
    else if (!(rec.finalized_in_block > Number(after))) problems.push(`sent in block ${rec.finalized_in_block}, not after ${after}`);
  }
  if (step.ack_deadline_within) {
    const ev = rec.events.find((e) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested");
    const win = Number(sub(step.ack_deadline_within));
    if (ev) {
      const d = Number(ev.fields.ack_deadline) - rec.finalized_in_block;
      if (!(d > 0 && d < win)) problems.push(`ack deadline is ${d} blocks after the block of inclusion; at spec 1014014 it was fewer than the window of ${win}`);
      else info.push(`ack deadline ${d} blocks after the block of inclusion (window ${win})`);
    }
  }
  for (const [k, v] of Object.entries(step.reads_after ?? {})) {
    const got = rec.reads_after?.[k];
    if (got === undefined || got === null) missing.push(`read ${k}`);
    else if (String(got) !== sub(v)) problems.push(`read ${k} is ${got}, expected ${sub(v)}`);
  }
  if (problems.length) return { status: "differs", problems: [...problems, ...missing.map((m) => `${m} is missing`)], info };
  if (missing.length) return { status: "incomplete", problems: missing.map((m) => `${m} is missing`), info };
  return { status: "pass", problems, info };
}

/** Judges a whole run: each step, the accounts, and that nothing was sent after a step whose rule is stop went wrong. */
export function judgeRun(ctx) {
  const { plan, results } = ctx;
  const run = [];
  const top = [];
  for (const role of Object.keys(ROLES)) if (!HASH.test(results.accounts?.[role]?.public_key ?? "")) top.push(`accounts.${role}.public_key is missing`);
  if (results.accounts?.owner?.public_key && results.accounts.owner.public_key !== plan.values.OWNER.value) top.push("accounts.owner is not the owner of the earlier tests");
  if (results.spec_version !== plan.spec_version) top.push(`results.spec_version is ${results.spec_version}, not ${plan.spec_version}`);
  const known = new Set(plan.steps.map((s) => s.id));
  for (const r of results.steps ?? []) if (!known.has(r.step)) top.push(`results has a step ${r.step} the plan does not have`);
  let stoppedAt = null;
  for (const step of plan.steps) {
    const rec = (results.steps ?? []).find((s) => s.step === step.id && s.block_hash !== null);
    const j = judgeStep(step, rec, ctx);
    if (stoppedAt && rec) j.problems.push(`sent after ${stoppedAt} went wrong, whose rule is stop`), (j.status = "differs");
    if (!stoppedAt && step.on_unexpected === "stop" && j.status === "differs") stoppedAt = step.id;
    run.push({ id: step.id, ...j });
  }
  const bal = results.owner_free_balance_raw ?? {};
  const raw = /^(0|[1-9][0-9]*)$/;
  if (run.every((r) => r.status === "pass") && raw.test(bal.before ?? "") && raw.test(bal.after ?? "")) {
    const fees = (results.steps ?? []).reduce((n, s) => n + BigInt(s.fee_raw), 0n);
    const fall = BigInt(bal.before) - BigInt(bal.after);
    if (fall !== fees) top.push(`the owner's balance fell by ${fall}, the fees of all steps are ${fees}: something other than fees left the owner`);
  } else if (run.every((r) => r.status === "pass")) top.push("owner_free_balance_raw before and after are missing");
  const all = top.length === 0 && run.every((r) => r.status === "pass");
  return { all, top, run, stoppedAt };
}

/** The fee an earlier results.json recorded for a step, as a raw string. */
export function earlierFee(plan, ref, repo = REPO) {
  if (!ref) return null;
  const s = readJson(join(repo, plan.files[ref.file])).steps.find((x) => x.step === ref.step);
  if (!s) throw new Error(`${ref.file} has no step ${ref.step}`);
  return s.fee_raw;
}

/** Everything judgeRun needs, from the files of this folder and the recorded results. */
export function context(results, dir = HERE, repo = REPO) {
  const plan = loadPlan(dir);
  return { plan, results, errors: loadErrors(dir), facts: loadFacts(dir), earlier: (ref) => earlierFee(plan, ref, repo) };
}
