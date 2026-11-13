/**
 * The shape of chain-read's frozen table (key-table.ts, written by scripts/read-key-table.mjs). Pure.
 */

/** A type as session-state.ts reads it, reduced from the shape file by the script. */
export type FieldType =
  | { readonly kind: "u8" | "u16" | "u32" | "u64" | "u128" | "bool" }
  | { readonly kind: "bytes"; readonly length?: number }
  | { readonly kind: "list"; readonly of: FieldType }
  | { readonly kind: "record"; readonly fields: readonly RecordField[] };

export interface RecordField {
  readonly name: string;
  readonly type: FieldType;
}

/** One storage entry: the two fixed 16 byte parts of its key, and the hasher of each account part, by the shape's names. */
export interface EntryLine {
  readonly pallet: string;
  readonly entry: string;
  readonly palletPart: string;
  readonly entryPart: string;
  readonly hashers: readonly string[];
}

export interface RuntimeLine {
  readonly specName: string;
  readonly specVersion: number;
  readonly shapeFile: string;
  readonly metadataSha256: string;
  readonly entries: { readonly sessions: EntryLine; readonly session_nonces: EntryLine; readonly circuit_breakers: EntryLine };
  readonly records: { readonly session: readonly RecordField[]; readonly circuitBreaker: readonly RecordField[]; readonly sessionNonce: FieldType };
  /** The cross check (C5): the event, the fields that name the session, and the totals each paired with the stored field of the same name. */
  readonly crossCheck: { readonly pallet: string; readonly event: string; readonly keys: readonly string[]; readonly totals: readonly string[] };
}

export interface KeyTable {
  readonly system: { readonly events: EntryLine; readonly last_runtime_upgrade: EntryLine };
  readonly runtimes: readonly RuntimeLine[];
}
