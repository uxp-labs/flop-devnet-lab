// Hash-chained snapshot log: one canonical JSON line per snapshot.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { duplicateKey } from "./strict.js";
import type { Snapshot } from "./types.js";

function canon(v: unknown): string | undefined {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x) ?? "null").join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(o).sort()) {
      const c = canon(o[k]);
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

/**
 * The log's non-blank lines, each decoded as strict UTF-8. A line that is not valid UTF-8 is null:
 * it is never read with U+FFFD in place of its bad bytes.
 */
function lines(path: string): (string | null)[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path);
  const strict = new TextDecoder("utf-8", { fatal: true });
  const out: (string | null)[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i < raw.length && raw[i] !== 0x0a) continue;
    let line: string | null;
    try {
      line = strict.decode(raw.subarray(start, i));
    } catch {
      line = null;
    }
    start = i + 1;
    if (line === null || line.trim() !== "") out.push(line);
  }
  return out;
}

/** One log line as a snapshot, or the reason it is not one (strict UTF-8, JSON, one value per key). */
function parseLine(line: string | null): Snapshot | string {
  if (line === null) return "is not valid UTF-8";
  let s: Snapshot;
  try {
    s = JSON.parse(line) as Snapshot;
  } catch {
    return "is not JSON";
  }
  // Two readers of a line with a repeated key can see two different snapshots.
  const twice = duplicateKey(line);
  return twice === null ? s : `holds the key ${JSON.stringify(twice)} twice in one object`;
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
  const last = existing[existing.length - 1];
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
  for (let i = 0; i < ls.length; i++) {
    const s = parseLine(ls[i] ?? null);
    if (typeof s === "string") return i;
    if (s.seq !== i) return i;
    if (s.prev_hash !== prev) return i;
    if (s.hash !== hashSnapshot(s)) return i;
    prev = s.hash;
  }
  return null;
}
