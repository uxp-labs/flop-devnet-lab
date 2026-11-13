/**
 * What every function of chain-read answers (P2, rule C1). Unknown is a value: it carries the reason and is never
 * 0, never absent and never a default. Absent says the chain holds no value under a key: it is known, and it is
 * not unknown. Nothing in chain-read throws for what a chain or a node said. Pure.
 */

export interface Known<T> {
  readonly kind: "known";
  readonly value: T;
}

export interface Unknown {
  readonly kind: "unknown";
  readonly reason: string;
}

/** The chain holds no value under the key: known, and not unknown. */
export interface Absent {
  readonly kind: "absent";
}

/** A value that is either known or unknown. */
export type Got<T> = Known<T> | Unknown;

/** A stored entry: its value, absent, or unknown. */
export type Stored<T> = Known<T> | Absent | Unknown;

export const known = <T>(value: T): Known<T> => ({ kind: "known", value });
export const unknown = (reason: string): Unknown => ({ kind: "unknown", reason });
export const absent = (): Absent => ({ kind: "absent" });

/** An unknown with a step's name put before its reason. */
export const within = (step: string, u: Unknown): Unknown => unknown(`${step}: ${u.reason}`);
