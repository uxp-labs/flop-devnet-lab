/**
 * The observatory's sixth recording (observatory/fixtures/recording-20261114071524-9afba293ba8d1b2f) read for the
 * receipt vector: the two blocks where a compute channel settled cooperatively, each with its block, its events, its
 * runtime and the channel's record at the block and at its parent. Only committed files are read: the fixture's tape
 * and its frozen inputs, the upgrade recording's tape for the metadata, and the reviewed shape file.
 *
 * Every chain value goes through the lab's door (src/chain-read/door.ts): the runtime, the pin, the record and the
 * events. Two things are read beside the door, each said where it is done:
 *  - the sha256 of the metadata of the block's runtime, from the reviewed line runtimeOfBlock gives (the door's
 *    runtimeOf does not carry it), so the metadata is found on the tape that holds it by its sha256;
 *  - the settle call's arguments, two ways that must agree (decision R-6): the reference decoder (@polkadot-api, dev
 *    dependencies) over that metadata, and the call found by its pallet and call index from the shape file followed
 *    by the channel id, its fixed width fields read in the shape's order, each width from the shape's type.
 */
import { createHash } from "node:crypto";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { compact as refCompact, decAnyMetadata, extrinsicFormat, Tuple, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { runtimeOfBlock } from "flop-observatory/scale/block";
import { bytesOf, hexOf } from "../../src/chain-read/bytes.js";
import { type DoorEvent, type DoorValue, type Pin, eventsOf, provenPin, runtimeOf, valueOf } from "../../src/chain-read/door.js";
import { KEY_TABLE } from "../../src/chain-read/key-table.js";
import { eventsKey, lastRuntimeUpgradeKey } from "../../src/chain-read/keys.js";
import { shapeFileText } from "../../src/chain-read/shape-file.js";
import { UPGRADE_RECORDING, repoJson, tapeOf } from "./recorded-node.js";

export const SETTLE_RECORDING = "observatory/fixtures/recording-20261114071524-9afba293ba8d1b2f";
/** The fixture's own copy of the inputs its list was derived from. */
export const SETTLE_INPUTS_FILE = `${SETTLE_RECORDING}/requests-inputs.json`;

type Rec = Record<string, any>;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const INPUTS = repoJson(SETTLE_INPUTS_FILE) as { channels: Record<string, { value: string }>; blocks: Record<string, { hash: { value: string }; height: { value: number } }> };
const TAPE = tapeOf(SETTLE_RECORDING);

/** The channels whose settle the recording holds, in the order of its inputs. */
export const SETTLE_CHANNELS = Object.keys(INPUTS.channels);

const answerOf = (method: string, at: string): unknown => {
  const found = TAPE.filter((c) => c.method === method && (method === "chain_getBlock" ? c.params[0] : c.params[1]) === at);
  if (found.length !== 1) throw new Error(`${SETTLE_RECORDING} holds ${found.length} answers to ${method} at ${at}`);
  return found[0]?.result;
};

/** The one batch answer at a block: its values by key, and the keys asked in order. */
function batchAt(hash: string): { keys: string[]; values: Map<string, string | null> } {
  const c = TAPE.filter((x) => x.method === "state_queryStorageAt" && x.params[1] === hash);
  if (c.length !== 1) throw new Error(`${c.length} batches at ${hash}`);
  const sets = c[0]?.result as { block: string; changes: [string, string | null][] }[];
  if (sets.length !== 1 || sets[0]?.block !== hash) throw new Error(`the batch at ${hash} is not one set for that block`);
  return { keys: (c[0]?.params[0] as string[]).slice(), values: new Map(sets[0].changes) };
}

/** The metadata of a reviewed runtime, found on the upgrade recording's tape by the sha256 its reviewed line gives. */
function metadataOf(lastRuntimeUpgrade: Uint8Array): Uint8Array {
  const r = runtimeOfBlock(lastRuntimeUpgrade);
  if (!r.found) throw new Error(r.refused);
  const found = tapeOf(UPGRADE_RECORDING)
    .filter((c) => c.method === "state_getMetadata" && typeof c.result === "string")
    .map((c) => bytesOf(c.result as string))
    .filter((b) => sha256(b) === r.reviewed.metadataSha256);
  if (found.length < 1) throw new Error(`${UPGRADE_RECORDING} holds no metadata of sha256 ${r.reviewed.metadataSha256}`);
  return found[0] as Uint8Array;
}

const LRU = KEY_TABLE.system.last_runtime_upgrade;
const AT = { pallet: LRU.pallet, entry: LRU.entry, key: lastRuntimeUpgradeKey() };

/** A block read through the door: its proven pin, and the channel's record (and, at a settled block, its events). */
export interface DoorBlock {
  readonly height: number;
  readonly hash: string;
  readonly pin: Pin;
  readonly record: Rec;
  readonly recordStored: boolean;
}

function doorBlock(channelId: string, hash: string, height: number): DoorBlock {
  const batch = batchAt(hash);
  const lru = batch.values.get(hexOf(AT.key));
  if (typeof lru !== "string") throw new Error(`no LastRuntimeUpgrade at ${hash}`);
  const lastRuntimeUpgrade = bytesOf(lru);
  const runtime = runtimeOf(lastRuntimeUpgrade);
  if (runtime.kind !== "known") throw new Error(runtime.reason);
  const shapeText = shapeFileText(runtime.value.shapeFile);
  if (shapeText.kind !== "known") throw new Error(shapeText.reason);
  const pin = provenPin({ runtime: runtime.value, metadata: metadataOf(lastRuntimeUpgrade), lastRuntimeUpgrade, shapeText: shapeText.value }, AT);
  if (pin.kind !== "known") throw new Error(pin.reason);
  const others = batch.keys.filter((k) => k !== hexOf(AT.key) && k !== hexOf(eventsKey()));
  if (others.length !== 1 || !others[0]?.endsWith(channelId.slice(2))) throw new Error(`the batch at ${hash} does not read one record of ${channelId}`);
  const key = others[0];
  const v = valueOf(pin.value, { pallet: "ComputeChannel", entry: "Channels", keys: [bytesOf(channelId)], key: bytesOf(key), answer: batch.values.get(key) === null ? null : bytesOf(batch.values.get(key) as string) });
  if (v.kind !== "known") throw new Error(v.reason);
  return { height, hash, pin: pin.value, record: v.value.value as Rec, recordStored: v.value.stored };
}

/** One settle of the recording, read from committed files. */
export interface Settle {
  readonly channel: string;
  readonly channelId: string;
  readonly parent: DoorBlock;
  readonly settled: DoorBlock;
  readonly events: readonly DoorEvent[];
  readonly extrinsics: readonly string[];
  /** The reviewed shape file of the settled block's runtime, parsed. */
  readonly shape: Rec;
}

export function settleOf(channel: string): Settle {
  const channelId = INPUTS.channels[channel]?.value as string;
  const s = INPUTS.blocks[`${channel}/settled`];
  const p = INPUTS.blocks[`${channel}/settled-parent`];
  if (s === undefined || p === undefined) throw new Error(`the inputs name no blocks of ${channel}`);
  const settled = doorBlock(channelId, s.hash.value, s.height.value);
  const parent = doorBlock(channelId, p.hash.value, p.height.value);
  const events = bytesOf(batchAt(s.hash.value).values.get(hexOf(eventsKey())) as string);
  const e = eventsOf(settled.pin, events);
  if (e.kind !== "known") throw new Error(e.reason);
  const body = answerOf("chain_getBlock", s.hash.value) as { block: { extrinsics: string[] } };
  return { channel, channelId, parent, settled, events: e.value, extrinsics: body.block.extrinsics.slice(), shape: JSON.parse(settled.pin.shapeText) as Rec };
}

/** The ComputeChannel events of a settle that name its channel. */
export const channelEvents = (s: Settle, event: string) => s.events.filter((e) => e.pallet === "ComputeChannel" && e.event === event && (e.fields as Record<string, DoorValue>).channel_id === s.channelId);

// The shape: the settle call's indices, its fields and the width of a fixed width type.

/** The pallet index and the call index of ComputeChannel.settle, and the settle variant's fields, from the shape's types. */
export function settleCallOf(shape: Rec): { pallet: number; call: number; fields: { name: string; type: string }[] } {
  const types = shape.types as Record<string, Rec>;
  const outer = Object.values(types).filter((t) => t.kind === "variant" && Array.isArray(t.path) && t.path.at(-1) === "RuntimeCall");
  if (outer.length !== 1) throw new Error(`${outer.length} RuntimeCall types in the shape`);
  const pallet = (outer[0]?.variants as Rec[]).filter((v) => v.name === "ComputeChannel");
  if (pallet.length !== 1 || pallet[0]?.fields.length !== 1) throw new Error("the shape's RuntimeCall holds no one ComputeChannel variant of one field");
  const calls = ((types[pallet[0].fields[0].type] as Rec).variants as Rec[]).filter((v) => v.name === "settle");
  if (calls.length !== 1) throw new Error("the shape's ComputeChannel call holds no one settle");
  return { pallet: pallet[0].index, call: calls[0]?.index, fields: calls[0]?.fields };
}

/** The width in bytes of a fixed width type of the shape (an unsigned integer, a byte array, a composite of one), or null. */
export function widthOf(shape: Rec, type: string): number | null {
  const t = (shape.types as Record<string, Rec>)[type];
  if (t === undefined) return null;
  if (t.kind === "primitive") {
    const m = /^u(8|16|32|64|128)$/.exec(String(t.primitive));
    return m === null ? null : Number(m[1]) / 8;
  }
  if (t.kind === "array" && t.element === "u8" && Number.isSafeInteger(t.len)) return t.len;
  if (t.kind === "composite" && Array.isArray(t.fields) && t.fields.length === 1) return widthOf(shape, t.fields[0].type);
  return null;
}

/**
 * The settle call of a settle's channel, found in the block by the pallet and call index from the shape followed by
 * the channel id, exactly once in the block; then its leading fixed width fields in the shape's order, up to the
 * first field that is not of fixed width. Throws when the call is not found exactly once.
 */
export function settleByShape(s: Settle): { extrinsic: string; fields: Map<string, Uint8Array>; next: string | undefined } {
  const { pallet, call, fields } = settleCallOf(s.shape);
  const head = hexOf(Uint8Array.of(pallet, call, ...bytesOf(s.channelId))).slice(2);
  const at = s.extrinsics.flatMap((x) => {
    const hits: number[] = [];
    for (let i = x.indexOf(head, 2); i >= 0; i = x.indexOf(head, i + 1)) if (i % 2 === 0) hits.push(i);
    return hits.map((i) => ({ x, i }));
  });
  if (at.length !== 1) throw new Error(`the settle call of ${s.channelId} is found ${at.length} times in the block`);
  const { x, i } = at[0] as { x: string; i: number };
  const bytes = bytesOf(x);
  let o = (i - 2) / 2 + 2;
  const out = new Map<string, Uint8Array>();
  for (const f of fields) {
    const w = widthOf(s.shape, f.type);
    if (w === null) return { extrinsic: x, fields: out, next: f.name };
    out.set(f.name, bytes.slice(o, o + w));
    o += w;
  }
  return { extrinsic: x, fields: out, next: undefined };
}

// The reference decoder, over the metadata of the settled block's runtime.

/** The reference's decoding of a signed extrinsic, as test/chain-reference.test.ts's refDecode does it. */
export function refDecodeOf(metadata: Uint8Array) {
  const md = unifyMetadata(decAnyMetadata(metadata));
  const lookup = getLookupFn(md);
  const ref = getDynamicBuilder(lookup);
  const refCall = ref.buildDefinition(lookup.call as number);
  const params = md.lookup[md.extrinsic.type].params;
  const codec = (n: string) => ref.buildDefinition(params.find((p: { name: string }) => p.name === n)!.type!);
  return (bytes: Uint8Array) => {
    const length = refCompact.dec(bytes);
    const prefix = refCompact.enc(length).length;
    const body = bytes.slice(prefix);
    const format = extrinsicFormat.dec(body.slice(0, 1));
    const rest = Tuple(codec("Address"), codec("Signature"), codec("Extra"), refCall);
    const [address, signature, extra, c] = rest.dec(body.slice(1));
    return { length: Number(length), bodyLength: body.length, format, address, signature, extra, call: c, reencoded: rest.enc([address, signature, extra, c]), body };
  };
}

/** A fixed size binary of the reference decoder as bytes: an H256 it gives as hex text, a byte array as a binary. */
export const refBytes = (v: unknown): Uint8Array => {
  if (typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/.test(v)) return bytesOf(v);
  if (v !== null && typeof v === "object" && typeof (v as { asBytes?: unknown }).asBytes === "function") return (v as { asBytes: () => Uint8Array }).asBytes();
  throw new Error("not a fixed size binary of the reference");
};
