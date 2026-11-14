/**
 * The refusals of the channel modules (rules E1, E2). Each one is thrown before anything is returned. A message
 * names the field and the length or range found and wanted. It never carries bytes or hex of any input, whole or
 * in part.
 */
import { CliError, EXIT } from "../errors.js";

export const CHANNEL_REFUSAL = Object.freeze({
  /** A byte value of the wrong length: a 32 byte id, key or hash, a 16 byte nonce, a 64 byte signature, a seed. */
  WRONG_LENGTH: "WRONG_LENGTH",
  /** A number out of the range of its type: u32, u64, u128. */
  OUT_OF_RANGE: "OUT_OF_RANGE",
  /** A value of the wrong kind or a field missing or extra, an accessor, a method, path, body or challenge out of its form. */
  BAD_INPUT: "BAD_INPUT",
  /** The signature the library gave is not 64 bytes or does not verify under the key's own public key. */
  SELF_CHECK: "SELF_CHECK",
  /** The library threw while signing. The thrown value is kept as the refusal's cause; none of its text is in the message. */
  SIGN_FAILED: "SIGN_FAILED",
} as const);

export type ChannelRefusalCode = (typeof CHANNEL_REFUSAL)[keyof typeof CHANNEL_REFUSAL];

export class ChannelError extends CliError {
  constructor(
    readonly refusal: ChannelRefusalCode,
    message: string,
    cause?: unknown,
  ) {
    super(`channel key refused (${refusal}): ${message}`, EXIT.REFUSED_RULE);
    if (arguments.length > 2) Object.defineProperty(this, "cause", { value: cause, writable: false, enumerable: false, configurable: false });
  }
}

export function refuse(refusal: ChannelRefusalCode, message: string): never {
  throw new ChannelError(refusal, message);
}

/**
 * The class name of a thrown value, for a message: its constructor's own name when that is a plain identifier,
 * else its kind. No getter of the value is called and none of its text is read.
 */
export function className(e: unknown): string {
  if (e === null) return "null";
  if (typeof e !== "object" && typeof e !== "function") return typeof e;
  try {
    const proto: unknown = Object.getPrototypeOf(e);
    const ctor = proto === null || typeof proto !== "object" ? undefined : Object.getOwnPropertyDescriptor(proto, "constructor");
    const fn: unknown = ctor && "value" in ctor ? ctor.value : undefined;
    const nameD = typeof fn === "function" ? Object.getOwnPropertyDescriptor(fn, "name") : undefined;
    const name: unknown = nameD && "value" in nameD ? nameD.value : undefined;
    return typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : "object";
  } catch {
    return "object";
  }
}
