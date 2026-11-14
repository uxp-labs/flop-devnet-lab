// The judge of a run time record (H15): each claim of the batch pass, differ, incomplete, not run
// or not needed, and one verdict. Unknown stays unknown: a value the record does not hold is
// incomplete, never a pass and never 0. The owner's balance is not judged in this record. The events and fees are the decoder's (the tool's
// readBlockEvents over the block tape); the explorer's reading is a second source, and where the two
// differ the claim of the step's sources says differ. Pure. No network, no key.
import { join } from "node:path";
import { RAW, REPO, readJson, V } from "./lib.mjs";
import { entryOf, idsOf, planStepOf, viewOf } from "./run.mjs";
import { nextOf } from "./next.mjs";
import { plannedCaps } from "./owner-call.mjs";
import { feeOf, outcomeOf } from "./events.mjs";
import { sourcesDiffer } from "./record-step.mjs";

export const STATUSES = ["pass", "differ", "incomplete", "not run", "not needed", "not judged"];
const big = (v) => (RAW.test(String(v ?? "")) ? BigInt(v) : null);
const claim = (id, what, status, why = "") => ({ id, what, status, why });
const eventOf = (e, name) => e?.decoder?.events?.find((x) => x.pallet === "FlopSessionKeys" && x.name === name) ?? null;

/**
 * What a step's evidence gives (F6): its outcome, error and fee computed from its decoder events, and
 * where its explorer reading and those events differ; and `words`, each derived word of the record
 * (success, error, fee_raw, sources_differ) that is not what the evidence gives. null when the
 * record holds no decoder reading.
 */
export function evidenceOf(plan, results, id, errors) {
  const e = entryOf(results, id);
  if (!e?.decoder || !Array.isArray(e.decoder.events)) return null;
  const o = outcomeOf(e.decoder.events, errors);
  const fee = feeOf(e.decoder.events, V(plan, "OWNER"));
  const differ = e.run_time?.explorer ? sourcesDiffer({ decoder: { ...e.decoder, success: o.success, error: o.error }, run_time: e.run_time }) : null;
  const words = [];
  if (e.decoder.success !== o.success) words.push(`the record says success ${e.decoder.success}, its events give ${o.success}`);
  if ((e.decoder.error?.name ?? null) !== (o.error?.name ?? null)) words.push(`the record says the error ${e.decoder.error?.name ?? null}, its events give ${o.error?.name ?? null}`);
  const feeWord = e.decoder.fee_raw !== fee ? `the record says the fee ${e.decoder.fee_raw}, its events give ${fee}` : null;
  const srcWord = differ !== null && JSON.stringify(e.sources_differ ?? []) !== JSON.stringify(differ) ? `the record says the sources differ in ${JSON.stringify(e.sources_differ ?? [])}, its readings give ${JSON.stringify(differ)}` : null;
  return { success: o.success, error: o.error, fee, differ, words, feeWord, srcWord };
}

/** The try of a revoke that succeeded in its block by its events, or null. */
const revokeTry = (plan, results, base, errors) => idsOf(planStepOf(plan, base)).find((id) => evidenceOf(plan, results, id, errors)?.success === true) ?? null;

