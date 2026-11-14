/**
 * Review of P5a, attack 8 (P10, P15): forged copies of the table, put in place of src/chain/runtimes.js by
 * vi.doMock as test/chain-owner-table.test.ts does. The table copied is RUNTIMES[0], the committed one.
 */
import { describe, expect, it, vi } from "vitest";
import { RT, RUNTIME_ID } from "./lib/chain-fixtures.js";

async function withTable(change: (rt: Record<string, unknown> & { calls: { pallet: string; name: string; fields: { name: string; type: { kind: string; fields?: unknown[] } }[] }[] }) => void, f: (m: { shape: typeof import("../src/chain/shape.js") }) => unknown): Promise<string> {
  const rt = structuredClone(RT) as never as Parameters<typeof change>[0];
  change(rt);
  vi.resetModules();
  vi.doMock("../src/chain/runtimes.js", () => ({ RUNTIMES: [rt] }));
  try {
    const shape = await import("../src/chain/shape.js");
    const errors = await import("../src/chain/errors.js");
    try {
      f({ shape });
      return "accepted";
    } catch (e) {
      return e instanceof errors.ChainEncodeError ? `refused ${e.refusal}` : `raw ${(e as Error).constructor.name}`;
    }
  } finally {
    vi.doUnmock("../src/chain/runtimes.js");
    vi.resetModules();
  }
}

describe("review P5a, attack 8: forged tables", () => {
  it("HOLDS: the forged path is live: an inner call with a bytesList field at the top is refused by reviewedRuntime", async () => {
    const r = await withTable(
      (rt) => rt.calls.find((c) => c.name === "top_up_escrow")!.fields.push({ name: "l", type: { kind: "bytesList" } }),
      ({ shape }) => shape.reviewedRuntime(RUNTIME_ID),
    );
    expect(r).toBe("refused RUNTIME_UNKNOWN");
  });

  it("DEFECT RP5A-4: an inner call whose struct field holds a bytesList is not refused by the session path's shape check", async () => {
    const r = await withTable(
      (rt) => {
        const open = rt.calls.find((c) => c.name === "open_channel")!;
        const sla = open.fields.find((f) => f.type.kind === "struct")!;
        sla.type.fields!.push({ name: "l", type: { kind: "bytesList" } });
      },
      ({ shape }) => shape.reviewedRuntime(RUNTIME_ID),
    );
    // Expected (README: "they refuse an inner call field of the allow list's kind"; O4): refused RUNTIME_UNKNOWN.
    expect(r).toBe("refused RUNTIME_UNKNOWN");
  });
});
