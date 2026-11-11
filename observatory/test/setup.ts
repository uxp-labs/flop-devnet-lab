// Tests never touch the network or start processes, and nothing may sign, spend or write. The one
// exemption, runShell below, lets test/publish-shell.test.ts alone run bash against file:// remotes.
//
// Every way out is replaced before any test runs: fetch and WebSocket, node:http, node:https and
// node:http2 requests and servers, node:net and node:tls connections and listeners, node:dgram
// sockets, node:dns lookups and resolvers, worker threads, module hooks (module.register, whose
// hooks run on a loader thread that holds its own unpatched copy of every module, and
// module.registerHooks), every node:child_process call, and the lower layers
// (ChildProcess.prototype.spawn, net.Server's _listen2 under listen, the dgram.Socket
// constructor, which opens its native handle at once, the native bindings behind process.binding,
// process.dlopen and inspector.open). Each attempt is recorded and throws. The node: modules are
// patched on their shared module objects and then synced, so named ESM imports
// (`import { request } from "node:https"`) see the block too.
//
// After each test file, any attempt still in the log fails the file. A test that provokes a
// refusal on purpose must assert it and then call resetAttempts().
//
// The log is also written to a journal (OBS_ATTEMPTS_FILE, which test/global-setup.ts always
// sets) the moment anything happens: each attempt, each reset, and each file's final check. A
// blocked call fired from a timer after that check is out of reach of any afterAll, but it is on
// disk, and scripts/attempts-check.mjs fails the run for it once every file has ended.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
// Imported before the block is set, to prove the sync below reaches bindings that already exist.
import { request as httpsRequestBeforeBlock } from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { relative } from "node:path";
import { afterAll, expect } from "vitest";
import { type AttemptKind, attemptLog, onAttempt, recordAttempt } from "../src/guard.js";

const require = createRequire(import.meta.url);

const journal = process.env.OBS_ATTEMPTS_FILE || null;
const run = randomUUID();
const testFile = relative(process.cwd(), expect.getState().testPath ?? "") || "unknown";
function journalLine(entry: Record<string, unknown>): void {
  if (journal) appendFileSync(journal, JSON.stringify({ run, file: testFile, ...entry }) + "\n");
}
// Registered before anything is blocked, so no attempt can come before it.
onAttempt((e) => journalLine(e.type === "attempt" ? { event: "attempt", attempt: e.attempt } : { event: "reset", cleared: e.cleared }));

// The one exemption from the block (memory review): test/publish-shell.test.ts runs the publish
// job's shell, as the workflow holds it, with bash against a local bare repository, since a shell
// that is only read as text is not tested. The real spawnSync is taken before the block is set and
// held here, never exported. runShell hands it out to that one file only, runs bash only, with an
// environment built from nothing but the caller's and PATH, git limited to the file:// transport and
// no system or global git config, so no network path opens. Any other file that calls it records a
// process attempt and throws, as every other child process call does.
const realSpawnSync = (require("node:child_process") as typeof import("node:child_process")).spawnSync;
export const SHELL_TEST_FILE = "test/publish-shell.test.ts";
export interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}
export function runShell(args: readonly string[], env: Readonly<Record<string, string>>, cwd: string): ShellResult {
  if (testFile !== SHELL_TEST_FILE) {
    recordAttempt("process", `runShell bash from ${testFile}`);
    throw new Error("child processes disabled in tests");
  }
  const server = env.GITHUB_SERVER_URL;
  if (server !== undefined && !server.startsWith("file://")) throw new Error(`runShell: GITHUB_SERVER_URL must be a file:// URL, not ${server}`);
  const r = realSpawnSync("bash", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env, GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? String(r.error.message) : null };
}

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

/** A stand in that records the attempt and throws. what names the way out in the error. */
function blocked(kind: AttemptKind, label: string, what = kind === "process" ? "child processes" : "network") {
  return function blockedCall(...args: unknown[]): never {
    const target = describeTarget(args);
    recordAttempt(kind, target ? `${label} ${target}` : label);
    throw new Error(`${what} disabled in tests`);
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
// listen() hands over to _listen2, which makes the listening handle itself (third IMD audit J2).
net.Server.prototype._listen2 = blocked("network", "net.Server._listen2");
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
// Module hooks (third IMD audit J1): register() starts Node's loader thread, whose code sees none
// of the patches here, and registerHooks() rewires how every later module loads.
const nodeModule = require("node:module");
nodeModule.register = blocked("process", "module.register", "module hooks");
nodeModule.registerHooks = blocked("process", "module.registerHooks", "module hooks");

// The lower layers, which a module function block alone would miss.
const dgram = require("node:dgram");
const dgramSocket = dgram.Socket.prototype;
for (const name of ["send", "bind", "connect"]) dgramSocket[name] = blocked("network", `dgram.Socket.${name}`);
// A socket made directly holds its native handle from the constructor on, and that handle binds
// without the prototype's bind (third IMD audit J2), so the constructor itself is refused. The
// prototype stays the real one, with its methods blocked above.
dgram.Socket = function Socket(...args: unknown[]) {
  blocked("network", "dgram.Socket")(...args);
};
dgram.Socket.prototype = dgramSocket;
// The real prototype's constructor property would still hand out the real function (tenth rerun),
// so it names the stand in too.
dgramSocket.constructor = dgram.Socket;
for (const [proto, prefix] of [
  [dns.Resolver.prototype, "dns.Resolver"],
  [dns.promises.Resolver.prototype, "dns.promises.Resolver"],
] as const) {
  for (const name of Object.getOwnPropertyNames(proto).filter((k) => /^(resolve|reverse)/.test(k))) {
    (proto as Record<string, unknown>)[name] = blocked("network", `${prefix}.${name}`);
  }
}
require("node:child_process").ChildProcess.prototype.spawn = blocked("process", "child_process.ChildProcess.spawn");
block(require("node:inspector"), ["open"], "network", "inspector");
// process.binding reaches the native socket and spawn layers directly. Only those are refused.
const NATIVE = new Set(["spawn_sync", "process_wrap", "tcp_wrap", "udp_wrap", "pipe_wrap", "tls_wrap", "cares_wrap", "stream_wrap", "js_stream", "inspector"]);
const realBinding = (process as unknown as { binding: (name: string) => unknown }).binding.bind(process);
(process as unknown as { binding: (name: string) => unknown }).binding = (name: string) =>
  NATIVE.has(name) ? blocked("process", "process.binding")(name) : realBinding(name);
process.dlopen = blocked("process", "process.dlopen") as typeof process.dlopen;
syncBuiltinESMExports();

/** For test/guard.test.ts: a binding that existed before the block, read after it. */
export const earlyBindings = { httpsRequest: () => httpsRequestBeforeBlock };

afterAll(() => {
  const left = attemptLog();
  journalLine({ event: "checked", left: left.length });
  if (left.length > 0) {
    throw new Error(`unexpected network, write, sign or spend attempts: ${JSON.stringify(left)}`);
  }
});
