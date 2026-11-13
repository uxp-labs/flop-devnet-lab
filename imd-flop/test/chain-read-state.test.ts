/**
 * P2, rules C4 and C3: the door's decoded values turned into imd-flop's own types. The base values are the door's
 * decode of the recorded answers at the rerun's step A6; each test changes one thing the test names.
 */
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { type DoorValue, runtimeOf, valueOf } from "../src/chain-read/door.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { accountOf, lastRuntimeUpgradeKey, sessionKeys } from "../src/chain-read/keys.js";
import { CIRCUIT_BREAKER_FIELDS, circuitBreakerOf, SESSION_FIELDS, sessionNonceOf, sessionOf } from "../src/chain-read/session-state.js";
import { shapeFileText } from "../src/chain-read/shape-file.js";
import { RERUN_RESULTS, repoJson, rerunScript } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const LINE = KEY_TABLE.runtimes[0] as (typeof KEY_TABLE.runtimes)[number];
const acc = (h: string) => (accountOf(h) as { value: Uint8Array }).value;

/** The door's decoded values of the three entries at A6, from the recording. */
function decodedAtA6(): { session: Record<string, DoorValue>; nonce: DoorValue; breaker: Record<string, DoorValue> } {
  const s = rerunScript(A6.block_hash);
  const lru = bytesOf(s.storage.get(`${A6.block_hash} ${hexOf(lastRuntimeUpgradeKey())}`) as string);
  const runtime = (runtimeOf(lru) as any).value;
  const pin = { runtime, metadata: bytesOf(s.metadata.values().next().value as string), lastRuntimeUpgrade: lru, shapeText: (shapeFileText(runtime.shapeFile) as any).value };
  const k = (sessionKeys(LINE, acc(RESULTS.accounts.owner.public_key), acc(RESULTS.accounts.dev1.public_key)) as any).value;
  const v = (e: string, key: { key: Uint8Array; parts: Uint8Array[] }) => (valueOf(pin, { pallet: "FlopSessionKeys", entry: e, keys: key.parts, key: key.key, answer: bytesOf(s.storage.get(`${A6.block_hash} ${hexOf(key.key)}`) as string) }) as any).value;
  return { session: v("Sessions", k.sessions), nonce: v("SessionNonces", k.sessionNonces), breaker: v("CircuitBreakers", k.circuitBreakers) };
}

