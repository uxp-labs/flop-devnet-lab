// Hash-chained snapshot log: one canonical JSON line per snapshot.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
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

/** One line of the log as the store writes it: the snapshot in canonical JSON and a newline. */
export function logLine(s: Snapshot): string {
  return canonicalJson(s) + "\n";
}

/** The snapshot that follows last in a log (or starts one, when last is undefined): seq, prev_hash and hash set. */
export function sealSnapshot(snap: NewSnapshot, last: Snapshot | undefined): Snapshot {
  const base = {
    ...snap,
    seq: last ? last.seq + 1 : 0,
    prev_hash: last ? last.hash : null,
  };
  return { ...base, hash: hashSnapshot(base as Snapshot) } as Snapshot;
}

/** Sets seq and prev_hash from the last line, hashes, appends one line. Returns the stored snapshot. */
export function appendSnapshot(path: string, snap: NewSnapshot): Snapshot {
  const full = sealSnapshot(snap, readSnapshots(path).at(-1));
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, logLine(full));
  return full;
}

/** Why a snapshot does not follow the line before it (seq and prev_hash it should hold), or null. The one owner of the chain rule. */
function linkProblem(s: Snapshot, seq: number, prev: string | null): string | null {
  if (s.seq !== seq) return `has seq ${JSON.stringify(s.seq)}, not ${seq}`;
  if (s.prev_hash !== prev) return "does not name the hash of the line before it as prev_hash";
  if (s.hash !== hashSnapshot(s)) return "fails its hash check";
  return null;
}

/** Returns the first broken seq (by line position), or null when the whole chain checks out. */
export function verifyChain(path: string): number | null {
  const ls = lines(path);
  let prev: string | null = null;
  for (const [i, line] of ls.entries()) {
    const s = parseLine(line);
    if (typeof s === "string") return i;
    if (linkProblem(s, i, prev) !== null) return i;
    prev = s.hash;
  }
  return null;
}

/** A day file of a log split by day: <UTC date>.jsonl, as the publish job names them. */
export const DAY_FILE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})\.jsonl$/;

/** Why a log split by day was refused: a file or line that cannot be read, or a chain that breaks. */
export class LogRefused extends Error {
  readonly kind: "unreadable" | "broken";
  constructor(kind: "unreadable" | "broken", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface DayLog {
  /** The day files read, in name order. */
  files: string[];
  /** Every snapshot in the log, oldest first. */
  snapshots: Snapshot[];
}

/** A day file name that names a real calendar date. */
function isDayFile(name: string): boolean {
  const m = DAY_FILE.exec(name);
  if (m === null) return false;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === name.slice(0, 10);
}

/**
 * A log split by day (the log/ folder of the data branch): its day files, read in name order, are
 * one log. The day split keeps each file small; one file would grow without bound. Returns null
 * when the folder does not exist: no earlier snapshot. Throws LogRefused, naming the day file by
 * its name only, so the reason reads the same on any machine, when anything
 * in it is not what the publish job writes: the folder is a link or no folder, it holds a name that
 * is no day file, a day file is a link or not a regular file, or a line fails a check readSnapshots
 * makes (all "unreadable"); or a line does not follow the one before it (verifyChain's rule, across
 * files: "broken").
 *
 * One allowance, for the readings published before runs kept memory: the log may begin with lines
 * that each hold seq 0 and no prev_hash, each a whole log of one line that passes its hash check.
 * The chain then goes on from the last of them. Once a line follows another (seq 1 and up), a line
 * with seq 0 breaks the chain, so a log is never restarted part way.
 */
export function readDayLog(dir: string): DayLog | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LogRefused("unreadable", `the log folder cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  if (!st.isDirectory()) throw new LogRefused("unreadable", "the log folder is not a folder");
  /** A system error on the way (no permission, say) refuses the log too: it is never a crash. */
  const read = <T>(what: string, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw new LogRefused("unreadable", `${what} cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  };
  const names = read("the log folder", () => readdirSync(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const snapshots: Snapshot[] = [];
  let chained = false;
  for (const name of names) {
    const path = join(dir, name);
    if (!isDayFile(name)) throw new LogRefused("unreadable", `the log folder holds ${JSON.stringify(name)}, which is no <UTC date>.jsonl day file`);
    if (!read(name, () => lstatSync(path)).isFile()) throw new LogRefused("unreadable", `${name} is not a regular file`);
    for (const [i, line] of read(name, () => lines(path)).entries()) {
      const s = parseLine(line);
      if (typeof s === "string") throw new LogRefused("unreadable", `${name} line ${i} ${s}`);
      const last = snapshots.at(-1);
      // A whole log of one line, from before runs kept memory, only before the chain has begun.
      const oneLine = !chained && s.seq === 0 && s.prev_hash === null;
      const why = oneLine ? linkProblem(s, 0, null) : linkProblem(s, last === undefined ? 0 : last.seq + 1, last?.hash ?? null);
      if (why !== null) throw new LogRefused("broken", `${name} line ${i} ${why}`);
      if (!oneLine) chained = true;
      snapshots.push(s);
    }
  }
  return { files: names, snapshots };
}