function createdClaims(plan, results, id, errors) {
  const e = entryOf(results, id), v = viewOf(results, id);
  const out = [];
  const x = evidenceOf(plan, results, id, errors);
  if (!x) return [claim(id, "SessionCreated is the derived caps, owner and delegate", "not run"), claim(id, "expires_at is its block plus DURATION", "not run"), claim(id, "session show after says active with those caps", "not run")];
  const c = eventOf(e, "SessionCreated");
  const want = { owner: V(plan, "OWNER"), delegate: results.accounts?.device?.public_key, spending_cap: V(plan, "SPENDING_CAP"), per_tx_limit: V(plan, "A_PER_TX"), daily_cap: V(plan, "A_DAILY") };
  if (x.success === null) out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", "incomplete", "its events hold no one System outcome event: its outcome is unknown"));
  else if (x.words.length) out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", "differ", x.words.join("; ")));
  else if (x.success !== true) out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", "differ", `failed in its block with ${x.error?.name ?? "an unnamed error"}`));
  else if (!c) out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", "differ", "no SessionCreated in its events"));
  else {
    const d = Object.entries(want).filter(([k, w]) => w === undefined || String(c.fields[k]) !== w).map(([k, w]) => `${k} ${c.fields[k]}, the plan's ${w ?? "unknown"}`);
    out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", d.length ? (want.delegate === undefined ? "incomplete" : "differ") : "pass", d.join("; ")));
  }
  const exp = c?.fields?.expires_at;
  if (!c) out.push(claim(id, "expires_at is its block plus DURATION", x.success === true ? "differ" : "incomplete", "no SessionCreated"));
  else if (!Number.isInteger(v?.block_number) || exp === undefined || exp === null) out.push(claim(id, "expires_at is its block plus DURATION", "incomplete", "the block or expires_at is not held"));
  else out.push(claim(id, "expires_at is its block plus DURATION", String(exp) === String(v.block_number + Number(V(plan, "DURATION"))) ? "pass" : "differ", `expires_at ${exp}, block ${v.block_number}`));
  const s = e.after?.session;
  if (!e.after) out.push(claim(id, "session show after says active with those caps", "not run"));
  else if (e.after.exit !== 0 || !s || s.state === "unknown") out.push(claim(id, "session show after says active with those caps", "incomplete", `show exited ${e.after.exit}`));
  else {
    const caps = plannedCaps(plan);
    const d = s.value?.active !== true ? ["not active"] : ["spending_cap", "per_tx_limit", "daily_cap"].filter((k) => s.value[k] !== caps[k]).map((k) => `${k} ${s.value[k]}`);
    out.push(claim(id, "session show after says active with those caps", d.length ? "differ" : "pass", d.join("; ")));
  }
  return out;
}

function revokedClaims(plan, results, base, errors) {
  const id = revokeTry(plan, results, base, errors);
  const tried = idsOf(planStepOf(plan, base)).filter((x) => entryOf(results, x));
  if (!id) {
    const status = tried.length === 0 ? "not run" : tried.some((x) => evidenceOf(plan, results, x, errors)?.success === false) ? "differ" : "incomplete";
    return [claim(base, "SessionRevoked of the pair", status, tried.length ? `tries: ${tried.join(", ")}, none succeeded in its block by the record` : ""), claim(base, "session show after says revoked", tried.length ? "incomplete" : "not run")];
  }
  const e = entryOf(results, id);
  const r = eventOf(e, "SessionRevoked");
  const want = { owner: V(plan, "OWNER"), delegate: results.accounts?.device?.public_key };
  const d = [...evidenceOf(plan, results, id, errors).words, ...(!r ? ["no SessionRevoked in its events"] : Object.entries(want).filter(([k, w]) => String(r.fields[k]) !== w).map(([k]) => `${k} ${r.fields[k]}`))];
  const out = [claim(id, "SessionRevoked of the pair", d.length ? "differ" : "pass", d.join("; "))];
  const s = e.after?.session;
  if (!e.after) out.push(claim(id, "session show after says revoked", "not run"));
  else if (e.after.exit !== 0 || !s || s.state === "unknown") out.push(claim(id, "session show after says revoked", "incomplete", `show exited ${e.after.exit}`));
  else out.push(claim(id, "session show after says revoked", s.state === "stored" && s.value?.active === false ? "pass" : "differ", s.state === "stored" ? `active ${s.value?.active}` : s.state));
  return out;
}

/**
 * The claims of a record, in order, and its verdict (F6). Each claim is computed from the events and
 * the readings the record holds; a derived word of the record that is not what they give makes its
 * claim differ. passed, exit 0, only when plan.mjs next says the end for the record and every claim
 * this record judges passes or is not needed (the owner's balance is not judged here, and never
 * counts as a pass or a differ); otherwise exit 1 when a claim differs and 4 in every other case, and the
 * verdict names what is missing or differing.
 */
