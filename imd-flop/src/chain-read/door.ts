/**
 * The observatory's decoder, reached through its one door (P2, rules A4 and C3). This is the only file of imd-flop
 * that imports the observatory, and it imports only flop-observatory/scale/block. It takes bytes and returns what
 * the door said; a refusal of the door is unknown, with the door's own words. Pure: the shape file's text is handed
 * in (shape-file.ts reads it).
 */
import { type BlockEvents, type StorageValue, decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "flop-observatory/scale/block";
import { type Got, type Stored, absent, known, unknown } from "./result.js";

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

/** The value of a stored entry; absent when the node answered no bytes, whatever default the metadata states. */
export function valueOf(pin: Pin, read: EntryRead): Stored<DoorValue> {
  const v = decodeStorageValue({ ...pinInput(pin), pallet: read.pallet, entry: read.entry, keys: read.keys, key: read.key, answer: read.answer });
  if (!v.decoded) return unknown(`the decoder: ${v.refused}`);
  return v.stored ? known(v.value) : absent();
}
