// The events of one block (RULES.md section 9): the value of System.Events, decoded by the type the
// parsed metadata states for that entry (src/scale/storage-key.ts finds it, src/scale/decode.ts
// decodes it), never by a layout written here. Pure: no file, network, clock or random access.
//
// Before any byte is read, the metadata must say what this module relies on, or the events are
// refused: System.Events is a plain entry whose value is a list of records with the fields phase,
// event and topics; the event field is an enum with one variant for each pallet that has events,
// named as that pallet and at its index, holding exactly that pallet's event type. Each decoded
// event then gets its pallet's name and index, its own name and variant index, its fields and its
// phase. The whole value must be read to its last byte. Every refusal is a ScaleError.
import { type Decoded, decodeValue } from "./decode.js";
import type { Metadata, Variant } from "./metadata.js";
import { ScaleError, withinSize } from "./reader.js";
import { storageEntryOf } from "./storage-key.js";

export interface BlockEvent {
  /** The place of the event in the block's list, from 0. */
  index: number;
  /** When it was deposited: { variant: "ApplyExtrinsic", fields: n }, "Finalization" or "Initialization". */
  phase: Decoded;
  pallet: string;
  palletIndex: number;
  event: string;
  eventIndex: number;
  /** The event's fields: an object when they are named (as in every event of the reviewed runtime). */
  fields: Decoded;
  topics: Decoded;
}

/** The layout the metadata gives System.Events: its value type and, per pallet, its event enum. */
interface EventsLayout {
  value: number;
  pallets: { name: string; index: number; events: Variant[] }[];
}

const RECORD_FIELDS = ["event", "phase", "topics"];

/** What the metadata says about System.Events, or a refusal saying which part is not as relied on. */
function layoutOf(md: Metadata): EventsLayout {
  const { entry } = storageEntryOf(md, "System", "Events");
  if (entry.key !== null) throw new ScaleError("System.Events is a map, not a plain entry");
  const list = md.types.at(entry.value)?.def;
  if (list?.kind !== "sequence") throw new ScaleError("System.Events is not a list");
  const record = md.types.at(list.type)?.def;
  const names = record?.kind === "composite" ? record.fields.map((f) => f.name ?? "").sort() : [];
  const exact = names.length === RECORD_FIELDS.length && names.every((n, i) => n === RECORD_FIELDS.at(i));
  if (record?.kind !== "composite" || !exact) {
    throw new ScaleError("an event record of System.Events does not have exactly the fields phase, event and topics");
  }
  const eventField = record.fields.find((f) => f.name === "event");
  const outer = eventField === undefined ? undefined : md.types.at(eventField.type)?.def;
  if (outer?.kind !== "variant") throw new ScaleError("the event of an event record is not an enum of pallets");
  const pallets = outer.variants.map((v) => {
    const p = md.pallets.find((x) => x.name === v.name);
    if (p === undefined) throw new ScaleError(`the event enum names ${JSON.stringify(v.name)}, which is no pallet`);
    if (p.index !== v.index) throw new ScaleError(`the event enum puts pallet ${p.name} at ${v.index}, and the pallet is at ${p.index}`);
    const only = v.fields.length === 1 ? v.fields.at(0) : undefined;
    if (only === undefined || only.name !== null || p.event === null || only.type !== p.event) {
      throw new ScaleError(`the event enum's variant ${p.name} does not hold exactly that pallet's event type`);
    }
    const events = md.types.at(p.event)?.def;
    if (events?.kind !== "variant") throw new ScaleError(`the events of pallet ${p.name} are not an enum`);
    return { name: p.name, index: p.index, events: events.variants };
  });
  return { value: entry.value, pallets };
}

/** A decoded enum value as its variant name and fields; the decoder gives every enum this form. */
function variantOf(v: Decoded | undefined, what: string): { name: string; fields: Decoded } {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v) || typeof v.variant !== "string" || v.fields === undefined) {
    throw new ScaleError(`${what} did not decode as an enum`);
  }
  return { name: v.variant, fields: v.fields };
}

/** The events in the bytes of System.Events, read with this metadata, to the last byte. */
export function decodeEvents(md: Metadata, bytes: Uint8Array): BlockEvent[] {
  withinSize(bytes, "System.Events");
  const layout = layoutOf(md);
  const all = decodeValue(md, layout.value, bytes);
  if (!Array.isArray(all)) throw new ScaleError("System.Events did not decode as a list");
  return all.map((record, index) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new ScaleError(`event ${index} did not decode as a record`);
    const outer = variantOf(record.event, `the event of record ${index}`);
    const inner = variantOf(outer.fields, `the pallet event of record ${index}`);
    // The decoder read both names from these enums, so each is found; a refusal here is a bug.
    const pallet = layout.pallets.find((p) => p.name === outer.name);
    const event = pallet?.events.find((e) => e.name === inner.name);
    if (pallet === undefined || event === undefined) throw new ScaleError(`record ${index} names ${outer.name}.${inner.name}, which the layout does not hold`);
    return {
      index,
      phase: record.phase ?? null,
      pallet: pallet.name,
      palletIndex: pallet.index,
      event: event.name,
      eventIndex: event.index,
      fields: inner.fields,
      topics: record.topics ?? null,
    };
  });
}
