/**
 * Review of P2 (reviewer, not the builder): attack A, unknown is a value (R1, R6).
 *
 * Which test is which:
 *  - "DEFECT ..." tests state the promise and FAIL on fcf75d0.
 *  - "HOLDS ..." tests pass on fcf75d0 and pin what held, so the next reviewer does not repeat it.
 *
 * A scripted node answers from the rerun's committed recording (test/lib/recorded-node.ts) at results.json step A6;
 * one answer at a time is replaced by a JSON value the test names. No value read is compared with a typed value.
 */
import { describe, expect, it } from "vitest";
import { hexOf } from "../src/chain-read/bytes.js";
import { accountOf, eventsKey, lastRuntimeUpgradeKey, sessionKeys } from "../src/chain-read/keys.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { CAPS, type Transport } from "../src/chain-read/node.js";
import { readBlockEvents, readSessionState } from "../src/chain-read/read.js";
import { RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const AT = { number: A6.finalized_in_block as number, hash: A6.block_hash as string };
const LINE = KEY_TABLE.runtimes[0] as (typeof KEY_TABLE.runtimes)[number];
const K = (sessionKeys(LINE, (accountOf(OWNER) as any).value, (accountOf(DEV1) as any).value) as any).value;

const MISSING = Symbol("a missing answer (the transport resolves undefined)");

/** Every kind of JSON value, and a few texts made from the honest answer. */
const VALUES = (honest: unknown): [string, unknown][] => {
  const h = typeof honest === "string" ? honest : "0x00";
  return [
    ["a missing answer", MISSING],
    ["true", true],
    ["0", 0],
    ["1.5", 1.5],
    ['""', ""],
    ["upper case hex", /[a-f]/.test(h.slice(2)) ? `0x${h.slice(2).toUpperCase()}` : `${h.length > 3 ? h.slice(0, -2) : "0x"}AB`],
    ["an odd number of digits", h.length > 3 ? h.slice(0, -1) : "0x0"],
    ["an array", []],
    ["an array of the honest answer", [honest]],
    ["an object", {}],
    ["an object with keys of Object.prototype", JSON.parse('{"__proto__":{"number":"0x1"},"constructor":"x","toString":"0x00","valueOf":"0x00"}')],
  ];
};

type Pick = (method: string, params: readonly unknown[]) => boolean;

function replacing(pick: Pick, value: unknown): Transport {
  const base = transportOf(rerunScript(A6.block_hash));
  return async (m, p) => (pick(m, p) ? (value === MISSING ? undefined : value) : base(m, p));
}

async function honestOf(pick: Pick): Promise<unknown> {
  const base = transportOf(rerunScript(A6.block_hash));
  let got: unknown;
  const t: Transport = async (m, p) => {
    const a = await base(m, p);
    if (pick(m, p)) got = a;
    return a;
  };
  await readBlockEvents(t, AT);
  await readSessionState(t, OWNER, DEV1);
  return got;
}

const storageOf = (key: Uint8Array): Pick => (m, p) => m === "state_getStorage" && p[0] === hexOf(key);

/** The answers whose change makes a whole read unknown. */
const WHOLE: [string, Pick][] = [
  ["chain_getFinalizedHead", (m) => m === "chain_getFinalizedHead"],
  ["chain_getHeader", (m) => m === "chain_getHeader"],
  ["chain_getBlockHash", (m) => m === "chain_getBlockHash"],
  ["state_getMetadata", (m) => m === "state_getMetadata"],
  ["System.LastRuntimeUpgrade", storageOf(lastRuntimeUpgradeKey())],
];

/** The answers whose change makes one entry unknown. */
const ENTRIES: [string, "session" | "sessionNonce" | "circuitBreaker", Pick][] = [
  ["Sessions", "session", storageOf(K.sessions.key)],
  ["SessionNonces", "sessionNonce", storageOf(K.sessionNonces.key)],
  ["CircuitBreakers", "circuitBreaker", storageOf(K.circuitBreakers.key)],
];

describe("A: every JSON value for each answer", () => {
  for (const [name, pick] of WHOLE) {
    it(`HOLDS ${name}: every value is unknown with a reason for both reads, and nothing throws`, async () => {
      const honest = await honestOf(pick);
      for (const [what, v] of VALUES(honest)) {
        const t = replacing(pick, v);
        const s = await readSessionState(t, OWNER, DEV1);
        const e = await readBlockEvents(t, AT);
        // chain_getBlockHash is asked only by readBlockEvents.
        if (name !== "chain_getBlockHash") expect([what, s.kind]).toEqual([what, "unknown"]);
        expect([what, e.kind]).toEqual([what, "unknown"]);
        for (const r of [s, e]) if (r.kind === "unknown") expect(r.reason.length).toBeGreaterThan(0);
      }
    });
  }

  it("HOLDS System.Events: every value is unknown for the events read", async () => {
    const pick = storageOf(eventsKey());
    for (const [what, v] of VALUES(await honestOf(pick))) expect([what, (await readBlockEvents(replacing(pick, v), AT)).kind]).toEqual([what, "unknown"]);
  });

  for (const [name, field, pick] of ENTRIES) {
    it(`HOLDS ${name}: every value but null leaves the entry unknown, the other two known`, async () => {
      for (const [what, v] of VALUES(await honestOf(pick))) {
        const r = await readSessionState(replacing(pick, v), OWNER, DEV1);
        expect([what, r.kind]).toEqual([what, "known"]);
        expect([what, (r as any).value[field].kind]).toEqual([what, "unknown"]);
        for (const other of ["session", "sessionNonce", "circuitBreaker"].filter((f) => f !== field)) expect([what, other, (r as any).value[other].kind]).toEqual([what, other, "known"]);
      }
    });
  }
});

describe('A: "0x", an answer of no bytes', () => {
  for (const [name, pick] of WHOLE.filter(([n]) => n === "state_getMetadata" || n === "System.LastRuntimeUpgrade")) {
    it(`HOLDS ${name} "0x" is unknown (for metadata, the session read is known with each of its three entries unknown by the door's words)`, async () => {
      const s = await readSessionState(replacing(pick, "0x"), OWNER, DEV1);
      if (s.kind === "known") for (const f of ["session", "sessionNonce", "circuitBreaker"]) expect([f, (s.value as any)[f].kind]).toEqual([f, "unknown"]);
      else expect(s.kind).toBe("unknown");
      expect((await readBlockEvents(replacing(pick, "0x"), AT)).kind).toBe("unknown");
    });
  }
  it('HOLDS System.Events "0x" is unknown', async () => {
    expect((await readBlockEvents(replacing(storageOf(eventsKey()), "0x"), AT)).kind).toBe("unknown");
  });
  for (const [name, field, pick] of ENTRIES) {
    it(`HOLDS ${name} "0x" is unknown, not absent and not a default`, async () => {
      expect(((await readSessionState(replacing(pick, "0x"), OWNER, DEV1)) as any).value[field].kind).toBe("unknown");
    });
  }
});

describe("A: one byte over and one byte under each cap", () => {
  for (const [name, field, pick, cap] of [...ENTRIES.map(([n, f, p]) => [n, f, p, CAPS[f]] as const)]) {
    it(`HOLDS ${name}: ${cap + 1} bytes is over its cap; ${cap} bytes of zeros reaches the door (unknown for Sessions, a whole value for the fixed size entries)`, async () => {
      const over = await readSessionState(replacing(pick, `0x${"00".repeat(cap + 1)}`), OWNER, DEV1);
      expect((over as any).value[field].reason).toMatch(/more than its cap/);
      const under = await readSessionState(replacing(pick, `0x${"00".repeat(cap)}`), OWNER, DEV1);
      const u = (under as any).value[field];
      if (field === "session") expect(u.kind).toBe("unknown");
      else expect([u.kind, u.stored]).toEqual(["known", true]);
      if (u.kind === "unknown") expect(u.reason).not.toMatch(/more than its cap/);
    });
  }
  it("HOLDS System.LastRuntimeUpgrade one byte over its cap is unknown", async () => {
    const r = await readSessionState(replacing(storageOf(lastRuntimeUpgradeKey()), `0x${"00".repeat(CAPS.lastRuntimeUpgrade + 1)}`), OWNER, DEV1);
    expect((r as any).reason).toMatch(/more than its cap/);
  });
});

describe("A: a header", () => {
  const head = (h: unknown): Pick => (m) => m === "chain_getHeader" && h !== undefined;
  const honestHeader = async () => (await honestOf((m) => m === "chain_getHeader")) as Record<string, unknown>;
  it("HOLDS the number as a JSON number, with a leading zero, above a u32, negative, and in upper case are unknown", async () => {
    const h = await honestHeader();
    const n = h.number as string;
    for (const number of [Number.parseInt(n, 16), `0x0${n.slice(2)}`, "0x100000000", `-${n}`, `0x${n.slice(2, -1)}A`, "0x"]) {
      const r = await readSessionState(replacing(head(h), { ...h, number }), OWNER, DEV1);
      expect([number, r.kind]).toEqual([number, "unknown"]);
    }
  });
  it("HOLDS a parent hash that is the block's own: on a block that is not an upgrade, the metadata at the block is asked, and the door pins it (the same runtime)", async () => {
    const h = await honestHeader();
    // Recorded: the rerun's scripted node holds metadata only at the stand in parents, so the read is unknown here.
    const r = await readSessionState(replacing(head(h), { ...h, parentHash: A6.block_hash }), OWNER, DEV1);
    expect(r.kind).toBe("unknown");
  });
});

describe("A: the transport itself", () => {
  const reasonOf = (g: any) => g.reason ?? "";
  it("HOLDS a thrown text, a thrown null, and a promise rejected with nothing are unknown", async () => {
    for (const thrown of ["boom", null, undefined, 7, { message: "an object, not an Error" }]) {
      const t: Transport = () => Promise.reject(thrown);
      const r = await readSessionState(t, OWNER, DEV1);
      expect(r.kind).toBe("unknown");
      expect(reasonOf(r)).toBe("the finalized head: chain_getFinalizedHead: the transport failed");
    }
  });

  it("DEFECT a thrown Error whose message getter throws is unknown, and the read does not throw (fails on fcf75d0)", async () => {
    const e = new Error("x");
    Object.defineProperty(e, "message", {
      get() {
        throw new Error("the getter");
      },
    });
    const t: Transport = () => Promise.reject(e);
    let r: unknown;
    let threw = false;
    try {
      r = await readSessionState(t, OWNER, DEV1);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect((r as any)?.kind).toBe("unknown");
  });

  it("DEFECT a header the transport answers that JSON.stringify cannot write (a bigint) is unknown, and the read does not throw (fails on fcf75d0)", async () => {
    const h = (await honestOf((m) => m === "chain_getHeader")) as Record<string, unknown>;
    let threw = false;
    let r: unknown;
    try {
      r = await readSessionState(replacing((m) => m === "chain_getHeader", { ...h, extra: 1n }), OWNER, DEV1);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect((r as any)?.kind).toBe("unknown");
  });
});
