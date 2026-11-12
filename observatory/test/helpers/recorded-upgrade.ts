// The third real recording (fixtures/recording-20261112080132-05842a6db1e9c890): FLOP devnet's
// runtime upgrade from spec 1014014 to spec 1014020, read through judgeRecording with the request
// list it was made from (the fixture's own copy), and laid out call by call with the list derived
// again from the inputs it was made from (also the fixture's own copy). Real data from one RPC
// endpoint: evidence for building the decoder, never proof of chain state (RULES.md section 8).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type RecordedCall, judgeRecording } from "../../src/recording.js";
import { parseMetadata } from "../../src/scale/metadata.js";
import { hexBytes, recorded } from "./recorded.js";
import { type Block, type DerivedCall, type Inputs, type Read, deriveCalls, readInputs } from "./requests/list-3.js";

export const UPGRADE_RECORDING = "recording-20261112080132-05842a6db1e9c890";
const FIXTURE = new URL(`../../fixtures/${UPGRADE_RECORDING}/`, import.meta.url);
export const upgradeFixtureText = (name: string) => readFileSync(new URL(name, FIXTURE), "utf8");
/** The request list the recording was made from: the fixture's own copy. */
export const UPGRADE_REQUESTS_TEXT = upgradeFixtureText("requests.json");
/** The inputs that list was derived from: the fixture's own copy, frozen with it. */
export const UPGRADE_INPUTS_TEXT = upgradeFixtureText("requests-inputs.json");

/** The three files of the recording as published, by name. */
export const upgradeRecordingFiles = (): Record<string, string> => ({
  "run.json": upgradeFixtureText("run.json"),
  "tape.jsonl": upgradeFixtureText("tape.jsonl"),
  SHA256SUMS: upgradeFixtureText("SHA256SUMS"),
});

/** One call of the recording with the derived call it answers: its block and the storage it reads, if any. */
export interface UpgradeCall {
  seq: number;
  derived: DerivedCall;
  call: RecordedCall;
  /** The answer's result: the recording holds an answer for every call (63 of 63). */
  result: unknown;
}

/** One storage entry read of the recording: where it was made, what it read, the key asked and what the node answered. */
export interface UpgradeRead {
  seq: number;
  block: Block;
  height: number;
  hash: string;
  read: Read;
  key: string;
  /** The answer's bytes, or null when the node holds no value there. */
  answer: Uint8Array | null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The recording judged usable and laid out call by call. Throws when it is not usable. */
export function recordedUpgrade() {
  const j = judgeRecording(upgradeRecordingFiles(), UPGRADE_REQUESTS_TEXT);
  if (!j.usable) throw new Error(`the recording is not usable: ${j.refused.join("; ")}`);
  const inputs: Inputs = readInputs(UPGRADE_INPUTS_TEXT);
  // The list's keys were built from the 1014014 metadata the first recording holds (list-3.ts).
  const derived = deriveCalls(inputs, parseMetadata(recorded().metadata));
  if (derived.length !== j.calls.length) throw new Error("the recording does not hold the derived list's calls");
  const calls: UpgradeCall[] = derived.map((d, seq) => {
    const c = j.calls.at(seq) as RecordedCall;
    if (c.method !== d.call.method || JSON.stringify(c.params) !== JSON.stringify(d.call.params)) throw new Error(`call ${seq} is not the derived call`);
    if (!("result" in c.answer)) throw new Error(`call ${seq} holds no answer`);
    return { seq, derived: d, call: c, result: c.answer.result };
  });
  const reads: UpgradeRead[] = calls.flatMap((c) => {
    const d = c.derived;
    if (d.read === null || d.block === null) return [];
    if (c.result !== null && typeof c.result !== "string") throw new Error(`call ${c.seq} has an answer that is neither bytes nor null`);
    const b = inputs.blocks[d.block];
    return [{ seq: c.seq, block: d.block, height: b.height.value, hash: b.hash.value, read: d.read, key: c.call.params[0] as string, answer: c.result === null ? null : hexBytes(c.result) }];
  });
  /** The answer of the one call of a method at a block, of a kind of derived call. */
  const at = (block: Block, method: string, upgrade: boolean): unknown => {
    const found = calls.filter((c) => c.derived.block === block && c.call.method === method && (method !== "state_getStorage" || (c.derived.read === null) === upgrade));
    if (found.length !== 1) throw new Error(`${found.length} calls of ${method} at ${block}`);
    return found[0]?.result;
  };
  /** Every metadata answer on the tape, by the sha256 of its bytes. */
  const metadata = new Map<string, Uint8Array>();
  for (const c of calls) if (c.call.method === "state_getMetadata") metadata.set(sha256(hexBytes(c.result as string)), hexBytes(c.result as string));
  return {
    run: j.run,
    calls,
    inputs,
    reads,
    genesis: calls.at(1)?.result as string,
    /** The hash the node answered for a block's height. */
    hashOf: (b: Block) => at(b, "chain_getBlockHash", false) as string,
    versionOf: (b: Block) => at(b, "state_getRuntimeVersion", false) as Record<string, unknown>,
    /** System.LastRuntimeUpgrade at a block, as bytes. */
    upgradeOf: (b: Block) => hexBytes(at(b, "state_getStorage", true) as string),
    /** System.Events at a block, as bytes. */
    eventsOf: (b: Block) => {
      const r = reads.find((x) => x.block === b && x.read.entry === "Events");
      if (r === undefined || r.answer === null) throw new Error(`no events at ${b}`);
      return r.answer;
    },
    /** The metadata answered at a block, as bytes. */
    metadataAt: (b: Block) => hexBytes(at(b, "state_getMetadata", false) as string),
    /** A metadata the tape holds, found by the sha256 of its bytes; never by the block it was read at. */
    metadataBySha: (sha: string) => {
      const m = metadata.get(sha);
      if (m === undefined) throw new Error(`the tape holds no metadata of sha256 ${sha}`);
      return m;
    },
  };
}
