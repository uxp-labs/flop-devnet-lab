// Hash-chained snapshot log: one canonical JSON line per snapshot.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { NotARegularFile, readRegularFile } from "./files.js";
import { duplicateKey } from "./strict.js";
import type { Snapshot } from "./types.js";

function canon(v: unknown): string | undefined {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x) ?? "null").join(",") + "]";
  if (typeof v === "object") {
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const c = canon(x);
      if (c !== undefined) parts.push(JSON.stringify(k) + ":" + c);
    }
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(v);
}

/** Sorted keys, no whitespace, numbers as JS prints them. */
export function canonicalJson(v: unknown): string {
  return canon(v) ?? "null";
}

/** sha256 (hex) over the canonical JSON of the snapshot without its hash field. */
export function hashSnapshot(s: Omit<Snapshot, "hash"> | Snapshot): string {
  const rest: Record<string, unknown> = { ...(s as unknown as Record<string, unknown>) };
  delete rest.hash;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export type NewSnapshot = Omit<Snapshot, "hash" | "seq" | "prev_hash">;

/** One line of the log as read: its text (null when it is not valid UTF-8) and whether a newline ended it. */
interface LogLine {
  text: string | null;
  ended: boolean;
}

/**
 * Every line of the log, decoded as strict UTF-8 with a byte order mark kept, so a mark refuses
 * (RULES.md 3.1 clause 12) and a bad byte is never read as U+FFFD. Blank lines and a last line
 * with no newline are kept too, so they fail their own checks: the log the code writes is
 * canonical JSON lines, each ending in a newline, and nothing else.
 */
function lines(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  let raw: Buffer;
  try {
    raw = readRegularFile(path);
  } catch (e) {
    // A named pipe or a folder at the log's path is no log: it is never read, extended or trusted.
    if (e instanceof NotARegularFile) throw new Error(`snapshot log ${path} is not a regular file; it is never extended or trusted`);
    throw e;
  }
  const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decode = (b: Uint8Array): string | null => {
    try {
      return strict.decode(b);
    } catch {
      return null;
    }
  };
  const out: LogLine[] = [];
  let start = 0;
  for (let i = raw.indexOf(0x0a); i !== -1; i = raw.indexOf(0x0a, start)) {
    out.push({ text: decode(raw.subarray(start, i)), ended: true });
    start = i + 1;
  }
  if (start < raw.length) out.push({ text: decode(raw.subarray(start)), ended: false });
  return out;
}

/**
 * One log line as a snapshot, or the reason it is not one. The line must be strict UTF-8, end in
 * a newline, parse as JSON with one value per key, and be in canonical form byte for byte, so it
 * has one reading only: padding, a carriage return, `0.0e0` for 0 or an integer past 2^53 - 1
 * (which JSON.parse rounds) all refuse.
 */
function parseLine(line: LogLine | undefined): Snapshot | string {
  if (line === undefined || line.text === null) return "is not valid UTF-8";
  if (!line.ended) return "does not end with a newline (a line cut short)";
  if (line.text === "") return "is blank";
  let s: Snapshot;
  try {
    s = JSON.parse(line.text) as Snapshot;
  } catch {
    return "is not JSON";
  }
  // Two readers of a line with a repeated key can see two different snapshots.
  const twice = duplicateKey(line.text);
  if (twice !== null) return `holds the key ${JSON.stringify(twice)} twice in one object`;
  return canonicalJson(s) === line.text ? s : "is not in canonical form";
}

export function readSnapshots(path: string): Snapshot[] {
  return lines(path).map((l, i) => {
    const s = parseLine(l);
    if (typeof s === "string") throw new Error(`snapshot log ${path} line ${i} ${s}`);
    return s;
  });
}

/** Sets seq and prev_hash from the last line, hashes, appends one line. Returns the stored snapshot. */
export function appendSnapshot(path: string, snap: NewSnapshot): Snapshot {
  const existing = readSnapshots(path);
  const last = existing.at(-1);
  const base = {
    ...snap,
    seq: last ? last.seq + 1 : 0,
    prev_hash: last ? last.hash : null,
  };
  const full = { ...base, hash: hashSnapshot(base as Snapshot) } as Snapshot;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, canonicalJson(full) + "\n");
  return full;
}

/** Returns the first broken seq (by line position), or null when the whole chain checks out. */
export function verifyChain(path: string): number | null {
  const ls = lines(path);
  let prev: string | null = null;
  for (const [i, line] of ls.entries()) {
    const s = parseLine(line);
    if (typeof s === "string") return i;
    if (s.seq !== i) return i;
    if (s.prev_hash !== prev) return i;
    if (s.hash !== hashSnapshot(s)) return i;
    prev = s.hash;
  }
  return null;
}
