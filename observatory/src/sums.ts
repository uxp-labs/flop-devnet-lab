// SHA256SUMS as sha256sum writes it: one line per file, sorted by name, the hex sha256, two spaces
// and the name. The one owner of that form, for the runs that write it (src/live-run.ts,
// src/record-run.ts) and the readers of the data branch that check it (src/published.ts,
// src/recording.ts).
import { createHash } from "node:crypto";
import { own } from "./own.js";

/** The SHA256SUMS text for these files, each a name and its bytes (a string is read as UTF-8). */
export function sumsOf(files: readonly (readonly [string, string | Uint8Array])[]): string {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)
    .join("");
}

/**
 * Why a folder's files, each a name and its text, are not exactly `names` and SHA256SUMS, each
 * matching its line, with SHA256SUMS in the written form. The reasons of the first of those three
 * steps that fails, or none: a reader reads nothing of a file before this says none.
 */
export function sumsRefusals(files: Readonly<Record<string, string>>, names: readonly string[]): string[] {
  const known = [...names, "SHA256SUMS"];
  const text = (name: string): string => own(files, name) as string;
  const missing = known.filter((n) => typeof own(files, n) !== "string").map((n) => `missing ${n}`);
  const unexpected = Object.keys(files)
    .filter((n) => !known.includes(n))
    .sort()
    .map((n) => `unexpected ${n}`);
  if (missing.length + unexpected.length > 0) return [...missing, ...unexpected];
  const sums = text("SHA256SUMS");
  const lines = sums.split("\n");
  const differ = names.filter((n) => !lines.includes(sumsOf([[n, text(n)]]).slice(0, -1))).map((n) => `${n} differs from SHA256SUMS`);
  if (differ.length > 0) return differ;
  if (sumsOf(names.map((n) => [n, text(n)] as const)) !== sums) return ["SHA256SUMS is not in the written form"];
  return [];
}
