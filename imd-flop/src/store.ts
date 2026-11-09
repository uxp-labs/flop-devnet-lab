import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

export function appendJsonlSafe(path: string, obj: unknown, what = path): void {
  assertNoSecrets(obj, what);
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(obj) + "\n", { mode: 0o644 });
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
