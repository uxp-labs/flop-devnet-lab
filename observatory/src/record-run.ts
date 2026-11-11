// One record run: read a reviewed request list (src/requests.ts), make each call once, in order,
// through a transport, and write exactly what was asked and answered into a fresh output folder
// (RULES.md section 8). src/record-bin.ts hands it the network; a test hands it a fake or a tape.
//
// Before anything is sent, the list must be in its written form and every method in it must pass
// the read only guard (src/guard.ts). A list that fails either is refused whole: nothing is read
// from the network. The calls are then made one at a time, on the transport's one socket, through
// the tape code's Recorder (src/tape.ts). A call that failed on the way (a TransportError: an RPC
// error, a time limit, an answer over its limit, a socket that failed) is recorded as its error and
// the run goes on. Anything else (a refusal, a tape that does not match) stops the run.
//
// The output folder holds, and nothing else:
//   tape.jsonl   every request and its answer, in order, in the tape's form; it holds no clock
//                read: the times are run.json's
//   run.json     schema, started and ended, the source revision if given, the endpoint, the sha256
//                of the request list as it was read, how many calls were asked, answered and
//                failed, and how the run ended
//   SHA256SUMS   the sha256 of the two other files, as sha256sum writes it (src/sums.ts)
//
// How a run ends, in the live run's codes (EXIT in src/live-run.ts):
//   0  every call in the list was made and recorded, answered or failed on the way
//   4  the read only guard or the transport refused a request
//   1  the request list could not be read or was refused, or the run broke
//   2  the command was given wrong flags, or an output folder that is not empty
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedText } from "./feed.js";
import { readRegularFile } from "./files.js";
import { ReadOnlyViolation, attemptLog, guardRpc } from "./guard.js";
import { EXIT, commandText, readFlags, sumsText } from "./live-run.js";
import { MAX_STATED_ANSWER_BYTES } from "./net.js";
import { type RequestList, readRequests } from "./requests.js";
import { Recorder, type TapeAnswer } from "./tape.js";
import { type Transport, TransportError } from "./transport.js";

export const RECORD_SCHEMA = "flop-observatory/record-run@0";

/** The files a recording holds but SHA256SUMS, in the order SHA256SUMS lists them. */
export const RECORDING_FILES = ["run.json", "tape.jsonl"] as const;

/**
 * The answer limits a recording states (src/net.ts): state_getMetadata's answer is about 964 KB
 * as hex today, just under the 1 MiB every other call keeps, and a runtime upgrade could pass it.
 */
export const RECORD_ANSWER_LIMITS: ReadonlyMap<string, number> = new Map([["state_getMetadata", MAX_STATED_ANSWER_BYTES]]);

export interface RecordArgs {
  requests: string;
  out: string;
  sourceSha: string | null;
}

/** The flags: --requests <file>, --out <folder>, and --source-sha <revision> when known (readFlags). */
export function parseRecordArgs(argv: readonly string[]): RecordArgs | string {
  const got = readFlags(argv, ["--requests", "--out", "--source-sha"], "record");
  if (typeof got === "string") return got;
  const requests = got.get("--requests");
  if (requests === undefined) return "missing --requests";
  const out = got.get("--out");
  if (out === undefined) return "missing --out";
  return { requests, out, sourceSha: got.get("--source-sha") ?? null };
}

export interface RecordOptions extends RecordArgs {
  /** The clock for run.json's start and end. */
  clock: () => string;
}

export interface CallCounts {
  asked: number;
  answered: number;
  failed: number;
}

/** What the notice says of one state_getMetadata answer: its decoded bytes' length and sha256. */
export interface MetadataSeen {
  seq: number;
  bytes: number | null;
  sha256: string | null;
}

