// Tests never touch the network or start processes, and nothing may sign, spend or write.
//
// Every way out is replaced before any test runs: fetch and WebSocket, node:http, node:https and
// node:http2 requests and servers, node:net and node:tls connections and listeners, node:dgram
// sockets, node:dns lookups, worker threads and every node:child_process call. Each attempt is
// recorded and throws. The node: modules are patched on their shared module objects and then
// synced, so named ESM imports (`import { request } from "node:https"`) see the block too.
//
// After each test file, any attempt still in the log fails the file. A test that provokes a
// refusal on purpose must assert it and then call resetAttempts().
import { appendFileSync } from "node:fs";
// Imported before the block is set, to prove the sync below reaches bindings that already exist.
import { request as httpsRequestBeforeBlock } from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterAll } from "vitest";
import { type AttemptKind, attemptLog, recordAttempt } from "../src/guard.js";

const require = createRequire(import.meta.url);

function describeTarget(args: unknown[]): string {
  const a = args[0];
  if (typeof a === "string" || typeof a === "number") return String(a);
  if (a instanceof URL) return a.href;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    const host = o.hostname ?? o.host ?? o.path ?? "";
    return `${String(host)}${o.port !== undefined ? `:${String(o.port)}` : ""}`;
  }
  return "";
}

function blocked(kind: AttemptKind, label: string) {
  return function blockedCall(...args: unknown[]): never {
    const target = describeTarget(args);
    recordAttempt(kind, target ? `${label} ${target}` : label);
    throw new Error(kind === "process" ? "child processes disabled in tests" : "network disabled in tests");
  };
}

function block(mod: Record<string, unknown>, names: string[], kind: AttemptKind, prefix: string): void {
  for (const name of names) {
    if (typeof mod[name] === "function") mod[name] = blocked(kind, `${prefix}.${name}`);
  }
}

globalThis.fetch = blocked("network", "fetch") as unknown as typeof fetch;
(globalThis as { WebSocket?: unknown }).WebSocket = class {
  constructor(url: unknown) {
    blocked("network", "websocket")(url);
  }
};

block(require("node:http"), ["request", "get", "createServer"], "network", "http");
block(require("node:https"), ["request", "get", "createServer"], "network", "https");
block(require("node:http2"), ["connect", "createServer", "createSecureServer"], "network", "http2");
const net = require("node:net");
block(net, ["connect", "createConnection", "createServer"], "network", "net");
net.Socket.prototype.connect = blocked("network", "net.Socket.connect");
net.Server.prototype.listen = blocked("network", "net.Server.listen");
block(require("node:tls"), ["connect", "createServer"], "network", "tls");
block(require("node:dgram"), ["createSocket"], "network", "dgram");
const dns = require("node:dns");
const lookups = (m: Record<string, unknown>) => Object.keys(m).filter((k) => /^(lookup|resolve|reverse)/.test(k));
block(dns, lookups(dns), "network", "dns");
block(dns.promises, lookups(dns.promises), "network", "dns.promises");
block(
  require("node:child_process"),
  ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
  "process",
  "child_process",
);
const threads = require("node:worker_threads");
threads.Worker = class {
  constructor(file: unknown) {
    blocked("process", "worker_threads.Worker")(file);
  }
};
syncBuiltinESMExports();

/** For test/guard.test.ts: a binding that existed before the block, read after it. */
export const earlyBindings = { httpsRequest: () => httpsRequestBeforeBlock };

afterAll(() => {
  const left = attemptLog();
  const file = process.env.OBS_ATTEMPTS_FILE;
  if (file && left.length > 0) {
    appendFileSync(file, left.map((a) => JSON.stringify(a)).join("\n") + "\n");
  }
  if (left.length > 0) {
    throw new Error(`unexpected network, write, sign or spend attempts: ${JSON.stringify(left)}`);
  }
});
