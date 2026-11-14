// The judge of a run time record (H15): each claim of the batch pass, differ, incomplete, not run
// or not needed, and one verdict. Unknown stays unknown: a value the record does not hold is
// incomplete, never a pass and never 0. The events and fees are the decoder's (the tool's
// readBlockEvents over the block tape); the explorer's reading is a second source, and where the two
// differ the claim of the step's sources says differ. Pure. No network, no key.
import { RAW, V } from "./lib.mjs";
import { entryOf, idsOf, planStepOf, viewOf } from "./run.mjs";
import { nextOf } from "./next.mjs";
import { plannedCaps } from "./owner-call.mjs";

export const STATUSES = ["pass", "differ", "incomplete", "not run", "not needed"];
const big = (v) => (RAW.test(String(v ?? "")) ? BigInt(v) : null);
const claim = (id, what, status, why = "") => ({ id, what, status, why });
const eventOf = (e, name) => e?.decoder?.events?.find((x) => x.pallet === "FlopSessionKeys" && x.name === name) ?? null;

/** The id of a step the record holds as done in its block (decoder and show after), or null. */
const doneId = (results, id) => (entryOf(results, id)?.decoder && entryOf(results, id)?.after ? id : null);
/** The try of a revoke that succeeded in its block, or null. */
const revokeTry = (plan, results, base) => idsOf(planStepOf(plan, base)).find((id) => entryOf(results, id)?.decoder?.success === true) ?? null;

