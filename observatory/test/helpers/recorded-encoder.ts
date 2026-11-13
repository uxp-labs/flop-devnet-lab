// The fifth real recording (fixtures/recording-20261113182100-8769e8d2841bf49a): the nine blocks of
// the lab's devnet test of its encoder of 2026-11-13 at spec 1014020, read through judgeRecording
// with the request list it was made from (the fixture's own copy), and laid out block by block with
// the list derived again from the inputs it was made from (also the fixture's own copy). Each batch
// answer goes through readBatchAnswer, which refuses rather than guesses. Real data from one RPC
// endpoint: evidence for filling the encoder test's results.final.json, never proof of chain state
// (RULES.md section 8).
import { readFileSync } from "node:fs";
import { type RecordedCall, judgeRecording } from "../../src/recording.js";
import { parseMetadata } from "../../src/scale/metadata.js";
import { type BatchAnswer, readBatchAnswer } from "./batch-answer.js";
import { reviewedMetadata } from "./recorded-upgrade.js";
import { type Block, type DerivedCall, type Inputs, MORTAL_IDS, type MortalId, type Read, START, STEP_IDS, type StepId, birthOf, blockOf, deriveCalls, readInputs } from "./requests/list-5.js";

export const ENCODER_RECORDING = "recording-20261113182100-8769e8d2841bf49a";
const REPO = new URL("../../../", import.meta.url);
/** The encoder test's folder, its run time record, and the field that names the spec it ran at. */
export const ENCODER_DIR = "research/2026-11-12-encoder-devnet-test";
export const ENCODER_RUN_TIME = `${ENCODER_DIR}/results.json`;
export const ENCODER_SPEC_FIELD = "spec_version";

/** The metadata every key of the fifth list is built from: the reviewed metadata of the spec the run time record names. */
export const encoderMetadata = (): Uint8Array => reviewedMetadata((JSON.parse(readFileSync(new URL(ENCODER_RUN_TIME, REPO), "utf8")) as Record<string, unknown>)[ENCODER_SPEC_FIELD]);
const FIXTURE = new URL(`../../fixtures/${ENCODER_RECORDING}/`, import.meta.url);
export const encoderFixtureText = (name: string) => readFileSync(new URL(name, FIXTURE), "utf8");
/** The request list the recording was made from: the fixture's own copy. */
export const ENCODER_REQUESTS_TEXT = encoderFixtureText("requests.json");
/** The inputs that list was derived from: the fixture's own copy, frozen with it. */
export const ENCODER_INPUTS_TEXT = encoderFixtureText("requests-inputs.json");

/** The three files of the recording as published, by name. */
export const encoderRecordingFiles = (): Record<string, string> => ({
  "run.json": encoderFixtureText("run.json"),
  "tape.jsonl": encoderFixtureText("tape.jsonl"),
  SHA256SUMS: encoderFixtureText("SHA256SUMS"),
});

/** A hash by height as the recording answered it. */
export interface HashAt {
  height: number;
  /** The hash the inputs give for the height. */
  hash: string;
  /** The hash the node answered for the height. */
  answeredHash: unknown;
}

/** One block of the list as the recording answered it: the start, or a step's block. */
export interface EncoderBlock extends HashAt {
  /** "start", or the step sent in the block. */
  id: "start" | StepId;
  /** What the batch asked, in order. */
  reads: readonly Read[];
  keys: readonly string[];
  /** The batch answer read, or its refusal. */
  answer: BatchAnswer;
  /** The block's extrinsics as chain_getBlock answered them (0x hex), or null at the start, which the list does not fetch. */
  extrinsics: unknown;
  /** For a step signed with a mortal era, the hash at the era's birth height. */
  birth: HashAt | null;
}

const result = (c: RecordedCall | undefined): unknown => {
  if (c === undefined || !("result" in c.answer)) throw new Error("the recording holds no answer here");
  return c.answer.result;
};
const isMortal = (id: StepId): id is MortalId => (MORTAL_IDS as readonly StepId[]).includes(id);

/** The recording judged usable and laid out by block. Throws when it is not usable or is not the derived list. */
export function recordedEncoder() {
  const j = judgeRecording(encoderRecordingFiles(), ENCODER_REQUESTS_TEXT);
  if (!j.usable) throw new Error(`the recording is not usable: ${j.refused.join("; ")}`);
  const inputs: Inputs = readInputs(ENCODER_INPUTS_TEXT);
  const metadata = encoderMetadata();
  const derived: DerivedCall[] = deriveCalls(inputs, parseMetadata(metadata));
  if (derived.length !== j.calls.length) throw new Error("the recording does not hold the derived list's calls");
  derived.forEach((d, seq) => {
    const c = j.calls.at(seq) as RecordedCall;
    if (c.method !== d.call.method || JSON.stringify(c.params) !== JSON.stringify(d.call.params)) throw new Error(`call ${seq} is not the derived call`);
  });
  const callAt = (b: Block, method: string) => {
    const seq = derived.findIndex((d) => d.block === b && d.call.method === method);
    if (seq < 0) throw new Error(`no ${method} for ${b}`);
    return { d: derived[seq] as DerivedCall, c: j.calls.at(seq) };
  };
  const hashAt = (b: Block): HashAt => ({ height: inputs.blocks[b].height.value, hash: inputs.blocks[b].hash.value, answeredHash: result(callAt(b, "chain_getBlockHash").c) });
  const blockAt = (id: "start" | StepId): EncoderBlock => {
    const b = id === "start" ? START : blockOf(id);
    const batch = callAt(b, "state_queryStorageAt");
    const keys = (batch.d.call.params as [string[], string])[0];
    const at = hashAt(b);
    const body = id === "start" ? null : (result(callAt(b, "chain_getBlock").c) as { block?: { extrinsics?: unknown } } | null);
    return {
      id,
      ...at,
      reads: batch.d.reads ?? [],
      keys,
      answer: readBatchAnswer(result(batch.c), keys, at.hash),
      extrinsics: body === null ? null : (body.block?.extrinsics ?? null),
      birth: id !== "start" && isMortal(id) ? hashAt(birthOf(id)) : null,
    };
  };
  const blocks: EncoderBlock[] = [blockAt("start"), ...STEP_IDS.map(blockAt)];
  return { run: j.run, calls: j.calls, inputs, metadata, head: result(j.calls.at(0)), genesis: result(j.calls.at(1)), blocks };
}
