// The request list as recordings/requests.json must hold it: the derived list
// (test/helpers/requests/list-2.ts) over the committed inputs and the first recording's metadata.
// The one place both the tests and the writer (scripts/write-requests.mjs) get it from, so there is
// no second copy of the derive logic.
import { readFileSync } from "node:fs";
import { parseMetadata } from "../../src/scale/metadata.js";
import { recorded } from "./recorded.js";
import { deriveRequestsText, readInputs } from "./requests/list-2.js";

/** The text of recordings/requests.json, derived again from recordings/requests-inputs.json. */
export function requestsListText(): string {
  const inputs = readInputs(readFileSync(new URL("../../recordings/requests-inputs.json", import.meta.url), "utf8"));
  return deriveRequestsText(inputs, parseMetadata(recorded().metadata));
}
