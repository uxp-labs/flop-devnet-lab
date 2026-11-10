#!/usr/bin/env node
// The source scan over the syntax tree (RULES.md section 4; Fable review M10).
//
// test/guard.test.ts scans the raw text of each src module with regular expressions. This scan
// reads what the code means instead: rolldown's TypeScript parser (the bundler vite and vitest
// run on, already pinned in package-lock.json) decodes every escape in a module name or an
// identifier and skips comments, so "n\x65t", fetch and from /* x */ "node:net" are read as
// net, fetch and node:net. It runs outside vitest because the tests block process.dlopen, which
// the parser's native code needs. If the parser is missing, this script fails: it never passes
// without scanning.
//
// Rules, for every .ts module under src (subfolders included) but guard.ts, which names what it
// blocks:
// - Imports, dynamic imports and re-exports name their module as one plain string, and that module
//   is relative or on the allow-list: node:fs, node:path, node:readline, node:url, node:crypto and
//   yaml. An allow-list, so a module nobody thought to ban (the legacy _http_client, a third party
//   client) fails too. From node:crypto only createHash may be imported.
// - No identifier, property or literal computed key from the banned list: transports reached as
//   globals, the global object by any name, code from strings, Reflect, constructor (a class's own
//   constructor method is fine), module loading outside import statements, and signing, key and
//   spending names.
// - process only as process.version, argv, exit, stdout, stderr or stdin.
// - No string or template names an RPC method that writes or signs.
// Before it scans src it proves itself: every BAD sample must fail and every GOOD sample must pass.
// Known limit: a computed key built at run time ([][k][k] with k assembled from pieces) can still
// reach Function; the runtime guard in the tests covers that path, not this scan.
//
// Prints a JSON array of {check, outcome: "pass" | "fail", stderr?}; exit 1 on any failure.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_MODULES = new Set(["node:fs", "node:path", "node:readline", "node:url", "node:crypto", "yaml"]);
const CRYPTO_NAMES = new Set(["createHash"]);
const PROCESS_MEMBERS = new Set(["version", "argv", "exit", "stdout", "stderr", "stdin"]);
const BANNED = new Set([
  // Transports reached as globals.
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "navigator",
  // The global object by any name, code from strings, and reflection.
  "globalThis",
  "global",
  "self",
  "window",
  "eval",
  "Function",
  "Reflect",
  "constructor",
  // Module loading outside import statements.
  "require",
  "createRequire",
  "getBuiltinModule",
  "internalBinding",
  "binding",
  "_linkedBinding",
  "dlopen",
  // Signing, keys and spending.
  "sign",
  "createSign",
  "signAndSend",
  "signRaw",
  "signPayload",
  "signTransaction",
  "signMessage",
  "signTypedData",
  "sendTransaction",
  "writeContract",
  "Keyring",
  "secretKey",
  "privateKey",
  "generateKeyPair",
  "generateKeyPairSync",
  "generateKey",
  "generateKeySync",
  "createPrivateKey",
  "createSecretKey",
  "createPublicKey",
  "KeyObject",
  "subtle",
  "webcrypto",
  "createHmac",
  "createCipheriv",
  "createDecipheriv",
  "privateEncrypt",
  "privateDecrypt",
  "publicEncrypt",
  "publicDecrypt",
  "createECDH",
  "createDiffieHellman",
  "diffieHellman",
]);
const WRITE_RPC = /author_submit|eth_send(?:Raw)?Transaction|eth_sign|personal_sign/;

function moduleProblem(name) {
  if (name.startsWith("./") || name.startsWith("../")) return null;
  return ALLOWED_MODULES.has(name) ? null : `imports ${JSON.stringify(name)}, which is not on the allow-list`;
}

/** Every rule the code breaks, as short sentences; empty when it breaks none. */
function problems(code) {
  let ast;
  try {
    ast = parseAst(code, { lang: "ts" });
  } catch (e) {
    return [`does not parse: ${String(e?.message ?? e).split("\n")[0]}`];
  }
  const out = [];
  const visit = (n, parent, key) => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x, parent, key);
      return;
    }
    if (!n || typeof n !== "object" || typeof n.type !== "string") return;
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        if (!n.source) break;
        const name = n.source.value;
        const p = moduleProblem(name);
        if (p) out.push(p);
        if (name === "node:crypto") {
          const only =
            n.type === "ImportDeclaration" &&
            n.specifiers.length > 0 &&
            n.specifiers.every((s) => s.type === "ImportSpecifier" && CRYPTO_NAMES.has(s.imported.name ?? s.imported.value));
          if (!only) out.push("imports from node:crypto something other than createHash");
        }
        break;
      }
      case "ImportExpression": {
        if (n.source?.type !== "Literal" || typeof n.source.value !== "string") out.push("a dynamic import names its module as something other than one plain string");
        else {
          const p = moduleProblem(n.source.value);
          if (p) out.push(p);
        }
        break;
      }
      case "Identifier": {
        const ownConstructor = key === "key" && parent?.type === "MethodDefinition" && parent.kind === "constructor";
        if (BANNED.has(n.name) && !ownConstructor) out.push(`uses ${n.name}`);
        else if (/mnemonic/i.test(n.name)) out.push(`uses ${n.name}`);
        if (n.name === "process") {
          const allowed = key === "object" && parent?.type === "MemberExpression" && !parent.computed && PROCESS_MEMBERS.has(parent.property?.name);
          if (!allowed) out.push("uses process other than process.version, argv, exit, stdout, stderr or stdin");
        }
        break;
      }
      case "MemberExpression": {
        const k = n.computed && n.property?.type === "Literal" && typeof n.property.value === "string" ? n.property.value : null;
        if (k !== null && (BANNED.has(k) || /mnemonic/i.test(k))) out.push(`reaches ${k} by a computed key`);
        if (!n.computed && n.object?.type === "Identifier" && n.object.name === "api" && n.property?.name === "tx") out.push("uses api.tx");
        break;
      }
      case "Literal": {
        if (typeof n.value === "string" && WRITE_RPC.test(n.value)) out.push(`names the RPC method ${n.value}`);
        break;
      }
      case "TemplateElement": {
        const cooked = n.value?.cooked;
        if (typeof cooked === "string" && WRITE_RPC.test(cooked)) out.push(`names the RPC method ${cooked}`);
        break;
      }
    }
    for (const k of Object.keys(n)) if (k !== "type") visit(n[k], n, k);
  };
  visit(ast, null, null);
  return out;
}

