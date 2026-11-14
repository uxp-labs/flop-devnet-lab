/**
 * The refusals of the miner modules (P6a, rule W4). Each one is thrown before anything is returned. A message names
 * the check that failed and the form wanted. It never carries bytes, hex or text of the miner's answer or of any
 * input, whole or in part: the miner's answer is the miner's word, and the caller's input may hold a prompt.
 */
import { CliError, EXIT } from "../errors.js";
import { freezeFunction } from "../freeze.js";

export const MINER_REFUSAL = Object.freeze({
  /** The caller's own input is not of its form. */
  BAD_INPUT: "BAD_INPUT",
  /** An answer of the miner is not of its form. Exit 5 for the info proof, which comes before anything is funded. */
  WIRE: "WIRE",
  /** The info proof does not answer our challenge for what the owner pinned. Exit 5. */
  PROOF: "PROOF",
  /** The signed info does not name what the owner pinned. */
  INFO: "INFO",
  /** The turn receipt does not hold. */
  TURN: "TURN",
  /** The turn's cost is out of the lab's bounds. */
  MONEY: "MONEY",
  /** The receipt's payable is out of the lab's bounds. */
  RECEIPT: "RECEIPT",
} as const);

export type MinerRefusalCode = (typeof MINER_REFUSAL)[keyof typeof MINER_REFUSAL];

/** The answers of the miner a parser reads. Only the proof's form refusal is exit 5. */
export type MinerAnswer = "proof" | "info" | "turn" | "close";

export class MinerError extends CliError {
  constructor(
    readonly refusal: MinerRefusalCode,
    /** The name of the check that failed, a fixed text of this package. */
    readonly check: string,
    message: string,
    code: number,
  ) {
    super(`miner answer refused (${refusal}, ${check}): ${message}`, code);
  }
}
freezeFunction(MinerError);

/** The exit code of a refusal: 5 for the proof and its form, 1 for every other. */
function exitOf(refusal: MinerRefusalCode, answer: MinerAnswer | null): number {
  if (refusal === "PROOF") return EXIT.REFUSED_RULE;
  if (refusal === "WIRE" && answer === "proof") return EXIT.REFUSED_RULE;
  return EXIT.ERROR;
}

/** Throws a refusal that is not of the form of an answer. */
export function refuseMiner(refusal: Exclude<MinerRefusalCode, "WIRE">, check: string, message: string): never {
  throw new MinerError(refusal, check, message, exitOf(refusal, null));
}
freezeFunction(refuseMiner);

/** Throws the form refusal of one answer. */
export function refuseWire(answer: MinerAnswer, check: string, message: string): never {
  throw new MinerError("WIRE", check, message, exitOf("WIRE", answer));
}
freezeFunction(refuseWire);
