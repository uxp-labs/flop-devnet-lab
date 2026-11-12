// The one way real chain data is decoded (RULES.md section 9): a block's System.Events, and the
// value of a storage entry at a block, decoded only when the shape pin (src/scale/shape.ts) says the
// block's spec, metadata and shape are the reviewed ones. Pure: no file, network, clock or random
// access.
import { type Decoded, decodeValue } from "./decode.js";
import { type BlockEvent, decodeEvents } from "./events.js";
import { ScaleError, toHex } from "./reader.js";
import { type PinInput, type ReviewedShape, STATED_ENTRIES, copyBytes, copyPinInput, pinShape } from "./shape.js";
import { storageEntryOf, storageKey } from "./storage-key.js";

export type BlockEvents = { decoded: true; reviewed: ReviewedShape; events: BlockEvent[] } | { decoded: false; refused: string };

/** The events of one block, or the reason they were not decoded: the pin's refusal, or the decoder's. */
export function decodeBlockEvents(input: PinInput & { events: Uint8Array }): BlockEvents {
  // Each field read once and each byte array copied, before anything is hashed or parsed.
  let pinInput: PinInput;
  let events: Uint8Array;
  try {
    pinInput = copyPinInput(input);
    events = copyBytes(input.events, "the events");
  } catch (e) {
    if (e instanceof ScaleError) return { decoded: false, refused: `not decoded: ${e.message}` };
    throw e;
  }
  const pin = pinShape(pinInput);
  if (!pin.pinned) return { decoded: false, refused: `not decoded: ${pin.refused}` };
  try {
    return { decoded: true, reviewed: pin.reviewed, events: decodeEvents(pin.metadata, events) };
  } catch (e) {
    if (e instanceof ScaleError) return { decoded: false, refused: `System.Events: ${e.message}` };
    throw e;
  }
}

/** One storage read at a block: the pin input, the entry, its key parts, the key asked and the answer. */
export interface StorageRead extends PinInput {
  pallet: string;
  entry: string;
  /** The SCALE bytes of each map key part, in key order; none for a plain entry. */
  keys: readonly Uint8Array[];
  /** The storage key the node was asked, as the tape holds it. */
  key: Uint8Array;
  /** The bytes the node answered, or null when it holds no value under the key. */
  answer: Uint8Array | null;
}

/**
 * A storage value, or the reason it was not decoded. stored is true only when the node answered
 * bytes. When it answered null, an Optional entry is null and a Default entry is the default the
 * metadata states for it, and stored is false either way, so a default is never taken for a value
 * the chain holds.
 */
export type StorageValue = { decoded: true; reviewed: ReviewedShape; stored: boolean; value: Decoded } | { decoded: false; refused: string };

/** Each field of the read taken once, the byte arrays copied, or a refusal. */
function copyRead(input: StorageRead): { pin: PinInput; pallet: string; entry: string; keys: Uint8Array[]; key: Uint8Array; answer: Uint8Array | null } {
  const pin = copyPinInput(input);
  const pallet = input.pallet;
  const entry = input.entry;
  const keys = input.keys;
  const key = input.key;
  const answer = input.answer;
  if (typeof pallet !== "string" || typeof entry !== "string") throw new ScaleError("the pallet and the entry must be strings");
  if (!Array.isArray(keys)) throw new ScaleError("the key parts are not a list");
  return {
    pin,
    pallet,
    entry,
    keys: Array.from(keys, (k, i) => copyBytes(k, `key part ${i}`)),
    key: copyBytes(key, "the storage key"),
    answer: answer === null ? null : copyBytes(answer, "the answer"),
  };
}

/**
 * The value of a storage entry the reviewed shape states, at a pinned block. Refused when the
 * entry is not one the shape states, when the block is not pinned, when the key asked is not the
 * key the entry and key parts give (so a value is never read under another entry or account), or
 * when the answer is not one whole value of the entry's type.
 */
export function decodeStorageValue(input: StorageRead): StorageValue {
  let r: ReturnType<typeof copyRead>;
  try {
    r = copyRead(input);
  } catch (e) {
    if (e instanceof ScaleError) return { decoded: false, refused: `not decoded: ${e.message}` };
    throw e;
  }
  const name = `${JSON.stringify(r.pallet)}.${JSON.stringify(r.entry)}`;
  if (!STATED_ENTRIES.some(([p, e]) => p === r.pallet && e === r.entry)) return { decoded: false, refused: `not decoded: ${name} is not a storage entry the reviewed shape states` };
  const pin = pinShape(r.pin);
  if (!pin.pinned) return { decoded: false, refused: `not decoded: ${pin.refused}` };
  const md = pin.metadata;
  try {
    const built = toHex(storageKey(md, r.pallet, r.entry, r.keys));
    if (built !== toHex(r.key)) return { decoded: false, refused: `${r.pallet}.${r.entry}: the key asked is not the key of this entry and these key parts` };
    const e = storageEntryOf(md, r.pallet, r.entry).entry;
    if (r.answer !== null) return { decoded: true, reviewed: pin.reviewed, stored: true, value: decodeValue(md, e.value, r.answer) };
    if (e.modifier === "Optional") return { decoded: true, reviewed: pin.reviewed, stored: false, value: null };
    return { decoded: true, reviewed: pin.reviewed, stored: false, value: decodeValue(md, e.value, e.fallback) };
  } catch (e) {
    if (e instanceof ScaleError) return { decoded: false, refused: `${r.pallet}.${r.entry}: ${e.message}` };
    throw e;
  }
}
