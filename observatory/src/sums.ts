// SHA256SUMS as sha256sum writes it: one line per file, sorted by name, the hex sha256, two spaces
// and the name. The one owner of that form, for the live run that writes it (src/live-run.ts) and
// the reader of the data branch that checks it (src/published.ts).
import { createHash } from "node:crypto";

/** The SHA256SUMS text for these files, each a name and its bytes (a string is read as UTF-8). */
export function sumsOf(files: readonly (readonly [string, string | Uint8Array])[]): string {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)
    .join("");
}
