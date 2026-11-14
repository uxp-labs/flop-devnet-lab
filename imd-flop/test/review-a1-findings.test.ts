/**
 * Review of piece A1 (reviewer, not the builder), promise P12: each audit finding this piece fixes, written again
 * from the finding's description in research/2026-11-14-audit-56b900b/report.md with the reviewer's own input. Each
 * test here passes on the branch; the reviewer ran this file against main 3639e23 in a copy outside the repo, where
 * each fails. Findings 6 and 8 are test notes, not behaviour: they are held by the mutation table of the report.
 *
 * Hashes and heights come from research/2026-11-12-session-rerun-1014020/results.json (steps[].block_hash,
 * steps[].finalized_in_block); the devnet genesis is networks.ts NETWORKS.devnet.genesisHash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readBlockEvents } from "../src/chain-read/read.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { signSessionCall } from "../src/chain/extrinsic.js";
import { ByteReader } from "../src/chain/scale.js";
import { NETWORKS } from "../src/networks.js";
import * as rpc from "../src/node-rpc.js";
import { OWNER, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";
import { type Log, RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const A9 = RESULTS.steps.find((s: any) => s.step === "A9");

const real = globalThis.WebSocket;
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = real;
});

const codeOf = (f: () => unknown): string | null => {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
};

describe("review A1, P12: the audit's findings, from their descriptions", () => {
  it("HOLDS finding 1: a Proxy block that answers the canonical hash on its first get and a sibling block's after is never read through get", async () => {
    let gets = 0;
    const block = new Proxy(
      { number: A6.finalized_in_block, hash: A6.block_hash },
      {
        get(t, k, r) {
          gets++;
          return k === "hash" && gets > 2 ? A9.block_hash : Reflect.get(t, k, r);
        },
      },
    );
    const log: Log = [];
    const r: any = await readBlockEvents(transportOf(rerunScript(A6.block_hash), log), block as never);
    expect(gets).toBe(0);
    expect(r.kind).toBe("known");
    expect(r.value.hash).toBe(A6.block_hash);
  });

  it("HOLDS finding 2: a getter on signer.sign is refused before it runs, and nothing is signed", () => {
    const device = testDevice();
    let ran = 0;
    const signer = {
      publicKey: device.publicKey,
      get sign() {
        ran++;
        return device.sign;
      },
    };
    const birth = { number: 9, hash: unhex(A6.block_hash) };
    expect(codeOf(() => signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: sampleInner().timeout, sessionNonce: 1n, accountNonce: 0, birth, signer: signer as never }))).toBe("BAD_INPUT");
    expect(ran).toBe(0);
    expect(device.calls).toHaveLength(0);
  });

  it("HOLDS finding 3: ByteReader.prototype cannot be given a field or have a method replaced", () => {
    const proto = ByteReader.prototype as unknown as Record<string, unknown>;
    const before = proto.uint;
    let wrote = false;
    try {
      proto.uint = () => 0n;
      wrote = true;
    } catch {
      // frozen
    }
    if (wrote) proto.uint = before; // put back what a copy of main lets the test change
    expect(wrote).toBe(false);
    expect(proto.uint).toBe(before);
  });

  it("HOLDS finding 7: answerOf is not exported by node-rpc.ts", () => {
    expect(Object.keys(rpc)).not.toContain("answerOf");
  });

  it("HOLDS finding 9 (close): a close before any answer ends the call at once with its own reason", async () => {
    let sock: { onclose?: () => void; onerror?: () => void } | undefined;
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      onclose?: () => void;
      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        sock = this;
      }
      send() {}
      close() {}
    };
    const p = rpc.rpcCall("ws://scripted.invalid", "chain_getBlockHash", [0], { timeoutMs: 60_000, maxFrameChars: 65536 });
    const outcome = p.then(
      () => "answered",
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 5));
    sock?.onclose?.();
    expect(await outcome).toBe("rpc socket closed before an answer");
  });

  it("HOLDS finding 9 (size): a frame over the caller's cap is refused before it is parsed, with the cap's words", async () => {
    const big = `{"jsonrpc":"2.0","id":1,"result":"${NETWORKS.devnet.genesisHash}"`; // not JSON: a parse would say so
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
      send() {
        setTimeout(() => this.onmessage?.({ data: big }), 0);
      }
      close() {}
    };
    const got = await rpc.rpcCall("ws://scripted.invalid", "chain_getBlockHash", [0], { timeoutMs: 60_000, maxFrameChars: 64 }).then(
      () => "answered",
      (e: Error) => e.message,
    );
    expect(got).toBe(`rpc frame of ${big.length} characters is over its cap of 64`);
  });
});
