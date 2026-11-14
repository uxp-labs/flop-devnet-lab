/**
 * The storage keys of the chain reads (P2, rule C2): System.Events, System.LastRuntimeUpgrade,
 * FlopSessionKeys.Sessions(owner, delegate), FlopSessionKeys.SessionNonces(owner, delegate) and
 * FlopSessionKeys.CircuitBreakers(delegate). The two fixed 16 byte parts of each key come from the frozen table
 * key-table.ts, which scripts/read-key-table.mjs derives from the committed shape and recorded metadata. The
 * account parts are hashed here with @noble/hashes, the one hasher the table names (Blake2_128Concat). The door
 * then builds the whole key again with the observatory's own lines and refuses one that differs. Pure.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { bytesOf, isHex } from "./bytes.js";
import type { Runtime } from "./door.js";
import { KEY_TABLE } from "./key-table.js";
import type { EntryLine, RuntimeLine } from "./key-table-types.js";
import { type Got, known, unknown } from "./result.js";
import { freezeFunction } from "../freeze.js";

/** A storage key and the SCALE bytes of each of its account parts, in key order, as the door takes them. */
export interface Key {
  readonly key: Uint8Array;
  readonly parts: readonly Uint8Array[];
}

/** The hashers this file computes, by the shape file's names. */
const HASHERS: Readonly<Record<string, (part: Uint8Array) => Uint8Array>> = Object.freeze({
  Blake2_128Concat: (part: Uint8Array) => concatBytes(blake2b(part, { dkLen: 16 }), part),
});

/** An account: 0x and 32 bytes of lower case hex. */
export function accountOf(text: unknown): Got<Uint8Array> {
  if (!isHex(text) || text.length !== 66) return unknown("an account is 0x and 32 bytes of lower case hex");
  return known(bytesOf(text));
}
freezeFunction(accountOf);

/** The key of an entry with these account parts, or unknown when the parts are not as many as its hashers, or a hasher is not one computed here. */
export function keyOf(line: EntryLine, accounts: readonly Uint8Array[]): Got<Key> {
  if (accounts.length !== line.hashers.length) return unknown(`${line.pallet}.${line.entry} takes ${line.hashers.length} key parts, not ${accounts.length}`);
  const hashed: Uint8Array[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const h = HASHERS[line.hashers[i] as string];
    const a = accounts[i] as Uint8Array;
    if (h === undefined) return unknown(`${line.pallet}.${line.entry}: the hasher ${line.hashers[i]} is not one chain-read computes`);
    if (a.length !== 32) return unknown(`${line.pallet}.${line.entry}: key part ${i} is not a 32 byte account`);
    hashed.push(h(a));
  }
  return known({ key: concatBytes(bytesOf(line.palletPart), bytesOf(line.entryPart), ...hashed), parts: accounts.map((a) => Uint8Array.from(a)) });
}
freezeFunction(keyOf);

/** The key of System.Events, the same for every runtime of the table. */
export const eventsKey = (): Uint8Array => (keyOf(KEY_TABLE.system.events, []) as { value: Key }).value.key;
freezeFunction(eventsKey);

/** The key of System.LastRuntimeUpgrade, the same for every runtime of the table. */
export const lastRuntimeUpgradeKey = (): Uint8Array => (keyOf(KEY_TABLE.system.last_runtime_upgrade, []) as { value: Key }).value.key;
freezeFunction(lastRuntimeUpgradeKey);

/** The table's line of a runtime the door named, or unknown when the table holds none for it or names another shape file. */
export function lineOf(runtime: Runtime): Got<RuntimeLine> {
  const line = KEY_TABLE.runtimes.find((r) => r.specName === runtime.specName && r.specVersion === runtime.specVersion);
  if (line === undefined) return unknown(`chain-read's key table holds no line for spec ${runtime.specName} ${runtime.specVersion}`);
  if (line.shapeFile !== runtime.shapeFile) return unknown(`chain-read's key table line for spec ${runtime.specVersion} names ${line.shapeFile}, not the reviewed ${runtime.shapeFile}`);
  return known(line);
}
freezeFunction(lineOf);

/** The three keys of one session, by the owner and the delegate. */
export interface SessionKeys {
  readonly sessions: Key;
  readonly sessionNonces: Key;
  readonly circuitBreakers: Key;
}

export function sessionKeys(line: RuntimeLine, owner: Uint8Array, delegate: Uint8Array): Got<SessionKeys> {
  const s = keyOf(line.entries.sessions, [owner, delegate]);
  if (s.kind === "unknown") return s;
  const n = keyOf(line.entries.session_nonces, [owner, delegate]);
  if (n.kind === "unknown") return n;
  const c = keyOf(line.entries.circuit_breakers, [delegate]);
  if (c.kind === "unknown") return c;
  return known({ sessions: s.value, sessionNonces: n.value, circuitBreakers: c.value });
}
freezeFunction(sessionKeys);
