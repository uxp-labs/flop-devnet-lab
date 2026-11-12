/**
 * P3 fix round, rule H2: nothing is signed or returned that was not read back. The call bytes are read back
 * with the strict reader and compared with the snapshot, field by field, before sign is called, and before
 * encodeSessionCall returns. To show the check works, the writer of fields.ts is replaced, in a fresh module
 * graph, by one that writes a wrong byte: the encoder must refuse and never call sign.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const BIRTH = { number: 3552594, hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };

/** The encoder with a writer that changes one value of the kind `kind` as it writes it. */
async function withBadWriter(kind: string, change: (b: Uint8Array) => void) {
  vi.resetModules();
  vi.doMock("../src/chain/fields.js", async (orig) => {
    const real = (await orig()) as typeof import("../src/chain/fields.js");
    return {
      ...real,
      writeValue: (ty: { kind: string }, value: never, what: string) => {
        const b = real.writeValue(ty as never, value, what);
        if (ty.kind === kind) change(b);
        return b;
      },
    };
  });
  const x = await import("../src/chain/extrinsic.js");
  const e = await import("../src/chain/errors.js");
  const codeOf = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      return err instanceof e.ChainEncodeError ? err.refusal : `not a ChainEncodeError: ${String(err)}`;
    }
    return null;
  };
  return { x, codeOf };
}

afterEach(() => {
  vi.doUnmock("../src/chain/fields.js");
  vi.resetModules();
});

describe("H2: the call bytes are read back and compared with the snapshot before sign", () => {
  const cases: [string, string, (b: Uint8Array) => void][] = [
    ["a 32 byte field written with one bit changed", "bytes32", (b) => void (b[0] ^= 1)],
    ["the sla (three u32) written with one bit changed", "struct", (b) => void (b[4] ^= 1)],
    ["a u64 nonce written with one bit changed", "u64", (b) => void (b[7] ^= 0x80)],
  ];
  for (const [label, kind, change] of cases) {
    it(`${label}: signSessionCall refuses with READ_BACK and never calls sign`, async () => {
      const { x, codeOf } = await withBadWriter(kind, change);
      const device = testDevice();
      expect(codeOf(() => x.signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 1n, accountNonce: 0, birth: BIRTH, signer: device }))).toBe("READ_BACK");
      expect(device.calls).toHaveLength(0);
    });
    it(`${label}: encodeSessionCall refuses with READ_BACK`, async () => {
      const { x, codeOf } = await withBadWriter(kind, change);
      expect(codeOf(() => x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 1n }))).toBe("READ_BACK");
    });
  }

  it("an amount written wrong is refused before sign too (the reader's own spend check, or the comparison)", async () => {
    const { x, codeOf } = await withBadWriter("u128", (b) => void (b[0] ^= 1));
    const device = testDevice();
    const code = codeOf(() => x.signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.top_up_escrow, sessionNonce: 1n, accountNonce: 0, birth: BIRTH, signer: device }));
    expect(["READ_BACK", "SPEND_MISMATCH"]).toContain(code);
    expect(device.calls).toHaveLength(0);
  });

  it("control: the same mock with no change signs", async () => {
    const { x } = await withBadWriter("none", () => undefined);
    const device = testDevice();
    x.signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 1n, accountNonce: 0, birth: BIRTH, signer: device });
    expect(device.calls).toHaveLength(1);
  });
});
