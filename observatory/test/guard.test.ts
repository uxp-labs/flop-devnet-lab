import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import * as dgram from "node:dgram";
import * as dns from "node:dns";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as inspector from "node:inspector";
import { register, registerHooks } from "node:module";
import * as https from "node:https";
import { request as httpsRequest } from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { earlyBindings, runShell } from "./setup.js";
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
    // Third IMD audit J2: the constructor opens the socket's native handle, so it is refused itself.
    ["a dgram.Socket made directly", () => new (dgram.Socket as unknown as new (o: dgram.SocketOptions) => unknown)({ type: "udp4" }), "network", "dgram.Socket"],
    ["a dgram.Socket made directly from its type", () => new (dgram.Socket as unknown as new (t: string) => unknown)("udp4"), "network", "dgram.Socket"],
    ["a dgram.Socket made from the real prototype's constructor", () => new (dgram.Socket.prototype.constructor as unknown as new (t: string) => unknown)("udp4"), "network", "dgram.Socket"],
    // The real prototype's methods stay blocked too, for a socket the constructor did not make.
    ["a dgram.Socket send on the real prototype", () => (dgram.Socket.prototype.send as (this: dgram.Socket, msg: string, port: number, address: string) => void).call(Object.create(dgram.Socket.prototype), "x", 9, "canary.invalid"), "network", "dgram.Socket.send"],
    ["a dgram.Socket bind on the real prototype", () => (dgram.Socket.prototype.bind as (this: dgram.Socket, port: number) => dgram.Socket).call(Object.create(dgram.Socket.prototype), 0), "network", "dgram.Socket.bind"],
    ["net.Server _listen2, under listen", () => (new net.Server() as unknown as { _listen2: (...a: unknown[]) => unknown })._listen2("canary.invalid", 0, 4, -1, false), "network", "net.Server._listen2"],
    // Third IMD audit J1: a loader thread holds unpatched modules of its own.
    ["module.register", () => register("data:text/javascript,"), "process", "module.register"],
    ["module.registerHooks", () => registerHooks({}), "process", "module.registerHooks"],
    ["a dns.Resolver query", () => new dns.Resolver().resolve4("canary.invalid", () => undefined), "network", "dns.Resolver.resolve4"],
    ["a dns.promises.Resolver query", () => new dns.promises.Resolver().resolve4("canary.invalid"), "network", "dns.promises.Resolver.resolve4"],
    ["ChildProcess.prototype.spawn", () => (new childProcess.ChildProcess() as unknown as { spawn: (o: never) => unknown }).spawn({ file: "true", args: ["true"], stdio: "ignore" } as never), "process", "child_process.ChildProcess.spawn"],
    ["process.binding spawn_sync", () => (process as unknown as { binding: (n: string) => unknown }).binding("spawn_sync"), "process", "process.binding"],
    ["process.dlopen", () => process.dlopen({ exports: {} } as never, "/nonexistent/canary.node"), "process", "process.dlopen"],
    ["inspector.open", () => inspector.open(0, "127.0.0.1"), "network", "inspector.open"],
    // The one exemption serves test/publish-shell.test.ts only (RULES.md section 4).
    ["runShell from a file other than the publish shell test", () => runShell(["-c", "true"], {}, tmpdir()), "process", "runShell"],
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
    // The name alone, so fetch.call(...), const f = fetch, and new globalThis.WebSocket(...) count.
    /\bfetch\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bXMLHttpRequest\b/,
    // The global object by any of its names, which reaches every global, computed or not.
    /\bglobalThis\b/,
    /\bglobal\s*(?:\?\.)?\s*[.[]/,
    /\b(?:self|window)\s*(?:\?\.)?\s*[.[]/,
    // process only through the members src needs, so no computed, cast or reflected access, and
    // the Function constructor never reached by .constructor.
    /\bprocess\b(?!\.(?:version|argv|exit|stdout|stderr|stdin)\b)/,
    /\bReflect\b/,
    /\.\s*constructor\b/,
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
    /\beval\b/,
    /\bFunction\s*\(/,
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
    // A socket or pipe opened from a stream src already holds, a hook V8 calls with stack frames,
    // code from bytes, and the ways to read or write a property by a name only known at run time
    // (round 8 review M1). The syntax tree scan holds the full rule: no computed key at all.
    /\.\s*(?:connect|connect6|listen|bind|bind6)\b/,
    /\bprepareStackTrace\b/,
    /\bWebAssembly\b/,
    /\bgetOwnPropertyNames\b/,
    /\bObject\s*\.\s*assign\b/,
    /\batob\b/,
  ];
  const dir = new URL("../src/", import.meta.url);
  // Every module under src, in subfolders too, since tsconfig compiles all of src.
  const listModules = (d: URL | string) => (readdirSync(d, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && f !== "guard.ts").sort();
  const files = listModules(dir);

  // The one exemption (RULES.md section 4): src/net-root.ts, the composition root of every network
  // read (the live command's and the recorder's), names WebSocket and fetch in exactly this text,
  // once. With it taken out, that module must pass every rule as any other does.
  // scripts/source-scan.mjs holds the same exemption as a syntax tree.
  const ROOT = "net-root.ts";
  const ROOT_FORM = "new NetTransport({ socketClass: WebSocket, httpCall: fetch, answerLimits })";
  const exempted = (file: string, text: string) => (file === ROOT ? text.split(ROOT_FORM).join("") : text);

  it.each(files)("%s has no network, process, signing, spending or key handling", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    if (file === ROOT) expect(text.split(ROOT_FORM).length - 1, `${file} holds the exempted text once`).toBe(1);
    for (const re of forbidden) expect(exempted(file, text), `${file} matches ${re}`).not.toMatch(re);
  });

  it("exempts only the composition root's one text, in src/net-root.ts alone", () => {
    expect(files).toContain(ROOT);
    const hits = (file: string, text: string) => forbidden.some((re) => re.test(exempted(file, text)));
    // The exact form passes there, and nowhere else.
    expect(hits(ROOT, `const t = ${ROOT_FORM};`)).toBe(false);
    for (const other of ["cli.ts", "net.ts", "live-bin.ts", "record-bin.ts", join("live", ROOT)]) expect(hits(other, `const t = ${ROOT_FORM};`), other).toBe(true);
    // Any other use of either name in the root is still caught.
    for (const line of [
      "const f = fetch;",
      "const w = new WebSocket(url);",
      `const t = ${ROOT_FORM}; const r = await fetch(url);`,
      "const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch.call });",
      "const t = new NetTransport({ httpCall: fetch, socketClass: WebSocket, answerLimits });",
      "const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch });",
      "const t = new Other({ socketClass: WebSocket, httpCall: fetch });",
    ]) {
      expect(hits(ROOT, line), line).toBe(true);
    }
  });

  it("allows a plain dynamic import of a local module, and words that only contain a banned name", () => {
    for (const line of [
      'const t = await import("./types.js");',
      "const fetchedAt = reading.fetched_at;",
      "// One self-contained HTML page.",
      "const evaluated = evaluate(x);",
      "process.stdout.write(out);",
      "const node = process.version;",
      "// every child processes test",
    ]) {
      expect(forbidden.some((re) => re.test(line)), line).toBe(false);
    }
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
      "const r = await fetch.call(null, url);",
      "const f = fetch;",
      "const ws = new globalThis.WebSocket(url);",
      'const get = globalThis["fe" + "tch"];',
      "const W = WebSocket;",
      "const es = new EventSource(url);",
      'const x = global["fetch"];',
      "const y = self.fetch;",
      "const z = (0, eval)(code);",
      'const g = Function("return this")();',
      'const m = (process as any)["getBuiltin" + "Module"]("node:" + "https");',
      'const gb = Reflect.get(process, "getBuiltin" + "Module");',
      "const F = [].constructor.constructor;",
      "const AF = Object.getPrototypeOf(async () => {}).constructor;",
      'const b = (process as any)["bind" + "ing"];',
      'const c = process?.["dlopen"];',
      'const m = proc.getBuiltinModule("node:https");',
      "const p = process;",
      "process.env.HOME;",
      "(process.stdout as any).connect(443, host);",
      "rl.input.listen(path);",
      'Error.prepareStackTrace = (e, frames) => frames;',
      "const m = await WebAssembly.instantiate(bytes);",
      "const k = Object.getOwnPropertyNames(A.prototype)[0];",
      'Object.assign(Error, extra);',
      'const k = atob("Y29uc3RydWN0b3I=");',
    ];
    for (const line of samples) expect(forbidden.some((re) => re.test(line)), line).toBe(true);
  });

  // The independent recount may run its own tests in a subprocess, but recount.py itself
  // reads files only.
  it("lists modules in subfolders too", () => {
    const tmp = mkdtempSync(join(tmpdir(), "obs-scan-"));
    try {
      mkdirSync(join(tmp, "live"));
      writeFileSync(join(tmp, "a.ts"), "");
      writeFileSync(join(tmp, "live", "net.ts"), "");
      writeFileSync(join(tmp, "guard.ts"), "");
      expect(listModules(tmp)).toEqual(["a.ts", join("live", "net.ts")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no test loads a second copy of src/guard.ts, whose attempts no check would read", () => {
    // The attempt log lives in the instance test/setup.ts imported. A test that reloads modules,
    // mocks them, or imports the guard under a query string would get a copy of its own, and a
    // refused write there would reach neither the log nor the journal (Fable review I6). The
    // pattern is built from pieces so this file does not match itself.
    const ways = ["reset" + "Modules", "isolate" + "Modules", "vi" + "\\.mock", "vi" + "\\.doMock", "vi" + "\\.importActual", "vi" + "\\.importMock", "guard" + "\\.(?:js|ts)\\?"];
    const re = new RegExp(ways.join("|"));
    const testDir = new URL("./", import.meta.url);
    const files = (readdirSync(testDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("guard.test.ts");
    for (const f of files) expect(readFileSync(new URL(f, testDir), "utf8"), f).not.toMatch(re);
    expect(re.test('await import("../src/guard' + '.js?fresh")')).toBe(true);
    expect(re.test("vi.reset" + "Modules()")).toBe(true);
  });

  it("src holds nothing but regular .ts files, so the scans read every file tsc compiles (round 7 review M4)", () => {
    const entries = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => !lstatSync(new URL(f, dir)).isDirectory());
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.filter((f) => !f.endsWith(".ts") || !lstatSync(new URL(f, dir)).isFile())).toEqual([]);
  });

  it("lists every module under src, subfolders included, and the list is not empty", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("status.ts");
    expect(files.every((f) => !f.endsWith("guard.ts") || f.includes("/"))).toBe(true);
    // A class constructor declaration is not a .constructor access.
    expect(forbidden.some((re) => re.test("  constructor(reason: string) {"))).toBe(false);
  });

  it("tools/recount.py imports nothing that reaches the network or starts a process", () => {
    // tools/test_recount.py reads the same file as a syntax tree; this is the raw text view.
    const text = readFileSync(new URL("../tools/recount.py", import.meta.url), "utf8");
    // Every name on every import line ("import a, b as c" lists a and b), and no from-import.
    const names = [...text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)].flatMap((m) =>
      (m[1] as string).split(",").map((p) => (p.trim().split(/\s+/)[0] as string).split(".")[0]),
    );
    expect([...new Set(names)].sort()).toEqual(["json", "os", "re", "stat", "sys"]);
    expect(text).not.toMatch(/^[ \t]*from[ \t]+\S+[ \t]+import\b/m);
    // An import after a semicolon or a colon would not start its own line.
    expect(text).not.toMatch(/[;:][ \t]*(?:import|from)[ \t]/);
    expect(text).not.toMatch(/\bos\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*|kill\w*|remove|unlink|rename|replace)\b/);
    expect(text).not.toMatch(/__import__|importlib|\bgetattr\s*\(|\bsubprocess\b|\bsocket\b|\beval\s*\(|\bexec\s*\(/);
    // A private attribute reaches other modules (argparse._os), open kept in a name can write, and
    // FileType opens files: none of them belongs in a recount that only reads (round 7 review L5).
    expect(text).not.toMatch(/\.(?!__init__\b)_\w/);
    expect(text).not.toMatch(/\bopen\b(?!\()/);
    expect(text).not.toMatch(/\bFileType\b|__loader__|\bload_module\b|\bmodules\s*\[/);
    // A frame's globals and builtins, a builtin that reaches a file type or a pager, and open with
    // its arguments unpacked or an opener (round 8 review L6).
    expect(text).not.toMatch(/\.(?:gi|cr|ag|tb|f|co)_\w/);
    expect(text).not.toMatch(/\b(?:type|help|vars|dir|memoryview|object)\s*\(/);
    expect(text).not.toMatch(/\bopen\s*\([^)\n]*(?:\*|\bopener\b)/);
    // A module under an alias, a match class pattern that reads attributes by keyword, and a
    // method resolution order that hands over object (round 9 review M2 and L1).
    expect(text).not.toMatch(/^[ \t]*import[ \t][^\n#]*\bas\b/m);
    expect(text).not.toMatch(/^[ \t]*(?:match|case)[ \t][^\n]*:[ \t]*(?:#.*)?$/m);
    expect(text).not.toMatch(/\.mro\b/);
    // A submodule import, and a write call reached through a stream (round 10 review I5).
    expect(text).not.toMatch(/^[ \t]*import[ \t][^\n#]*\b[A-Za-z_]\w*\.[A-Za-z_]/m);
    expect(text).not.toMatch(/\.(?:buffer|raw|truncate|write|writelines|detach|fileno)\b/);
  });
});
