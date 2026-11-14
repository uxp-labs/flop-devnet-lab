// What the lead does next, by the run time record (H10, H11): the one next action, or the wait, or
// the stop and why. It walks both branches of G2 (U1): taken, then R2; refused, the end. A revoke
// that failed in its block has a cleanup try at the next nonce, three tries at most (record.mjs
// MAX_ATTEMPTS of the last batch). Every state of the planner's part 6 that applies without U2 is a
// stop. Pure: it reads the record and steps.json only. No network, no key.
import { RAW, V } from "./lib.mjs";
import { entryOf, idsOf, planStepOf, viewOf, MAX_ATTEMPTS } from "./run.mjs";
import { plannedCaps } from "./owner-call.mjs";
import { sendOutcome } from "./outcomes.mjs";

/** The phases of one id of an owner step, in order. */
export const PHASES = ["call", "sign", "send", "wait", "block", "after", "done"];

const big = (v) => (RAW.test(String(v ?? "")) ? BigInt(v) : null);

/** Where an id of an owner step is, by the record: a phase, or a stop of these tools with why. */
export function phaseOf(plan, results, id) {
  const e = entryOf(results, id);
  if (e?.lead_stop) return { phase: "stopped", lead_stop: e.lead_stop };
  if (!e?.call) return { phase: "call" };
  if (e.call.refused) return { stop: `the tool's call of ${id} is refused, nothing is signed: ${e.call.refused}` };
  if (!e.signed_check) return { phase: "sign" };
  if (e.signed_check.refused) return { stop: `the signed file of ${id} is refused, nothing is sent: ${e.signed_check.refused}` };
  if (!e.run_time) return { phase: "send" };
  const v = viewOf(results, id);
  if (!v.final) return { phase: "wait", sent: e.run_time.sent };
  if (!e.decoder) return { phase: "block" };
  if (e.decoder.exit !== 0) return { stop: `the tool's readBlockEvents of ${id}'s block exited ${e.decoder.exit}, not 0: ${e.decoder.unknown ?? "no reason"}` };
  if (e.decoder.success === null) return { stop: `the outcome of ${id} is unknown: its events in block ${v.block_number} hold neither one System.ExtrinsicSuccess nor one System.ExtrinsicFailed` };
  if (!e.after) return { phase: "after" };
  if (e.after.exit !== 0) return { stop: `the tool's session show after ${id} exited ${e.after.exit}, not 0` };
  return { phase: "done" };
}

/** The decoder's event of a name among an id's events, or null. */
const eventOf = (e, pallet, name) => e?.decoder?.events?.find((x) => x.pallet === pallet && x.name === name) ?? null;

/**
 * What differs in a done step from the plan, as words: the events' fields, the expiry, the show after,
 * the fee above the most per step. A failed step's problems are its failure only.
 */
export function problemsOf(plan, results, id) {
  const step = planStepOf(plan, id);
  const e = entryOf(results, id);
  const v = viewOf(results, id);
  const out = [];
  const device = results.accounts.device.public_key, owner = V(plan, "OWNER");
  const fee = big(e.decoder.fee_raw);
  if (fee === null) out.push(`the fee of ${id} is not read from its events (unknown, never 0)`);
  else if (fee > BigInt(V(plan, "MAX_FEE"))) out.push(`the fee of ${id}, ${fee}, is above the most per step ${V(plan, "MAX_FEE")}`);
  if (e.decoder.success !== true) return out;
  const s = e.after.session;
  if (step.command === "grant") {
    const c = eventOf(e, "FlopSessionKeys", "SessionCreated");
    const want = { owner, delegate: device, spending_cap: V(plan, "SPENDING_CAP"), per_tx_limit: V(plan, "A_PER_TX"), daily_cap: V(plan, "A_DAILY") };
    if (!c) out.push(`${id} has no FlopSessionKeys.SessionCreated in its events`);
    else {
      for (const [k, w] of Object.entries(want)) if (String(c.fields[k]) !== w) out.push(`SessionCreated ${k} is ${c.fields[k]}, the plan's is ${w}`);
      const exp = v.block_number + Number(V(plan, "DURATION"));
      if (String(c.fields.expires_at) !== String(exp)) out.push(`SessionCreated expires_at is ${c.fields.expires_at}, not its block ${v.block_number} plus ${V(plan, "DURATION")}, ${exp}`);
    }
    const caps = plannedCaps(plan);
    if (s?.state !== "stored" || s.value?.active !== true) out.push(`session show after ${id} does not say active`);
    else for (const k of ["spending_cap", "per_tx_limit", "daily_cap"]) if (s.value[k] !== caps[k]) out.push(`session show after ${id} says ${k} ${s.value[k]}, the plan's is ${caps[k]}`);
  } else {
    const r = eventOf(e, "FlopSessionKeys", "SessionRevoked");
    if (!r) out.push(`${id} has no FlopSessionKeys.SessionRevoked in its events`);
    else for (const [k, w] of Object.entries({ owner, delegate: device })) if (String(r.fields[k]) !== w) out.push(`SessionRevoked ${k} is ${r.fields[k]}, the plan's is ${w}`);
    if (s?.state !== "stored" || s.value?.active !== false) out.push(`session show after ${id} does not say revoked`);
  }
  if (e.after.runtime?.specVersion !== Number(V(plan, "SPEC")) || e.after.runtime?.specName !== V(plan, "SPEC_NAME")) out.push(`the runtime after ${id} is not the plan's`);
  return out;
}

