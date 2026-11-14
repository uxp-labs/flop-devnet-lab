/**
 * `session show` (P5b, rules C13 to C16): the session as the chain stores it at the finalized head, the seat's local
 * caps beside the chain's, and the room left for one call. It reads; it signs, sends and writes nothing.
 *
 * Exit 0 only when everything it shows is known (rule C17): the read, the session, the nonce, the breaker, the local
 * caps and the room. Anything unknown is exit 1, with the words `unknown (<reason>)` where the value would be, and in JSON a
 * null value with its reason. A known room of none is exit 0.
 */
import { ERA_PERIOD } from "../chain/era.js";
import type { SessionState } from "../chain-read/read.js";
import { known, unknown, type Got } from "../chain-read/result.js";
import type { CircuitBreakerRecord, SessionRecord } from "../chain-read/session-state.js";
import { CliError, EXIT } from "../errors.js";
import type { NetworkInfo } from "../networks.js";
import { deviceOf, ownerOf } from "./accounts.js";
import { localRaw, type LocalRaw } from "./caps.js";
import { encoderRuntime, holdGenesis, stateOf, transportOf, type EncoderRuntime } from "./chain.js";
import type { SessionContext } from "./context.js";
import { BREAKER_NOT_COUNTED, CHANNEL_PALLET, roomOf, type Room } from "./room.js";
import { amountText, headOf, palletName, ss58Of, storedJson, unknownWords, type Output } from "./words.js";

/** The seat's local caps as show reads them: a cap `run` would refuse, or one off the grid, is unknown with the reason. */
function localOf(ctx: SessionContext): Got<LocalRaw> {
  try {
    return known(localRaw(ctx.caps, ctx.seat));
  } catch (e) {
    if (e instanceof CliError) return unknown(e.message);
    throw e;
  }
}

function sessionLines(s: SessionState["session"]): string[] {
  if (s.kind === "unknown") return [`  session  ${unknownWords(s.reason)}`];
  if (s.kind === "absent") return ["  session  no session"];
  const v = s.value;
  return [
    `  session  stored, ${v.active ? "active" : "not active (revoked)"}`,
    `    spending_cap     ${amountText(v.spending_cap)}`,
    `    per_tx_limit     ${amountText(v.per_tx_limit)}`,
    `    daily_cap        ${amountText(v.daily_cap)}`,
    `    spent            ${amountText(v.spent)}`,
    `    epoch_spent      ${amountText(v.epoch_spent)}`,
    `    epoch_start      ${v.epoch_start}`,
    `    expires_at       ${v.expires_at}`,
    `    allowed_pallets  [${v.allowed_pallets.map(palletName).join(", ")}]`,
  ];
}

function sessionJson(v: SessionRecord, net: NetworkInfo): Record<string, unknown> {
  return {
    owner: ss58Of(v.owner, net),
    delegate: ss58Of(v.delegate, net),
    spending_cap: String(v.spending_cap),
    per_tx_limit: String(v.per_tx_limit),
    daily_cap: String(v.daily_cap),
    spent: String(v.spent),
    epoch_spent: String(v.epoch_spent),
    epoch_start: v.epoch_start,
    expires_at: v.expires_at,
    allowed_pallets: v.allowed_pallets.map(palletName),
    active: v.active,
  };
}

function nonceLine(n: SessionState["sessionNonce"]): string {
  if (n.kind === "unknown") return `  session nonce  ${unknownWords(n.reason)}`;
  if (n.kind === "absent") return "  session nonce  none";
  return `  session nonce  ${n.value}${n.stored ? "" : " (not stored: the chain's default)"}`;
}

function breakerLine(b: SessionState["circuitBreaker"]): string {
  if (b.kind === "unknown") return `  breaker  ${unknownWords(b.reason)}`;
  if (b.kind === "absent") return "  breaker  none";
  const v = b.value;
  return `  breaker  period_start ${v.period_start}, tx_count ${v.tx_count}, total_spend ${amountText(v.total_spend)}, tripped ${v.tripped}`;
}

const breakerJson = (v: CircuitBreakerRecord) => ({ period_start: v.period_start, tx_count: v.tx_count, total_spend: String(v.total_spend), tripped: v.tripped });