describe("C4: the session record", () => {
  it("has exactly the fields the reviewed shape states, amounts as bigint, equal to the door's values", () => {
    const { session } = decodedAtA6();
    const r = sessionOf(LINE, session);
    expect(r.kind).toBe("known");
    const v = (r as any).value;
    expect(Object.keys(v)).toEqual(LINE.records.session.map((f) => f.name));
    for (const f of LINE.records.session) {
      if (f.type.kind === "u128" || f.type.kind === "u64") {
        expect(typeof v[f.name]).toBe("bigint");
        expect(String(v[f.name])).toBe(session[f.name]);
      } else expect(v[f.name]).toEqual(session[f.name]);
    }
  });

  it("this reader's fields are the shape's, in its order and with its types", () => {
    expect(SESSION_FIELDS).toEqual(LINE.records.session);
    expect(CIRCUIT_BREAKER_FIELDS).toEqual(LINE.records.circuitBreaker);
  });

  it("a field the shape does not state is unknown", () => {
    const { session } = decodedAtA6();
    const r = sessionOf(LINE, { ...session, extra: 1 });
    expect((r as any).reason).toMatch(/has the field extra, which the shape does not state/);
  });

  it("a field the shape states that is missing is unknown", () => {
    const { session } = decodedAtA6();
    const { spent: _, ...rest } = session;
    expect((sessionOf(LINE, rest) as any).reason).toMatch(/lacks the field spent/);
  });

  it("a value of another kind is unknown", () => {
    const { session } = decodedAtA6();
    for (const [f, v] of [["spent", 1], ["active", "true"], ["owner", 7], ["epoch_start", "3552729"], ["allowed_pallets", "0x00"], ["allowed_pallets", [1]]] as const) {
      expect([f, sessionOf(LINE, { ...session, [f]: v as DoorValue }).kind]).toEqual([f, "unknown"]);
    }
    expect(sessionOf(LINE, [session] as DoorValue).kind).toBe("unknown");
    expect(sessionOf(LINE, null).kind).toBe("unknown");
  });

  it("a number out of its range is unknown", () => {
    const { session } = decodedAtA6();
    expect(sessionOf(LINE, { ...session, spent: (1n << 128n).toString() }).kind).toBe("unknown");
    expect(sessionOf(LINE, { ...session, spent: ((1n << 128n) - 1n).toString() }).kind).toBe("known");
    expect(sessionOf(LINE, { ...session, expires_at: 2 ** 32 }).kind).toBe("unknown");
    expect(sessionOf(LINE, { ...session, expires_at: 2 ** 32 - 1 }).kind).toBe("known");
    expect(sessionOf(LINE, { ...session, expires_at: -1 }).kind).toBe("unknown");
    expect(sessionOf(LINE, { ...session, spent: "-1" }).kind).toBe("unknown");
    expect(sessionOf(LINE, { ...session, spent: "012" }).kind).toBe("unknown");
    expect(sessionOf(LINE, { ...session, owner: `${session.owner as string}00` }).kind).toBe("unknown");
  });

  it("a runtime whose shape states the record otherwise is unknown", () => {
    const { session } = decodedAtA6();
    const other = JSON.parse(JSON.stringify(LINE));
    other.records.session[2].type = { kind: "u64" };
    expect((sessionOf(other, session) as any).reason).toMatch(/states the session record otherwise/);
  });
});

describe("C4: the session nonce and the circuit breaker", () => {
  it("the nonce is a bigint equal to the door's value", () => {
    const { nonce } = decodedAtA6();
    const r = sessionNonceOf(LINE, nonce);
    expect(r.kind).toBe("known");
    expect(String((r as any).value)).toBe(nonce);
    expect(typeof (r as any).value).toBe("bigint");
    expect(sessionNonceOf(LINE, (1n << 64n).toString()).kind).toBe("unknown");
    expect(sessionNonceOf(LINE, 1).kind).toBe("unknown");
  });

  it("the circuit breaker has exactly its stated fields, total_spend as bigint", () => {
    const { breaker } = decodedAtA6();
    const r = circuitBreakerOf(LINE, breaker);
    expect(r.kind).toBe("known");
    expect(String((r as any).value.total_spend)).toBe(breaker.total_spend);
    expect(circuitBreakerOf(LINE, { ...breaker, more: true }).kind).toBe("unknown");
    expect(circuitBreakerOf(LINE, { ...breaker, tripped: 0 }).kind).toBe("unknown");
  });

  it("a runtime whose shape states the nonce or the breaker otherwise is unknown", () => {
    const { nonce, breaker } = decodedAtA6();
    const other = JSON.parse(JSON.stringify(LINE));
    other.records.sessionNonce = { kind: "u128" };
    other.records.circuitBreaker = other.records.circuitBreaker.slice(1);
    expect(sessionNonceOf(other, nonce).kind).toBe("unknown");
    expect(circuitBreakerOf(other, breaker).kind).toBe("unknown");
  });
});

describe("C3: the door's refusal is unknown with the door's words", () => {
  it("a shape file the package does not hold, or a name that is not a shape file's, is unknown", () => {
    expect(shapeFileText("shapes/none.json").kind).toBe("unknown");
    for (const bad of ["../package.json", "shapes/../package.json", "src/scale/block.ts", "/etc/passwd"]) expect(shapeFileText(bad).kind).toBe("unknown");
    expect(shapeFileText(LINE.shapeFile).kind).toBe("known");
  });

  it("bytes that are no LastRuntimeUpgrade record are unknown, quoting the decoder", () => {
    expect((runtimeOf(new Uint8Array([1, 2, 3])) as any).reason).toMatch(/^the decoder: no reviewed runtime/);
  });
});
