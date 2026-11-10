import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import * as dgram from "node:dgram";
import * as dns from "node:dns";
import { readdirSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as inspector from "node:inspector";
import * as https from "node:https";
import { request as httpsRequest } from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { earlyBindings } from "./setup.js";
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

describe("every network and process path is blocked at runtime (RULES section 4)", () => {
  // Hosts end in .invalid, so even a broken block could never reach FLOP.
  const cases: [string, () => unknown, string, string][] = [
    ["http.request", () => http.request("http://canary.invalid/fund"), "network", "http.request"],
    ["http.get", () => http.get("http://canary.invalid/"), "network", "http.get"],
    ["https.request", () => https.request("https://canary.invalid/fund"), "network", "https.request"],
    ["a named https request import", () => httpsRequest("https://canary.invalid/fund"), "network", "https.request"],
    ["http2.connect", () => http2.connect("https://canary.invalid"), "network", "http2.connect"],
    ["net.connect", () => net.connect(9, "canary.invalid"), "network", "net.connect"],
    ["net.Socket connect", () => new net.Socket().connect(9, "canary.invalid"), "network", "net.Socket.connect"],
    ["net.createServer", () => net.createServer(), "network", "net.createServer"],
    ["tls.connect", () => tls.connect(443, "canary.invalid"), "network", "tls.connect"],
    ["dgram.createSocket", () => dgram.createSocket("udp4"), "network", "dgram.createSocket"],
    ["dns.lookup", () => dns.lookup("canary.invalid", () => undefined), "network", "dns.lookup"],
    ["dns.promises.resolve4", () => dns.promises.resolve4("canary.invalid"), "network", "dns.promises.resolve4"],
    ["child_process.spawn", () => childProcess.spawn("true"), "process", "child_process.spawn"],
    ["a named spawnSync import", () => spawnSync("true"), "process", "child_process.spawnSync"],
    ["child_process.execSync", () => childProcess.execSync("true"), "process", "child_process.execSync"],
    ["child_process.fork", () => childProcess.fork("x.js"), "process", "child_process.fork"],
    ["a worker thread", () => new Worker("x.js"), "process", "worker_threads.Worker"],
    ["an https binding imported before the block was set", () => earlyBindings.httpsRequest()("https://canary.invalid/"), "network", "https.request"],
    ["a dgram.Socket made directly, with its own lookup", () => {
      const sock = new dgram.Socket({ type: "udp4", lookup: (_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, "127.0.0.1", 4) });
      try {
        return sock.send("x", 9, "canary.invalid");
      } finally {
        sock.close();
      }
    }, "network", "dgram.Socket.send"],
    ["a dgram.Socket bind", () => {
      const sock = new dgram.Socket({ type: "udp4" });
      try {
        return sock.bind(0);
      } finally {
        sock.close();
      }
    }, "network", "dgram.Socket.bind"],
    ["a dns.Resolver query", () => new dns.Resolver().resolve4("canary.invalid", () => undefined), "network", "dns.Resolver.resolve4"],
    ["a dns.promises.Resolver query", () => new dns.promises.Resolver().resolve4("canary.invalid"), "network", "dns.promises.Resolver.resolve4"],
    ["ChildProcess.prototype.spawn", () => new childProcess.ChildProcess().spawn({ file: "true", args: ["true"], stdio: "ignore" } as never), "process", "child_process.ChildProcess.spawn"],
    ["process.binding spawn_sync", () => (process as unknown as { binding: (n: string) => unknown }).binding("spawn_sync"), "process", "process.binding"],
    ["process.dlopen", () => process.dlopen({ exports: {} } as never, "/nonexistent/canary.node"), "process", "process.dlopen"],
    ["inspector.open", () => inspector.open(0, "127.0.0.1"), "network", "inspector.open"],
  ];
  // The label proves the block sits where it claims to, not only at some deeper layer.
  it.each(cases)("%s throws and is recorded", (_name, call, kind, label) => {
    expect(call).toThrow(/disabled in tests/);
    const log = takeAttempts();
    expect(log.map((a) => a.kind)).toEqual([kind]);
    expect(log[0]?.what.split(" ")[0]).toBe(label);
  });
});

describe("source scan", () => {
  // M0 has no transport at all. This keeps it that way until M1 adds one behind the guard.
  const NET = "(?:http|https|http2|net|tls|dgram|dns|dns/promises|child_process|worker_threads|cluster|inspector|vm|module|undici|ws|axios|node-fetch)";
  const forbidden = [
    /\bfetch\s*\(/,
    /new\s+WebSocket\b/,
    new RegExp(`from\\s*["'](?:node:)?${NET}["']`),
    new RegExp(`import\\s*\\(?\\s*["'](?:node:)?${NET}["']`),
    new RegExp(`require\\s*\\(\\s*["'](?:node:)?${NET}["']`),
    /\bprocess\.(?:binding|_linkedBinding|dlopen)\b/,
    /internalBinding/,
    /\bgetBuiltinModule\b/,
    /\bcreateRequire\b/,
    // import() or require() whose argument is anything but one plain string literal
    /\bimport\s*\((?!\s*(["'])[^"'`]*\1\s*\))/,
    /\brequire\s*\((?!\s*(["'])[^"'`]*\1\s*\))/,
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /signAndSend/,
    /\bsignRaw\b/,
    /\bsignPayload\b/,
    /\bsignTransaction\b/,
    /\bsign\s*\(/,
    /\bcreateSign\b/,
    /\bgenerateKeyPair/,
    /author_submit/,
    /eth_send(?:Raw)?Transaction/,
    /\bsendTransaction\b/,
    /\bwriteContract\b/,
    /\bapi\.tx\b/,
    /\bKeyring\b/,
    /mnemonic/i,
    /\bsecretKey\b/,
    /\bprivateKey\b/,
  ];
  const dir = new URL("../src/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "guard.ts");

  it.each(files)("%s has no network, process, signing, spending or key handling", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    for (const re of forbidden) expect(text, `${file} matches ${re}`).not.toMatch(re);
  });

  it("allows a plain dynamic import of a local module", () => {
    expect(forbidden.some((re) => re.test('const t = await import("./types.js");'))).toBe(false);
  });

  it("catches each kind of forbidden line it claims to", () => {
    const samples = [
      'import { request } from "node:https";',
      'import net from "net";',
      'const cp = await import("node:child_process");',
      'require("node:dgram")',
      "await api.tx.balances.transferKeepAlive(to, 1).signAndSend(pair);",
      "const sig = pair.sign(message);",
      "const keyring = new Keyring();",
      'const https = process.getBuiltinModule("node:https");',
      'const cp = createRequire(import.meta.url)("node:child_process");',
      'const m = await import("node:" + "https");',
      "const m = await import(`node:${name}`);",
      "const m = require(name);",
      'const r = eval("fetch(1)");',
      'const f = new Function("return 1");',
      'const s = process.binding("spawn_sync");',
    ];
    for (const line of samples) expect(forbidden.some((re) => re.test(line)), line).toBe(true);
  });

  // The independent recount may run its own tests in a subprocess, but recount.py itself
  // reads files only.
  it("tools/recount.py imports nothing that reaches the network or starts a process", () => {
    const text = readFileSync(new URL("../tools/recount.py", import.meta.url), "utf8");
    const imports = [...text.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["argparse", "json", "os", "re", "sys"]);
    expect(text).not.toMatch(/\bos\.(?:system|popen|exec|spawn|fork)/);
    expect(text).not.toMatch(/__import__|importlib/);
  });
});
