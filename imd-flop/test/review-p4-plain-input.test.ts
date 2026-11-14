/**
 * Review of P4 (reviewer): plainInput with a refuse that does not throw (attack 2), and what is frozen (P12, L3).
 *
 * plain-input.ts types refuse as `=> never` and its doc says "it throws and never returns". Nothing in the module
 * holds that: after each refuse call the check goes on and returns. P2 says the module never returns a value it
 * should have refused.
 */
import { describe, expect, it } from "vitest";
import * as auth from "../src/channel/auth.js";
import * as bytes from "../src/channel/bytes.js";
import * as errors from "../src/channel/errors.js";
import * as key from "../src/channel/key.js";
import * as transcript from "../src/channel/transcript.js";
import { plainInput, type PlainInputRefuse } from "../src/plain-input.js";

/** A refuse that records the code and returns, as a careless user might write it. */
function returning(): { refuse: PlainInputRefuse; codes: string[] } {
  const codes: string[] = [];
  return { refuse: ((code: string) => void codes.push(code)) as unknown as PlainInputRefuse, codes };
}

/** What a call gave: "returned" when it returned after refusing, else what it threw. */
function after(f: () => unknown): string {
  try {
    f();
    return "returned";
  } catch (e) {
    return `threw ${(e as Error).constructor.name}`;
  }
}

describe("attack 2: a refuse that returns", () => {
  const cases: [string, (p: ReturnType<typeof plainInput>) => unknown][] = [
    ["bytesOf of a Uint16Array", (p) => p.bytesOf(new Uint16Array(16), 32, "x")],
    ["bytesOf of 3 bytes where 32 are wanted", (p) => p.bytesOf(new Uint8Array(3), 32, "x")],
    ["uintOf u32 of 2^40", (p) => p.uintOf("u32", 2 ** 40, "x")],
    ["uintOf u64 of a text", (p) => p.uintOf("u64", "5", "x")],
    ["uintOf u128 of -1n", (p) => p.uintOf("u128", -1n, "x")],
    ["takeFields with an extra field", (p) => p.takeFields({ a: 1, b: 2 }, ["a"], "x")],
    ["ownValue of an accessor", (p) => p.ownValue(Object.defineProperty({}, "a", { get: () => 1 }), "a", "x")],
  ];
  for (const [name, call] of cases) {
    it(`HOLDS (was DEFECT R1): ${name}: after refuse was called, the check hands back nothing`, () => {
      const { refuse, codes } = returning();
      const got = after(() => call(plainInput(refuse)));
      expect(codes.length).toBeGreaterThan(0); // control: the check did refuse
      expect(got).not.toBe("returned");
    });
  }

  it("HOLDS: a refuse that throws a value that is not an Error: that value reaches the caller as it was thrown", () => {
    const thrown = Object.freeze({ not: "an error" });
    const p = plainInput((() => {
      throw thrown;
    }) as PlainInputRefuse);
    let got: unknown;
    try {
      p.bytesOf("x", 32, "x");
    } catch (e) {
      got = e;
    }
    expect(got).toBe(thrown);
  });
});

describe("P12: every exported object is frozen where it is defined, functions and classes included (the lead's rule)", () => {
  it("HOLDS (was DEFECT R2): (L3) ChannelError and its prototype are frozen", () => {
    expect({ class: Object.isFrozen(errors.ChannelError), prototype: Object.isFrozen(errors.ChannelError.prototype) }).toEqual({ class: true, prototype: true });
  });

  it("control: an open prototype lets any importer change what every refusal shows", () => {
    // Shown on a class of the test's own, so the real prototype is left as it is.
    class Probe extends Error {}
    Object.defineProperty(Probe.prototype, "toJSON", { value: () => ({ said: "changed" }), configurable: true });
    expect(JSON.stringify(new Probe("x"))).toBe('{"said":"changed"}');
  });

  const modules: Record<string, Record<string, unknown>> = { errors, bytes, transcript, auth, key };
  for (const [name, mod] of Object.entries(modules)) {
    it(`HOLDS (was DEFECT R3): every function exported by src/channel/${name}.ts is frozen, and so is its prototype`, () => {
      const open: string[] = [];
      for (const [k, v] of Object.entries(mod)) {
        if (typeof v !== "function") continue;
        if (!Object.isFrozen(v)) open.push(k);
        const proto = (v as { prototype?: unknown }).prototype;
        if (proto !== undefined && !Object.isFrozen(proto)) open.push(`${k}.prototype`);
      }
      expect(open).toEqual([]);
    });
  }

  it("HOLDS (was DEFECT R3): the four functions of a channel key are frozen", () => {
    const k = key.channelKeyFromSeed({ seed: new Uint8Array(32).fill(1) });
    expect(Object.entries(k).filter(([, f]) => !Object.isFrozen(f)).map(([n]) => n)).toEqual([]);
  });

  it("HOLDS (was DEFECT R3): the five functions plainInput returns, and plainInput itself, are frozen", () => {
    const p = plainInput(errors.refuse);
    expect([...Object.entries(p).filter(([, f]) => !Object.isFrozen(f)).map(([n]) => n), ...(Object.isFrozen(plainInput) ? [] : ["plainInput"])]).toEqual([]);
  });
});
