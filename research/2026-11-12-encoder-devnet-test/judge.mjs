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
import { viewOf, idsOf, MAX_ATTEMPTS, afterBlockOf } from "./record.mjs";

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

/** The block a step must follow, as a decimal string, or the reason it is not known (record.mjs afterBlockOf, S7). */
function afterBlock(plan, step, results) {
  const a = afterBlockOf(plan, step, results);
  return a === null ? null : typeof a === "object" ? a : String(a);
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

// ---- the run time record: what is next ---------------------------------------------------------

const RUN_TIME_PALLETS = ["ComputeChannel", "FlopSessionKeys"];

/** Whether a step's condition holds by the record of either kind; null while it is not known. */
export function holdsBy(cond, plan, results, stopped = false) {
  const v = viewOf(results, cond.step);
  if (stopped && (!v || (results.record !== "final" && !v.entry.run_time))) return false; // after a stop, a step not sent never will be
  if (!v || !v.final || v.success === null) return null;
  if (cond.event) return v.success === true && v.names.includes(cond.event);
  if (cond.outcome === "success") return v.success === true;
  throw new Error(`unknown condition ${JSON.stringify(cond)}`);
}

/**
 * The run time judgement of one recorded id against its step: from the outcome and the events of
 * ComputeChannel and FlopSessionKeys the explorer gave, and the names of all events. Returns
 * { ok, said, problems, findings }. It never says passed: balances are not in a run time record.
 */
export function judgeRunTime(plan, step, view, results) {
  const problems = [], findings = [];
  let said, events;
  const named = view.error?.name ?? null;
  if (step.expect === "success") {
    if (view.success === true) { said = "success, as expected"; events = step.events ?? []; }
    else { problems.push(`expected success, it was refused with ${named ?? `pallet ${view.error?.pallet_index} error ${view.error?.error_index}, which the 1014020 table does not name`}`); events = []; }
  } else if (view.success === true) { said = "recorded: success"; events = step.events_if_success ?? []; }
  else if (!named) { problems.push(`recorded, not expected, but its error (pallet ${view.error?.pallet_index}, error ${view.error?.error_index}) is not named by the 1014020 table`); events = []; }
  else if (!step.errors_allowed_of.includes(named.split(".")[0])) { problems.push(`recorded, not expected, but ${named} is not an error of ${step.errors_allowed_of.join(" or ")}`); events = []; }
  else { said = `recorded: ${named}`; events = []; }
  if (named && step.finding_if?.[named]) findings.push(`${step.id}: ${named}: ${step.finding_if[named]}`);
  for (const want of events) {
    const [pallet, name] = want.event.split(".");
    if (!RUN_TIME_PALLETS.includes(pallet)) { if (!view.names.includes(want.event)) problems.push(`no ${want.event} among the events`); continue; }
    const fields = Object.fromEntries(Object.entries(want.fields).map(([k, v]) => [k, substitute(v, plan, results, true)]));
    const hit = view.events.find((e) => e.pallet === pallet && e.name === name && Object.entries(fields).every(([k, v]) => String(e.fields?.[k]) === v));
    if (!hit) problems.push(`no ${want.event} with ${JSON.stringify(fields)}`);
  }
  for (const pattern of step.forbid ?? []) if (view.names.includes(pattern)) problems.push(`${pattern} must not appear`);
  return { ok: problems.length === 0, said: said ?? "refused", problems, findings };
}

/**
 * What is next by the record (S2c): the one function sign-device.mjs, record-step.mjs and
 * plan.mjs next ask. While the judge says go on, the next step in the plan's order; after a stop,
 * the cleanup steps that apply, in their order, an attempt of one when S5 allows it; nothing while
 * it says wait. Returns { word: "go on" | "wait" | "stop", step, why, waiting, stopped_at, row,
 * cleanup, left, findings, said }. waiting is "inclusion" while step is sent and not in a
 * finalized block, "outcome" while its explorer reading is missing, else null.
 */
export function nextOf(plan, results) {
  const findings = [], left = [], said = [];
  let stoppedAt = null, row = null;
  const out = (word, step, why, waiting = null) => ({ word: stoppedAt && word === "go on" ? "stop" : word, step, why, waiting, stopped_at: stoppedAt, row, cleanup: cleanupThatApplies(), left, findings, said });
  const cleanupThatApplies = () => (stoppedAt ? plan.steps.filter((s) => s.cleanup && (!s.only_if || holdsBy(s.only_if, plan, results, true) !== false)).map((s) => s.id) : []);
  for (const step of plan.steps) {
    if (stoppedAt && !step.cleanup) continue;
    if (step.only_if) {
      const h = holdsBy(step.only_if, plan, results, stoppedAt !== null);
      if (h === null) return out("wait", step.id, `the outcome of ${step.only_if.step}, which ${step.id} depends on`, "outcome");
      if (h === false) { said.push(`${step.id}: not needed`); continue; }
    }
    let done = false;
    for (const id of idsOf(step)) {
      const v = viewOf(results, id);
      if (!v || !v.entry.run_time) return out("go on", id, stoppedAt ? `the cleanup step ${id}` : `the next step ${id}`);
      if (!v.final) return out("wait", id, `${id} is sent and not in a finalized block (the runner said ${v.sent_status}): see send_outcomes`, "inclusion");
      if (v.success === null) return out("wait", id, `the explorer reading of ${id}`, "outcome");
      const j = judgeRunTime(plan, step, v, results);
      findings.push(...j.findings);
      said.push(`${id}: ${j.ok ? j.said : j.problems.join("; ")}`);
      if (j.ok) { done = true; break; }
      if (!step.cleanup) { stoppedAt = step.id; row = stopRowOf(plan, step, v); done = true; break; }
      if (v.success === true) { left.push(`${id} was included and succeeded, but ${j.problems.join("; ")}`); done = true; break; }
    }
    if (!done) left.push(`${step.id} was refused ${MAX_ATTEMPTS} times: ${step.left_if_it_fails}`);
  }
  return out("go on", null, "nothing is left to send");
}

/** The plan's row for a stop at a step: from the stop table of steps.json when it has one for the answer, else the step's own words. */
export function stopRowOf(plan, step, view) {
  const answer = view.success === false ? "err" : "ok";
  const hit = (plan.stop_table ?? []).find((r) => r.step === step.id && r.answer === answer);
  return hit ? `${hit.on_chain}; ${hit.brings_back}` : `${step.id} did not answer as planned; the rule is ${step.on_unexpected}`;
}
