/**
 * The refusals of the channel modules (rules E1, E2). Each one is thrown before anything is returned. A message
 * names the field and the length or range found and wanted. It never carries bytes or hex of any input, whole or
 * in part.
 */
import { CliError, EXIT } from "../errors.js";
import { freezeFunction } from "../freeze.js";

export const CHANNEL_REFUSAL = Object.freeze({
  /** A byte value of the wrong length: a 32 byte id, key or hash, a 16 byte nonce, a 64 byte signature, a seed. */
  WRONG_LENGTH: "WRONG_LENGTH",
  /** A number out of the range of its type: u32, u64, u128. */
  OUT_OF_RANGE: "OUT_OF_RANGE",
  /** A value of the wrong kind or a field missing or extra, an accessor, a method, path, body or challenge out of its form. */
  BAD_INPUT: "BAD_INPUT",
  /** The signature the library gave is not 64 bytes or does not verify under the key's own public key. */
  SELF_CHECK: "SELF_CHECK",
  /** The library threw while signing. Nothing of the thrown value is kept: no text, no class name, no cause. */
  SIGN_FAILED: "SIGN_FAILED",
} as const);

export type ChannelRefusalCode = (typeof CHANNEL_REFUSAL)[keyof typeof CHANNEL_REFUSAL];

export class ChannelError extends CliError {
  constructor(
    readonly refusal: ChannelRefusalCode,
    message: string,
  ) {
    super(`channel key refused (${refusal}): ${message}`, EXIT.REFUSED_RULE);
  }
}
freezeFunction(ChannelError);

export function refuse(refusal: ChannelRefusalCode, message: string): never {
  throw new ChannelError(refusal, message);
}
freezeFunction(refuse);
