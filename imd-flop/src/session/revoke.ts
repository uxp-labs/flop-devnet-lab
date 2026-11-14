/**
 * `session revoke` (P5b, rule C12): the call FlopSessionKeys.revoke_session for the owner to sign in his own wallet,
 * printed as grant prints its call, with one line of what is stored for the pair. It prints the call in each case.
 * Nothing is signed or sent, and no file is written.
 */
import { describeOwnerCall } from "../chain/describe.js";
import { encodeOwnerCall } from "../chain/owner-calls.js";
import { CliError, EXIT } from "../errors.js";
import { deviceOf, ownerOf } from "./accounts.js";
import { holdGenesis, requireEncoderRuntime, stateOf, transportOf } from "./chain.js";
import type { SessionContext } from "./context.js";
import { callHash, headOf, hexOf, SIGNING_LINE, type Output } from "./words.js";

/** What is stored for the pair, in the words of C12. */
export type StoredKind = "no session" | "an active session" | "a revoked session";

export async function revoke(ctx: SessionContext): Promise<Output> {
  if (ctx.days !== undefined) throw new CliError("--days is for `session grant` only", EXIT.USAGE);
  const device = deviceOf(ctx.home, ctx.seat, ctx.net);
  const owner = ownerOf(ctx.owner, ctx.net, device);
  const t = transportOf(ctx.net, ctx.transport);
  await holdGenesis(t, ctx.net);
  const state = await stateOf(t, owner, device);
  const rt = requireEncoderRuntime(state, ctx.net);
  if (state.session.kind === "unknown") throw new CliError(`the stored session is unknown: ${state.session.reason}. No call printed`, EXIT.ERROR);
  const stored: StoredKind = state.session.kind === "absent" ? "no session" : state.session.value.active ? "an active session" : "a revoked session";
  const bytes = encodeOwnerCall({ runtime: rt.id, call: "revoke_session", delegate: device.pub });
  const callHex = hexOf(bytes);
  const hash = callHash(bytes);
  const words = describeOwnerCall(rt.id, bytes);
  const head = headOf(ctx.seat, ctx.net, owner, device, state);
  const storedLine = `Stored for this owner and device: ${stored}.`;
  const lines = [...head.lines, `  call    ${callHex}`, `  blake2b 256 of the call  ${hash}`, `  ${words}`, storedLine, SIGNING_LINE];
  return { lines, json: { ...head.json, call: "revoke_session", call_hex: callHex, call_blake2b_256: hash, words, stored, signing: SIGNING_LINE }, code: EXIT.OK };
}
