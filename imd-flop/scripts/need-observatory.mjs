#!/usr/bin/env node
/**
 * Says what to do when the observatory is not built (the P2 fix round, rule X10). imd-flop reaches the decoder through
 * the file:../observatory dependency (src/chain-read/door.ts imports flop-observatory/scale/block), so its build and
 * its tests need the door's built file and its declarations. This checks that both are there in the observatory
 * folder beside imd-flop, found from this script's own place. When one is missing it prints one line that names what
 * is missing and the command to run, and exits 1. It builds nothing, installs nothing and uses no network.
 * package.json runs it as prebuild and pretest.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The observatory folder beside imd-flop, from this script's place: imd-flop/scripts/../../observatory. */
export const OBSERVATORY = fileURLToPath(new URL("../../observatory/", import.meta.url));

/** The door's built file and its declarations, by their path in the observatory folder. */
export const NEEDED = Object.freeze(["dist/scale/block.js", "dist/scale/block.d.ts"]);

/** The command that builds the observatory, from imd-flop. */
export const BUILD = "cd ../observatory && npm ci && npm run build";

/** What the observatory folder lacks of NEEDED, and the one line to print, or null when nothing is missing. */
export function needObservatory(dir) {
  const missing = NEEDED.filter((f) => !existsSync(join(dir, f)));
  if (missing.length === 0) return { missing, line: null };
  return { missing, line: `imd-flop needs the observatory built first: ${missing.map((f) => `../observatory/${f}`).join(" and ")} missing; run: ${BUILD}` };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { line } = needObservatory(OBSERVATORY);
  if (line !== null) {
    process.stderr.write(`${line}\n`);
    process.exit(1);
  }
}
