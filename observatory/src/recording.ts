// The reader of a recording (RULES.md section 8): the output folder of one record run, as the
// record workflow publishes it under recordings/<id>/ on the branch observatory-data. A consumer
// hands the text of each file to judgeRecording, and the text of the request list when it has it.
// It is pure: it reads no file, no clock and no network.
//
// A recording is usable only when, in this order:
//   1. the files are exactly RECORDING_FILES and SHA256SUMS,
//   2. each file matches its line in SHA256SUMS, and SHA256SUMS is in the written form (src/sums.ts),
//   3. run.json is a flop-observatory/record-run@0 in the written form (src/feed.ts) with exactly
//      its keys, from the devnet endpoint, that exited 0, names the request list's sha256, and whose
//      counts add up,
//   4. the tape parses (src/tape.ts), every entry on it is an rpc call that was answered or failed
//      on the way, and it holds the counts run.json gives,
//   5. when a request list is given: it is in its form (src/requests.ts), its sha256 is the one
//      run.json names, and the tape holds exactly its calls, in order.
// The first step that fails gives the reasons, and nothing after it is read. A usable recording
// shows what one RPC endpoint answered to those calls. It is evidence for building decoders, never
// proof of chain state: no answer on it is checked against anything.
import { writtenValue } from "./feed.js";
import { DEVNET_RPC_URL } from "./net.js";
import { RECORD_SCHEMA } from "./record-run.js";
import { readRequests } from "./requests.js";
import { canonicalJson } from "./store.js";
import { isSafeInt, parseZoned } from "./strict.js";
import { sumsRefusals } from "./sums.js";
import { type TapeEntry, TapeError, parseTape } from "./tape.js";

/** Every file a recording holds but SHA256SUMS, in the order SHA256SUMS lists them. */
export const RECORDING_FILES = ["run.json", "tape.jsonl"] as const;

/** The run.json of a recording, as the recorder writes it. */
export interface RecordRun {
  schema: string;
  started_at: string;
  ended_at: string;
  source_sha: string | null;
  endpoint: string;
  request_list_sha256: string;
  calls: { asked: number; answered: number; failed: number };
  exit_code: number;
  exit_reason: string;
}

export interface RecordedCall {
  method: string;
  params: unknown[];
  /** The list's reason for the call, when the list was given. */
  why: string | null;
  answer: { result: unknown } | { error: string };
}

export type RecordingJudgement = { usable: true; run: RecordRun; calls: RecordedCall[] } | { usable: false; refused: string[] };

const refuse = (...refused: string[]): RecordingJudgement => ({ usable: false, refused });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const RUN_KEYS = ["calls", "ended_at", "endpoint", "exit_code", "exit_reason", "request_list_sha256", "schema", "source_sha", "started_at"];
const HEX64 = /^[0-9a-f]{64}$/;
/** The one form the recorder's clock writes (Date's toISOString), which the publish job reads too. */
const RECORDER_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const count = (v: unknown): v is number => isSafeInt(v) && v >= 0;

/** Whether the files of one recording may be used, and its calls with their answers when they may. */
export function judgeRecording(files: Readonly<Record<string, string>>, requests?: string): RecordingJudgement {
  // 1 and 2. Exactly the files, each against its sum, then the sums file's own form.
  const unsummed = sumsRefusals(files, RECORDING_FILES);
  if (unsummed.length > 0) return refuse(...unsummed);

  // 3. run.json.
  const read = writtenValue("run.json", files["run.json"] as string);
  if (typeof read === "string") return refuse(read);
  const r = read.value;
  if (!isRecord(r) || !keysAre(r, RUN_KEYS) || r.schema !== RECORD_SCHEMA) return refuse(`run.json is not a ${RECORD_SCHEMA}`);
  if (r.exit_code !== 0) return refuse(`run.json says exit ${canonicalJson(r.exit_code)}: only a run that exited 0 is a recording`);
  if (typeof r.request_list_sha256 !== "string" || !HEX64.test(r.request_list_sha256)) return refuse("run.json names no request list hash");
  const started = typeof r.started_at === "string" && RECORDER_TIME.test(r.started_at) ? parseZoned(r.started_at) : null;
  const ended = typeof r.ended_at === "string" && RECORDER_TIME.test(r.ended_at) ? parseZoned(r.ended_at) : null;
  if (started === null || ended === null || ended < started) return refuse("run.json has a start or end time not in the form the recorder writes, or an end before its start");
  const endpoint = `rpc ${DEVNET_RPC_URL}`;
  if (r.endpoint !== endpoint) return refuse(`run.json has the endpoint ${canonicalJson(r.endpoint)}, not ${canonicalJson(endpoint)}`);
  if (!(typeof r.source_sha === "string" || r.source_sha === null) || typeof r.exit_reason !== "string") return refuse(`run.json is not a ${RECORD_SCHEMA}`);
  const c = r.calls;
  if (!isRecord(c) || !keysAre(c, ["answered", "asked", "failed"]) || !count(c.asked) || !count(c.answered) || !count(c.failed) || c.answered + c.failed !== c.asked) {
    return refuse("run.json has calls that are not whole counts where answered and failed add up to asked");
  }
  const run = r as unknown as RecordRun;

  // 4. The tape: rpc calls, each answered or failed on the way, as many as run.json says.
  let entries: TapeEntry[];
  try {
    entries = parseTape(files["tape.jsonl"] as string);
  } catch (e) {
    if (!(e instanceof TapeError)) throw e;
    return refuse(`tape.jsonl: ${e.message}`);
  }
  const calls: RecordedCall[] = [];
  for (const e of entries) {
    if (e.request.kind !== "rpc" || "refused" in e.answer) return refuse(`tape.jsonl entry ${e.seq} is not an rpc call answered or failed on the way`);
    calls.push({ method: e.request.method, params: e.request.params, why: null, answer: e.answer });
  }
  const answered = calls.filter((x) => "result" in x.answer).length;
  const held = { asked: calls.length, answered, failed: calls.length - answered };
  if (canonicalJson(held) !== canonicalJson(run.calls)) {
    return refuse(`run.json says ${run.calls.answered} answered and ${run.calls.failed} failed of ${run.calls.asked}, the tape holds ${held.answered} and ${held.failed} of ${held.asked}`);
  }

  // 5. The request list, when given: the one run.json names, call for call.
  if (requests === undefined) return { usable: true, run, calls };
  const list = readRequests(new TextEncoder().encode(requests));
  if (typeof list === "string") return refuse(list.replace(/^the request list /, "the request list given "));
  if (list.sha256 !== run.request_list_sha256) return refuse("run.json names another request list");
  const off = list.calls
    .map((q, i) => (canonicalJson([q.method, q.params]) === canonicalJson([calls.at(i)?.method, calls.at(i)?.params]) ? null : `tape.jsonl call ${i} is not call ${i} of the request list`))
    .filter((x) => x !== null);
  if (off.length > 0 || list.calls.length !== calls.length) return refuse(...(off.length > 0 ? off : ["tape.jsonl holds another number of calls than the request list"]));
  return { usable: true, run, calls: calls.map((x, i) => ({ ...x, why: list.calls.at(i)?.why ?? null })) };
}
