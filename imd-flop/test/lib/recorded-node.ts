/**
 * Scripted FLOP nodes for the chain-read tests, answering only from the observatory's committed recordings. No
 * socket is opened: a scripted node is a Transport (src/chain-read/node.ts), a function over maps of recorded answers.
 * A question the recording holds no answer to is a node error (the function throws), so a read that needs it is
 * unknown, never a default.
 *
 * Two things a node answers are not in the recordings, and are scripted here, said where they are used:
 *  - chain_getHeader. The recordings hold block hashes by height but no header. A header's number is the height the
 *    recording's inputs give for that hash. Its parent hash is the recorded hash at the height below when the
 *    recording holds it, and otherwise a stand in, parentOf(hash), whose metadata the node answers with the
 *    metadata of the runtime that executed the block (the door checks those bytes by their sha256).
 *  - chain_getFinalizedHead. The recordings hold the head's hash at recording time but not its number. A scripted
 *    node's head is a recorded block the test names.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, SOURCES } from "../../scripts/chain-table.mjs";
import type { ReadMethod, Transport } from "../../src/chain-read/node.js";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const repoText = (rel: string): string => readFileSync(join(REPO, rel), "utf8");
export const repoJson = (rel: string): any => JSON.parse(repoText(rel));

export const RERUN_RECORDING = "observatory/fixtures/recording-20261112132634-0a472f1b49f7b661";
export const UPGRADE_RECORDING = "observatory/fixtures/recording-20261112080132-05842a6db1e9c890";
export const RERUN_RESULTS = "research/2026-11-12-session-rerun-1014020/results.json";

/** One answered call of a recording's tape. */
interface TapeCall {
  method: string;
  params: unknown[];
  result: unknown;
}

export function tapeOf(recording: string): TapeCall[] {
  return repoText(`${recording}/tape.jsonl`)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
    .filter((o) => o.request?.kind === "rpc" && "result" in (o.answer ?? {}))
    .map((o) => ({ method: o.request.method, params: o.request.params, result: o.answer.result }));
}

/** The stand in for the parent hash of a block whose parent the recording does not hold: 32 bytes made from the block's hash. */
export const parentOf = (hash: string): string => `0x${createHash("sha256").update(`the parent of ${hash}`).digest("hex")}`;

/** The 1014020 metadata, as scripts/chain-table.mjs reads it: from the upgrade recording, by the facts file's sha256. */
export const metadata1014020 = (): string => `0x${Buffer.from(readSource(SOURCES[0]).metadata).toString("hex")}`;

/** What a scripted node holds. Each map is filled only from a recording. */
export interface Script {
  head: string;
  headers: Map<string, { number: number; parentHash: string }>;
  hashes: Map<number, string>;
  /** By `${at} ${key}`: the answer's bytes as hex, or null when the node holds no value there. */
  storage: Map<string, string | null>;
  metadata: Map<string, string>;
}

/** Every call a scripted node was asked, in order. */
export type Log = { method: ReadMethod; params: readonly unknown[] }[];

export function transportOf(s: Script, log: Log = []): Transport {
  return async (method, params) => {
    log.push({ method, params });
    const p0 = params[0];
    switch (method) {
      case "chain_getFinalizedHead":
        return s.head;
      case "chain_getHeader": {
        const h = s.headers.get(p0 as string);
        if (h === undefined) return null;
        return { number: `0x${h.number.toString(16)}`, parentHash: h.parentHash, stateRoot: p0, extrinsicsRoot: p0, digest: { logs: [] } };
      }
      case "chain_getBlockHash":
        return s.hashes.get(p0 as number) ?? null;
      case "state_getStorage": {
        const k = `${params[1]} ${p0}`;
        if (!s.storage.has(k)) throw new Error("rpc error: the recording holds no answer for this key at this block");
        return s.storage.get(k);
      }
      case "state_getMetadata": {
        const m = s.metadata.get(p0 as string);
        if (m === undefined) throw new Error("rpc error: the recording holds no metadata at this block");
        return m;
      }
    }
  };
}

