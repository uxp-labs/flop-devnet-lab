// The request list as recordings/requests.json must hold it: the current list, the fourth
// (test/helpers/requests/list-4.ts), derived over recordings/requests-inputs.json and the metadata
// of the runtime the session rerun ran at. The one place both the tests and the writer
// (scripts/write-requests.mjs) get it from, so there is no second copy of the derive logic. When a
// list is replaced, its list and its inputs are already frozen in its recording's fixture folder,
// and this points at the next plan.
import { readFileSync } from "node:fs";
import { parseMetadata } from "../../src/scale/metadata.js";
import { REVIEWED } from "../../src/scale/shape.js";
import { recordedUpgrade } from "./recorded-upgrade.js";
import { deriveRequestsText, readInputs } from "./requests/list-4.js";

const REPO = new URL("../../../", import.meta.url);
/** The record of the run the list reads, and the field that names the spec it ran at. */
export const RERUN_RESULTS = "research/2026-11-12-session-rerun-1014020/results.json";
export const RERUN_SPEC_FIELD = "spec_version";

/**
 * The metadata every key of the list is built from: the reviewed line of the spec the rerun's
 * results.json names, its metadata found on the third recording's tape by the sha256 that line
 * gives, never by the block it was read at. Throws when no reviewed line names that spec.
 */
export function rerunMetadata(): Uint8Array {
  const spec = (JSON.parse(readFileSync(new URL(RERUN_RESULTS, REPO), "utf8")) as Record<string, unknown>)[RERUN_SPEC_FIELD];
  const line = REVIEWED.find((r) => r.specVersion === spec);
  if (line === undefined) throw new Error(`no reviewed runtime of spec ${String(spec)}`);
  return recordedUpgrade().metadataBySha(line.metadataSha256);
}

/** The text of recordings/requests.json, derived again from recordings/requests-inputs.json. */
export function requestsListText(): string {
  const inputs = readInputs(readFileSync(new URL("../../recordings/requests-inputs.json", import.meta.url), "utf8"));
  return deriveRequestsText(inputs, parseMetadata(rerunMetadata()));
}
