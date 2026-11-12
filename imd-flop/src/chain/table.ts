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

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const TABLE: readonly Runtime[] = deepFreeze(RUNTIMES);

/** The reviewed runtime with exactly these four names, or a RUNTIME_UNKNOWN refusal. */
export function runtimeFor(id: RuntimeId): Runtime {
  const found = TABLE.find(
    (r) => r.specName === id?.specName && r.specVersion === id?.specVersion && r.transactionVersion === id?.transactionVersion && r.genesisHash === id?.genesisHash,
  );
  if (!found) refuse("RUNTIME_UNKNOWN", `no reviewed runtime is ${JSON.stringify(id)}`);
  return found;
}

/** The table's entry for a call, or a CALL_NOT_ALLOWED refusal. */
export function callEntry(rt: Runtime, pallet: string, name: string): CallEntry {
  const found = rt.calls.find((c) => c.pallet === pallet && c.name === name);
  if (!found) refuse("CALL_NOT_ALLOWED", `${pallet}.${name} is not in the table of ${rt.specName} ${rt.specVersion}`);
  return found;
}