/** The stops of P0, as words; empty when P0 holds. */
export function p0Stops(plan, results) {
  const out = [];
  const c = results.chain ?? {};
  if (c.spec_name_at_start !== V(plan, "SPEC_NAME") || c.spec_version_at_start !== Number(V(plan, "SPEC"))) out.push(`the runtime at the start is ${c.spec_name_at_start} ${c.spec_version_at_start}, not the plan's ${V(plan, "SPEC_NAME")} ${V(plan, "SPEC")}`);
  if (c.transaction_version_at_start !== Number(V(plan, "TXV"))) out.push(`the transaction version at the start is ${c.transaction_version_at_start}, not the plan's ${V(plan, "TXV")}`);
  if (c.genesis_at_start !== V(plan, "GENESIS")) out.push(`the genesis at the start is ${c.genesis_at_start}, not the plan's ${V(plan, "GENESIS")}`);
  const p = results.p0 ?? {};
  if (p.exit !== 0) out.push(`the tool's session show at P0 exited ${p.exit}, not 0`);
  if (p.session?.state !== "none") out.push(`the pair is not absent at P0: the session is ${p.session?.state ?? "not read"}`);
  if (p.runtime?.specVersion !== Number(V(plan, "SPEC")) || p.runtime?.specName !== V(plan, "SPEC_NAME")) out.push("the runtime of the P0 tape is not the plan's");
  const n = p.session_count;
  if (!n || n.value === null || n.value === undefined) out.push(`SessionCount(S) cannot be read at P0${n?.reason ? `: ${n.reason}` : ""}`);
  else if (n.value >= Number(V(plan, "SESSION_COUNT_STOP"))) out.push(`SessionCount(S) is ${n.value}, at or above ${V(plan, "SESSION_COUNT_STOP")}`);
  return out;
}

const go = (step, phase, why, extra = {}) => ({ word: phase === "wait" ? "wait" : "go", step, phase, why, ...extra });
const stop = (at, why, extra = {}) => ({ word: "stop", step: null, phase: null, stopped_at: at, why, ...extra });

/**
 * The next action of an id that is not done (F1). A sent id not in a finalized block follows the
 * action its outcome row names, and nothing else: the lead's stop (word stop, phase lead-stop, with
 * the case the row names), a find, the same bytes again, or the first send again. A reading no row
 * names an action for is a stop.
 */
function actOf(plan, id, p) {
  if (p.phase !== "wait") return go(id, p.phase, `${id} is at its ${p.phase}`);
  const said = `the runner said ${p.sent?.status}${p.sent?.node?.code !== undefined ? ` with node code ${p.sent.node.code}` : ""}${p.sent?.node_status ? ` (${p.sent.node_status})` : ""}${p.sent?.sent_by ? ` to ${p.sent.sent_by}` : ""}`;
  let o;
  try { o = sendOutcome(plan, p.sent); } catch (e) { o = { row: null, action: null, reason: e.message }; }
  if (!o.row || !o.action || o.action.kind === "record") return stop(id, `${id}: ${said}; no row of send_outcomes names an action for it here${o.reason ? `: ${o.reason}` : ""}. The lead rules`);
  if (o.action.kind === "stop") return { word: "stop", step: id, phase: "lead-stop", stopped_at: id, why: `${id}: ${said}; send_outcomes says the lead stops at the step (case ${o.action.case}): ${o.action.words}`, sent: p.sent, row: o.row, action: o.action };
  return go(id, "wait", `${id}: ${said}; send_outcomes says: ${o.action.words}`, { sent: p.sent, row: o.row, action: o.action });
}
const end = (why, extra = {}) => ({ word: "end", step: null, phase: null, why, ...extra });

/** The left words of an active session that no revoke ended. */
const activeLeft = (results, id) => {
  const c = entryOf(results, id)?.decoder?.events?.find((x) => x.name === "SessionCreated");
  return `an active session of the owner for the device, made by ${id}, until block ${c?.fields?.expires_at ?? "unknown"} (the device is unfunded and signs nothing)`;
};

/**
 * One revoke and its cleanup tries: the next action of the first id not done, or { done: id } for the
 * first that succeeded, or { exhausted } when every try failed in its block, or a stop.
 */
