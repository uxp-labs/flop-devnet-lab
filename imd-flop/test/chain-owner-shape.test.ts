/**
 * P5a, rules O4 and O5: a table entry is fit for the owner's calls only by a check of its own, and the five session
 * calls refuse a field of the new kind. Each case replaces runtimes.ts with one forged entry in a fresh module
 * graph, as test/chain-refusals.test.ts does for the session path.
 */
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../src/chain/table.js";
import { encodeSessionCall } from "../src/chain/extrinsic.js";
import { encodeOwnerCall } from "../src/chain/owner-calls.js";
import { OWNER, readJson, results, RT, RUNTIME_ID, sampleInner, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const A2 = (results.steps as { step: string; call: string; finalized_in_block: number; events: { name: string; fields: Record<string, string | number> }[] }[]).find((s) => s.step === "A2")!;
const created = A2.events.find((e) => e.name === "SessionCreated")!.fields;
const GRANT = {
  runtime: RUNTIME_ID,
  call: "create_session" as const,
  delegate: unhex(created.delegate as string),
  spending_cap: BigInt(created.spending_cap),
  per_tx_limit: BigInt(created.per_tx_limit),
  daily_cap: BigInt(created.daily_cap),
  duration_blocks: (created.expires_at as number) - A2.finalized_in_block,
};
const REVOKE = { runtime: RUNTIME_ID, call: "revoke_session" as const, delegate: GRANT.delegate };
const facts = readJson("research/2026-11-12-session-rerun-1014020/facts-1014020.json");

type Mutable = { -readonly [K in keyof Runtime]: any };
const copy = () => structuredClone(RT) as unknown as Mutable;
const entry = (rt: Mutable, name: string) => rt.calls.find((c: { name: string }) => c.name === name);
const constant = (rt: Mutable, name: string) => rt.constants.find((c: { name: string }) => c.name === name);

/** The owner functions and the session functions, against a forged table. */
async function withTable(rt: unknown) {
  vi.resetModules();
  vi.doMock("../src/chain/runtimes.js", () => ({ RUNTIMES: [rt] }));
  const o = await import("../src/chain/owner-calls.js");
  const r = await import("../src/chain/reader.js");
  const d = await import("../src/chain/describe.js");
  const x = await import("../src/chain/extrinsic.js");
  const e = await import("../src/chain/errors.js");
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      return err instanceof e.ChainEncodeError ? err.refusal : `not a ChainEncodeError: ${String(err)}`;
    }
    return null;
  };
  return { o, r, d, x, code };
}
function done() {
  vi.doUnmock("../src/chain/runtimes.js");
  vi.resetModules();
}

/** Every owner function refuses the forged table with RUNTIME_UNKNOWN; the session path still works. */
async function ownerRefused(rt: unknown) {
  const t = await withTable(rt);
  try {
    const bytes = encodeOwnerCall(GRANT);
    expect(t.code(() => t.o.encodeOwnerCall(GRANT))).toBe("RUNTIME_UNKNOWN");
    expect(t.code(() => t.o.encodeOwnerCall(REVOKE))).toBe("RUNTIME_UNKNOWN");
    expect(t.code(() => t.r.readOwnerCall(RUNTIME_ID, bytes))).toBe("RUNTIME_UNKNOWN");
    expect(t.code(() => t.d.describeOwnerCall(RUNTIME_ID, bytes))).toBe("RUNTIME_UNKNOWN");
    expect(t.code(() => t.o.sessionConstants(RUNTIME_ID))).toBe("RUNTIME_UNKNOWN");
    // The session path does not stand on the owner check (O5).
    expect(t.x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n })).toEqual(encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n }));
  } finally {
    done();
  }
}

