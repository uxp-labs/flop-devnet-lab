import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  READ_ONLY_RPC_METHODS,
  ReadOnlyViolation,
  attemptLog,
  guardHttp,
  guardRpc,
  refuseSigning,
  refuseSpend,
  resetAttempts,
} from "../src/guard.js";

function takeAttempts() {
  const log = attemptLog();
  resetAttempts();
  return log;
}

describe("read-only guard", () => {
  it("lets read RPC methods through without recording anything", () => {
    for (const m of READ_ONLY_RPC_METHODS) guardRpc(m);
    expect(attemptLog()).toEqual([]);
  });

  it.each(["author_submitExtrinsic", "author_submitAndWatchExtrinsic", "author_insertKey", "author_rotateKeys"])(
    "refuses and records rpc %s",
    (method) => {
      expect(() => guardRpc(method)).toThrow(ReadOnlyViolation);
      expect(takeAttempts()).toMatchObject([{ kind: "rpc-write", what: `rpc ${method}` }]);
    },
  );

  it("refuses the faucet's funding call and any other write over HTTP", () => {
    expect(() => guardHttp("POST", "https://faucet.flop.network/fund")).toThrow(ReadOnlyViolation);
    expect(() => guardHttp("put", "https://api.flop.network/v1/keys")).toThrow(ReadOnlyViolation);
    expect(takeAttempts().map((a) => a.what)).toEqual([
      "POST https://faucet.flop.network/fund",
      "PUT https://api.flop.network/v1/keys",
    ]);
    guardHttp("GET", "https://faucet.flop.network/health");
    guardHttp("head", "https://faucet.flop.network/chain");
    expect(attemptLog()).toEqual([]);
  });

  it("refuses and records signing and spending", () => {
    expect(() => refuseSigning("escrow open")).toThrow(ReadOnlyViolation);
    expect(() => refuseSpend("0.001 FLOP")).toThrow(ReadOnlyViolation);
    expect(takeAttempts().map((a) => a.kind)).toEqual(["sign", "spend"]);
  });

  it("has fetch and WebSocket disabled in tests, and records the attempt", () => {
    expect(() => fetch("https://faucet.flop.network/health")).toThrow(/network disabled/);
    expect(() => new (globalThis as unknown as { WebSocket: new (u: string) => unknown }).WebSocket("wss://rpc.devnet.flop.network")).toThrow(
      /network disabled/,
    );
    expect(takeAttempts().map((a) => a.kind)).toEqual(["network", "network"]);
  });
});

describe("source scan", () => {
  // M0 has no transport at all. This keeps it that way until M1 adds one behind the guard.
  const forbidden = [/\bfetch\s*\(/, /new\s+WebSocket\b/, /signAndSend/, /author_submit/, /\bKeyring\b/, /mnemonic/i, /\bsecretKey\b/];
  const dir = new URL("../src/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "guard.ts");

  it.each(files)("%s has no network, signing or key handling", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    for (const re of forbidden) expect(text, `${file} matches ${re}`).not.toMatch(re);
  });
});
