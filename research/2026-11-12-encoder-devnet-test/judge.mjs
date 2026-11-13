// The judge of a record of the batch against steps.json. A record is one of two kinds (C1):
//   "run-time": written by record-step.mjs from what the pane relayed. The judge looks at the order,
//               the outcomes and the explorer's events, and says only go on, wait or stop at <id>.
//               It never says passed: no balance is in a run time record.
//   "final":    filled later from an observatory recording. The whole check: each step through the
//               rerun's judgeStep, made concrete first by this file (a "recorded" step is judged by
//               the outcome it recorded when that outcome is allowed, the device's nonce counts the
//               device's transactions, the block a step must follow is worked out), then the owner's
//               and the device's balances step by step against what the steps move and the fees, the
//               session's reads, the refunds, the stop rule with its cleanup, and the verdict (C3).
// Both kinds: the blocks rise in the plan's order and nothing is recorded twice (C2), and every
// channel id in the events is the derived one (C7). nextOf says what is next (S2c). No network, no key.
import { join } from "node:path";
import { judgeStep, failedWith } from "../2026-11-12-session-rerun-1014020/rerun-lib.mjs";
import { RERUN, RAW, loadPlan, readJson, substitute, rerunFee, flopText } from "./lib.mjs";
import { viewOf, idsOf, MAX_ATTEMPTS, afterBlockOf, planStepOf, entryOf, leadStopOf, unsentLeft } from "./record.mjs";

export function context(results, dir) {
  const plan = loadPlan(dir);
  return { plan, results, errors: readJson(join(RERUN, "errors-1014020.json")), facts: readJson(join(RERUN, "facts-1014020.json")), earlier: () => null };
}

