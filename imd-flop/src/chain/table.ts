/**
 * The shape of the reviewed runtime table (rule E2) and the one lookup into it. The table itself is
 * runtimes.ts, written by scripts/chain-table.mjs from recorded metadata; nothing in it is typed by hand.
 * A runtime is found only by all four of its names: spec name, spec version, transaction version and genesis.
 * runtimeIdOf gives those four names from three of them (P5a, O12).
 */
import { refuse } from "./errors.js";
import { ownKeys, ownValue } from "./fields.js";
import { RUNTIMES } from "./runtimes.js";
import { freezeFunction } from "../freeze.js";

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
  | { readonly kind: "call" }
  /** A list of byte strings, Vec<Vec<u8>>: only the allow list of create_session has it (P5a, O4). */
  | { readonly kind: "bytesList" };

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

/** A constant of a pallet, read from the metadata's constants by the script (P5a, O3). Only u32 constants. */
export interface Constant {
  readonly pallet: string;
  readonly name: string;
  readonly type: Ty;
  readonly value: number;
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
  readonly constants: readonly Constant[];
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
 * The table's runtime with exactly these four names, or a RUNTIME_UNKNOWN refusal. Each name is read once as an
 * own value: an accessor on one is refused (BAD_INPUT), and a Proxy's get trap is not used. A name the id does not
 * have as an own field reads as undefined, so no runtime is found. Other fields of the id are allowed and never
 * read, so a whole entry of the table is an id too. The entry returned is the frozen one of runtimes.ts, never an
 * object of the caller's.
 */
export function runtimeFor(id: RuntimeId): Runtime {
  const ok = id !== null && typeof id === "object";
  const keys = ok ? ownKeys(id) : [];
  const name = (n: string): unknown => (keys.includes(n) ? ownValue(id, n, "the runtime id") : undefined);
  const specName = name("specName");
  const specVersion = name("specVersion");
  const transactionVersion = name("transactionVersion");
  const genesisHash = name("genesisHash");
  const found = TABLE.find((r) => r.specName === specName && r.specVersion === specVersion && r.transactionVersion === transactionVersion && r.genesisHash === genesisHash);
  if (!found) refuse("RUNTIME_UNKNOWN", `no reviewed runtime is ${JSON.stringify({ specName, specVersion, transactionVersion, genesisHash }, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
  return found;
}
freezeFunction(runtimeFor);

/** The three names a caller reads from the chain to find a runtime's four (P5a, O12): no transaction version. */
export interface RuntimeNames {
  readonly specName: string;
  readonly specVersion: number;
  /** 0x and 64 lower case hex digits. */
  readonly genesisHash: string;
}

/**
 * The four names of the one table entry with these three (P5a, O12), or a RUNTIME_UNKNOWN refusal: none has them, or
 * more than one has them. The three are read as runtimeFor reads its four: each once as an own value, an accessor
 * refused (BAD_INPUT), a Proxy's get trap not used, a name the id does not have as an own field read as undefined,
 * other fields allowed and never read. The id returned is a new frozen object of the four names, never the caller's.
 */
export function runtimeIdOf(names: RuntimeNames): RuntimeId {
  const ok = names !== null && typeof names === "object";
  const keys = ok ? ownKeys(names) : [];
  const name = (n: string): unknown => (keys.includes(n) ? ownValue(names, n, "the runtime names") : undefined);
  const specName = name("specName");
  const specVersion = name("specVersion");
  const genesisHash = name("genesisHash");
  const found = TABLE.filter((r) => r.specName === specName && r.specVersion === specVersion && r.genesisHash === genesisHash);
  const shown = JSON.stringify({ specName, specVersion, genesisHash }, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  if (found.length === 0) refuse("RUNTIME_UNKNOWN", `no reviewed runtime is ${shown}`);
  if (found.length > 1) refuse("RUNTIME_UNKNOWN", `${found.length} reviewed runtimes are ${shown}: three names do not name one`);
  const [r] = found;
  return Object.freeze({ specName: r.specName, specVersion: r.specVersion, transactionVersion: r.transactionVersion, genesisHash: r.genesisHash });
}
freezeFunction(runtimeIdOf);
