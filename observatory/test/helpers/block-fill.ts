// What every fill of a results file from a recording needs, in one place (review round 32, D2): a
// block pinned to the runtime its System.LastRuntimeUpgrade names, through the lab's decoder's one
// door (src/scale/block.ts); the events of one extrinsic of it, with its result and its fee; one
// storage read through the door; and the error rows of spec 1014020 that name a failed result. Used
// by the session rerun's fill (rerun-fill.ts) and the encoder test's fill (encoder-fill.ts). Pure but
// for reading the committed files it names.
import { readFileSync } from "node:fs";
import { type BlockEvents, type StorageValue, decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "../../src/scale/block.js";
import type { BatchAnswer } from "./batch-answer.js";

const REPO = new URL("../../../", import.meta.url);
export const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
/** The error table of spec 1014020 a failed result is named by. */
export const ERRORS_FILE = "research/2026-11-12-session-rerun-1014020/errors-1014020.json";

export type Value = null | boolean | number | string | Value[] | { [name: string]: Value };
export type Rec = Record<string, unknown>;
export interface ErrorRow {
  pallet: string;
  pallet_index: number;
  error_index: number;
  name: string;
}

/** The rows of ERRORS_FILE. */
export const errorRows = (): ErrorRow[] => (JSON.parse(repoText(ERRORS_FILE)) as { errors: ErrorRow[] }).errors;

export const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
export const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
/** A decoded number, string or bool as text; anything else null. */
export const text = (x: unknown) => (typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : null);
/** The bytes of a key the list asked, as 0x hex (the list writes only whole bytes, lower case). */
export const keyOf = (h: string) => new Uint8Array(Buffer.from(h.slice(2), "hex"));

/** A decoded value in the results form: every enum value { variant, fields } written { type, value }, as events_form gives dispatch_error. */
export function resultsForm(v: Value): Value {
  if (Array.isArray(v)) return v.map(resultsForm);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys.includes("variant") && keys.includes("fields") && typeof v.variant === "string") return { type: v.variant, value: resultsForm(v.fields as Value) };
    return Object.fromEntries(keys.map((k) => [k, resultsForm(v[k] as Value)]));
  }
  return v;
}

/** The result of an extrinsic from its events: success, or the error by the 1014020 table; null when it cannot be named. */
function resultOf(events: Rec[], errors: readonly ErrorRow[]): string | null {
  const ok = events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
  const failed = events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
  if (ok.length + failed.length !== 1) return null;
  if (ok.length === 1) return "success";
  const d = (failed[0]?.fields as Rec | undefined)?.dispatch_error as Rec | undefined;
  const v = d?.value as Rec | undefined;
  if (d?.type !== "Module" || !isRec(v) || !Number.isInteger(v.index) || typeof v.error !== "string" || !/^0x[0-9a-f]{8}$/.test(v.error)) return null;
  const index = Number.parseInt(v.error.slice(2, 4), 16);
  const row = errors.find((e) => e.pallet_index === v.index && e.error_index === index);
  return row === undefined ? null : `failed: ${row.pallet}.${row.name} (pallet ${row.pallet_index}, error ${row.error_index})`;
}

/** One decoded event of a block, as the door gives it. */
export type BlockEvent = Extract<BlockEvents, { decoded: true }>["events"][number];

/** What the door is given for every read of one block: its runtime, its metadata and its LastRuntimeUpgrade. */
export interface Pin {
  specName: string;
  specVersion: number;
  metadata: Uint8Array;
  lastRuntimeUpgrade: Uint8Array;
  shapeText: string;
}

/**
 * One block's batch answer pinned through the door: not read (the batch refused, System.Events or
 * System.LastRuntimeUpgrade absent, or a runtime no reviewed line names); read, with the spec named
 * but the events not decoded; or decoded, with the pin every read of the block goes through.
 */
export type PinnedBlock =
  | { state: "not read" }
  | { state: "events not decoded"; spec: number }
  | { state: "decoded"; spec: number; pin: Pin; events: BlockEvent[]; values: ReadonlyMap<string, Uint8Array | null> };

/** A block's batch answer pinned: eventsKey and lruKey are the keys the list asked for System.Events and System.LastRuntimeUpgrade. */
export function pinBlock(answer: BatchAnswer, eventsKey: string | undefined, lruKey: string | undefined, metadata: Uint8Array): PinnedBlock {
  if (!answer.read) return { state: "not read" };
  const values = answer.values;
  const lru = lruKey === undefined ? undefined : values.get(lruKey);
  const events = eventsKey === undefined ? undefined : values.get(eventsKey);
  if (!(lru instanceof Uint8Array) || !(events instanceof Uint8Array)) return { state: "not read" };
  const rt = runtimeOfBlock(lru);
  if (!rt.found) return { state: "not read" };
  const pin: Pin = { specName: rt.reviewed.specName, specVersion: rt.reviewed.specVersion, metadata, lastRuntimeUpgrade: lru, shapeText: readFileSync(new URL(`../../${rt.reviewed.shapeFile}`, import.meta.url), "utf8") };
  const decoded = decodeBlockEvents({ ...pin, events });
  if (!decoded.decoded) return { state: "events not decoded", spec: rt.reviewed.specVersion };
  return { state: "decoded", spec: rt.reviewed.specVersion, pin, events: decoded.events, values };
}

/** One extrinsic of a block as the record's events_form writes it: its events in order, its result, and its fee. */
export interface ExtrinsicFill {
  events: Rec[];
  result: string | null;
  fee_raw: string | null;
}

/** The events of the extrinsic at extrinsicIndex alone, its result by the error rows, and its one TransactionFeePaid's actual_fee. */
export function extrinsicFill(events: readonly BlockEvent[], extrinsicIndex: number, errors: readonly ErrorRow[]): ExtrinsicFill {
  const mine: Rec[] = events
    .filter((e) => isRec(e.phase) && e.phase.variant === "ApplyExtrinsic" && e.phase.fields === extrinsicIndex)
    .map((e) => ({ pallet: e.pallet, name: e.event, fields: resultsForm(e.fields as Value) }));
  const fees = mine.filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid");
  const fee = fees.length === 1 ? (fees[0]?.fields as Rec).actual_fee : null;
  return { events: mine, result: resultOf(mine, errors), fee_raw: typeof fee === "string" ? fee : null };
}

/** One storage read of a pinned block through the door: the key asked (0x hex), its key parts, and the node's answer. */
export const readThroughDoor = (pin: Pin, pallet: string, entry: string, keys: Uint8Array[], key: string, answer: Uint8Array | null): StorageValue =>
  decodeStorageValue({ ...pin, pallet, entry, keys, key: keyOf(key), answer });
