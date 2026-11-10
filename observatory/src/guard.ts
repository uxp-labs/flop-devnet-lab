// Read-only guard. The observatory never signs, spends or writes.
//
// Every transport (the live RPC and HTTP readers in M1) must call these checks before it
// sends anything. A refused call is recorded, then thrown, so tests can prove that nothing
// tried to write. In tests, test/setup.ts also records any fetch or WebSocket attempt.

export type AttemptKind = "network" | "rpc-write" | "http-write" | "sign" | "spend";

export interface Attempt {
  kind: AttemptKind;
  what: string;
  at: string;
}

const attempts: Attempt[] = [];

export class ReadOnlyViolation extends Error {
  readonly attempt: Attempt;
  constructor(attempt: Attempt) {
    super(`read-only observatory refused ${attempt.kind}: ${attempt.what}`);
    this.name = "ReadOnlyViolation";
    this.attempt = attempt;
  }
}

export function recordAttempt(kind: AttemptKind, what: string): Attempt {
  const attempt = { kind, what, at: new Date().toISOString() };
  attempts.push(attempt);
  return attempt;
}

/** Every refused or blocked call since the last reset, oldest first. */
export function attemptLog(): readonly Attempt[] {
  return attempts.slice();
}

export function resetAttempts(): void {
  attempts.length = 0;
}

/** RPC methods the observatory may call. Anything else is refused and recorded. */
export const READ_ONLY_RPC_METHODS: ReadonlySet<string> = new Set([
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "chain_getBlock",
  "state_getRuntimeVersion",
  "state_getMetadata",
  "state_getStorage",
  "state_getKeysPaged",
  "state_queryStorageAt",
  "system_chain",
  "system_properties",
  "system_health",
  "rpc_methods",
]);

export function guardRpc(method: string): void {
  if (!READ_ONLY_RPC_METHODS.has(method)) {
    throw new ReadOnlyViolation(recordAttempt("rpc-write", `rpc ${method}`));
  }
}

/** Only GET and HEAD leave the observatory. The faucet's POST /fund and any gateway write are refused. */
export function guardHttp(method: string, url: string): void {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    throw new ReadOnlyViolation(recordAttempt("http-write", `${m} ${url}`));
  }
}

export function refuseSigning(what: string): never {
  throw new ReadOnlyViolation(recordAttempt("sign", what));
}

export function refuseSpend(what: string): never {
  throw new ReadOnlyViolation(recordAttempt("spend", what));
}
