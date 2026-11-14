// The run folder on the PC (H13) and the record in it, read the same way by every tool of this
// folder. The generic readers of a record are the last batch's (record.mjs of
// research/2026-11-12-encoder-devnet-test): the entry of an id, its view from the runner's reading,
// the ids recorded, the attempts of a cleanup step. This file only reads. No network, no key.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./lib.mjs";
import { entryOf, idsOf, MAX_ATTEMPTS, planStepOf, readingsOf, recordedIds, viewOf, baseOf, attemptOf, sendText } from "../2026-11-12-encoder-devnet-test/record.mjs";

export { entryOf, idsOf, MAX_ATTEMPTS, planStepOf, readingsOf, recordedIds, viewOf, baseOf, attemptOf, sendText };

/** The folders and files of a run folder. */
export const runFiles = (run) => ({
  results: join(run, "results.json"),
  seat: join(run, "seat"),
  tool: join(run, "tool"),
  tapes: join(run, "tapes"),
  calls: join(run, "calls"),
  signed: join(run, "signed"),
});
export const toolFile = (run, id, purpose) => join(run, "tool", `${id}.${purpose}.json`);
export const tapeFile = (run, id, purpose) => join(run, "tapes", `${id}.${purpose}.json`);
export const callFile = (run, id) => join(run, "calls", `${id}.json`);
export const signedFile = (run, id) => join(run, "signed", `${id}.json`);
export const sendFile = (run, id) => join(run, "signed", `${id}.send.json`);

/** The record of a run folder, or null. */
export const loadRecord = (run) => (existsSync(runFiles(run).results) ? readJson(runFiles(run).results) : null);

/** The tool's outputs in the run folder, each read. */
export function toolOutputs(run) {
  const dir = runFiles(run).tool;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, ...readJson(join(dir, f)) }));
}

/** The highest block of a step the record holds as included in a block the node reported finalized, or null. */
export function lastFinalizedBlock(plan, results) {
  const blocks = recordedIds(plan, results).map((id) => viewOf(results, id)).filter((v) => v?.final).map((v) => v.block_number);
  return blocks.length ? Math.max(...blocks) : null;
}
