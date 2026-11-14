/**
 * Shared inputs of the session command tests (P5b). Every value comes from a committed file:
 *  - the owner S and the delegates: research/2026-11-12-session-rerun-1014020/results.json `accounts.owner`,
 *    `accounts.dev1`, `accounts.dev2` (public_key and ss58);
 *  - the recorded states: the observatory recording the rerun made (test/lib/recorded-node.ts rerunScript), at the
 *    block of a step of that results.json (`steps[i].block_hash`);
 *  - the local caps of a test seat: the recorded grant's per_tx_limit and daily_cap from the step's SessionCreated
 *    event fields, as FLOP.
 * A test seat has an identity file that names a delegate's public key as a did:key, and no key file: an identity is
 * public data, and the session commands read no key. Nothing here opens a socket.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountOf, sessionKeys } from "../../src/chain-read/keys.js";
import { KEY_TABLE } from "../../src/chain-read/key-table.js";
import { hexOf } from "../../src/chain-read/bytes.js";
import { SESSION_FIELDS, CIRCUIT_BREAKER_FIELDS } from "../../src/chain-read/session-state.js";
import type { Transport } from "../../src/chain-read/node.js";
import { didKeyFromPub, ss58Encode } from "../../src/ss58.js";
import { cli, tmpHome } from "../helpers.js";
import { copyScript, RERUN_RESULTS, repoJson, rerunScript, type Script, transportOf } from "./recorded-node.js";

export const RESULTS = repoJson(RERUN_RESULTS);
export const stepOf = (id: string) => (RESULTS.steps as any[]).find((s) => s.step === id);
export const OWNER = RESULTS.accounts.owner as { public_key: string; ss58: string };
export const DEV1 = RESULTS.accounts.dev1 as { public_key: string; ss58: string };
export const DEV2 = RESULTS.accounts.dev2 as { public_key: string; ss58: string };
export const SEAT = "42";

export const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

/** A FLOP amount from a raw decimal string, through its millionths, so it is the nearest double to the exact value. */
export const flopOf = (raw: string): number => Number(BigInt(raw) / 10n ** 12n) / 1e6;

/** The recorded grant's fields of a step: its SessionCreated event. */
export const createdOf = (id: string): Record<string, string> => stepOf(id).events.find((e: any) => e.pallet === "FlopSessionKeys" && e.name === "SessionCreated").fields;

/** A home with seat 42, its identity naming the delegate's public key, no key file, and the caps given (or the A2 grant's). */
export function seatHome(delegate: { public_key: string } = DEV1, caps: { daily: unknown; perCall: unknown } | null = capsOfGrant("A2")): string {
  const home = tmpHome();
  const pub = unhex(delegate.public_key);
  mkdirSync(join(home, "seats", SEAT), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "seats", SEAT, "identity.json"), JSON.stringify({ v: 0, seat: SEAT, network: "devnet", did: didKeyFromPub(pub), ss58: ss58Encode(pub, 42), ss58Prefix: 42, createdAt: "recorded" }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ network: "devnet", seat: SEAT, payer: "holder", caps: caps === null ? {} : { [SEAT]: caps } }));
  return home;
}

/** The local caps equal to a recorded grant's per_tx_limit and daily_cap. */
export function capsOfGrant(id: string): { daily: number; perCall: number } {
  const f = createdOf(id);
  return { daily: flopOf(f.daily_cap), perCall: flopOf(f.per_tx_limit) };
}

/** The rerun's recording as a node whose finalized head is a step's block. */
export const scriptAt = (id: string): Script => rerunScript(stepOf(id).block_hash);

/** Runs a session command against a scripted node. */
export const session = (home: string, args: string[], transport: Transport) => cli(home, ["session", ...args], { transport });

/** The storage keys of the pair's three entries at the 1014020 line, as 0x hex. */
export function keysOf(owner: string, delegate: string): { sessions: string; nonces: string; breakers: string } {
  const line = KEY_TABLE.runtimes.find((r) => r.specVersion === RESULTS.spec_version)!;
  const k = (sessionKeys(line, (accountOf(owner) as any).value, (accountOf(delegate) as any).value) as any).value;
  return { sessions: hexOf(k.sessions.key), nonces: hexOf(k.sessionNonces.key), breakers: hexOf(k.circuitBreakers.key) };
}

/** The byte width of a fixed field of the session record or the breaker, by the reader's own field types. */
const WIDTH: Record<string, number> = { u32: 4, u128: 16, bytes: 32, bool: 1 };

/** The offset and width of a fixed width field, from the reader's field lists, in the order the shape states them. */
function fieldAt(fields: readonly { name: string; type: { kind: string } }[], name: string): { offset: number; width: number } {
  let offset = 0;
  for (const f of fields) {
    const width = WIDTH[f.type.kind];
    if (width === undefined) throw new Error(`the field ${f.name} has no fixed width; ${name} is past it`);
    if (f.name === name) return { offset, width };
    offset += width;
  }
  throw new Error(`no field ${name}`);
}

const le = (v: bigint, width: number): string => {
  let h = "";
  for (let i = 0; i < width; i++) h += ((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
  return h;
};

/** A copy of a script whose answer for a key at the head has one fixed width field set to a value (said by the test). */
export function withField(s: Script, key: string, record: "session" | "breaker", field: string, value: bigint): Script {
  const c = copyScript(s);
  const k = `${s.head} ${key}`;
  const old = c.storage.get(k);
  if (typeof old !== "string") throw new Error("the recording holds no value for that key at the head");
  const { offset, width } = fieldAt(record === "session" ? SESSION_FIELDS : CIRCUIT_BREAKER_FIELDS, field);
  const body = old.slice(2);
  c.storage.set(k, `0x${body.slice(0, 2 * offset)}${le(value, width)}${body.slice(2 * (offset + width))}`);
  return c;
}

/** A copy of a script whose session record at the head has an empty allow list (the record's last byte is `active`). */
export function withEmptyAllowList(s: Script, key: string): Script {
  const c = copyScript(s);
  const k = `${s.head} ${key}`;
  const body = (c.storage.get(k) as string).slice(2);
  const { offset, width } = fieldAt(SESSION_FIELDS, "expires_at");
  const listAt = 2 * (offset + width);
  c.storage.set(k, `0x${body.slice(0, listAt)}00${body.slice(-2)}`);
  return c;
}

/** A copy of a script whose node holds no value for a key at the head. */
export function withNone(s: Script, key: string): Script {
  const c = copyScript(s);
  c.storage.set(`${s.head} ${key}`, null);
  return c;
}

export { copyScript, transportOf };
