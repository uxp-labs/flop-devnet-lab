// The request list as recordings/requests.json must hold it: the current list, the sixth
// (test/helpers/requests/list-6.ts), derived over recordings/requests-inputs.json and the reviewed
// metadata of the runtime the plan names. The one place both the tests and the writer
// (scripts/write-requests.mjs) get it from, so there is no second copy of the derive logic. When a
// list is replaced, its list and its inputs are already frozen in its recording's fixture folder,
// and this points at the next plan.
//
// The plan names its runtime by a file, a field and a block (its RUNTIME), never by a typed spec: the
// field is a call of a recorded tape, a read of System.LastRuntimeUpgrade at that block of the plan,
// and the spec is the one runtimeOfBlock names for the answer.
import { readFileSync } from "node:fs";
import { runtimeOfBlock } from "../../src/scale/block.js";
import { parseMetadata } from "../../src/scale/metadata.js";
import { hexBytes } from "./recorded.js";
import { reviewedMetadata } from "./recorded-upgrade.js";
import { keyHex } from "./requests/core.js";
import { type Block, RUNTIME, deriveRequestsText, readInputs } from "./requests/list-6.js";

const REPO = new URL("../../../", import.meta.url);

/** Where the current list's runtime is named: a file and a field. */
export const LIST_RUNTIME: { file: string; field: string; block: Block } = RUNTIME;

/** The one form of field a runtime may be named by: the answer to one call of a tape, by its seq. */
const FIELD = /^the answer to the (state_getStorage) call at seq (0|[1-9][0-9]*)$/;

interface TapeCall {
  seq: number;
  request: { kind: string; method: string; params: unknown[] };
  answer: { result: unknown };
}

/**
 * The tape line a field names, its form, seq, kind, method and answer checked. Throws when the field
 * is not of the one form, the tape holds no such call at that seq, the call is not an rpc call, or
 * the call has no answer.
 */
function tapeCall(file: string, field: string): TapeCall {
  const m = FIELD.exec(field);
  if (m === null) throw new Error(`a runtime is named by "the answer to the state_getStorage call at seq N", not "${field}"`);
  const seq = Number(m[2]);
  const lines = readFileSync(new URL(file, REPO), "utf8").split("\n");
  const entry = JSON.parse(lines[seq + 1] ?? "null") as { seq?: unknown; request?: { kind?: unknown; method?: unknown; params?: unknown }; answer?: { result?: unknown } } | null;
  if (entry === null || entry.seq !== seq || entry.request === undefined || entry.request.method !== m[1]) throw new Error(`${file} holds no ${m[1]} call at seq ${seq}`);
  if (entry.request.kind !== "rpc") throw new Error(`${file} seq ${seq} is not an rpc call: its kind is ${JSON.stringify(entry.request.kind)}`);
  if (entry.answer === undefined || !("result" in entry.answer)) throw new Error(`${file} holds no answer to the call at seq ${seq}`);
  return entry as TapeCall;
}

/** The answer a tape holds for the call a field names (tapeCall's checks). */
export const tapeAnswer = (file: string, field: string): unknown => tapeCall(file, field).answer.result;

const inputsOfList = () => readInputs(readFileSync(new URL("../../recordings/requests-inputs.json", import.meta.url), "utf8"));

/**
 * The spec a runtime source names: the reviewed runtime runtimeOfBlock names for the bytes of the
 * answer. The field passes only when its tape line is an rpc state_getStorage call with exactly two
 * params: first the System.LastRuntimeUpgrade key, built from the reviewed metadata of the spec the
 * answer names, then the hash the inputs give for the plan's named block. Each other case throws,
 * with its own words.
 */
export function specNamed(source: { file: string; field: string; block: Block }): number {
  const call = tapeCall(source.file, source.field);
  const where = `${source.file}, ${source.field}`;
  const r = runtimeOfBlock(hexBytes(String(call.answer.result)));
  if (!r.found) throw new Error(`${where}: ${r.refused}`);
  const { params } = call.request;
  if (!Array.isArray(params) || params.length !== 2) throw new Error(`${where}: the call has ${Array.isArray(params) ? params.length : "no"} params, not exactly two (the key, then the block hash)`);
  const key = keyHex(parseMetadata(reviewedMetadata(r.reviewed.specVersion)), "System", "LastRuntimeUpgrade", []);
  if (params[0] !== key) throw new Error(`${where}: the call reads ${String(params[0])}, not the System.LastRuntimeUpgrade key ${key}`);
  const hash = inputsOfList().blocks[source.block].hash.value;
  if (params[1] !== hash) throw new Error(`${where}: the call reads at ${String(params[1])}, not at the hash ${hash} of the plan's block ${source.block}`);
  return r.reviewed.specVersion;
}

/**
 * The metadata every key of the list is built from: the reviewed metadata of the spec the plan's
 * RUNTIME names (reviewedMetadata), found on the third recording's tape by the sha256 its reviewed
 * line gives. Throws when the runtime is not named or no reviewed line names it.
 */
export const listMetadata = (): Uint8Array => reviewedMetadata(specNamed(LIST_RUNTIME));

/** The text of recordings/requests.json, derived again from recordings/requests-inputs.json. */
export function requestsListText(): string {
  return deriveRequestsText(inputsOfList(), parseMetadata(listMetadata()));
}
