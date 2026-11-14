/**
 * The refusals of the part of the miner client that talks (P6b): the endpoint, the one HTTP file and the order of a
 * run. They are apart from the refusals of the miner's words (errors.ts), whose words say "miner answer refused":
 * an endpoint, a call that failed or a step out of order is not an answer of the miner.
 *
 * A message names the call or the step and what failed, with the status as a number where there is one. It never
 * carries a body, a header value, the endpoint's text, a prompt, an output, a signature or a key (T7, R7).
 */
import { CliError, EXIT } from "../errors.js";
import { freezeFunction } from "../freeze.js";

export const CLIENT_REFUSAL = Object.freeze({
  /** The endpoint text is not an origin this client speaks to (E1, E2). Exit 5. */
  ENDPOINT: "ENDPOINT",
  /** A call gave no answer this client reads: the transport failed, a time limit passed, a redirect, a size, a type or an encoding (T1 to T8). */
  HTTP: "HTTP",
  /** An answer was read, and its status or its challenge header is not the one the step wants. */
  ANSWER: "ANSWER",
  /** A request handed to the transport is not of its form (a call, a body, signed headers, limits). Nothing was sent. */
  REQUEST: "REQUEST",
  /** A step out of its order, a step after a failure, or a step while another is running (R2). Nothing was sent. */
  ORDER: "ORDER",
  /** The channel key, the clock or the random source handed in failed. What it threw is not kept. */
  FAILED: "FAILED",
} as const);

export type ClientRefusalCode = (typeof CLIENT_REFUSAL)[keyof typeof CLIENT_REFUSAL];

export class MinerClientError extends CliError {
  constructor(
    readonly refusal: ClientRefusalCode,
    /** The name of the check that failed, a fixed text of this package. */
    readonly check: string,
    message: string,
    code: number,
  ) {
    super(`miner client refused (${refusal}, ${check}): ${message}`, code);
  }
}
freezeFunction(MinerClientError);

/** Throws a refusal of the client. */
export function refuseClient(refusal: ClientRefusalCode, check: string, message: string, code: number): never {
  throw new MinerClientError(refusal, check, message, code);
}
freezeFunction(refuseClient);

/**
 * The exit code of a call that gave no answer this client reads (R5, M-15): 11 (`NOT_SENT`) for the info proof,
 * which comes before anything is funded; 1 for every other call, which comes after the channel was opened.
 */
export function httpExit(call: string): number {
  return call === "proof" ? EXIT.NOT_SENT : EXIT.ERROR;
}
freezeFunction(httpExit);

/**
 * The exit code of an answer whose status or challenge is not the one its step wants (R5, and the lead's ruling of
 * P6b): 5 (`REFUSED_RULE`) for the info proof, a refusal by rule before anything is funded; 1 for every other call.
 */
export function answerExit(call: string): number {
  return call === "proof" ? EXIT.REFUSED_RULE : EXIT.ERROR;
}
freezeFunction(answerExit);

/** Throws an endpoint refusal (E3: exit 5). */
export function refuseEndpoint(check: string, message: string): never {
  throw new MinerClientError("ENDPOINT", `endpoint.${check}`, message, EXIT.REFUSED_RULE);
}
freezeFunction(refuseEndpoint);