export interface RecordResult {
  code: number;
  reason: string;
  /** The one line for the run log, in the GitHub Actions notice format, when the folder was written. */
  notice: string | null;
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** The decoded bytes of a metadata answer, by length and sha256; null for an answer that is not 0x and whole hex bytes. */
export function metadataOf(seq: number, answer: TapeAnswer): MetadataSeen {
  if (!("result" in answer) || typeof answer.result !== "string" || !HEX_BYTES.test(answer.result)) return { seq, bytes: null, sha256: null };
  const bytes = Buffer.from(answer.result.slice(2), "hex");
  return { seq, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The notice line: the counts, the list's hash, and what each metadata answer holds. */
export function recordNotice(calls: CallCounts, listSha: string | null, metadata: readonly MetadataSeen[]): string {
  const line = JSON.stringify({ asked: calls.asked, answered: calls.answered, failed: calls.failed, request_list_sha256: listSha, metadata });
  return `::notice title=recording::${commandText(line)}`;
}

/** The reason an error gives. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runRecord(transport: Transport, o: RecordOptions): Promise<RecordResult> {
  if (existsSync(o.out) && readdirSync(o.out).length > 0) {
    transport.close();
    return { code: EXIT.usage, reason: `the output folder ${o.out} is not empty; a record run writes only into a new one`, notice: null };
  }
  mkdirSync(o.out, { recursive: true });
  const startedAt = o.clock();
  const before = attemptLog().length;
  const recorder = new Recorder(transport);
  const calls: CallCounts = { asked: 0, answered: 0, failed: 0 };
  const metadata: MetadataSeen[] = [];
  let listSha: string | null = null;
  let unread: string | null = null;
  let refusedList: string | null = null;
  let guarded = false;
  let broke: string | null = null;
  try {
    let list: RequestList | string;
    try {
      const bytes = readRegularFile(o.requests);
      listSha = createHash("sha256").update(bytes).digest("hex");
      list = readRequests(bytes);
    } catch (e) {
      unread = messageOf(e);
      list = "";
    }
    if (typeof list === "string") {
      if (unread === null) refusedList = list;
    } else {
      calls.asked = list.calls.length;
      // Every method through the guard before anything is sent. Each refusal is recorded.
      for (const c of list.calls) {
        try {
          guardRpc(c.method);
        } catch (e) {
          if (!(e instanceof ReadOnlyViolation)) throw e;
        }
      }
      guarded = attemptLog().length === before;
      if (guarded) {
        for (const [seq, c] of list.calls.entries()) {
          try {
            const result = await recorder.rpc(c.method, c.params);
            calls.answered++;
            if (c.method === "state_getMetadata") metadata.push(metadataOf(seq, { result }));
          } catch (e) {
            if (!(e instanceof TransportError)) throw e;
            calls.failed++;
            if (c.method === "state_getMetadata") metadata.push(metadataOf(seq, { error: e.message }));
          }
        }
      }
    }
  } catch (e) {
    broke = messageOf(e);
  } finally {
    recorder.close();
  }
  const refused = attemptLog().slice(before);
  const said = refused.map((a) => `${a.kind} ${a.what}`).join("; ");
  let code: number;
  let reason: string;
  if (unread !== null) {
    code = EXIT.crashed;
    reason = `the request list could not be read: ${unread}`;
  } else if (refusedList !== null) {
    code = EXIT.crashed;
    reason = `the request list was refused, so nothing was read: ${refusedList}`;
  } else if (refused.length > 0) {
    code = EXIT.refused;
    reason = `${guarded ? "refused" : "refused before anything was sent"}: ${said}`;
  } else if (broke !== null) {
    code = EXIT.crashed;
    reason = `the run broke: ${broke}`;
  } else {
    code = EXIT.ok;
    reason = `every call was made and recorded: ${calls.answered} answered, ${calls.failed} failed on the way`;
  }
  writeFileSync(join(o.out, "tape.jsonl"), recorder.text());
  writeFileSync(
    join(o.out, "run.json"),
    feedText({
      schema: RECORD_SCHEMA,
      started_at: startedAt,
      ended_at: o.clock(),
      source_sha: o.sourceSha,
      endpoint: transport.label,
      request_list_sha256: listSha,
      calls,
      exit_code: code,
      exit_reason: reason,
    }),
  );
  writeFileSync(join(o.out, "SHA256SUMS"), sumsText(o.out));
  return { code, reason, notice: recordNotice(calls, listSha, metadata) };
}