// Forms the scan must catch: the Fable review's M10 probes (escapes, legacy modules, a comment
// before the module name, key and signing APIs, third party clients) and every form the raw text
// scan in test/guard.test.ts claims to catch.
const BAD = [
  'import { request } from "node:https";',
  'import { connect } from "n\\x65t";',
  'const cp = await import("node:child_\\x70rocess");',
  "const r = await f\\u0065tch(url);",
  'const g = gl\\u006fbalThis["fe" + "tch"];',
  'import { ClientRequest } from "node:_http_client";',
  'import { Agent } from "_http_agent";',
  'import { TLSSocket } from "node:_tls_wrap";',
  'import { Socket } from /* x */ "node:net";',
  'import { createPrivateKey } from "node:crypto";',
  // Not on the banned list, so only the createHash-only rule catches these two.
  'import { pbkdf2Sync } from "node:crypto";',
  'import { createHash, createVerify } from "node:crypto";',
  'import * as c from "node:crypto";',
  'import crypto from "node:crypto";',
  'export { createHash } from "node:crypto";',
  "const s = wallet.signMessage(msg);",
  "const t = signer.signTypedData(domain, types, value);",
  'const u = await crypto.subtle["sign"](alg, key, data);',
  'const v = crypto["subtle"];',
  'import axios from "axios";',
  'import got from "got";',
  'import { request as req } from "undici";',
  'export * from "node:net";',
  'export { connect } from "node:net";',
  "const m = await import(name);",
  'const m2 = await import("node:" + "https");',
  "const m3 = await import(`node:${name}`);",
  'const fs = require("node:fs");',
  'const cp2 = createRequire(import.meta.url)("node:child_process");',
  "const F = [].constructor.constructor;",
  'const F2 = []["constructor"]["constructor"];',
  "const AF = Object.getPrototypeOf(async () => {}).constructor;",
  'const h = process.getBuiltinModule("node:https");',
  'const h2 = proc.getBuiltinModule("node:https");',
  'const s2 = process.binding("spawn_sync");',
  'const b = (process as any)["bind" + "ing"];',
  'const d = process?.["dlopen"];',
  "const p = process;",
  "const home = process.env.HOME;",
  'const gb = Reflect.get(process, "getBuiltin" + "Module");',
  'const r2 = eval("1");',
  "const z = (0, eval)(code);",
  'const f2 = new Function("return 1");',
  'const g2 = Function("return this")();',
  "const r3 = await fetch.call(null, url);",
  "const ws = new globalThis.WebSocket(url);",
  "const W = WebSocket;",
  "const es = new EventSource(url);",
  'const x = global["fetch"];',
  "const y = self.fetch;",
  "await api.tx.balances.transferKeepAlive(to, 1).signAndSend(pair);",
  "const sig = pair.sign(message);",
  "const keyring = new Keyring();",
  "const words = wallet.mnemonicPhrase;",
  'const method = "author_submitExtrinsic";',
  "const call = `eth_sendRawTransaction`;",
  "const k = createSecretKey(bytes);",
];

// Forms src uses that must pass.
const GOOD = [
  'import { readFileSync } from "node:fs";',
  'import { createHash } from "node:crypto";',
  'import type { Snapshot } from "./types.js";',
  'import YAML from "yaml";',
  'export { parseZoned } from "./strict.js";',
  'const t = await import("./types.js");',
  "process.stdout.write(out);",
  "const v = process.version;",
  "const a = process.argv.slice(2);",
  "class A { constructor(x: number) { this.x = x; } x: number; }",
  "const fetchedAt = reading.fetched_at;",
  "const signal = 1; const signed = true; const design = 2;",
  "// fetch, WebSocket and process.env in a comment are not code",
  'const note = "a gateway report is not chain proof";',
  "const o = { [key]: 1 }; const w = o[key];",
];

const results = [];
let bad = 0;
const record = (check, pass, stderr) => {
  if (!pass) bad++;
  results.push({ check, outcome: pass ? "pass" : "fail", ...(pass ? {} : { stderr }) });
};
for (const code of BAD) {
  const p = problems(code);
  record(`catches: ${code}`, p.length > 0 && !p.some((x) => x.startsWith("does not parse")), p.length ? p.join("; ") : "nothing found");
}
for (const code of GOOD) {
  const p = problems(code);
  record(`allows: ${code}`, p.length === 0, p.join("; "));
}
const src = join(pkg, "src");
const files = readdirSync(src, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".ts") && f !== "guard.ts")
  .sort();
record("src holds the modules the scan expects to read", files.length > 10 && files.includes("status.ts") && files.includes("cli.ts"), `found ${files.length}: ${files.join(", ")}`);
for (const f of files) {
  const p = problems(readFileSync(join(src, f), "utf8"));
  record(`src/${f} passes the syntax tree scan`, p.length === 0, p.join("; "));
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
