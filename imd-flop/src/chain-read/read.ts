/**
 * The two entry points of the chain reads (P2, rule C6), and no more:
 *  - readSessionState: a session's state at the finalized head, for an owner and a delegate. The finalized head is
 *    taken once and every other call is made at that one hash, so a head that moves between calls changes nothing.
 *  - readBlockEvents: the events of a named block, read only when the node reports it finalized and canonical: its
 *    number is at or below the finalized head's, and chain_getBlockHash(number) is its hash.
 * Each answers the block's number and hash and the runtime the door pinned beside the values. What is fetched is what
 * the door needs: System.LastRuntimeUpgrade at the block, the metadata at the block's PARENT (a block is in the
 * encoding of the runtime that executed it), the value of each entry at the block, and System.Events at the block.
 * The runtime must be on the decoder's reviewed list (C7); the encoder's table is not consulted here. Unknown is a
 * value: nothing here throws for what a chain or a node said, and nothing here can send.
 */
import { type DoorEvent, type Pin, type Runtime, eventsOf, runtimeOf, valueOf } from "./door.js";
import { accountOf, eventsKey, lastRuntimeUpgradeKey, lineOf, sessionKeys } from "./keys.js";
import { type Transport, blockHash, finalizedHead, header, metadata, storage } from "./node.js";
import { type Got, type Stored, known, unknown, within } from "./result.js";
import { type CircuitBreakerRecord, type SessionRecord, circuitBreakerOf, sessionNonceOf, sessionOf } from "./session-state.js";
import { shapeFileText } from "./shape-file.js";

/** The block a read was made at, and the runtime the door pinned for it. */
export interface At {
  readonly number: number;
  readonly hash: string;
  /** The reviewed runtime the door pinned: spec name, spec version and the shape file of its line. */
  readonly runtime: Runtime;
}

export interface SessionState extends At {
  readonly owner: string;
  readonly delegate: string;
  readonly session: Stored<SessionRecord>;
  readonly sessionNonce: Stored<bigint>;
  readonly circuitBreaker: Stored<CircuitBreakerRecord>;
}

export interface BlockEventsAt extends At {
  readonly events: readonly DoorEvent[];
}

/** The pin of a block: its runtime by its own LastRuntimeUpgrade, the metadata at its parent, the shape file. */
async function pinAt(t: Transport, hash: string, parentHash: string): Promise<Got<Pin>> {
  const lru = await storage(t, "lastRuntimeUpgrade", lastRuntimeUpgradeKey(), hash);
  if (lru.kind === "unknown") return within("System.LastRuntimeUpgrade", lru);
  if (lru.value === null) return unknown(`System.LastRuntimeUpgrade: the node holds no value at ${hash}, where one must be`);
  const runtime = runtimeOf(lru.value);
  if (runtime.kind === "unknown") return within("the runtime of the block", runtime);
  const md = await metadata(t, parentHash);
  if (md.kind === "unknown") return within("the metadata at the block's parent", md);
  const shape = shapeFileText(runtime.value.shapeFile);
  if (shape.kind === "unknown") return within("the shape file", shape);
  return known({ runtime: runtime.value, metadata: md.value, lastRuntimeUpgrade: lru.value, shapeText: shape.value });
}

const atOf = (number: number, hash: string, r: Runtime): At => ({ number, hash, runtime: { specName: r.specName, specVersion: r.specVersion, shapeFile: r.shapeFile } });

/** One entry's value at the block, turned into its record; absent stays absent. */
async function entryAt<T>(t: Transport, pin: Pin, at: string, what: Parameters<typeof storage>[1], read: { pallet: string; entry: string; key: Uint8Array; parts: readonly Uint8Array[] }, turn: (v: Parameters<typeof sessionOf>[1]) => Got<T>): Promise<Stored<T>> {
  const name = `${read.pallet}.${read.entry}`;
  const a = await storage(t, what, read.key, at);
  if (a.kind === "unknown") return within(name, a);
  const v = valueOf(pin, { pallet: read.pallet, entry: read.entry, keys: read.parts, key: read.key, answer: a.value });
  if (v.kind !== "known") return v.kind === "unknown" ? within(name, v) : v;
  const r = turn(v.value);
  return r.kind === "unknown" ? within(name, r) : r;
}

/** A session's state at the finalized head. owner and delegate are 0x and 32 bytes of lower case hex. */
export async function readSessionState(t: Transport, owner: string, delegate: string): Promise<Got<SessionState>> {
  const o = accountOf(owner);
  if (o.kind === "unknown") return within("the owner", o);
  const d = accountOf(delegate);
  if (d.kind === "unknown") return within("the delegate", d);
  const head = await finalizedHead(t);
  if (head.kind === "unknown") return within("the finalized head", head);
  const h = await header(t, head.value);
  if (h.kind === "unknown") return within("the finalized head's header", h);
  const pin = await pinAt(t, head.value, h.value.parentHash);
  if (pin.kind === "unknown") return pin;
  const line = lineOf(pin.value.runtime);
  if (line.kind === "unknown") return line;
  const keys = sessionKeys(line.value, o.value, d.value);
  if (keys.kind === "unknown") return keys;
  const L = line.value;
  const k = keys.value;
  const session = await entryAt(t, pin.value, head.value, "session", { ...L.entries.sessions, ...k.sessions }, (v) => sessionOf(L, v));
  const sessionNonce = await entryAt(t, pin.value, head.value, "sessionNonce", { ...L.entries.session_nonces, ...k.sessionNonces }, (v) => sessionNonceOf(L, v));
  const circuitBreaker = await entryAt(t, pin.value, head.value, "circuitBreaker", { ...L.entries.circuit_breakers, ...k.circuitBreakers }, (v) => circuitBreakerOf(L, v));
  return known({ ...atOf(h.value.number, head.value, pin.value.runtime), owner, delegate, session, sessionNonce, circuitBreaker });
}

/** The events of a named block, read only when the node reports it finalized and canonical. */
export async function readBlockEvents(t: Transport, block: { number: number; hash: string }): Promise<Got<BlockEventsAt>> {
  const head = await finalizedHead(t);
  if (head.kind === "unknown") return within("the finalized head", head);
  const hh = await header(t, head.value);
  if (hh.kind === "unknown") return within("the finalized head's header", hh);
  if (!Number.isSafeInteger(block.number) || block.number > hh.value.number) return unknown(`block ${block.number} is not at or below the finalized head ${hh.value.number}`);
  const canonical = await blockHash(t, block.number);
  if (canonical.kind === "unknown") return within("the canonical hash", canonical);
  if (canonical.value !== block.hash) return unknown(`block ${block.number} ${block.hash} is not canonical: the node's hash at ${block.number} is ${canonical.value}`);
  const h = await header(t, block.hash);
  if (h.kind === "unknown") return within("the block's header", h);
  if (h.value.number !== block.number) return unknown(`the header of ${block.hash} names block ${h.value.number}, not ${block.number}`);
  const pin = await pinAt(t, block.hash, h.value.parentHash);
  if (pin.kind === "unknown") return pin;
  const ev = await storage(t, "events", eventsKey(), block.hash);
  if (ev.kind === "unknown") return within("System.Events", ev);
  if (ev.value === null) return unknown(`System.Events: the node holds no value at ${block.hash}, where one must be`);
  const events = eventsOf(pin.value, ev.value);
  if (events.kind === "unknown") return within("System.Events", events);
  return known({ ...atOf(block.number, block.hash, pin.value.runtime), events: events.value });
}