/** The notes of C13 and C15: a chain cap above its local cap, an allow list this tool does not write, an epoch past its reset. */
function notesOf(state: SessionState, local: Got<LocalRaw>, rt: Got<EncoderRuntime>): string[] {
  if (state.session.kind !== "known") return [];
  const s = state.session.value;
  const out: string[] = [];
  if (local.kind === "known") {
    if (s.per_tx_limit > local.value.perCall) out.push(`The chain's per_tx_limit ${amountText(s.per_tx_limit)} is above the seat's per call cap ${amountText(local.value.perCall)}.`);
    if (s.daily_cap > local.value.daily) out.push(`The chain's daily_cap ${amountText(s.daily_cap)} is above the seat's daily cap ${amountText(local.value.daily)}.`);
  }
  const names = s.allowed_pallets.map(palletName);
  if (names.length === 0) out.push("The allow list is empty, which lets the session call every pallet: this is not a grant this tool writes.");
  else if (names.length !== 1 || names[0] !== CHANNEL_PALLET) out.push(`The allow list is not exactly ${CHANNEL_PALLET}: this is not a grant this tool writes.`);
  if (rt.kind === "known" && state.number >= s.epoch_start + rt.value.constants.sessionEpochLength) {
    out.push(
      `The head ${state.number} is at or past epoch_start ${s.epoch_start} plus the epoch length of ${rt.value.constants.sessionEpochLength} blocks: by the lab's reading of the runtime (inferred), the chain resets this epoch's spend at the next call. The room shown counts the stored epoch_spent, so it is a lower bound.`,
    );
  }
  return out;
}

function roomLine(r: Room): string {
  if (r.kind === "unknown") return `  room for one call  ${unknownWords(r.reason)}`;
  if (r.kind === "none") return `  room for one call  none (${r.reason})`;
  const b = r.bounds;
  return `  room for one call  ${amountText(r.raw)}: the least of per_tx_limit ${amountText(b.per_tx_limit)}, daily_cap less epoch_spent ${amountText(b.epoch_left)}, spending_cap less spent ${amountText(b.lifetime_left)}; ${BREAKER_NOT_COUNTED}`;
}

function roomJson(r: Room): Record<string, unknown> {
  if (r.kind === "unknown") return { state: "unknown", value: null, reason: r.reason };
  if (r.kind === "none") return { state: "none", value: null, reason: r.reason };
  return { state: "known", value: String(r.raw), bounds: { per_tx_limit: String(r.bounds.per_tx_limit), epoch_left: String(r.bounds.epoch_left), lifetime_left: String(r.bounds.lifetime_left) }, not_counted: BREAKER_NOT_COUNTED };
}

function runtimeLine(rt: Got<EncoderRuntime>): string {
  if (rt.kind === "unknown") return `  encoder  ${unknownWords(rt.reason)}`;
  const c = rt.value.constants;
  return `  encoder  in the encoder's table: transaction version ${rt.value.id.transactionVersion}, SessionEpochLength ${c.sessionEpochLength} blocks, MaxSessionDuration ${c.maxSessionDuration} blocks, era period ${ERA_PERIOD} blocks`;
}

function localLine(l: Got<LocalRaw>): string {
  if (l.kind === "unknown") return `  local caps  ${unknownWords(l.reason)}`;
  return `  local caps  per call ${amountText(l.value.perCall)}, daily ${amountText(l.value.daily)} (per UTC day)`;
}

export async function show(ctx: SessionContext): Promise<Output> {
  if (ctx.days !== undefined) throw new CliError("--days is for `session grant` only", EXIT.USAGE);
  const device = deviceOf(ctx.home, ctx.seat, ctx.net);
  const owner = ownerOf(ctx.owner, ctx.net, device);
  const t = transportOf(ctx.net, ctx.transport);
  await holdGenesis(t, ctx.net);
  const state = await stateOf(t, owner, device);
  const rt = encoderRuntime(state, ctx.net);
  const local = localOf(ctx);
  const room = roomOf({ head: state.number, session: state.session, breaker: state.circuitBreaker, constants: rt, eraPeriod: ERA_PERIOD });
  const notes = notesOf(state, local, rt);
  const head = headOf(ctx.seat, ctx.net, owner, device, state);
  const lines = [...head.lines, runtimeLine(rt), ...sessionLines(state.session), nonceLine(state.sessionNonce), breakerLine(state.circuitBreaker), localLine(local), ...notes.map((n) => `  ${n}`), roomLine(room)];
  const anyUnknown = [state.session, state.sessionNonce, state.circuitBreaker, local, room].some((x) => x.kind === "unknown");
  const json = {
    ...head.json,
    encoder: rt.kind === "known" ? { state: "known", value: { transactionVersion: rt.value.id.transactionVersion, sessionEpochLength: rt.value.constants.sessionEpochLength, maxSessionDuration: rt.value.constants.maxSessionDuration, eraPeriod: ERA_PERIOD } } : { state: "unknown", value: null, reason: rt.reason },
    session: storedJson(state.session, (v) => sessionJson(v, ctx.net)),
    session_nonce: storedJson(state.sessionNonce, (v) => String(v)),
    circuit_breaker: storedJson(state.circuitBreaker, breakerJson),
    local_caps: local.kind === "known" ? { state: "known", value: { per_call: String(local.value.perCall), daily: String(local.value.daily) } } : { state: "unknown", value: null, reason: local.reason },
    notes,
    room: roomJson(room),
  };
  return { lines, json, code: anyUnknown ? EXIT.ERROR : EXIT.OK };
}
