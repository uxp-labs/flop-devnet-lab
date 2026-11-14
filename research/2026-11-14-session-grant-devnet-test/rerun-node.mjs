// A scripted FLOP node for the tests of this folder, answering only from the observatory's committed
// recording of the session rerun, observatory/fixtures/recording-20261112132634-0a472f1b49f7b661. It
// is made as imd-flop/test/lib/recorded-node.ts rerunScript makes its node, said here because that
// file is TypeScript of the tool's tests and is not imported:
//  - chain_getHeader. The recording holds no header. A header's number is the height the recording's
//    inputs give for that hash, and its parent hash is a stand in, parentOf(hash), the sha256 of the
//    text "the parent of <hash>", exactly as recorded-node.ts parentOf makes it.
//  - state_getMetadata at a stand in parent answers the 1014020 metadata, read by
//    imd-flop/scripts/chain-table.mjs readSource(SOURCES[0]) as recorded-node.ts metadata1014020 does.
//    Every rerun block was executed by 1014020 (results.json last_runtime_upgrade_spec).
//  - chain_getFinalizedHead answers a recorded block the test names.
// A question the recording holds no answer to is a node error, never a default. A test that needs
// a value the recording does not hold (the pair absent before the first grant: the recording reads
// no session key at A1) sets it with `set`, and says so.
// Not a test file itself. No socket, no network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, readJson } from "./lib.mjs";

export const RECORDING = "observatory/fixtures/recording-20261112132634-0a472f1b49f7b661";
export const RERUN = readJson(join(REPO, "research/2026-11-12-session-rerun-1014020/results.json"));
export const rerunStep = (id) => RERUN.steps.find((s) => s.step === id) ?? (() => { throw new Error(`the rerun has no step ${id}`); })();

/** The stand in parent hash, as recorded-node.ts parentOf makes it. */
export const parentOf = (hash) => `0x${createHash("sha256").update(`the parent of ${hash}`).digest("hex")}`;

const { readSource, SOURCES } = await import(pathToFileURL(join(REPO, "imd-flop", "scripts", "chain-table.mjs")).href);
let md = null;
/** The 1014020 metadata as 0x hex, read once. */
export const metadataHex = () => (md ??= `0x${Buffer.from(readSource(SOURCES[0]).metadata).toString("hex")}`);

const tape = readFileSync(join(REPO, RECORDING, "tape.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
  .filter((o) => o.request?.kind === "rpc" && "result" in (o.answer ?? {}));
const inputs = readJson(join(REPO, RECORDING, "requests-inputs.json"));

/** A node over the recording whose finalized head is the block of a rerun step. */
export function rerunNode(headStep) {
  const hashes = new Map(), storage = new Map(), headers = new Map(), metadata = new Map();
  for (const c of tape) {
    if (c.request.method === "chain_getBlockHash" && typeof c.answer.result === "string") hashes.set(c.request.params[0], c.answer.result);
    if (c.request.method === "state_queryStorageAt") for (const set of c.answer.result) for (const [k, v] of set.changes) storage.set(`${set.block} ${k}`, v);
  }
  for (const b of Object.values(inputs.blocks)) {
    headers.set(b.hash.value, { number: b.height.value, parentHash: parentOf(b.hash.value) });
    metadata.set(parentOf(b.hash.value), true);
  }
  const head = rerunStep(headStep).block_hash;
  const log = [];
  const answer = (method, params) => {
    log.push({ method, params });
    const p0 = params[0];
    switch (method) {
      case "chain_getFinalizedHead": return head;
      case "chain_getHeader": { const h = headers.get(p0); return h === undefined ? null : { number: `0x${h.number.toString(16)}`, parentHash: h.parentHash, stateRoot: p0, extrinsicsRoot: p0, digest: { logs: [] } }; }
      case "chain_getBlockHash": return hashes.get(p0) ?? null;
      case "state_getStorage": { const k = `${params[1]} ${p0}`; if (!storage.has(k)) throw { code: -32000, message: "the recording holds no answer for this key at this block" }; return storage.get(k); }
      case "state_getMetadata": if (!metadata.has(p0)) throw { code: -32000, message: "the recording holds no metadata at this block" }; return metadataHex();
      default: throw { code: -32601, message: `the recording holds no ${method}` };
    }
  };
  return {
    head, log, answer,
    /** Sets the answer for a key at the head: a value the recording does not hold, said by the test that sets it. */
    set: (key, value) => { storage.set(`${head} ${key}`, value); },
    /** A block of the recording by its rerun step. */
    blockOf: (id) => ({ number: rerunStep(id).finalized_in_block, hash: rerunStep(id).block_hash }),
  };
}

/**
 * A WebSocket that answers JSON-RPC frames from a scripted node, as pane-runner.js wsTransport talks
 * to one: it opens, takes frames by send, and answers each in a later turn.
 */
export function fakeWebSocket(node) {
  return class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      setTimeout(() => {
        let reply;
        try { reply = { jsonrpc: "2.0", id: m.id, result: node.answer(m.method, m.params) }; } catch (e) { reply = { jsonrpc: "2.0", id: m.id, error: e }; }
        this.onmessage?.({ data: JSON.stringify(reply) });
      }, 0);
    }
    close() { this.readyState = 3; }
  };
}
