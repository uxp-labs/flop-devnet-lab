// Runs once around the whole vitest run, in the main process (RULES.md section 4).
//
// Before any test file starts, it gives them all one attempts journal: OBS_ATTEMPTS_FILE if the
// caller named one (npm run check does), else a temp file. After every file has ended, it checks
// what this run wrote there with scripts/attempts-check.mjs. A blocked call fired from a timer
// after a file's final check, or a reset made that late, fails the whole run here.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkJournal } from "../scripts/attempts-check.mjs";

export default function setup(): () => void {
  let own: string | null = null;
  if (!process.env.OBS_ATTEMPTS_FILE) {
    own = mkdtempSync(join(tmpdir(), "obs-attempts-"));
    process.env.OBS_ATTEMPTS_FILE = join(own, "attempts-journal.jsonl");
  }
  const journal = process.env.OBS_ATTEMPTS_FILE;
  // Only what this run writes counts, in case the caller's file already holds an earlier run.
  const start = existsSync(journal) ? statSync(journal).size : 0;
  return () => {
    try {
      const text = existsSync(journal) ? readFileSync(journal).subarray(start).toString("utf8") : "";
      const { problems } = checkJournal(text);
      if (problems.length > 0) {
        throw new Error(`unexpected network, write, sign or spend attempts after the last check: ${JSON.stringify(problems)}`);
      }
    } finally {
      if (own) {
        rmSync(own, { recursive: true, force: true });
        delete process.env.OBS_ATTEMPTS_FILE;
      }
    }
  };
}