const RERUN_INPUTS = () => repoJson(`${RERUN_RECORDING}/requests-inputs.json`);

/**
 * The session rerun's recording as a node: the hash at each recorded height, the batch answers of each block (a
 * key the batch lists with null is a value the node does not hold), a header for each block of the inputs, and the
 * 1014020 metadata at each block's stand in parent. Every rerun block was executed by 1014020: each one's own
 * System.LastRuntimeUpgrade names it (results.json last_runtime_upgrade_spec), and the door checks it again.
 */
export function rerunScript(head: string): Script {
  const tape = tapeOf(RERUN_RECORDING);
  const s: Script = { head, headers: new Map(), hashes: new Map(), storage: new Map(), metadata: new Map() };
  for (const c of tape) {
    if (c.method === "chain_getBlockHash" && typeof c.result === "string") s.hashes.set(c.params[0] as number, c.result);
    if (c.method === "state_queryStorageAt") {
      for (const set of c.result as { block: string; changes: [string, string | null][] }[]) for (const [k, v] of set.changes) s.storage.set(`${set.block} ${k}`, v);
    }
  }
  const md = metadata1014020();
  for (const b of Object.values(RERUN_INPUTS().blocks) as { hash: { value: string }; height: { value: number } }[]) {
    s.headers.set(b.hash.value, { number: b.height.value, parentHash: parentOf(b.hash.value) });
    s.metadata.set(parentOf(b.hash.value), md);
  }
  return s;
}

/** The upgrade recording's blocks, by the name its inputs give them. */
export function upgradeBlocks(): Record<string, { hash: string; height: number }> {
  const blocks = repoJson(`${UPGRADE_RECORDING}/requests-inputs.json`).blocks as Record<string, { hash: { value: string }; height: { value: number } }>;
  return Object.fromEntries(Object.entries(blocks).map(([k, b]) => [k, { hash: b.hash.value, height: b.height.value }]));
}

/**
 * The upgrade recording as a node: hashes by height, every single storage answer, the metadata answered at each
 * block, and a header for each block of the inputs whose parent is the recorded hash at the height below when there
 * is one, else the stand in. The stand in parent of a block the new runtime executed gets the metadata the recording
 * answered at the block that carried the upgrade, the new runtime's (named by the caller, from the inputs).
 */
export function upgradeScript(head: string, newRuntimeMetadataAt: string, newRuntimeBlocks: readonly string[]): Script {
  const tape = tapeOf(UPGRADE_RECORDING);
  const s: Script = { head, headers: new Map(), hashes: new Map(), storage: new Map(), metadata: new Map() };
  for (const c of tape) {
    if (c.method === "chain_getBlockHash" && typeof c.result === "string") s.hashes.set(c.params[0] as number, c.result);
    if (c.method === "state_getStorage") s.storage.set(`${c.params[1]} ${c.params[0]}`, c.result as string | null);
    if (c.method === "state_getMetadata") s.metadata.set(c.params[0] as string, c.result as string);
  }
  for (const b of Object.values(upgradeBlocks())) {
    const below = s.hashes.get(b.height - 1);
    s.headers.set(b.hash, { number: b.height, parentHash: below ?? parentOf(b.hash) });
  }
  const md = s.metadata.get(newRuntimeMetadataAt);
  if (md === undefined) throw new Error("the upgrade recording holds no metadata at that block");
  for (const h of newRuntimeBlocks) if (s.headers.get(h)?.parentHash === parentOf(h)) s.metadata.set(parentOf(h), md);
  return s;
}

/** A copy of a script, to change one answer in a test. */
export function copyScript(s: Script): Script {
  return { head: s.head, headers: new Map(s.headers), hashes: new Map(s.hashes), storage: new Map(s.storage), metadata: new Map(s.metadata) };
}
