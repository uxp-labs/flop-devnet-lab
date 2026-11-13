// The request list as recordings/requests.json must hold it: the current list, the fourth
// (test/helpers/requests/list-4.ts), derived over recordings/requests-inputs.json and the metadata
// of the runtime the session rerun ran at (rerunMetadata, recorded-rerun.ts). The one place both
// the tests and the writer (scripts/write-requests.mjs) get it from, so there is no second copy of
// the derive logic. When a list is replaced, its list and its inputs are already frozen in its
// recording's fixture folder, and this points at the next plan.
import { readFileSync } from "node:fs";
import { parseMetadata } from "../../src/scale/metadata.js";
import { rerunMetadata } from "./recorded-rerun.js";
import { deriveRequestsText, readInputs } from "./requests/list-4.js";

/** The text of recordings/requests.json, derived again from recordings/requests-inputs.json. */
export function requestsListText(): string {
  const inputs = readInputs(readFileSync(new URL("../../recordings/requests-inputs.json", import.meta.url), "utf8"));
  return deriveRequestsText(inputs, parseMetadata(rerunMetadata()));
}