function createdClaims(plan, results, id) {
  const e = entryOf(results, id), v = viewOf(results, id);
  const out = [];
  if (!e?.decoder) return [claim(id, "SessionCreated is the derived caps, owner and delegate", "not run"), claim(id, "expires_at is its block plus DURATION", "not run"), claim(id, "session show after says active with those caps", "not run")];
  const c = eventOf(e, "SessionCreated");
  const want = { owner: V(plan, "OWNER"), delegate: results.accounts?.device?.public_key, spending_cap: V(plan, "SPENDING_CAP"), per_tx_limit: V(plan, "A_PER_TX"), daily_cap: V(plan, "A_DAILY") };
  if (e.decoder.success !== true) out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", e.decoder.success === false ? "differ" : "incomplete", e.decoder.success === false ? `failed in its block with ${e.decoder.error?.name ?? "an unnamed error"}` : "its outcome is unknown"));
  else if (!c) out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", "differ", "no SessionCreated in its events"));
  else {
    const d = Object.entries(want).filter(([k, w]) => w === undefined || String(c.fields[k]) !== w).map(([k, w]) => `${k} ${c.fields[k]}, the plan's ${w ?? "unknown"}`);
    out.push(claim(id, "SessionCreated is the derived caps, owner and delegate", d.length ? (want.delegate === undefined ? "incomplete" : "differ") : "pass", d.join("; ")));
  }
  const exp = c?.fields?.expires_at;
  if (!c) out.push(claim(id, "expires_at is its block plus DURATION", e.decoder.success === true ? "differ" : "incomplete", "no SessionCreated"));
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

function revokedClaims(plan, results, base) {
  const id = revokeTry(plan, results, base);
  const tried = idsOf(planStepOf(plan, base)).filter((x) => entryOf(results, x));
  if (!id) {
    const status = tried.length === 0 ? "not run" : tried.some((x) => entryOf(results, x)?.decoder?.success === false) ? "differ" : "incomplete";
    return [claim(base, "SessionRevoked of the pair", status, tried.length ? `tries: ${tried.join(", ")}, none succeeded in its block by the record` : ""), claim(base, "session show after says revoked", tried.length ? "incomplete" : "not run")];
  }
  const e = entryOf(results, id);
  const r = eventOf(e, "SessionRevoked");
  const want = { owner: V(plan, "OWNER"), delegate: results.accounts?.device?.public_key };
  const d = !r ? ["no SessionRevoked in its events"] : Object.entries(want).filter(([k, w]) => String(r.fields[k]) !== w).map(([k]) => `${k} ${r.fields[k]}`);
  const out = [claim(id, "SessionRevoked of the pair", d.length ? "differ" : "pass", d.join("; "))];
  const s = e.after?.session;
  if (!e.after) out.push(claim(id, "session show after says revoked", "not run"));
  else if (e.after.exit !== 0 || !s || s.state === "unknown") out.push(claim(id, "session show after says revoked", "incomplete", `show exited ${e.after.exit}`));
  else out.push(claim(id, "session show after says revoked", s.state === "stored" && s.value?.active === false ? "pass" : "differ", s.state === "stored" ? `active ${s.value?.active}` : s.state));
  return out;
}

/** The claims of a record, in order, and its verdict. */
export function judge(plan, results) {
  const claims = [];
  claims.push(...createdClaims(plan, results, "G1"));
  claims.push(...revokedClaims(plan, results, "R1"));
  // G2: U1
  const g2 = entryOf(results, "G2");
  let branch = null;
  if (!g2?.decoder) claims.push(claim("G2", "the outcome of G2 (U1)", "not run"));
  else if (g2.decoder.success === true) { branch = "taken"; claims.push(claim("G2", "the outcome of G2 (U1)", "pass", "taken: SessionCreated")); claims.push(...createdClaims(plan, results, "G2")); }
  else if (g2.decoder.success === false) {
    const name = g2.decoder.error?.name ?? null;
    branch = name === `FlopSessionKeys.${V(plan, "ALREADY_EXISTS")}` ? "refused" : "other";
    claims.push(claim("G2", "the outcome of G2 (U1)", "pass", branch === "refused" ? `refused with ${name}` : `refused with ${name ?? "an unnamed error"}: U1 stays open`));
  } else claims.push(claim("G2", "the outcome of G2 (U1)", "incomplete", "its outcome is unknown"));
  if (branch === "taken") claims.push(...revokedClaims(plan, results, "R2"));
  else if (branch) claims.push(claim("R2", "SessionRevoked of the pair", "not needed", "G2 was not taken"));
  else claims.push(claim("R2", "SessionRevoked of the pair", "not run"));
  // fees, by the decoder
  const sent = results.steps.filter((e) => viewOf(results, e.step)?.final);
  for (const e of sent) {
    const fee = big(e.decoder?.fee_raw);
    claims.push(claim(e.step, "its fee is at or under the most per step", fee === null ? "incomplete" : fee <= BigInt(V(plan, "MAX_FEE")) ? "pass" : "differ", fee === null ? "not read from its events" : `${fee}`));
  }
  // the second source
  for (const e of sent) {
    const st = !e.run_time.explorer || !e.decoder ? "incomplete" : (e.sources_differ ?? []).length ? "differ" : "pass";
    claims.push(claim(e.step, "the explorer's reading agrees with the decoder's", st, st === "incomplete" ? "the record does not hold both" : (e.sources_differ ?? []).join("; ")));
  }
  // the owner's balance, only where the record holds it
  const b = results.balances;
  if (!b) claims.push(claim("batch", "the owner's free balance fell by the sum of the fees and nothing else", "not run", "the record holds no balances"));
  else {
    const before = big(b.owner_free_before), afterB = big(b.owner_free_after);
    const fees = sent.map((e) => big(e.decoder?.fee_raw));
    if (before === null || afterB === null || fees.some((f) => f === null)) claims.push(claim("batch", "the owner's free balance fell by the sum of the fees and nothing else", "incomplete", "a balance or a fee is unknown"));
    else { const sum = fees.reduce((a, f) => a + f, 0n); claims.push(claim("batch", "the owner's free balance fell by the sum of the fees and nothing else", before - afterB === sum ? "pass" : "differ", `fell ${before - afterB}, fees ${sum}`)); }
  }
  const n = nextOf(plan, results);
  const count = (s) => claims.filter((c) => c.status === s).length;
  const worst = count("differ") ? "differ" : count("incomplete") ? "incomplete" : count("not run") ? "not run" : "pass";
  const state = n.word === "end" ? `the end: ${n.why}` : n.word === "stop" ? `stopped at ${n.stopped_at}: ${n.why}` : `not finished: next ${n.step} ${n.phase}`;
  const verdict = `${worst === "pass" ? "passed" : worst === "differ" ? "differs" : worst}; ${state}${n.left.length ? `; left: ${n.left.join("; ")}` : ""}`;
  const exit = worst === "pass" ? 0 : worst === "differ" ? 1 : 4;
  return { claims, verdict, exit, branch, next: n, counts: Object.fromEntries(STATUSES.map((s) => [s, count(s)])) };
}
