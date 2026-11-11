// The first real recording (fixtures/recording-20261111160917-3c228907aa129a01), read through
// judgeRecording with the request list it was made from, and laid out by block for the decoder
// tests. Real data from one RPC endpoint: evidence for building the decoder, never proof of chain
// state (RULES.md section 8).
//
// The list it was made from is the fixture's own copy, requests.json in its folder, byte for byte
// the list recordings/requests.json held when the recording was made (its sha256 is the one
// run.json names). recordings/requests.json is the list to be recorded next, so it moves on.
import { readFileSync } from "node:fs";
import { type RecordedCall, judgeRecording } from "../../src/recording.js";

export const RECORDING = "recording-20261111160917-3c228907aa129a01";
const FIXTURE = new URL(`../../fixtures/${RECORDING}/`, import.meta.url);
export const fixtureText = (name: string) => readFileSync(new URL(name, FIXTURE), "utf8");
/** The request list the recording was made from: the fixture's own copy. */
export const REQUESTS_TEXT = fixtureText("requests.json");

/** The three files of the recording as published, by name. */
export const recordingFiles = (): Record<string, string> => ({
  "run.json": fixtureText("run.json"),
  "tape.jsonl": fixtureText("tape.jsonl"),
  SHA256SUMS: fixtureText("SHA256SUMS"),
});

export const EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
export const LAST_RUNTIME_UPGRADE_KEY = "0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8";

export interface RecordedBlock {
  number: number;
  hash: string;
  header: Record<string, unknown>;
  events: Uint8Array;
  lastRuntimeUpgrade: Uint8Array;
}

export const hexBytes = (hex: string): Uint8Array => {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`not lower case hex bytes: ${hex.slice(0, 20)}`);
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
};

const result = (c: RecordedCall | undefined): unknown => {
  if (c === undefined || !("result" in c.answer)) throw new Error("the recording holds no answer here");
  return c.answer.result;
};

/** The recording judged usable, laid out by what each call read. Throws when it is not usable. */
export function recorded() {
  const j = judgeRecording(recordingFiles(), REQUESTS_TEXT);
  if (!j.usable) throw new Error(`the recording is not usable: ${j.refused.join("; ")}`);
  const calls = j.calls;
  const blocks: RecordedBlock[] = [];
  // Calls 2 to 49: for each block its hash, header, System.Events and System.LastRuntimeUpgrade.
  for (let i = 2; i < 50; i += 4) {
    const [hashCall, headerCall, eventsCall, upgradeCall] = calls.slice(i, i + 4);
    const hash = result(hashCall) as string;
    if (eventsCall?.params[0] !== EVENTS_KEY || eventsCall.params[1] !== hash) throw new Error(`call ${i + 2} is not System.Events at ${hash}`);
    if (upgradeCall?.params[0] !== LAST_RUNTIME_UPGRADE_KEY || upgradeCall.params[1] !== hash) throw new Error(`call ${i + 3} is not System.LastRuntimeUpgrade at ${hash}`);
    blocks.push({
      number: hashCall?.params[0] as number,
      hash,
      header: result(headerCall) as Record<string, unknown>,
      events: hexBytes(result(eventsCall) as string),
      lastRuntimeUpgrade: hexBytes(result(upgradeCall) as string),
    });
  }
  return {
    run: j.run,
    calls,
    finalizedHead: result(calls.at(0)) as string,
    genesis: result(calls.at(1)) as string,
    blocks,
    runtimeVersion: result(calls.at(50)) as Record<string, unknown>,
    metadata: hexBytes(result(calls.at(51)) as string),
  };
}
