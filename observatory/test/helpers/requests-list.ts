// The request list as recordings/requests.json must hold it: the current list, the sixth
// (test/helpers/requests/list-6.ts), derived over recordings/requests-inputs.json and the reviewed
// metadata of the runtime the plan names. The one place both the tests and the writer
// (scripts/write-requests.mjs) get it from, so there is no second copy of the derive logic. When a
// list is replaced, its list and its inputs are already frozen in its recording's fixture folder,
// and this points at the next plan.
//
// The plan names its runtime by a file and a field (its RUNTIME), never by a typed spec: the field
// is a call of a recorded tape whose answer is a System.LastRuntimeUpgrade record, and the spec is
// the one runtimeOfBlock names for those bytes.
import { readFileSync } from "node:fs";
import { runtimeOfBlock } from "../../src/scale/block.js";
import { parseMetadata } from "../../src/scale/metadata.js";
import { hexBytes } from "./recorded.js";
import { reviewedMetadata } from "./recorded-upgrade.js";
import { RUNTIME, deriveRequestsText, readInputs } from "./requests/list-6.js";

const REPO = new URL("../../../", import.meta.url);

/** Where the current list's runtime is named: a file and a field. */
export const LIST_RUNTIME: { file: string; field: string } = RUNTIME;

/** The one form of field a runtime may be named by: the answer to one call of a tape, by its seq. */
const FIELD = /^the answer to the (state_getStorage) call at seq (0|[1-9][0-9]*)$/;

/**
 * The answer a tape holds for the call a field names, its method checked. Throws when the field is
 * not of the one form, the tape holds no such call at that seq, or the call has no answer.
 */
export function tapeAnswer(file: string, field: string): unknown {
  const m = FIELD.exec(field);
  if (m === null) throw new Error(`a runtime is named by "the answer to the state_getStorage call at seq N", not "${field}"`);
  const seq = Number(m[2]);
  const lines = readFileSync(new URL(file, REPO), "utf8").split("\n");
  const entry = JSON.parse(lines[seq + 1] ?? "null") as { seq?: unknown; request?: { method?: unknown }; answer?: { result?: unknown } } | null;
  if (entry === null || entry.seq !== seq || entry.request?.method !== m[1]) throw new Error(`${file} holds no ${m[1]} call at seq ${seq}`);
  if (entry.answer === undefined || !("result" in entry.answer)) throw new Error(`${file} holds no answer to the call at seq ${seq}`);
  return entry.answer.result;
}

/** The spec a file and field name: the reviewed runtime runtimeOfBlock names for the bytes there. Throws when it names none. */
export function specNamed(source: { file: string; field: string }): number {
  const r = runtimeOfBlock(hexBytes(String(tapeAnswer(source.file, source.field))));
  if (!r.found) throw new Error(`${source.file}, ${source.field}: ${r.refused}`);
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
  const inputs = readInputs(readFileSync(new URL("../../recordings/requests-inputs.json", import.meta.url), "utf8"));
  return deriveRequestsText(inputs, parseMetadata(listMetadata()));
}
