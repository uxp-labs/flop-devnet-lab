// The request list as recordings/requests.json must hold it: the current list, the fifth
// (test/helpers/requests/list-5.ts), derived over recordings/requests-inputs.json and the metadata
// of the runtime the encoder's devnet test ran at. The one place both the tests and the writer
// (scripts/write-requests.mjs) get it from, so there is no second copy of the derive logic. When a
// list is replaced, its list and its inputs are already frozen in its recording's fixture folder,
// and this points at the next plan.
import { readFileSync } from "node:fs";
import { parseMetadata } from "../../src/scale/metadata.js";
import { reviewedMetadata } from "./recorded-upgrade.js";
import { deriveRequestsText, readInputs } from "./requests/list-5.js";

const REPO = new URL("../../../", import.meta.url);
/** The record of the run the list reads, and the field that names the spec it ran at. */
export const ENCODER_RESULTS = "research/2026-11-12-encoder-devnet-test/results.json";
export const ENCODER_SPEC_FIELD = "spec_version";

/**
 * The metadata every key of the list is built from: the reviewed metadata of the spec the encoder
 * test's results.json names (reviewedMetadata), found on the third recording's tape by the sha256 its
 * reviewed line gives. Throws when no reviewed line names that spec.
 */
export const listMetadata = (): Uint8Array => reviewedMetadata((JSON.parse(readFileSync(new URL(ENCODER_RESULTS, REPO), "utf8")) as Record<string, unknown>)[ENCODER_SPEC_FIELD]);

/** The text of recordings/requests.json, derived again from recordings/requests-inputs.json. */
export function requestsListText(): string {
  const inputs = readInputs(readFileSync(new URL("../../recordings/requests-inputs.json", import.meta.url), "utf8"));
  return deriveRequestsText(inputs, parseMetadata(listMetadata()));
}
