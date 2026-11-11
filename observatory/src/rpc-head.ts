// The raw RPC answers of one head reading, turned into the RpcHead the status reads. Pure.
//
// The answers, read at the finalized head, by its hash:
//   chain_getBlockHash(0)             the genesis hash
//   chain_getFinalizedHead()          the finalized head's hash, F
//   chain_getHeader(F)                the finalized header, for its number
//   chain_getHeader()                 the best header, for its number
//   state_getRuntimeVersion(F)        the runtime at F, for its specVersion
// An answer that failed on the way is a read error: it goes into the head's error, named by its
// call, and its field is null. An answer that came back but does not hold what it should is null
// too, with no error of its own, so status.ts judges it as it judges a saved head that left the
// field out or gave it a wrong type (RULES.md 1.1). The genesis is passed on as given when it is a
// string, so the status's own rules on its spelling apply, a conflict for a malformed one included.
// The finalized hash must be 0x plus 64 lower case hex to be read by at all; any other answer
// leaves the finalized head and the runtime version unread.
//
// After the head, a run that builds on a log reads one more answer, the anchor (RULES.md 1.1):
//   chain_getBlockHash(h)             the block hash at h, the latest finalized height logged
// It is kept as given, for status.ts to judge against the logged hash; a failure is its own error.
import { isSafeInt } from "./strict.js";
import { normalizeHash } from "./status.js";
import type { AnchorReading, RpcHead } from "./types.js";

/** One call's answer: its result, or why it failed on the way. */
export type Answer = { result: unknown } | { error: string };

export interface HeadAnswers {
  /** When the head was read, ISO 8601. */
  observedAt: string | null;
  genesis: Answer;
  finalizedHead: Answer;
  /** Not read (null) when the finalized head gave no valid hash to read it by. */
  finalizedHeader: Answer | null;
  bestHeader: Answer;
  /** Not read (null) when the finalized head gave no valid hash to read it at. */
  runtimeVersion: Answer | null;
}

/** The finalized head's hash, when its answer is one to read by: 0x plus 64 lower case hex. */
export function finalizedHashOf(a: Answer): string | null {
  return "result" in a ? normalizeHash(a.result) : null;
}

const HEX_NUMBER = /^0x[0-9a-fA-F]+$/;

/** A header's block number, written as 0x and hex digits, when it is a safe integer; else null. */
export function headerNumber(header: unknown): number | null {
  if (header === null || typeof header !== "object" || Array.isArray(header)) return null;
  const n = (header as { number?: unknown }).number;
  if (typeof n !== "string" || !HEX_NUMBER.test(n)) return null;
  const v = BigInt(n);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/** A runtime version's specVersion when it is a safe integer from 0; else null. */
export function specVersionOf(version: unknown): number | null {
  if (version === null || typeof version !== "object" || Array.isArray(version)) return null;
  const v = (version as { specVersion?: unknown }).specVersion;
  return isSafeInt(v) && v >= 0 ? v : null;
}

export function headFrom(a: HeadAnswers): RpcHead {
  const errors: string[] = [];
  const result = (name: string, x: Answer | null): unknown => {
    if (x === null) return null;
    if ("error" in x) {
      errors.push(`${name}: ${x.error}`);
      return null;
    }
    return x.result;
  };
  const genesis = result("chain_getBlockHash(0)", a.genesis);
  result("chain_getFinalizedHead()", a.finalizedHead);
  const finalizedHash = finalizedHashOf(a.finalizedHead);
  const finalizedNumber = headerNumber(result("chain_getHeader(finalized)", a.finalizedHeader));
  const bestNumber = headerNumber(result("chain_getHeader()", a.bestHeader));
  const spec = specVersionOf(result("state_getRuntimeVersion(finalized)", a.runtimeVersion));
  return {
    genesis_hash: typeof genesis === "string" ? genesis : null,
    finalized: finalizedHash !== null && finalizedNumber !== null ? { number: finalizedNumber, hash: finalizedHash } : null,
    best_number: bestNumber,
    runtime_spec_version: spec,
    observed_at: a.observedAt,
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

/** The anchor read back at height: the answer as given, or why it failed on the way. */
export function anchorFrom(height: number, a: Answer): AnchorReading {
  return "error" in a ? { height, hash: null, error: a.error } : { height, hash: a.result, error: null };
}