export function judge(plan, results, errors = readJson(join(REPO, plan.files.errors))) {
  const claims = [];
  claims.push(...createdClaims(plan, results, "G1", errors));
  claims.push(...revokedClaims(plan, results, "R1", errors));
  // G2: U1
  const g2 = evidenceOf(plan, results, "G2", errors);
  const exists = `FlopSessionKeys.${V(plan, "ALREADY_EXISTS")}`;
  let branch = null;
  if (!g2) claims.push(claim("G2", "the outcome of G2 (U1)", "not run"));
  else if (g2.success === null) claims.push(claim("G2", "the outcome of G2 (U1)", "incomplete", "its events hold no one System outcome event: its outcome is unknown"));
  else if (g2.words.length) { branch = g2.success ? "taken" : g2.error?.name === exists ? "refused" : "other"; claims.push(claim("G2", "the outcome of G2 (U1)", "differ", g2.words.join("; "))); if (branch === "taken") claims.push(...createdClaims(plan, results, "G2", errors)); }
  else if (g2.success === true) { branch = "taken"; claims.push(claim("G2", "the outcome of G2 (U1)", "pass", "taken: SessionCreated")); claims.push(...createdClaims(plan, results, "G2", errors)); }
  else {
    const name = g2.error?.name ?? null;
    branch = name === exists ? "refused" : "other";
    claims.push(branch === "refused" ? claim("G2", "the outcome of G2 (U1)", "pass", `refused with ${name}`) : claim("G2", "the outcome of G2 (U1)", "differ", `refused with ${name ?? "an error the 1014020 table does not name"}, not ${exists}: U1 stays open`));
  }
  if (branch === "taken") claims.push(...revokedClaims(plan, results, "R2", errors));
  else if (branch) claims.push(claim("R2", "SessionRevoked of the pair", "not needed", "G2 was not taken"));
  else claims.push(claim("R2", "SessionRevoked of the pair", "not run"));
  // fees, by the events
  const sent = results.steps.filter((e) => viewOf(results, e.step)?.final);
  const fees = [];
  for (const e of sent) {
    const x = evidenceOf(plan, results, e.step, errors);
    const fee = big(x?.fee);
    fees.push(fee);
    if (x?.feeWord) claims.push(claim(e.step, "its fee is at or under the most per step", "differ", x.feeWord));
    else claims.push(claim(e.step, "its fee is at or under the most per step", fee === null ? "incomplete" : fee <= BigInt(V(plan, "MAX_FEE")) ? "pass" : "differ", fee === null ? "not read from its events" : `${fee}`));
  }
  // the second source, by the readings
  for (const e of sent) {
    const x = evidenceOf(plan, results, e.step, errors);
    if (!x || x.differ === null) { claims.push(claim(e.step, "the explorer's reading agrees with the decoder's", "incomplete", "the record does not hold both")); continue; }
    if (x.srcWord) { claims.push(claim(e.step, "the explorer's reading agrees with the decoder's", "differ", x.srcWord)); continue; }
    claims.push(claim(e.step, "the explorer's reading agrees with the decoder's", x.differ.length ? "differ" : "pass", x.differ.join("; ")));
  }
  // the owner's balance: not judged in this record (the lead's L1, ruled again). lab.accountReads
  // gives no balance; the balance before and after comes with the public recording of the batch's
  // blocks (stage 2), through the observatory's decoder. A balances field is reported, never judged.
  claims.push(claim("batch", "the owner's balance before and after", "not judged", results.balances !== undefined ? `the record carries balances (source ${JSON.stringify(results.balances?.source ?? null)}): not judged in this record` : "not read in this batch: it comes with the public recording of the batch's blocks (stage 2)"));
  const n = nextOf(plan, results);
  const count = (s) => claims.filter((c) => c.status === s).length;
  const worst = count("differ") ? "differ" : count("incomplete") ? "incomplete" : count("not run") ? "not run" : n.word !== "end" ? "incomplete" : "pass";
  const state = n.word === "end" ? `the end: ${n.why}` : n.word === "stop" ? `stopped at ${n.stopped_at}: ${n.why}` : `not finished: next ${n.step} ${n.phase}`;
  const missing = claims.filter((c) => !["pass", "not needed", "not judged"].includes(c.status)).map((c) => `${c.id} ${c.what}: ${c.status}`);
  const verdict = `${worst === "pass" ? "passed" : worst === "differ" ? "differs" : worst}; ${state}${missing.length ? `; ${missing.join("; ")}` : ""}${n.left.length ? `; left: ${n.left.join("; ")}` : ""}`;
  const exit = worst === "pass" ? 0 : worst === "differ" ? 1 : 4;
  return { claims, verdict, exit, branch, next: n, counts: Object.fromEntries(STATUSES.map((s) => [s, count(s)])) };
}
