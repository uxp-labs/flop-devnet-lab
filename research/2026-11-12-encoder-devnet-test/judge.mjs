// The judge of a filled results.json against steps.json, in the rerun's way and with its library:
// each step goes through the rerun's judgeStep, made concrete first by this file (the smallest
// addition): a "recorded" step is judged by the outcome it recorded when that outcome is allowed,
// the device's nonce counts the device's steps sent, and the block a step must follow is worked
// out. Then this file checks what the rerun's library does not: the owner's and the device's
// balances step by step against what the steps move and the fees, the session's reads, the refunds,
// and the stop rule with its cleanup. No network, no key.
import { join } from "node:path";
import { judgeStep, failedWith } from "../2026-11-12-session-rerun-1014020/rerun-lib.mjs";
import { RERUN, RAW, loadPlan, readJson, substitute, isUnresolved, rerunFee } from "./lib.mjs";

export function context(results, dir) {
  const plan = loadPlan(dir);
  return { plan, results, errors: readJson(join(RERUN, "errors-1014020.json")), facts: readJson(join(RERUN, "facts-1014020.json")), earlier: () => null };
}

const recOf = (results, id) => (results.steps ?? []).find((s) => s.step === id && s.block_hash !== null && s.block_hash !== undefined) ?? null;
const succeeded = (rec) => !!rec && Array.isArray(rec.events) && rec.events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
const failedEvent = (rec) => rec?.events?.find((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
const hasEvent = (rec, name) => !!rec && Array.isArray(rec.events) && rec.events.some((e) => `${e.pallet}.${e.name}` === name);

/** Whether a step's condition holds, from the records. */
export function holds(cond, results) {
  const rec = recOf(results, cond.step);
  if (cond.event) return hasEvent(rec, cond.event) && succeeded(rec);
  if (cond.outcome === "success") return succeeded(rec);
  throw new Error(`unknown condition ${JSON.stringify(cond)}`);
}

/**
 * What a "recorded, not expected" step is judged as: the outcome it recorded, when that is success
 * or an error of an allowed pallet named by the 1014020 table. Otherwise the reason it is not.
 */
export function recordedExpectation(step, rec, errors) {
  if (succeeded(rec)) return { expect: "success", events: step.events_if_success ?? [] };
  const f = failedEvent(rec);
  if (!f) return { problem: "neither ExtrinsicSuccess nor ExtrinsicFailed is recorded" };
  const named = failedWith(f, errors);
  if (!named.error) return { problem: `its error is not named by the 1014020 table: ${named.why}` };
  if (!step.errors_allowed_of.includes(named.error.split(".")[0])) return { problem: `${named.error} is not an error of ${step.errors_allowed_of.join(" or ")}` };
  return { expect: named.error, events: [] };
}

/** The moves of a step that took place: none unless the step succeeded, and only those whose condition holds. */
export function movesDone(step, rec, results) {
  if (!succeeded(rec)) return [];
  return step.moves.filter((m) => !m.when || holds({ step: m.when.step, outcome: m.when.outcome }, results));
}

const big = (v) => (RAW.test(String(v ?? "")) ? BigInt(v) : null);
/** An account read as numbers, or null when a field is not recorded. An absent account holds nothing. */
export function accountOf(a) {
  if (!a) return null;
  if (a.absent === true) return { free: 0n, reserved: 0n, nonce: 0n, absent: true };
  const free = big(a.free), reserved = big(a.reserved), nonce = big(a.nonce);
  return free === null || reserved === null || nonce === null ? null : { free, reserved, nonce, absent: false };
}

/** What a sweep moves: all its signer held before, less the fee. */
const restOf = (prev, from, fee) => { const a = accountOf(prev?.accounts?.[from]); return a ? a.free - fee : null; };

/** The balance check of one step: the change of the owner's and the device's account against the moves and the fee. */
export function balanceProblems(plan, step, rec, prev, results) {
  const problems = [], missing = [];
  const fee = big(rec.fee_raw);
  if (fee === null) return { problems, missing: ["fee_raw"] };
  for (const who of ["owner", "device"]) {
    const before = accountOf(prev?.accounts?.[who]), after = accountOf(rec.after?.accounts?.[who]);
    if (!before) { missing.push(`the ${who}'s account before ${step.id}`); continue; }
    if (!after) { missing.push(`the ${who}'s account after ${step.id}`); continue; }
    let free = step.signer === who ? -fee : 0n;
    for (const m of movesDone(step, rec, results)) {
      const amount = m.amount === "rest" ? restOf(prev, m.from, fee) : BigInt(substitute(m.amount, plan, results, true));
      if (amount === null) { missing.push(`the ${m.from}'s account before ${step.id}`); continue; }
      if (m.to === who) free += amount;
      if (m.from === who) free -= amount;
    }
    const nonce = step.signer === who ? 1n : 0n;
    if (after.free - before.free !== free) problems.push(`the ${who}'s free balance moved by ${after.free - before.free}, the plan's moves and the fee say ${free}`);
    if (after.reserved !== before.reserved) problems.push(`the ${who}'s reserved balance moved by ${after.reserved - before.reserved}, the plan says 0`);
    if (!after.absent && after.nonce - before.nonce !== nonce) problems.push(`the ${who}'s account nonce moved by ${after.nonce - before.nonce}, expected ${nonce}`);
  }
  return { problems, missing };
}

/** The session's expected reads after a step: nonce and spent count the session calls that succeeded. */
export function sessionExpected(plan, results, upTo) {
  const ids = plan.steps.map((s) => s.id);
  let nonce = 0n, spent = 0n;
  for (const st of plan.steps.slice(0, ids.indexOf(upTo) + 1)) {
    if (st.tool !== "encoder") continue;
    const rec = recOf(results, st.id);
    if (succeeded(rec)) { nonce += 1n; spent += BigInt(substitute(st.declared, plan, results, true)); }
  }
  const revoked = ids.indexOf(upTo) >= ids.indexOf("T8") && succeeded(recOf(results, "T8"));
  return { session_nonce: nonce.toString(), spent_raw: spent.toString(), active: revoked ? "false" : "true" };
}

function sessionProblems(plan, step, rec, results) {
  const problems = [], missing = [];
  if (!succeeded(recOf(results, "T2")) || step.id === "T1" || step.id === "T2" && !succeeded(rec)) return { problems, missing };
  const want = sessionExpected(plan, results, step.id);
  const got = { session_nonce: rec.after?.session_nonce, spent_raw: rec.after?.session?.spent_raw, active: rec.after?.session?.active };
  for (const k of Object.keys(want)) {
    if (got[k] === null || got[k] === undefined) missing.push(`read ${k} after ${step.id}`);
    else if (String(got[k]) !== want[k]) problems.push(`read ${k} is ${got[k]}, expected ${want[k]}`);
  }
  return { problems, missing };
}

function refundProblems(plan, step, rec, results) {
  if (!step.refund_event || !succeeded(rec)) return [];
  const [p, n, f] = step.refund_event.split(".");
  const ev = rec.events.find((e) => e.pallet === p && e.name === n);
  const want = movesDone(step, rec, results).filter((m) => m.to === "owner").reduce((s, m) => s + BigInt(substitute(m.amount, plan, results, true)), 0n);
  if (!ev) return [`no ${p}.${n}`];
  return String(ev.fields?.[f]) === want.toString() ? [] : [`${p}.${n}.${f} is ${ev.fields?.[f]}, the moves it returns add up to ${want}`];
}

/** The block a step must follow, as a decimal string, or the reason it is not known. */
function afterBlock(plan, step, results) {
  const a = step.after_block;
  if (!a) return null;
  if (a.event) { const v = substitute(a.event, plan, results); return isUnresolved(v) ? { unknown: a.event } : v; }
  const base = recOf(results, a.step);
  return base ? String(base.finalized_in_block + Number(substitute(a.plus, plan, results, true))) : { unknown: `the block of ${a.step}` };
}

/** One step, made concrete and judged by the rerun's judgeStep, then by this file's own checks. */
export function judgeOne(ctx, step, rec, prev, deviceSent) {
  const { plan, results, errors } = ctx;
  const problems = [], missing = [], info = [];
  const concrete = { ...step, reads_after: {}, nonce: step.signer === "device" ? deviceSent : step.nonce };
  if (step.expect === "recorded") {
    const e = recordedExpectation(step, rec, errors);
    if (e.problem) problems.push(`recorded, not expected, but ${e.problem}`);
    else { concrete.expect = e.expect; concrete.events = e.events; info.push(`recorded: ${e.expect}`); }
  }
  const after = afterBlock(plan, step, results);
  if (after && typeof after === "object") missing.push(`the block it must follow (${after.unknown})`);
  else concrete.after_block = after ?? undefined;
  for (const w of concrete.events ?? []) for (const v of Object.values(w.fields)) if (isUnresolved(substitute(v, plan, results))) missing.push(`a value for ${w.event}`);
  concrete.events = (concrete.events ?? []).map((w) => ({ ...w, fields: Object.fromEntries(Object.entries(w.fields).map(([k, v]) => [k, substitute(v, plan, results)])) }));
  const base = judgeStep(concrete.expect === "recorded" ? { ...concrete, expect: "success", events: [] } : concrete, rec, { ...ctx, plan });
  if (base.status === "incomplete") return { status: "incomplete", problems: base.problems, info };
  problems.push(...base.problems.filter((p) => !(step.expect === "recorded" && problems.length && /^expected success/.test(p))));
  info.push(...base.info);
  const f = failedEvent(rec) && failedWith(failedEvent(rec), errors).error;
  if (f && step.finding_if?.[f]) problems.push(`finding: ${step.finding_if[f]}`);
  problems.push(...refundProblems(plan, step, rec, results));
  const bal = balanceProblems(plan, step, rec, prev, results);
  const ses = sessionProblems(plan, step, rec, results);
  problems.push(...bal.problems, ...ses.problems);
  missing.push(...bal.missing, ...ses.missing);
  info.push(`fee ${rec.fee_raw}${step.fee_like ? `, the rerun's ${step.fee_like} paid ${rerunFee(step.fee_like)}` : ", no like step in the rerun"}`);
  if (rec.after?.session?.epoch_spent_raw != null || rec.after?.breaker_tx_count != null) info.push(`recorded, not judged: epoch_spent ${rec.after?.session?.epoch_spent_raw ?? "unknown"}, breaker tx_count ${rec.after?.breaker_tx_count ?? "unknown"}`);
  if (problems.length) return { status: "differs", problems: [...problems, ...missing.map((m) => `${m} is missing`)], info };
  if (missing.length) return { status: "incomplete", problems: missing.map((m) => `${m} is missing`), info };
  return { status: "pass", problems, info };
}

/** Judges a whole run: each step, the stop rule, the cleanup, and the accounts. */
export function judgeRun(ctx) {
  const { plan, results } = ctx;
  const top = [], run = [];
  for (const role of ["owner", "device"]) if (!/^0x[0-9a-f]{64}$/.test(results.accounts?.[role]?.public_key ?? "")) top.push(`accounts.${role}.public_key is missing`);
  if (results.accounts?.owner?.public_key && results.accounts.owner.public_key !== plan.values.OWNER.value) top.push("accounts.owner is not the owner of steps.json");
  if (results.spec_version !== plan.spec_version) top.push(`results.spec_version is ${results.spec_version}, not ${plan.spec_version}`);
  if (RAW.test(results.owner_account_nonce_at_start ?? "") && results.owner_account_nonce_at_start !== plan.values.OWNER_NONCE_AFTER_RERUN.value) top.push(`the owner's nonce at the start is ${results.owner_account_nonce_at_start}, not ${plan.values.OWNER_NONCE_AFTER_RERUN.value}: something else was sent from the owner since the rerun`);
  const known = new Set(plan.steps.map((s) => s.id));
  for (const r of results.steps ?? []) if (!known.has(r.step)) top.push(`results has a step ${r.step} the plan does not have`);
  let stoppedAt = null, prev = results.before, deviceSent = 0;
  const left = [];
  for (const step of plan.steps) {
    const rec = recOf(results, step.id);
    const needed = step.only_if ? holds(step.only_if, results) : true;
    let j;
    if (!rec) {
      if (step.cleanup && needed) { j = { status: "not run", problems: [], info: [] }; left.push(`${step.id} is needed and not run: ${step.left_if_it_fails}`); }
      else if (!needed) j = { status: "not needed", problems: [], info: [`only if ${step.only_if.step} ${step.only_if.event ? "recorded " + step.only_if.event : "succeeded"}`] };
      else j = { status: stoppedAt ? "not sent: stopped" : "not run", problems: [], info: [] };
    } else {
      j = judgeOne(ctx, step, rec, prev, deviceSent);
      if (!needed) { j.status = "differs"; j.problems.push("sent though its condition does not hold"); }
      if (stoppedAt && !step.cleanup) { j.status = "differs"; j.problems.push(`sent after ${stoppedAt} went wrong, whose rule is stop: only cleanup steps follow a stop`); }
      if (step.cleanup && j.status === "differs") left.push(`${step.id} did not pass: ${step.left_if_it_fails}`);
      if (!stoppedAt && !step.cleanup && step.on_unexpected === "stop" && j.status === "differs") stoppedAt = step.id;
      prev = rec.after;
      if (step.signer === "device") deviceSent += 1;
    }
    run.push({ id: step.id, ...j });
  }
  const fine = (s) => s === "pass" || s === "not needed";
  const all = top.length === 0 && left.length === 0 && stoppedAt === null && run.every((r) => fine(r.status));
  return { all, top, run, stoppedAt, left };
}
