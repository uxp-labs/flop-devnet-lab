#!/usr/bin/env node
// The recorder command. Its one transport comes from src/net-root.ts, the one module in src that
// names the global socket class and the global HTTP call, with the answer limits a recording states.
//
//   node dist/record-bin.js --requests <the request list> --out <a new folder> [--source-sha <revision>]
//
// It reads the request list, then FLOP devnet read only, one call at a time, writes the output
// folder src/record-run.ts describes, prints one GitHub Actions notice line with the counts and
// what each metadata answer holds, and exits with the code record-run gives.
import { EXIT, endCommand } from "./live-run.js";
import { realTransport } from "./net-root.js";
import { RECORD_ANSWER_LIMITS, parseRecordArgs, runRecord } from "./record-run.js";

const args = parseRecordArgs(process.argv.slice(2));
if (typeof args === "string") {
  process.stderr.write(`flop-observatory-record: ${args}\n`);
  process.exit(EXIT.usage);
}

const transport = realTransport(RECORD_ANSWER_LIMITS);

runRecord(transport, { ...args, clock: () => new Date().toISOString() }).then(
  (r) => endCommand("observatory record", r.code, r.notice, r.reason),
  (e) => endCommand("observatory record", EXIT.crashed, null, `the run broke: ${e instanceof Error ? e.message : String(e)}`),
);
