/**
 * The shape of the reviewed runtime table (rule E2) and the one lookup into it. The table itself is
 * runtimes.ts, written by scripts/chain-table.mjs from recorded metadata; nothing in it is typed by hand.
 * A runtime is found only by all four of its names: spec name, spec version, transaction version and genesis.
 */
import { refuse } from "./errors.js";
import { RUNTIMES } from "./runtimes.js";

/** A type as the encoder writes it, reduced from the metadata's type registry by the script. */
export type Ty =
  | { readonly kind: "u32" | "u64" | "u128" }
  | { readonly kind: "bytes32" }
  | { readonly kind: "enum"; readonly variants: readonly { readonly name: string; readonly index: number }[] }
  | { readonly kind: "struct"; readonly fields: readonly Field[] }
  | { readonly kind: "compact"; readonly of: "u32" | "u64" | "u128" }
  | { readonly kind: "unit" }
  | { readonly kind: "era" }
  | { readonly kind: "option"; readonly of: Ty }
  | { readonly kind: "call" };

export interface Field {
  readonly name: string;
  readonly type: Ty;
}

export interface CallEntry {
  readonly pallet: string;
  readonly name: string;
  /** The pallet's variant index in RuntimeCall. */
  readonly palletIndex: number;
  /** The call's variant index in the pallet's Call. */
  readonly callIndex: number;
  readonly fields: readonly Field[];
}

export interface SignedExtension {
  readonly identifier: string;
  /** What the extension adds to the extrinsic. */
  readonly extra: Ty;
  /** What it adds to the signed payload only. */
  readonly additionalSigned: Ty;
}

export interface Runtime {
  readonly specName: string;
  readonly specVersion: number;
  readonly transactionVersion: number;
  /** 0x and 64 lower case hex digits. */
  readonly genesisHash: string;
  readonly metadataSha256: string;
  readonly extrinsicVersion: number;
  readonly address: { readonly variant: string; readonly index: number };
  readonly signature: { readonly variant: string; readonly index: number };
  readonly signedExtensions: readonly SignedExtension[];
  readonly calls: readonly CallEntry[];
}

/** The four names a caller reads from the chain and the encoder finds a runtime by. */
export interface RuntimeId {
  readonly specName: string;
  readonly specVersion: number;
  readonly transactionVersion: number;
  /** 0x and 64 lower case hex digits. */
  readonly genesisHash: string;
}

const TABLE: readonly Runtime[] = RUNTIMES;

/**
 * The table's runtime with exactly these four names, or a RUNTIME_UNKNOWN refusal. Each name is read once.
 * The entry returned is the frozen one of runtimes.ts, never an object of the caller's.
 */
export function runtimeFor(id: RuntimeId): Runtime {
  const ok = id !== null && typeof id === "object";
  const specName: unknown = ok ? id.specName : undefined;
  const specVersion: unknown = ok ? id.specVersion : undefined;
  const transactionVersion: unknown = ok ? id.transactionVersion : undefined;
  const genesisHash: unknown = ok ? id.genesisHash : undefined;
  const found = TABLE.find((r) => r.specName === specName && r.specVersion === specVersion && r.transactionVersion === transactionVersion && r.genesisHash === genesisHash);
  if (!found) refuse("RUNTIME_UNKNOWN", `no reviewed runtime is ${JSON.stringify({ specName, specVersion, transactionVersion, genesisHash }, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
  return found;
}