function revokeChain(plan, results, base, findings) {
  const step = planStepOf(plan, base);
  for (const id of idsOf(step)) {
    const p = phaseOf(plan, results, id);
    if (p.stop) return { next: stop(id, p.stop) };
    if (p.phase === "stopped") { findings.push(`the lead stopped ${id} (case ${p.lead_stop.case}): a stopped cleanup try counts as not done, and the next try follows`); continue; }
    if (p.phase !== "done") return { next: actOf(plan, id, p) };
    const e = entryOf(results, id);
    if (e.decoder.success === false) { findings.push(`${id} failed in its block with ${e.decoder.error?.name ?? "an error the 1014020 table does not name"}: a cleanup try at the next nonce`); continue; }
    return { done: id, problems: problemsOf(plan, results, id) };
  }
  return { exhausted: true };
}

/**
 * The next action of the batch by the record (H10). word is go (a step's phase to do), wait (a sent
 * step not in a finalized block: follow the immortal rows of send_outcomes), stop (these tools go no
 * further, with why) or end (the batch is over, with why). findings and left go beside it.
 */
export function nextOf(plan, results) {
  const findings = [], left = [];
  const out = (r) => ({ cleanup: [], ...r, findings, left });
  if (!results) return out(go("P0", "start", "no record yet: P0"));
  const p0 = p0Stops(plan, results);
  if (p0.length) return out(stop("P0", p0.join("; ")));
  // G1
  const g1 = phaseOf(plan, results, "G1");
  if (g1.stop) return out(stop("G1", g1.stop));
  if (g1.phase === "stopped") return out(stop("G1", `the lead stopped G1 (case ${g1.lead_stop.case})`));
  if (g1.phase !== "done") return out(actOf(plan, "G1", g1));
  const g1e = entryOf(results, "G1");
  if (g1e.decoder.success === false) return out(stop("G1", `G1 failed in its block with ${g1e.decoder.error?.name ?? "an error the 1014020 table does not name"}: nothing is active, one fee is lost`));
  const g1p = problemsOf(plan, results, "G1");
  if (g1p.length) findings.push(...g1p.map((p) => `G1: ${p}`));
  // R1, and its tries
  const r1 = revokeChain(plan, results, "R1", findings);
  if (r1.next) { if (g1p.length && r1.next.word !== "stop") r1.next.why += "; then stop: G1 is not the plan's"; return out({ ...r1.next, cleanup: g1p.length ? ["R1"] : [] }); }
  if (r1.exhausted) { left.push(activeLeft(results, "G1")); return out(stop("R1", `every try of R1 (${MAX_ATTEMPTS}) failed in its block`)); }
  if (r1.problems.length) { findings.push(...r1.problems.map((p) => `${r1.done}: ${p}`)); return out(stop(r1.done, `${r1.done} is not the plan's revoke`)); }
  if (g1p.length) return out(stop("G1", `G1 was not the plan's (${g1p.join("; ")}); R1 has ended its session`));
  // G2: U1
  const g2 = phaseOf(plan, results, "G2");
  if (g2.stop) return out(stop("G2", g2.stop));
  if (g2.phase === "stopped") return out(stop("G2", `the lead stopped G2 (case ${g2.lead_stop.case})`));
  if (g2.phase !== "done") return out(actOf(plan, "G2", g2));
  const g2e = entryOf(results, "G2");
  if (g2e.decoder.success === false) {
    const name = g2e.decoder.error?.name;
    const fee = problemsOf(plan, results, "G2");
    findings.push(...fee.map((p) => `G2: ${p}`));
    if (name === `FlopSessionKeys.${V(plan, "ALREADY_EXISTS")}`) return out(end(`U1: the chain refused G2 with ${name}; the pair stays revoked`));
    return out(end(`U1 stays open: the chain refused G2 with ${name ?? "an error the 1014020 table does not name"}, not ${V(plan, "ALREADY_EXISTS")}; the pair stays revoked`));
  }
  const g2p = problemsOf(plan, results, "G2");
  if (g2p.length) findings.push(...g2p.map((p) => `G2: ${p}`));
  const r2 = revokeChain(plan, results, "R2", findings);
  if (r2.next) return out({ ...r2.next, cleanup: ["R2"] });
  if (r2.exhausted) { left.push(activeLeft(results, "G2")); return out(stop("R2", `every try of R2 (${MAX_ATTEMPTS}) failed in its block`)); }
  if (r2.problems.length) { findings.push(...r2.problems.map((p) => `${r2.done}: ${p}`)); return out(stop(r2.done, `${r2.done} is not the plan's revoke`)); }
  if (g2p.length) return out(stop("G2", `U1: the chain took G2, which was not the plan's (${g2p.join("; ")}); R2 has ended its session`));
  return out(end(`U1: the chain took G2 over the revoked record; R2 has ended its session`));
}
