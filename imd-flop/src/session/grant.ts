/**
 * `session grant` (P5b, rules C9, C10 and C11): the call FlopSessionKeys.create_session for the owner to sign in his
 * own wallet, with caps derived exactly from the seat's own local caps. Nothing is signed or sent, and no file is
 * written. The local checks come first, so a bad argument or cap never reaches the node; then the genesis, the read,
 * the runtime and the state.
 */
import { describeOwnerCall } from "../chain/describe.js";
import { encodeOwnerCall } from "../chain/owner-calls.js";
import type { SessionRecord } from "../chain-read/session-state.js";
import { CliError, EXIT } from "../errors.js";
import { deviceOf, ownerOf } from "./accounts.js";
import { checkDaysAgainstRuntime, daysOf, grantCaps, localRaw, type GrantCaps } from "./caps.js";
import { holdGenesis, requireEncoderRuntime, stateOf, transportOf } from "./chain.js";
import type { SessionContext } from "./context.js";
import { CHANNEL_PALLET } from "./room.js";
import { storedName } from "./stored.js";
import { amountText, callHash, headOf, hexOf, SIGNING_LINE, type Output } from "./words.js";

/** The line of C10: a stored record that does not stop the grant. */
export const STORED_RECORD_LINE = "Whether the chain takes a new grant over a stored record for this owner and device is not shown yet.";

/** What a stored record means for a new grant (C10): active refuses; revoked or past its expiry is a line. The name is stored.ts's. */
function storedNote(s: SessionRecord, head: number): string | null {
  const name = storedName(s, head);
  if (name === "an active session") {
    throw new CliError(`a session for this owner and device is stored and active until block ${s.expires_at}: the chain would refuse a second one (SessionAlreadyExists). Revoke it first with \`imd-flop session revoke --owner <ss58>\`. No call printed`, EXIT.REFUSED_RULE);
  }
  return `A record is stored for this pair, ${name === "a session past its expiry" ? `past its expiry at block ${s.expires_at}` : "revoked"}. ${STORED_RECORD_LINE}`;
}

/** The one plain sentence of what the grant allows in all (C11). Blocks and epochs, never hours: the tool holds no block time. */
function allowsSentence(c: GrantCaps, days: number, epochLength: number): string {
  return (
    `This grant lets the device spend at most ${amountText(c.spending_cap)} over the whole session, ` +
    `at most ${amountText(c.daily_cap)} per epoch, and at most ${amountText(c.per_tx_limit)} per call, ` +
    `through ${CHANNEL_PALLET} calls only, for ${c.duration_blocks} blocks, which is ${days} ${days === 1 ? "epoch" : "epochs"} of the runtime's epoch length of ${epochLength} blocks.`
  );
}

export async function grant(ctx: SessionContext): Promise<Output> {
  const device = deviceOf(ctx.home, ctx.seat, ctx.net);
  const owner = ownerOf(ctx.owner, ctx.net, device);
  const days = daysOf(ctx.days);
  const local = localRaw(ctx.caps, ctx.seat);
  const t = transportOf(ctx.net, ctx.transport);
  await holdGenesis(t, ctx.net);
  const state = await stateOf(t, owner, device);
  const rt = requireEncoderRuntime(state, ctx.net);
  checkDaysAgainstRuntime(days, rt.constants.sessionEpochLength, rt.constants.maxSessionDuration);
  if (state.session.kind === "unknown") throw new CliError(`the stored session is unknown, so whether a grant can land is not known: ${state.session.reason}. No call printed`, EXIT.ERROR);
  const note = state.session.kind === "known" ? storedNote(state.session.value, state.number) : null;
  const epochLength = rt.constants.sessionEpochLength;
  const caps = grantCaps(local, days, epochLength);
  const bytes = encodeOwnerCall({ runtime: rt.id, call: "create_session", delegate: device.pub, ...caps });
  const callHex = hexOf(bytes);
  const hash = callHash(bytes);
  const words = describeOwnerCall(rt.id, bytes);
  const allows = allowsSentence(caps, days, epochLength);
  const head = headOf(ctx.seat, ctx.net, owner, device, state);
  const lines = [...head.lines, `  call    ${callHex}`, `  blake2b 256 of the call  ${hash}`, `  ${words}`, allows, ...(note === null ? [] : [note]), SIGNING_LINE];
  const json = {
    ...head.json,
    call: "create_session",
    call_hex: callHex,
    call_blake2b_256: hash,
    words,
    allows,
    caps: { spending_cap: String(caps.spending_cap), per_tx_limit: String(caps.per_tx_limit), daily_cap: String(caps.daily_cap), duration_blocks: caps.duration_blocks, days, epoch_length: epochLength },
    stored_record: note,
    signing: SIGNING_LINE,
  };
  return { lines, json, code: EXIT.OK };
}
