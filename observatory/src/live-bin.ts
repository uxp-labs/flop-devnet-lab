#!/usr/bin/env node
// The live network status command. Its one transport comes from src/net-root.ts, the one module in
// src that names the global socket class and the global HTTP call.
//
//   node dist/live-bin.js --out <a new folder> --log <the published log folder> [--source-sha <revision>]
//
// It reads the published log, then FLOP devnet read only, writes the output folder src/live-run.ts
// describes, prints one GitHub Actions notice line with what the snapshot says, and exits with the
// code live-run gives.
import { parseLiveArgs, runLive } from "./live-run.js";
import { EXIT, endCommand } from "./run-command.js";
import { realTransport } from "./net-root.js";

const args = parseLiveArgs(process.argv.slice(2));
if (typeof args === "string") {
  process.stderr.write(`flop-observatory-live: ${args}\n`);
  process.exit(EXIT.usage);
}

const transport = realTransport();

runLive(transport, { ...args, clock: () => new Date().toISOString() }).then(
  (r) => endCommand("observatory live", r.code, r.notice, r.reason),
  (e) => endCommand("observatory live", EXIT.crashed, null, `the run broke: ${e instanceof Error ? e.message : String(e)}`),
);
