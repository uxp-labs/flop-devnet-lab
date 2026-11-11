/** Exit codes. Stable, so a script can branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1, // an unexpected failure
  USAGE: 2, // bad arguments, or a file the command needs is missing or malformed
  REFUSED: 3, // the signer will not sign this: it does not match what the wallet's owner approved
} as const;

export class HireError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.ERROR,
  ) {
    super(message);
  }
}

export const usage = (message: string): HireError => new HireError(message, EXIT.USAGE);
export const refused = (reasons: readonly string[]): HireError => new HireError(`refused, nothing signed: ${reasons.join("; ")}`, EXIT.REFUSED);
