import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CliError, EXIT } from "./errors.js";
import { assertNoSecrets } from "./secrets.js";

export function ensureDir(dir: string, mode = 0o700): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode });
}

/** Public JSON (identity, link, receipts, config). Always secret-scanned first. */
export function writeJsonSafe(path: string, obj: unknown, what = path): void {
  assertNoSecrets(obj, what);
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Append one JSON row as one line. Every row starts on a fresh line: when the file is not empty and its last
 * byte is not \n (a last write that lost its newline, or a torn line), the row is written as "\n" + JSON + "\n"
 * in one write. So a row is never glued onto the line before it (swarm audit 33f3b9f, finding 2).
 */
export function appendJsonlSafe(path: string, obj: unknown, what = path): void {
  assertNoSecrets(obj, what);
  ensureDir(dirname(path));
  appendFileSync(path, (endsOnFreshLine(path) ? "" : "\n") + JSON.stringify(obj) + "\n", { mode: 0o644 });
}

/** True when the file is missing, empty, or ends with \n. */
function endsOnFreshLine(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** Secret files only (seat key, gateway bearer): 0600, never scanned, never printed. */
export function writeSecretFile(path: string, contents: string, opts: { replace?: boolean } = {}): void {
  ensureDir(dirname(path));
  if (opts.replace) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } else {
    writeFileSync(path, contents, { mode: 0o600, flag: "wx" }); // fails if it exists
    chmodSync(path, 0o600);
  }
}

/**
 * The one reader of every secret file (the seat key, the gateway bearer). It returns the file's text. It never
 * prints it, and an error about it never quotes a character of it (review of the audit 33f3b9f fixes, defect 4).
 */
export function readSecretFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * A secret file that holds JSON, parsed and checked by `valid`. A file that does not parse, or does not pass,
 * is reported as malformed with its name only: JSON.parse's own message quotes the text, so it is never used.
 */
export function readSecretJson<T>(path: string, what: string, valid: (v: unknown) => v is T): T {
  let value: unknown;
  try {
    value = JSON.parse(readSecretFile(path));
  } catch {
    throw new CliError(`${what} ${path} is malformed (not JSON); restore it from a backup or rotate the key`, EXIT.ERROR);
  }
  if (!valid(value)) throw new CliError(`${what} ${path} is malformed (not the expected fields); restore it from a backup or rotate the key`, EXIT.ERROR);
  return value;
}
