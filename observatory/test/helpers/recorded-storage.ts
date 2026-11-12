// The second real recording (fixtures/recording-20261112004113-0b2b505d2d4b703b): the storage the
// lab's two devnet session tests left behind, read through judgeRecording with the request list it
// was made from (the fixture's own copy), and laid out by read with the list derived again from
// the inputs it was made from (also the fixture's own copy)
// (test/helpers/requests-derive.ts), which says for each call the block and the storage it reads.
// Real data from one RPC endpoint: evidence for building the decoder, never proof of chain state
// (RULES.md section 8).
import { readFileSync } from "node:fs";
import { type RecordedCall, judgeRecording } from "../../src/recording.js";
import { parseMetadata } from "../../src/scale/metadata.js";
import { hexBytes } from "./recorded.js";
import { type Block, type DerivedCall, type Inputs, type Read, deriveCalls, readInputs } from "./requests-derive.js";

export const STORAGE_RECORDING = "recording-20261112004113-0b2b505d2d4b703b";
const FIXTURE = new URL(`../../fixtures/${STORAGE_RECORDING}/`, import.meta.url);
export const storageFixtureText = (name: string) => readFileSync(new URL(name, FIXTURE), "utf8");
/** The request list the recording was made from: the fixture's own copy. */
export const STORAGE_REQUESTS_TEXT = storageFixtureText("requests.json");
/** The inputs that list was derived from: the fixture's own copy, frozen with it. */
export const INPUTS_TEXT = storageFixtureText("requests-inputs.json");

/** The three files of the recording as published, by name. */
export const storageRecordingFiles = (): Record<string, string> => ({
  "run.json": storageFixtureText("run.json"),
  "tape.jsonl": storageFixtureText("tape.jsonl"),
  SHA256SUMS: storageFixtureText("SHA256SUMS"),
});

/** One storage read of the recording: where it was made, what it read, and what the node answered. */
export interface StorageRead {
  seq: number;
  block: Block;
  height: number;
  hash: string;
  read: Read;
  /** The storage key the call asked, as the tape holds it. */
  key: string;
  /** The answer's bytes, or null when the node holds no value there. */
  answer: Uint8Array | null;
}

const result = (c: RecordedCall | undefined): unknown => {
  if (c === undefined || !("result" in c.answer)) throw new Error("the recording holds no answer here");
  return c.answer.result;
};

/** The recording judged usable and laid out by read. Throws when it is not usable. */
export function recordedStorage() {
  const j = judgeRecording(storageRecordingFiles(), STORAGE_REQUESTS_TEXT);
  if (!j.usable) throw new Error(`the recording is not usable: ${j.refused.join("; ")}`);
  const calls = j.calls;
  const metadata = hexBytes(result(calls.at(-1)) as string);
  const md = parseMetadata(metadata);
  const inputs: Inputs = readInputs(INPUTS_TEXT);
  const derived: DerivedCall[] = deriveCalls(inputs, md);
  if (derived.length !== calls.length) throw new Error("the recording does not hold the derived list's calls");
  const lastRuntimeUpgrade = new Map<Block, Uint8Array>();
  const reads: StorageRead[] = [];
  derived.forEach((d, seq) => {
    const c = calls.at(seq) as RecordedCall;
    if (c.method !== d.call.method || JSON.stringify(c.params) !== JSON.stringify(d.call.params)) throw new Error(`call ${seq} is not the derived call`);
    if (d.block === null) return;
    if (d.read !== null) {
      const answer = result(c);
      if (answer !== null && typeof answer !== "string") throw new Error(`call ${seq} has an answer that is neither bytes nor null`);
      const b = inputs.blocks[d.block];
      reads.push({ seq, block: d.block, height: b.height.value, hash: b.hash.value, read: d.read, key: c.params[0] as string, answer: answer === null ? null : hexBytes(answer) });
    } else if (c.method === "state_getStorage") {
      lastRuntimeUpgrade.set(d.block, hexBytes(result(c) as string));
    }
  });
  return {
    run: j.run,
    calls,
    inputs,
    derived,
    genesis: result(calls.at(1)) as string,
    runtimeVersion: result(calls.at(-2)) as Record<string, unknown>,
    metadata,
    md,
    lastRuntimeUpgrade,
    reads,
  };
}