describe("O5: a runtime is fit for owner calls by a check of its own", () => {
  it("the committed entry is accepted, also through the mock (control)", async () => {
    const t = await withTable(copy());
    try {
      expect(t.o.encodeOwnerCall(GRANT)).toEqual(encodeOwnerCall(GRANT));
      expect(t.o.sessionConstants(RUNTIME_ID)).toEqual({ maxSessionDuration: Number(facts.constants.FlopSessionKeys.MaxSessionDuration.value), sessionEpochLength: Number(facts.constants.FlopSessionKeys.SessionEpochLength.value) });
    } finally {
      done();
    }
  });

  it("a call missing", async () => {
    for (const name of ["create_session", "revoke_session"]) {
      const rt = copy();
      rt.calls = rt.calls.filter((c: { name: string }) => c.name !== name);
      await ownerRefused(rt);
    }
  });

  it("a field extra, missing, renamed, doubled or of another type", async () => {
    let rt = copy();
    entry(rt, "create_session").fields.push({ name: "memo", type: { kind: "u32" } });
    await ownerRefused(rt);
    rt = copy();
    entry(rt, "revoke_session").fields.push({ name: "memo", type: { kind: "u32" } });
    await ownerRefused(rt);
    rt = copy();
    entry(rt, "create_session").fields.pop();
    await ownerRefused(rt);
    rt = copy();
    entry(rt, "create_session").fields[1].name = "lifetime_cap";
    await ownerRefused(rt);
    rt = copy();
    const f = entry(rt, "create_session").fields;
    f[2] = structuredClone(f[1]);
    await ownerRefused(rt);
    for (const [i, type] of [[1, { kind: "u64" }], [4, { kind: "u64" }], [0, { kind: "u128" }], [5, { kind: "bytes32" }]] as const) {
      rt = copy();
      entry(rt, "create_session").fields[i].type = type;
      await ownerRefused(rt);
    }
  });

  it("an index shared with another call of the table", async () => {
    let rt = copy();
    entry(rt, "revoke_session").callIndex = entry(rt, "create_session").callIndex;
    await ownerRefused(rt);
    rt = copy();
    entry(rt, "create_session").callIndex = rt.calls[0].callIndex;
    entry(rt, "create_session").palletIndex = rt.calls[0].palletIndex;
    await ownerRefused(rt);
  });

  it("a constant missing, doubled, not a u32, not whole, 0, above u32, or the epoch above the longest duration", async () => {
    for (const name of ["MaxSessionDuration", "SessionEpochLength"]) {
      let rt = copy();
      rt.constants = rt.constants.filter((c: { name: string }) => c.name !== name);
      await ownerRefused(rt);
      rt = copy();
      rt.constants.push(structuredClone(constant(rt, name)));
      await ownerRefused(rt);
      rt = copy();
      constant(rt, name).type = { kind: "u64" };
      await ownerRefused(rt);
      for (const value of [0, 1.5, -1, 2 ** 32, "864000", Number.NaN]) {
        rt = copy();
        constant(rt, name).value = value;
        await ownerRefused(rt);
      }
    }
    const rt = copy();
    constant(rt, "SessionEpochLength").value = constant(rt, "MaxSessionDuration").value + 1;
    await ownerRefused(rt);
  });

  it("the epoch equal to the longest duration is in order (control)", async () => {
    const rt = copy();
    constant(rt, "SessionEpochLength").value = constant(rt, "MaxSessionDuration").value;
    const t = await withTable(rt);
    try {
      expect(t.o.encodeOwnerCall(GRANT)).toEqual(encodeOwnerCall(GRANT));
    } finally {
      done();
    }
  });

  it("a longest duration from the table bounds the grant: a forged shorter one refuses A2's 7200 blocks", async () => {
    const rt = copy();
    constant(rt, "MaxSessionDuration").value = GRANT.duration_blocks - 1;
    constant(rt, "SessionEpochLength").value = 1;
    const t = await withTable(rt);
    try {
      expect(t.code(() => t.o.encodeOwnerCall(GRANT))).toBe("OUT_OF_RANGE");
      expect(t.code(() => t.r.readOwnerCall(RUNTIME_ID, encodeOwnerCall(GRANT)))).toBe("OUT_OF_RANGE");
    } finally {
      done();
    }
  });
});

describe("O4: the five session calls refuse an inner call field of the list kind", () => {
  it("an inner call carrying a bytesList field: the session path refuses the runtime", async () => {
    for (const name of ["timeout", "open_channel"]) {
      const rt = copy();
      entry(rt, name).fields.push({ name: "names", type: { kind: "bytesList" } });
      const t = await withTable(rt);
      try {
        const call = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n });
        expect(t.code(() => t.x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n }))).toBe("RUNTIME_UNKNOWN");
        expect(t.code(() => t.r.readCall(RUNTIME_ID, call))).toBe("RUNTIME_UNKNOWN");
      } finally {
        done();
      }
    }
  });

  it("the outer call carrying one is refused too (its field set is exact)", async () => {
    const rt = copy();
    rt.calls[0].fields.push({ name: "names", type: { kind: "bytesList" } });
    const t = await withTable(rt);
    try {
      expect(t.code(() => t.x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n }))).toBe("RUNTIME_UNKNOWN");
    } finally {
      done();
    }
  });
});
