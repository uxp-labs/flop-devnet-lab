// The fourth real recording (fixtures/recording-20261112132634-0a472f1b49f7b661): the blocks of the
// lab's session rerun at spec 1014020, read through judgeRecording with the request list it was made
// from (the fixture's own copy), and laid out step by step with the list derived again from the
// inputs it was made from (also the fixture's own copy). Each batch answer goes through
// readBatchAnswer, which refuses rather than guesses. Real data from one RPC endpoint: evidence for
// filling the rerun's results.json, never proof of chain state (RULES.md section 8).
import { readFileSync } from "node:fs";
import { type RecordedCall, judgeRecording } from "../../src/recording.js";
import { parseMetadata } from "../../src/scale/metadata.js";
import { type BatchAnswer, readBatchAnswer } from "./batch-answer.js";
import { reviewedMetadata } from "./recorded-upgrade.js";
import { type DerivedCall, type Inputs, type Read, STEPS, type Step, type StepId, blockOf, deriveCalls, readInputs } from "./requests/list-4.js";

export const RERUN_RECORDING = "recording-20261112132634-0a472f1b49f7b661";
const REPO = new URL("../../../", import.meta.url);
/** The record of the run the fourth list reads, and the field that names the spec it ran at. */
export const RERUN_RESULTS = "research/2026-11-12-session-rerun-1014020/results.json";
export const RERUN_SPEC_FIELD = "spec_version";

/**
 * The metadata every key of the fourth list is built from: the reviewed metadata of the spec the
 * rerun's results.json names (reviewedMetadata). Throws when no reviewed line names that spec.
 */
export const rerunMetadata = (): Uint8Array => reviewedMetadata((JSON.parse(readFileSync(new URL(RERUN_RESULTS, REPO), "utf8")) as Record<string, unknown>)[RERUN_SPEC_FIELD]);
const FIXTURE = new URL(`../../fixtures/${RERUN_RECORDING}/`, import.meta.url);
export const rerunFixtureText = (name: string) => readFileSync(new URL(name, FIXTURE), "utf8");
/** The request list the recording was made from: the fixture's own copy. */
export const RERUN_REQUESTS_TEXT = rerunFixtureText("requests.json");
/** The inputs that list was derived from: the fixture's own copy, frozen with it. */
export const RERUN_INPUTS_TEXT = rerunFixtureText("requests-inputs.json");

/** The three files of the recording as published, by name. */
export const rerunRecordingFiles = (): Record<string, string> => ({
  "run.json": rerunFixtureText("run.json"),
  "tape.jsonl": rerunFixtureText("tape.jsonl"),
  SHA256SUMS: rerunFixtureText("SHA256SUMS"),
});

/** One step's block as the recording answered it. */
export interface RerunBlock {
  step: Step;
  height: number;
  /** The hash the inputs give for the step's block, at which the batch was asked. */
  hash: string;
  /** The hash the node answered for the step's height. */
  answeredHash: unknown;
  /** What the batch asked, in order. */
  reads: readonly Read[];
  keys: readonly string[];
  /** The batch answer read, or its refusal. */
  answer: BatchAnswer;
}

const result = (c: RecordedCall | undefined): unknown => {
  if (c === undefined || !("result" in c.answer)) throw new Error("the recording holds no answer here");
  return c.answer.result;
};

/** The recording judged usable and laid out by step. Throws when it is not usable or is not the derived list. */
export function recordedRerun() {
  const j = judgeRecording(rerunRecordingFiles(), RERUN_REQUESTS_TEXT);
  if (!j.usable) throw new Error(`the recording is not usable: ${j.refused.join("; ")}`);
  const inputs: Inputs = readInputs(RERUN_INPUTS_TEXT);
  const metadata = rerunMetadata();
  const derived: DerivedCall[] = deriveCalls(inputs, parseMetadata(metadata));
  if (derived.length !== j.calls.length) throw new Error("the recording does not hold the derived list's calls");
  derived.forEach((d, seq) => {
    const c = j.calls.at(seq) as RecordedCall;
    if (c.method !== d.call.method || JSON.stringify(c.params) !== JSON.stringify(d.call.params)) throw new Error(`call ${seq} is not the derived call`);
  });
  const callAt = (id: StepId, method: string) => {
    const seq = derived.findIndex((d) => d.block === blockOf(id) && d.call.method === method);
    if (seq < 0) throw new Error(`no ${method} for step ${id}`);
    return { seq, d: derived[seq] as DerivedCall, c: j.calls.at(seq) };
  };
  const blocks: RerunBlock[] = STEPS.map((step) => {
    const b = inputs.blocks[blockOf(step.id)];
    const hash = callAt(step.id, "chain_getBlockHash");
    const batch = callAt(step.id, "state_queryStorageAt");
    const keys = (batch.d.call.params as [string[], string])[0];
    return {
      step,
      height: b.height.value,
      hash: b.hash.value,
      answeredHash: result(hash.c),
      reads: batch.d.reads ?? [],
      keys,
      answer: readBatchAnswer(result(batch.c), keys, b.hash.value),
    };
  });
  return { run: j.run, calls: j.calls, inputs, metadata, head: result(j.calls.at(0)), genesis: result(j.calls.at(1)), blocks };
}
