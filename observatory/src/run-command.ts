// What a run's command and its output folder share, the live run's (src/live-run.ts) and the
// recorder's (src/record-run.ts): the exit codes, how flags are read, SHA256SUMS over the folder,
// and how the command ends. Each rule here has one owner, so the two runs cannot drift apart.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRegularFile } from "./files.js";
import { sumsOf } from "./sums.js";

/** How a run ends. src/live-run.ts and src/record-run.ts say which case gives which code. */
export const EXIT = { ok: 0, crashed: 1, usage: 2, reset: 3, refused: 4 } as const;

/**
 * A command's flags, by name, read as the command line reads its own (src/cli.ts): each flag is
 * --name followed by its value as the next argument, so --name=value, a flag not in known, one
 * given twice, an empty value or one that starts with -- and a stray argument are each refused.
 * Gives the reason as a string when refused. The live command and the recorder both read theirs so.
 */
export function readFlags(argv: readonly string[], known: readonly string[], command: string): Map<string, string> | string {
  const got = new Map<string, string>();
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift() as string;
    if (!a.startsWith("--")) return `${JSON.stringify(a)} is no flag's value; every argument is --name followed by its value`;
    if (a.includes("=")) return `${JSON.stringify(a)}: give a flag's value as the next argument, not after =`;
    if (!known.includes(a)) return `${a} is not a flag the ${command} command reads`;
    if (got.has(a)) return `${a} is given twice`;
    const v = rest.shift();
    if (v === undefined || v === "" || v.startsWith("--")) return `${a} needs a value`;
    got.set(a, v);
  }
  return got;
}

/** SHA256SUMS: the sha256 of every other file in the folder, sorted by name, as sha256sum writes it. */
export function sumsText(dir: string): string {
  const names = readdirSync(dir)
    .filter((n) => n !== "SHA256SUMS")
    .sort();
  return sumsOf(names.map((n) => [n, readRegularFile(join(dir, n))] as const));
}

/** A value made safe for a workflow command's message: %, CR and LF escaped as GitHub reads them. */
export function commandText(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * How a run's command ends: its notice line, if any, then, unless it exited 0, one error line
 * titled for the command, then the exit, once the lines are out. The live command and the
 * recorder both end so.
 */
export function endCommand(title: string, code: number, notice: string | null, reason: string): void {
  if (notice !== null) process.stdout.write(`${notice}\n`);
  if (code !== EXIT.ok) process.stderr.write(`::error title=${title}::${commandText(reason)}\n`);
  process.stdout.write("", () => process.exit(code));
}