const failedEvent = (rec) => rec?.events?.find((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
const succeeded = (rec) => !!rec && Array.isArray(rec.events) && rec.events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");

/** Whether a step's condition holds by the record of either kind; null while it is not known. */
export function holdsBy(cond, plan, results, stopped = false) {
  const v = viewOf(results, cond.step);
  if (leadStopOf(results, cond.step)) return false; // F3: a step the lead stopped never came on chain
  if (stopped && (!v || (results.record === "final" ? !v.final : !v.entry.run_time))) return false; // after a stop, a step not sent never will be
  if (!v || !v.final || v.success === null) return null;
  if (cond.event) return v.success === true && v.names.includes(cond.event);
  if (cond.outcome === "success") return v.success === true;
  throw new Error(`unknown condition ${JSON.stringify(cond)}`);
}

// ---- both kinds: order, repeats, channel ids ----------------------------------------------------

/** The ids of the plan in its order, each step followed by the attempts S5 allows. */
const planIds = (plan) => plan.steps.flatMap((s) => idsOf(s));

/**
 * The problems of the record as a whole (C2): an id that is no step and no allowed attempt, a step
 * id or an extrinsic hash that occurs twice, and blocks that do not rise in the plan's order
 * (block number, then extrinsic index). Each problem is { id, problem }.
 */
export function recordProblems(plan, results) {
  const out = [];
  const seen = new Map(), hashes = new Map();
  for (const e of results.steps ?? []) {
    if (!planStepOf(plan, e.step)) out.push({ id: e.step, problem: `results has a step ${e.step} the plan does not have, and it is not an attempt S5 allows` });
    if (seen.has(e.step)) out.push({ id: e.step, problem: `the record holds ${e.step} twice` });
    if (e.lead_stop && viewOf(results, e.step)?.final) out.push({ id: e.step, problem: `the record holds a stop by the lead at ${e.step} beside a finalized block of it` });
    seen.set(e.step, true);
    const v = viewOf(results, e.step);
    const ex = results.record === "run-time" ? e.run_time?.explorer : null;
    if (ex) {
      // F2: the explorer's success agrees with the one outcome event among its names
      const outcome = (ex.names ?? []).filter((n) => n === "System.ExtrinsicSuccess" || n === "System.ExtrinsicFailed");
      if (outcome.length !== 1 || ex.success !== (outcome[0] === "System.ExtrinsicSuccess")) out.push({ id: e.step, problem: `the explorer reading of ${e.step} says success ${ex.success} beside ${outcome.length ? outcome.join(" and ") : "no outcome event"}` });
    }
    const h = v?.extrinsic_hash;
    if (v?.final && h) {
      if (hashes.has(h)) out.push({ id: e.step, problem: `the extrinsic ${h} is recorded twice, as ${hashes.get(h)} and ${e.step}` });
      hashes.set(h, e.step);
    }
  }
  let last = null;
  for (const id of planIds(plan)) {
    const v = viewOf(results, id);
    if (!v?.final) continue;
    const pos = [v.block_number, Number.isInteger(v.extrinsic_index) ? v.extrinsic_index : -1];
    if (last && !(pos[0] > last.pos[0] || (pos[0] === last.pos[0] && pos[1] > last.pos[1]))) out.push({ id, problem: `${id} is in block ${pos[0]} at index ${pos[1]}, not after ${last.id} (block ${last.pos[0]} at index ${last.pos[1]}): the blocks do not rise in the plan's order` });
    last = { id, pos };
  }
  return out;
}

/** The events of an id that name a channel that is not the step's derived one: [{ event, derived, explorer }] (C7, G4). */
export function channelMismatches(plan, step, view, results) {
  const want = step.channel ? substitute(step.channel, plan, results, true) : null;
  return view.events.filter((e) => e.fields && "channel_id" in e.fields && e.fields.channel_id !== want).map((e) => ({ event: `${e.pallet}.${e.name}`, derived: want, explorer: e.fields.channel_id }));
}

/** The channel ids of an id's events that are not the step's derived one, in words (C7). */
export function channelProblems(plan, step, view, results) {
  return channelMismatches(plan, step, view, results).map((m) => `${m.event} names the channel ${m.explorer}, not the derived ${step.channel ? `${step.channel.slice(1)} ${m.derived}` : "channel of none"}`);
}

// ---- the run time record ------------------------------------------------------------------------

const RUN_TIME_PALLETS = ["ComputeChannel", "FlopSessionKeys"];

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
  if (named && step.finding_if?.[named]) findings.push(`${view.id}: ${named}: ${step.finding_if[named]}`);
  for (const want of events) {
    const [pallet, name] = want.event.split(".");
    if (!RUN_TIME_PALLETS.includes(pallet)) { if (!view.names.includes(want.event)) problems.push(`no ${want.event} among the events`); continue; }
    const fields = Object.fromEntries(Object.entries(want.fields).map(([k, v]) => [k, substitute(v, plan, results, true)]));
    const hit = view.events.find((e) => e.pallet === pallet && e.name === name && Object.entries(fields).every(([k, v]) => String(e.fields?.[k]) === v));
    if (!hit) problems.push(`no ${want.event} with ${JSON.stringify(fields)}`);
  }
  for (const pattern of step.forbid ?? []) if (view.names.includes(pattern)) problems.push(`${pattern} must not appear`);
  problems.push(...channelProblems(plan, step, view, results));
  const refund = runTimeRefund(plan, step, view, results);
  problems.push(...refund.problems);
  return { ok: problems.length === 0, said: said ?? "refused", problems, findings, channels: channelMismatches(plan, step, view, results), left: refund.left, info: refund.info };
}

/** The words of C6: a top up the refund did not bring back, left in the pallet account under the step's channel. */
function topUpText(plan, step, missing, results) {
  const amount = missing.reduce((s, m) => s + BigInt(substitute(m.amount, plan, results, true)), 0n);
  return `the top up of ${missing.map((m) => m.when.step).join(", ")}, ${amount} (${flopText(amount)} FLOP), is left in the pallet account ${plan.values.PALLET_ACCOUNT.value} under the channel ${substitute(step.channel, plan, results, true)} of T3; no step of this batch brings it back`;
}

/**
 * G2: the refund of a step with a refund event (T6, T7 and their attempts) where the explorer's
 * events give it, against the moves back to the owner whose condition holds. A refund of the escrow
 * alone after a top up is not a problem: what is left is said, by C6. Not given: said, not judged.
 */
export function runTimeRefund(plan, step, view, results) {
  const out = { problems: [], left: [], info: [] };
  if (!step.refund_event || view.success !== true) return out;
  const [p, n, f] = step.refund_event.split(".");
  const got = big(view.events.find((e) => e.pallet === p && e.name === n)?.fields?.[f]);
  if (got === null) { out.info.push(`${view.id}: the explorer's events give no ${step.refund_event}: the refund is not known`); return out; }
  const back = step.moves.filter((m) => m.to === "owner");
  const base = back.filter((m) => !m.when);
  const extra = back.filter((m) => m.when && holdsBy({ step: m.when.step, outcome: m.when.outcome }, plan, results) === true);
  const sum = (ms) => ms.reduce((s, m) => s + BigInt(substitute(m.amount, plan, results, true)), 0n);
  if (got === sum(base) + sum(extra)) return out;
  if (extra.length && got === sum(base)) { out.left.push(topUpText(plan, step, extra, results)); return out; }
  out.problems.push(`${step.refund_event} is ${got}, the moves it returns add up to ${sum(base) + sum(extra)}`);
  return out;
}

/** The plan's row for a stop at a step: from the stop table of steps.json for the answer, else the step's own words. */
export function stopRowOf(plan, step, view, answer = view.success === false ? "err" : "ok") {
  const hit = (plan.stop_table ?? []).find((r) => r.step === step.id && r.answer === answer);
  return hit ? `${hit.on_chain}; ${hit.brings_back}` : `${step.id} did not answer as planned; the rule is ${step.on_unexpected}`;
}

/**
 * What is next by the record (S2c): the one function sign-device.mjs, record-step.mjs and
 * plan.mjs next ask. While the judge says go on, the next step in the plan's order; after a stop,
 * the cleanup steps that apply, in their order, an attempt of one when S5 allows it; nothing while
 * it says wait. A record whose order or repeats are wrong (C2) stops everything.
 * Returns { word: "go on" | "wait" | "stop", step, why, waiting, stopped_at, row, cleanup, left,
 * findings, said }. waiting is "inclusion" while step is sent and not in a finalized block,
 * "outcome" while its explorer reading (or a step it depends on) is missing, else null.
 */
export function nextOf(plan, results) {
  const findings = [], left = [], said = [];
  let stoppedAt = null, row = null;
  const broken = recordProblems(plan, results);
  if (broken.length) return { word: "stop", step: null, why: broken.map((b) => b.problem).join("; "), waiting: null, stopped_at: broken[0].id, row: `the record: ${broken[0].problem}`, cleanup: [], left, findings, said };
  const badChannels = new Set(); // G4: the channels of steps whose explorer reading named another channel id
  const usable = (s) => !(s.channel && badChannels.has(s.channel));
  const cleanupThatApplies = () => (stoppedAt ? plan.steps.filter((s) => s.cleanup && usable(s) && (!s.only_if || holdsBy(s.only_if, plan, results, true) !== false)).map((s) => s.id) : []);
  const out = (word, step, why, waiting = null) => ({ word: stoppedAt && word === "go on" ? "stop" : word, step, why, waiting, stopped_at: stoppedAt, row, cleanup: cleanupThatApplies(), left, findings, said });
  for (const step of plan.steps) {
    if (stoppedAt && !step.cleanup) continue;
    if (!usable(step)) { said.push(`${step.id}: does not apply: it names ${step.channel.slice(1)}, and the explorer gave another channel id`); continue; }
    if (step.only_if) {
      const h = holdsBy(step.only_if, plan, results, stoppedAt !== null);
      if (h === null) return out("wait", step.id, `the outcome of ${step.only_if.step}, which ${step.id} depends on`, "outcome");
      if (h === false) { said.push(`${step.id}: not needed`); continue; }
    }
    let done = false;
    for (const id of idsOf(step)) {
      const v = viewOf(results, id);
      const ls = leadStopOf(results, id);
      if (ls) {
        // F3: the lead stopped this id: it never came on chain. A test step is a stop there, with the
        // stop table's row for a step that never came on chain; a cleanup step did not bring back
        // what it should, and the steps after it go on.
        said.push(`${id}: stopped by the lead (case ${ls.case}): ${ls.why}`);
        left.push(...unsentLeft(id, ls));
        if (!step.cleanup) { stoppedAt = step.id; row = `stopped by the lead (case ${ls.case}): ${stopRowOf(plan, step, v, "sub")}`; }
        else left.push(`${id} was stopped by the lead (case ${ls.case}): ${step.left_if_it_fails}`);
        done = true; break;
      }
      if (!v || !v.entry.run_time) return out("go on", id, stoppedAt ? `the cleanup step ${id}` : `the next step ${id}`);
      if (!v.final) return out("wait", id, `${id} is sent and not in a finalized block (the runner said ${v.sent_status}): see send_outcomes`, "inclusion");
      if (v.success === null) return out("wait", id, `the explorer reading of ${id}`, "outcome");
      const j = judgeRunTime(plan, step, v, results);
      findings.push(...j.findings);
      left.push(...j.left);
      said.push(...j.info);
      said.push(`${id}: ${j.ok ? j.said : j.problems.join("; ")}`);
      if (j.channels.length) {
        // G4: the explorer named a channel that is not the derived one. The judge stops at a test step;
        // the cleanup steps that use this channel do not apply; what is under the explorer's id is left.
        if (step.channel) badChannels.add(step.channel);
        if (step.cleanup && v.success === true) left.push(`${id} was included and succeeded, but ${j.problems.join("; ")}`);
        for (const m of j.channels) left.push(`what ${id} moved, under the channel id ${m.explorer} the explorer gave (not the derived ${m.derived ?? "none"}): a later piece of work brings it back`);
        if (!step.cleanup) { stoppedAt = step.id; row = (plan.stop_table ?? []).filter((x) => x.step === step.id && x.answer === "channel").map((x) => `${x.on_chain}; ${x.brings_back}`)[0] ?? `${step.id}: the explorer gave another channel id`; }
        done = true; break;
      }
      if (j.ok) { done = true; break; }
      if (!step.cleanup) { stoppedAt = step.id; row = stopRowOf(plan, step, v); done = true; break; }
      if (v.success === true) { left.push(`${id} was included and succeeded, but ${j.problems.join("; ")}`); done = true; break; }
    }
    if (!done) left.push(`${step.id} was refused ${MAX_ATTEMPTS} times: ${step.left_if_it_fails}`);
  }
  return out("go on", null, "nothing is left to send");
}

/** The run time check (C1): the word, never passed. */
function judgeRunTimeRecord(ctx) {
  const n = nextOf(ctx.plan, ctx.results);
  const word = n.word === "wait" ? `wait: ${n.why}` : n.word === "stop" ? `stop at ${n.stopped_at}: ${n.row}` : `go on: ${n.why}`;
  return { kind: "run-time", all: false, exit: 3, word, verdict: word, next: n, top: [], run: n.said.map((s) => ({ id: s.split(":")[0], status: "said", problems: [], info: [s] })), left: n.left, findings: n.findings, stoppedAt: n.stopped_at };
}

// ---- the final record ---------------------------------------------------------------------------

/**
 * What a "recorded, not expected" step is judged as: the outcome it recorded, when that is success
 * or an error of an allowed pallet named by the 1014020 table. Otherwise the reason it is not.
 */
export function recordedExpectation(step, rec, errors) {
  if (succeeded(rec)) return { expect: "success", events: step.events_if_success ?? step.events ?? [] };
  const f = failedEvent(rec);
  if (!f) return { problem: "neither ExtrinsicSuccess nor ExtrinsicFailed is recorded" };
  const named = failedWith(f, errors);
  if (!named.error) return { problem: `its error is not named by the 1014020 table: ${named.why}` };
  if (!step.errors_allowed_of.includes(named.error.split(".")[0])) return { problem: `${named.error} is not an error of ${step.errors_allowed_of.join(" or ")}` };
  return { expect: named.error, events: [] };
}

const big = (v) => (RAW.test(String(v ?? "")) ? BigInt(v) : null);
/** The refund a step's refund event gives, or null. */
const refundOf = (step, rec) => {
  if (!step.refund_event) return null;
  const [p, n, f] = step.refund_event.split(".");
  return big(rec?.events?.find((e) => e.pallet === p && e.name === n)?.fields?.[f]);
};

/**
 * The moves of a step that took place: none unless the step succeeded, and only those whose
 * condition holds. T6 (C6): when T4 succeeded and the refund event gives the escrow alone, the top
 * up did not come back, and its move is not counted.
 */
export function movesDone(plan, step, rec, results) {
  if (!succeeded(rec)) return [];
  const moves = step.moves.filter((m) => !m.when || holdsBy({ step: m.when.step, outcome: m.when.outcome }, plan, results) === true);
  const refunded = refundOf(step, rec);
  const conditional = moves.filter((m) => m.when && m.to === "owner");
  if (refunded !== null && conditional.length) {
    const base = moves.filter((m) => !m.when && m.to === "owner").reduce((s, m) => s + BigInt(substitute(m.amount, plan, results, true)), 0n);
    if (refunded === base) return moves.filter((m) => !(m.when && m.to === "owner"));
  }
  return moves;
}

/** What C6 says is left when T6 refunds the escrow alone after T4 moved a top up, or null. */
export function topUpLeft(plan, step, rec, results) {
  if (!succeeded(rec) || !step.refund_event) return null;
  const all = step.moves.filter((m) => m.when && m.to === "owner" && holdsBy({ step: m.when.step, outcome: m.when.outcome }, plan, results) === true);
  if (!all.length) return null;
  const done = movesDone(plan, step, rec, results);
  const missing = all.filter((m) => !done.includes(m));
  if (!missing.length) return null;
  return topUpText(plan, step, missing, results);
}

/** An account read as numbers, or null when a field is not recorded. An absent account holds nothing. */
export function accountOf(a) {
  if (!a) return null;
  if (a.absent === true) return { free: 0n, reserved: 0n, nonce: 0n, absent: true };
  const free = big(a.free), reserved = big(a.reserved), nonce = big(a.nonce);
  return free === null || reserved === null || nonce === null ? null : { free, reserved, nonce, absent: false };
}

/** What a sweep moves: all its signer held before, less the fee. */
const restOf = (prev, from, fee) => { const a = accountOf(prev?.accounts?.[from]); return a ? a.free - fee : null; };

/** The balance check of one recorded id: the change of the owner's and the device's account against the moves and the fee. */
export function balanceProblems(plan, step, rec, prev, results) {
  const problems = [], missing = [];
  const fee = big(rec.fee_raw);
  if (fee === null) return { problems, missing: ["fee_raw"] };
  for (const who of ["owner", "device"]) {
    const before = accountOf(prev?.accounts?.[who]), after = accountOf(rec.after?.accounts?.[who]);
    if (!before) { missing.push(`the ${who}'s account before ${rec.step}`); continue; }
    if (!after) { missing.push(`the ${who}'s account after ${rec.step}`); continue; }
    let free = step.signer === who ? -fee : 0n;
    for (const m of movesDone(plan, step, rec, results)) {
      const amount = m.amount === "rest" ? restOf(prev, m.from, fee) : BigInt(substitute(m.amount, plan, results, true));
      if (amount === null) { missing.push(`the ${m.from}'s account before ${rec.step}`); continue; }
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

/** The session's expected reads after an id: nonce and spent count the session calls that succeeded, attempts included. */
export function sessionExpected(plan, results, upTo) {
  const ids = planIds(plan);
  let nonce = 0n, spent = 0n;
  for (const id of ids.slice(0, ids.indexOf(upTo) + 1)) {
    const st = planStepOf(plan, id);
    if (st.tool !== "encoder") continue;
    if (viewOf(results, id)?.success === true) { nonce += 1n; spent += BigInt(substitute(st.declared, plan, results, true)); }
  }
  const revoked = ids.indexOf(upTo) >= ids.indexOf("T8") && viewOf(results, "T8")?.success === true;
  return { session_nonce: nonce.toString(), spent_raw: spent.toString(), active: revoked ? "false" : "true" };
}

function sessionProblems(plan, step, rec, results) {
  const problems = [], missing = [];
  if (viewOf(results, "T2")?.success !== true || step.id === "T1" || (step.id === "T2" && !succeeded(rec))) return { problems, missing };
  const want = sessionExpected(plan, results, rec.step);
  const got = { session_nonce: rec.after?.session_nonce, spent_raw: rec.after?.session?.spent_raw, active: rec.after?.session?.active };
  for (const k of Object.keys(want)) {
    if (got[k] === null || got[k] === undefined) missing.push(`read ${k} after ${rec.step}`);
    else if (String(got[k]) !== want[k]) problems.push(`read ${k} is ${got[k]}, expected ${want[k]}`);
  }
  return { problems, missing };
}

function refundProblems(plan, step, rec, results) {
  if (!step.refund_event || !succeeded(rec)) return [];
  const [p, n, f] = step.refund_event.split(".");
  const ev = rec.events.find((e) => e.pallet === p && e.name === n);
  const want = movesDone(plan, step, rec, results).filter((m) => m.to === "owner").reduce((s, m) => s + BigInt(substitute(m.amount, plan, results, true)), 0n);
  if (!ev) return [`no ${p}.${n}`];
  return String(ev.fields?.[f]) === want.toString() ? [] : [`${p}.${n}.${f} is ${ev.fields?.[f]}, the moves it returns add up to ${want}`];
}

/**
 * One recorded id, made concrete and judged by the rerun's judgeStep, then by this file's own
 * checks. asAttempt (false, or the words for it) judges a refused attempt by its recorded error.
 */
export function judgeOne(ctx, step, rec, prev, deviceSent, asAttempt = false) {
  const { plan, results, errors } = ctx;
  const problems = [], missing = [], info = [], findings = [];
  const concrete = { ...step, reads_after: {}, nonce: step.signer === "device" ? deviceSent : step.nonce };
  if (asAttempt) Object.assign(concrete, { expect: "recorded", errors_allowed_of: ["ComputeChannel", "FlopSessionKeys"] });
  if (concrete.expect === "recorded") {
    const e = recordedExpectation(concrete, rec, errors);
    if (e.problem) problems.push(`recorded, not expected, but ${e.problem}`);
    else { concrete.expect = e.expect; concrete.events = e.events; info.push(`${asAttempt || "recorded"}: ${e.expect}`); }
  }
  const after = afterBlockOf(plan, step, results);
  if (after !== null && typeof after === "object") missing.push(`the block it must follow (${after.unknown})`);
  else concrete.after_block = after === null ? undefined : String(after);
  concrete.events = (concrete.events ?? []).map((w) => ({ ...w, fields: Object.fromEntries(Object.entries(w.fields).map(([k, v]) => [k, substitute(v, plan, results)])) }));
  const base = judgeStep(concrete.expect === "recorded" ? { ...concrete, expect: "success", events: [] } : concrete, rec, { ...ctx, plan });
  if (base.status === "incomplete") return { status: "incomplete", problems: base.problems, info, findings };
  problems.push(...base.problems.filter((p) => !(concrete.expect === "recorded" && problems.length && /^expected success/.test(p))));
  info.push(...base.info);
  const f = failedEvent(rec) && failedWith(failedEvent(rec), errors).error;
  if (f && step.finding_if?.[f]) findings.push(`${rec.step}: ${f}: ${step.finding_if[f]}`);
  problems.push(...refundProblems(plan, step, rec, results));
  problems.push(...channelProblems(plan, step, viewOf(results, rec.step), results));
  const bal = balanceProblems(plan, step, rec, prev, results);
  const ses = sessionProblems(plan, step, rec, results);
  problems.push(...bal.problems, ...ses.problems);
  missing.push(...bal.missing, ...ses.missing);
  info.push(`fee ${rec.fee_raw}${step.fee_like ? `, the rerun's ${step.fee_like} paid ${rerunFee(step.fee_like)}` : ", no like step in the rerun"}`);
  if (rec.after?.session?.epoch_spent_raw != null || rec.after?.breaker_tx_count != null) info.push(`recorded, not judged: epoch_spent ${rec.after?.session?.epoch_spent_raw ?? "unknown"}, breaker tx_count ${rec.after?.breaker_tx_count ?? "unknown"}`);
  if (problems.length) return { status: "differs", problems: [...problems, ...missing.map((m) => `${m} is missing`)], info, findings };
  if (missing.length) return { status: "incomplete", problems: missing.map((m) => `${m} is missing`), info, findings };
  return { status: "pass", problems, info, findings };
}

/** The final check (C1 to C7): each step and attempt, the stop rule, the cleanup, the accounts, and the verdict. */
function judgeFinal(ctx) {
  const { plan, results } = ctx;
  const top = [], run = [], left = [], findings = [];
  for (const role of ["owner", "device"]) if (!/^0x[0-9a-f]{64}$/.test(results.accounts?.[role]?.public_key ?? "")) top.push(`accounts.${role}.public_key is missing`);
  if (results.accounts?.owner?.public_key && results.accounts.owner.public_key !== plan.values.OWNER.value) top.push("accounts.owner is not the owner of steps.json");
  if (results.spec_version !== plan.spec_version) top.push(`results.spec_version is ${results.spec_version}, not ${plan.spec_version}`);
  if (!["decoder", "by position"].includes(results.balances_source)) top.push(`balances_source is ${JSON.stringify(results.balances_source ?? null)}: a final record says "decoder" or "by position"`);
  if (RAW.test(results.owner_account_nonce_at_start ?? "") && results.owner_account_nonce_at_start !== plan.values.OWNER_NONCE_AFTER_RERUN.value) top.push(`the owner's nonce at the start is ${results.owner_account_nonce_at_start}, not ${plan.values.OWNER_NONCE_AFTER_RERUN.value}: something else was sent from the owner since the rerun`);
  top.push(...recordProblems(plan, results).map((p) => p.problem));
  let stoppedAt = null, prev = results.before, deviceSent = 0;
  for (const step of plan.steps) {
    const ids = idsOf(step).filter((id) => viewOf(results, id)?.final);
    const needed = step.only_if ? holdsBy(step.only_if, plan, results, stoppedAt !== null) === true : true;
    // F3, H5: a stop by the lead the final record carries over from the run time record, at an id of
    // this step that is not in a finalized block
    const stopIds = idsOf(step).filter((id) => leadStopOf(results, id) && !viewOf(results, id)?.final);
    for (const id of stopIds) {
      const ls = leadStopOf(results, id);
      left.push(...unsentLeft(id, ls));
      if (step.cleanup) left.push(`${id} was stopped by the lead (case ${ls.case}): ${step.left_if_it_fails}`);
    }
    if (!ids.length) {
      // H5: every step is run, left out by its only_if, or after a recorded stop. A test step that is
      // missing with no stop recorded at it or before it makes the record wrong.
      let j;
      const ls = stopIds.length ? leadStopOf(results, stopIds[0]) : null;
      if (ls) {
        j = { status: `stopped by the lead (case ${ls.case})`, problems: [], info: [ls.why] };
        if (!step.cleanup && !stoppedAt) stoppedAt = step.id;
      } else if (step.cleanup && needed) { j = { status: "not run", problems: [], info: [] }; left.push(`${step.id} is needed and not run: ${step.left_if_it_fails}`); }
      else if (!needed) j = { status: "not needed", problems: [], info: [`only if ${step.only_if.step} ${step.only_if.event ? "recorded " + step.only_if.event : "succeeded"}`] };
      else if (stoppedAt) j = { status: "not sent: stopped", problems: [], info: [] };
      else j = { status: "differs", problems: [`${step.id} is missing from the final record, and no stop is recorded at it or before it`], info: [] };
      run.push({ id: step.id, ...j });
      continue;
    }
    let last = null;
    for (const [i, id] of ids.entries()) {
      const rec = entryOf(results, id);
      // an attempt that was refused (any but the last, or a refused cleanup step) is judged by its recorded error (S5, C3)
      const j = judgeOne(ctx, step, rec, prev, deviceSent, i < ids.length - 1 ? "refused, attempted again" : step.cleanup && !succeeded(rec) ? "refused" : false);
      findings.push(...j.findings);
      if (!needed) { j.status = "differs"; j.problems.push("sent though its condition does not hold"); }
      if (stoppedAt && !step.cleanup) { j.status = "differs"; j.problems.push(`sent after ${stoppedAt} went wrong, whose rule is stop: only cleanup steps follow a stop`); }
      if (i < ids.length - 1 && succeeded(rec)) { j.status = "differs"; j.problems.push(`${id} succeeded, yet ${ids[i + 1]} was sent after it`); }
      run.push({ id, ...j });
      prev = rec.after;
      if (step.signer === "device") deviceSent += 1;
      last = { id, rec, j };
    }
    const lu = topUpLeft(plan, step, last.rec, results);
    if (lu) left.push(lu);
    if (step.cleanup && !succeeded(last.rec)) {
      left.push(`${last.id} was refused: ${step.left_if_it_fails}`);
      if (!stoppedAt) stoppedAt = step.id;
    }
    if (!stoppedAt && !step.cleanup && step.on_unexpected === "stop" && last.j.status === "differs") stoppedAt = step.id;
  }
  const src = `balances: ${results.balances_source ?? "not given"}`;
  const incomplete = run.filter((r) => r.status === "incomplete");
  const bad = run.filter((r) => r.status === "differs" && r.id !== stoppedAt);
  let verdict;
  if (top.length) verdict = `failed: ${top.join("; ")}`;
  else if (incomplete.length) verdict = `failed: incomplete: ${incomplete.map((r) => `${r.id} (${r.problems.join("; ")})`).join("; ")}`;
  else if (bad.length) verdict = `failed: ${bad.map((r) => `${r.id}: ${r.problems.join("; ")}`).join(" | ")}`;
  else if (stoppedAt) verdict = left.length ? `stopped at ${stoppedAt}, left: ${left.join("; ")}` : `stopped at ${stoppedAt}, cleanup complete, nothing left`;
  else verdict = left.length ? `as planned, left: ${left.join("; ")}` : "passed as planned";
  verdict = `${verdict} (${src})`;
  const all = verdict === `passed as planned (${src})`;
  // F12: 0 when the record is right and nothing is left on chain; 4 when it is right and something
  // is left, stopped or not; 1 when it is wrong. No verdict begins with "passed" when something is left.
  const exit = /^failed: /.test(verdict) ? 1 : left.length ? 4 : 0;
  return { kind: "final", all, exit, verdict, top, run, stoppedAt, left, findings };
}

/** Judges a whole record of either kind (C1). An unnamed kind fails. */
export function judgeRun(ctx) {
  const kind = ctx.results?.record;
  if (kind === "run-time") return judgeRunTimeRecord(ctx);
  if (kind === "final") return judgeFinal(ctx);
  const verdict = `failed: results.json says record ${JSON.stringify(kind ?? null)}, not "run-time" or "final"`;
  return { kind: kind ?? null, all: false, exit: 1, verdict, word: verdict, top: [verdict], run: [], stoppedAt: null, left: [], findings: [] };
}
