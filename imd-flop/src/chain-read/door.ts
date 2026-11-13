/**
 * The observatory's decoder, reached through its one door (P2, rules A4 and C3). This is the only file of imd-flop
 * that imports the observatory, and it imports only flop-observatory/scale/block. It takes bytes and returns what
 * the door said; a refusal of the door is unknown, with the door's own words. Pure: the shape file's text is handed
 * in (shape-file.ts reads it).
 */
import { type BlockEvents, type StorageValue, decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "flop-observatory/scale/block";
import { type Got, known, unknown } from "./result.js";

/** A runtime on the decoder's reviewed list, as the door names it (C7). */
export interface Runtime {
  readonly specName: string;
  readonly specVersion: number;
  /** The shape file the reviewed line names, by its path in the observatory package. */
  readonly shapeFile: string;
}

/** One event of a block, as the door decoded it. */
export type DoorEvent = Extract<BlockEvents, { decoded: true }>["events"][number];

/** A decoded value, as the door gives it: JSON safe, wide integers as decimal text, bytes as hex. */
export type DoorValue = Extract<StorageValue, { decoded: true }>["value"];

/** What the door needs to pin a block: its runtime, the metadata of that runtime, the block's LastRuntimeUpgrade and the shape file's text. */
export interface Pin {
  readonly runtime: Runtime;
  readonly metadata: Uint8Array;
  readonly lastRuntimeUpgrade: Uint8Array;
  readonly shapeText: string;
}

/** The runtime that executed a block, from the bytes of System.LastRuntimeUpgrade at that block and nothing else. */
export function runtimeOf(lastRuntimeUpgrade: Uint8Array): Got<Runtime> {
  const r = runtimeOfBlock(lastRuntimeUpgrade);
  if (!r.found) return unknown(`the decoder: ${r.refused}`);
  return known({ specName: r.reviewed.specName, specVersion: r.reviewed.specVersion, shapeFile: r.reviewed.shapeFile });
}

const pinInput = (p: Pin) => ({ specName: p.runtime.specName, specVersion: p.runtime.specVersion, metadata: p.metadata, lastRuntimeUpgrade: p.lastRuntimeUpgrade, shapeText: p.shapeText });

/** The events of a block. */
export function eventsOf(pin: Pin, events: Uint8Array): Got<readonly DoorEvent[]> {
  const d = decodeBlockEvents({ ...pinInput(pin), events });
  if (!d.decoded) return unknown(`the decoder: ${d.refused}`);
  return known(d.events);
}

/** One storage read at a block: the entry, the SCALE bytes of each key part, the key asked and what the node answered. */
export interface EntryRead {
  readonly pallet: string;
  readonly entry: string;
  readonly keys: readonly Uint8Array[];
  readonly key: Uint8Array;
  readonly answer: Uint8Array | null;
}

/** What the door said of an entry: whether the node answered bytes, and the value (for no bytes, null or the metadata's default). */
export interface DoorEntry {
  readonly stored: boolean;
  readonly value: DoorValue;
}

/** The value of a storage entry, as the door gives it. Absent or default is the caller's to say, by the entry's modifier. */
export function valueOf(pin: Pin, read: EntryRead): Got<DoorEntry> {
  const v = decodeStorageValue({ ...pinInput(pin), pallet: read.pallet, entry: read.entry, keys: read.keys, key: read.key, answer: read.answer });
  if (!v.decoded) return unknown(`the decoder: ${v.refused}`);
  return known({ stored: v.stored, value: v.value });
}

/** Where System.LastRuntimeUpgrade is stored: its pallet and entry, and its key from the key table. */
export interface LastRuntimeUpgradeAt {
  readonly pallet: string;
  readonly entry: string;
  readonly key: Uint8Array;
}

/**
 * The pin, proven through the door before it is used (the P2 fix round, rule X9, decision S31). The block's
 * LastRuntimeUpgrade bytes are decoded as a stored value with this pin, no key parts, the key from the key table and
 * the answer the bytes already read. The door then checks the metadata against the reviewed line, the shape file's
 * text and the key; a refusal is unknown with the door's words. The decoded record must name the spec name and spec
 * version runtimeOf named. So no runtime is stated for a pin the door did not accept.
 */
export function provenPin(pin: Pin, at: LastRuntimeUpgradeAt): Got<Pin> {
  const v = valueOf(pin, { pallet: at.pallet, entry: at.entry, keys: [], key: at.key, answer: pin.lastRuntimeUpgrade });
  if (v.kind === "unknown") return v;
  const r = v.value.value;
  if (!v.value.stored || r === null || typeof r !== "object" || Array.isArray(r)) return unknown(`${at.pallet}.${at.entry}: the door's value is not a stored record`);
  const named = r as Record<string, DoorValue>;
  if (named.spec_name !== pin.runtime.specName || named.spec_version !== pin.runtime.specVersion) {
    return unknown(`${at.pallet}.${at.entry}: the door reads spec ${JSON.stringify(named.spec_name)} ${JSON.stringify(named.spec_version)}, not the spec ${JSON.stringify(pin.runtime.specName)} ${pin.runtime.specVersion} the block's runtime named`);
  }
  return known(pin);
}
