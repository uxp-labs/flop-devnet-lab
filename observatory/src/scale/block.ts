// The one way real chain data is decoded (RULES.md section 9): a block's System.Events, and the
// value of a storage entry at a block, decoded only when the shape pin (src/scale/shape.ts) says the
// block's spec, metadata and shape are the reviewed ones. Pure: no file, network, clock or random
// access.
import { type Decoded, decodeValue } from "./decode.js";
import { type BlockEvent, decodeEvents } from "./events.js";
import type { StorageEntry } from "./metadata.js";
import { ScaleError } from "./reader.js";
import { MAX_NAME_INPUT, type PinInput, type ReviewedShape, STATED_ENTRIES, bytesLength, copyBytes, copyPinInput, inputObject, pinShape, readField } from "./shape.js";
import { storageEntryOf, storageKey } from "./storage-key.js";

export type BlockEvents = { decoded: true; reviewed: ReviewedShape; events: BlockEvent[] } | { decoded: false; refused: string };

/** The events of one block, or the reason they were not decoded: the pin's refusal, or the decoder's. */
export function decodeBlockEvents(input: PinInput & { events: Uint8Array }): BlockEvents {
  // Each field read once and each byte array copied, before anything is hashed or parsed.
  let pinInput: PinInput;
  let events: Uint8Array;
  try {
    const i = inputObject(input) as PinInput & { events: Uint8Array };
    pinInput = copyPinInput(i);
    events = copyBytes(readField(() => i.events, "the events"), "the events");
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

/** A refusal of the input, before or beside the decode. */
class InputRefusal extends ScaleError {}

/** The number of map key parts an entry takes: none for a plain entry, one a hasher for a map. */
const partsOf = (e: StorageEntry): number => (e.key === null ? 0 : e.hashers.length);

/**
 * The value of a storage entry the reviewed shape states, at a pinned block. In this order, each
 * field of the input read once and only when its step comes: the pallet and entry names, and an
 * entry the shape does not state is refused before any other field is read; then the pin; then the
 * key parts, as many as the entry takes, and the key asked, refused when it is not, byte for byte,
 * the key that entry and those parts give (so a value is never read under another entry or
 * account); then the answer, which must be bytes, one whole value of the entry's type, or null.
 */
export function decodeStorageValue(input: StorageRead): StorageValue {
  try {
    return door(input);
  } catch (e) {
    if (e instanceof ScaleError) return { decoded: false, refused: `not decoded: ${e.message}` };
    throw e;
  }
}

function door(input: StorageRead): StorageValue {
  const i = inputObject(input) as StorageRead;
  const pallet = readField(() => i.pallet, "the pallet");
  const entry = readField(() => i.entry, "the entry");
  if (typeof pallet !== "string" || typeof entry !== "string" || pallet.length > MAX_NAME_INPUT || entry.length > MAX_NAME_INPUT) {
    throw new InputRefusal(`the pallet and the entry must be strings of at most ${MAX_NAME_INPUT} characters`);
  }
  if (!STATED_ENTRIES.some(([p, e]) => p === pallet && e === entry)) throw new InputRefusal(`${JSON.stringify(pallet)}.${JSON.stringify(entry)} is not a storage entry the reviewed shape states`);
  const pin = pinShape(copyPinInput(i));
  if (!pin.pinned) throw new InputRefusal(pin.refused);
  const md = pin.metadata;
  const name = `${pallet}.${entry}`;
  const decoded = (stored: boolean, value: Decoded): StorageValue => ({ decoded: true, reviewed: pin.reviewed, stored, value });
  const fail = (why: string): StorageValue => ({ decoded: false, refused: `${name}: ${why}` });
  const e = storageEntryOf(md, pallet, entry).entry;
  // The key parts, by index, once the list says it holds exactly as many as the entry takes.
  const parts = partsOf(e);
  const list = readField(() => i.keys, "the key parts");
  if (!readField(() => Array.isArray(list), "the key parts")) throw new InputRefusal("the key parts are not a list");
  const count = readField(() => (list as readonly unknown[]).length, "the number of key parts");
  if (count !== parts) return fail(`storage ${name} takes ${parts} map keys, not ${Number.isSafeInteger(count) ? count : "a count"}`);
  const keys: Uint8Array[] = [];
  for (let k = 0; k < parts; k++) keys.push(copyBytes(readField(() => Array.prototype.at.call(list, k), `key part ${k}`), `key part ${k}`));
  let built: Uint8Array;
  try {
    built = storageKey(md, pallet, entry, keys);
  } catch (x) {
    if (x instanceof ScaleError) return fail(x.message);
    throw x;
  }
  // The key asked: its length first, before it is copied and never turned into text, then byte by byte.
  const rawKey = readField(() => i.key, "the storage key");
  const askedLength = bytesLength(rawKey, "the storage key");
  if (askedLength !== built.length) return fail(`the key asked is ${askedLength} bytes, ${askedLength > built.length ? "more" : "fewer"} than the ${built.length} of this entry and these key parts`);
  const asked = copyBytes(rawKey, "the storage key");
  for (let b = 0; b < built.length; b++) if (asked.at(b) !== built.at(b)) return fail("the key asked is not the key of this entry and these key parts");
  const raw = readField(() => i.answer, "the answer");
  const answer = raw === null ? null : copyBytes(raw, "the answer");
  try {
    if (answer !== null) return decoded(true, decodeValue(md, e.value, answer));
    if (e.modifier === "Optional") return decoded(false, null);
    return decoded(false, decodeValue(md, e.value, e.fallback));
  } catch (x) {
    if (x instanceof ScaleError) return fail(x.message);
    throw x;
  }
}
