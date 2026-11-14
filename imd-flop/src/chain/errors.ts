/**
 * The refusals of the chain encoder and its strict reader (rule E10). The encoder throws each one before
 * any signature, except the two of the signer: SIGNATURE_INVALID, the check of what it gave, and
 * SIGNER_THREW (rule H4). Nothing is returned then.
 */
import { CliError, EXIT } from "../errors.js";
import { freezeFunction } from "../freeze.js";

export const CHAIN_REFUSAL = Object.freeze({
  /** The runtime named is not in the reviewed table, or its table entry has a shape this encoder does not write. */
  RUNTIME_UNKNOWN: "RUNTIME_UNKNOWN",
  /** A byte value of the wrong length: a 32 byte field, a public key, a block hash, a signature. */
  WRONG_LENGTH: "WRONG_LENGTH",
  /** A number out of the range of its type: u32, u64, u128, a block number. */
  OUT_OF_RANGE: "OUT_OF_RANGE",
  /** An enum given by a name its type in the table does not have. */
  ENUM_UNKNOWN: "ENUM_UNKNOWN",
  /** An inner call that is not one of the five, or call bytes of a call the reader does not know. */
  CALL_NOT_ALLOWED: "CALL_NOT_ALLOWED",
  /** A value of the wrong kind or a field missing or extra: a number for an amount, free bytes, an unknown key. */
  BAD_INPUT: "BAD_INPUT",
  /** Call bytes that end early or have bytes left over. */
  BAD_BYTES: "BAD_BYTES",
  /** Call bytes whose declared spend is not what the inner call moves. */
  SPEND_MISMATCH: "SPEND_MISMATCH",
  /** The call bytes the encoder wrote do not read back to its snapshot of the input, field by field. */
  READ_BACK: "READ_BACK",
  /** The signature the sign function gave does not verify against the public key and the payload. */
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  /** The sign function threw. Nothing of the thrown value is kept: not its text, not its class, not the value as a cause. */
  SIGNER_THREW: "SIGNER_THREW",
} as const);

export type ChainRefusalCode = (typeof CHAIN_REFUSAL)[keyof typeof CHAIN_REFUSAL];

export class ChainEncodeError extends CliError {
  constructor(
    readonly refusal: ChainRefusalCode,
    message: string,
  ) {
    super(`chain encoder refused (${refusal}): ${message}`, EXIT.REFUSED_RULE);
  }
}
freezeFunction(ChainEncodeError);

export function refuse(refusal: ChainRefusalCode, message: string): never {
  throw new ChainEncodeError(refusal, message);
}
freezeFunction(refuse);
