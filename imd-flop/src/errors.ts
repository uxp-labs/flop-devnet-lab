/** Exit codes. Stable so scripts (and the imd worker, later) can branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  REFUSED_CAP: 3, // no cap, over per-call cap, or over the remaining daily / job budget
  REFUSED_LINK: 4, // seat-to-DID link missing or does not verify
  REFUSED_RULE: 5, // a section E rule (second key for a seat, secret scan, no job id, live gate) or a paid-run chain/genesis refusal
  TIMEOUT_UNKNOWN: 6, // call timed out: spend unknown, not retried
  ESTIMATE_FAILED: 7, // fail closed: no quote, no send
  VERIFY_FAILED: 8, // link verify found a bad signature or mismatch
  FAUCET_REFUSED: 9, // team rule: no faucets
  REFUSED_LOCK: 10, // ledger lock timeout before the paid call, or a refusal row that a lock error kept out of the ledger; nothing sent
  NOT_SENT: 11, // the provider failed before the paid request was sent (child-key mint, abort before send): nothing sent, nothing charged
} as const;

export class CliError extends Error {
  constructor(message: string, readonly code: number = EXIT.ERROR) {
    super(message);
  }
}
