#!/usr/bin/env node
// The live network status command. Its one transport comes from src/net-root.ts, the one module in
// src that names the global socket class and the global HTTP call.
//
//   node dist/live-bin.js --out <a new folder> --log <the published log folder> [--source-sha <revision>]
//
// It reads the published log, then FLOP devnet read only, writes the output folder src/live-run.ts
// describes, prints one GitHub Actions notice line with what the snapshot says, and exits with the
// code live-run gives.
import { EXIT, commandText, parseLiveArgs, runLive } from "./live-run.js";
import { realTransport } from "./net-root.js";

const args = parseLiveArgs(process.argv.slice(2));
if (typeof args === "string") {
  process.stderr.write(`flop-observatory-live: ${args}\n`);
  process.exit(EXIT.usage);
}

const transport = realTransport();

/** Writes the last lines, then exits once they are out. */
function finish(code: number, notice: string | null, reason: string): void {
  if (notice !== null) process.stdout.write(`${notice}\n`);
  if (code !== EXIT.ok) process.stderr.write(`::error title=observatory live::${commandText(reason)}\n`);
  process.stdout.write("", () => process.exit(code));
}

runLive(transport, { ...args, clock: () => new Date().toISOString() }).then(
  (r) => finish(r.code, r.notice, r.reason),
  (e) => finish(EXIT.crashed, null, `the run broke: ${e instanceof Error ? e.message : String(e)}`),
);
