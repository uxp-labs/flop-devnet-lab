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
// - Imports and re-exports name their module as one plain string, and that module is relative or
//   on the allow-list: node:fs, node:path, node:readline, node:url, node:crypto and yaml. An
//   allow-list, so a module nobody thought to ban (the legacy _http_client, a third party client)
//   fails too. From node:crypto only createHash may be imported. Every import names what it takes:
//   no default or namespace import, no export *, and no dynamic import() (round 9 review M1), so src
//   never holds a module object whose exports Object.entries could list by names the scan cannot
//   read.
// - No identifier, property or literal computed key from the banned list: transports reached as
//   globals, the global object by any name, code from strings, Reflect, constructor (a class's own
//   constructor method is fine), module loading outside import statements, and signing, key and
//   spending names.
// - process only as process.version, argv, exit, process.stdout.write(...),
//   process.stderr.write(...) and createInterface({ input: process.stdin }), so no stream src holds
//   can be asked to connect, handed on or read for its handle.
// - The reader that call hands back holds stdin, so it is named only as rl.on(event, arrow
//   function) in a statement of its own, rl being a const that is not exported and holds the whole
//   call, and createInterface is named only there and in its import from node:readline: the reader
//   is never listed, handed on, kept as the value on returns or given to a listener as this.
// - No string, template or regular expression names an RPC method that writes or signs.
// - No computed key that is not a string or number literal, in a member access (o[k], o?.[k],
//   super[k]), an object, a pattern or a class (round 8 review M1). A name only known at run time,
//   read back from a regular expression, decoded, trimmed or listed, can then never be used to
//   reach anything: every property src reads or writes is named in the code, where the rules above
//   read it. src reads a data record by a run time key through own() in src/own.ts, which walks the
//   record's own entries and never hands back a function.
// - One exemption, for the composition root of the live read (RULES.md section 4): src/live-bin.ts
//   may name the global WebSocket class and fetch, each exactly once, and only as the value of a
//   plain property (no shorthand, no computed key, no method or getter) of the object literal that
//   is the one argument of `new NetTransport(...)`. Every other rule still holds there, and no other
//   module, nor a live-bin.ts in a subfolder, gets the exemption.
// Before it scans src it proves itself: every BAD sample must fail and every GOOD sample must pass.
// Known limit: the scan reads what src names, not what an allowed module does with the arguments
// it is given; the runtime guard in the tests covers that.
//
// Prints a JSON array of {check, outcome: "pass" | "fail", stderr?}; exit 1 on any failure.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  // The Web Crypto global and its key and signing methods, reached by name or by string key.
  "crypto",
  "importKey",
  "exportKey",
  "deriveKey",
  "deriveBits",
  "wrapKey",
  "unwrapKey",
  "encrypt",
  "decrypt",
  // Ways to define a getter on a prototype or rewire one, which reach the global object under a
  // name that is not banned (round 7 review M3).
  "defineProperty",
  "defineProperties",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "setPrototypeOf",
  "getPrototypeOf",
  // Round 8 review M1: names that list or decode a key, write properties by names from data, hook
  // stack frames or run code from bytes, and the calls that open a socket or a pipe on a stream
  // src already holds (process.stdout is a socket under a pipe).
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "atob",
  "assign",
  "prepareStackTrace",
  "WebAssembly",
  "connect",
  "connect6",
  "listen",
  "bind",
  "bind6",
  // Round 9 review M1: the Web Crypto classes, globals whose prototypes list the key and signing
  // methods.
  "SubtleCrypto",
  "CryptoKey",
  "Crypto",
]);
// An underscore name is an internal (a stream's _handle, console._stdout, __proto__): src has no
// use for one.
const INTERNAL = /^_[A-Za-z_$]/;
// Keys the scan reads itself: a string or a number written in the code.
const literalKey = (k) => k?.type === "Literal" && (typeof k.value === "string" || typeof k.value === "number");
const KEYED = new Set(["MemberExpression", "Property", "MethodDefinition", "PropertyDefinition", "AccessorProperty"]);
const WRITE_RPC = /author_submit|eth_send(?:Raw)?Transaction|eth_sign|personal_sign/;

const SRC = join(pkg, "src");

// The one exemption: the composition root of the live read, by its path inside src, and the two
// globals it hands to the transport it makes.
const COMPOSITION_ROOT = "live-bin.ts";
const ROOT_GLOBALS = new Set(["WebSocket", "fetch"]);

/**
 * A relative module must land on a scanned module: a `.js` name whose `.ts` file is in src. So a
 * path out of src (into scripts, node_modules or anywhere else) and a `.mjs` or `.cjs` module that
 * neither scan reads both fail (round 7 review M4).
 */
function moduleProblem(name, file, scanned) {
  if (name.startsWith("./") || name.startsWith("../")) {
    const target = resolve(dirname(join(SRC, file)), name);
    const inside = relative(SRC, target);
    if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") return `imports ${JSON.stringify(name)}, which leaves src`;
    if (!inside.endsWith(".js")) return `imports ${JSON.stringify(name)}, which is not a .js name of a .ts module in src`;
    const ts = inside.slice(0, -3) + ".ts";
    return scanned.has(ts.split(sep).join("/")) ? null : `imports ${JSON.stringify(name)}, which is no scanned module in src`;
  }
  return ALLOWED_MODULES.has(name) ? null : `imports ${JSON.stringify(name)}, which is not on the allow-list`;
}

/**
 * A banned name as a string: a key, an argument or any other string is the name all the same, an
 * underscore name included (round 10 review L1: x["__proto__"], console["_stdout"]).
 */
const bannedText = (v) => typeof v === "string" && (BANNED.has(v) || /mnemonic/i.test(v) || INTERNAL.test(v));
// The reader's own streams: createInterface hands stdin back as .input (round 10 review L3).
const READER_STREAMS = new Set(["input", "output"]);

/**
 * Every rule the code breaks, as short sentences; empty when it breaks none. file is the module's
 * path inside src (a sample is read as src/sample.ts), and scanned the src modules both scans read.
 */
function problems(code, file = "sample.ts", scanned = SCANNED) {
  let ast;
  try {
    ast = parseAst(code, { lang: "ts" });
  } catch (e) {
    return [`does not parse: ${String(e?.message ?? e).split("\n")[0]}`];
  }
  const out = [];
  // Each node's parent and the key it sits under, so a rule can read a node's context.
  const up = new Map();
  // Every identifier, for the reader rule below, which reads them once the whole tree is known.
  const ids = [];
  // How often each exempted global has been named, in the composition root only.
  const rootUses = new Map();
  /**
   * The exemption's one form: in src/live-bin.ts, WebSocket or fetch as the value of a plain
   * property of the object literal that is the one argument of new NetTransport(...).
   */
  const rootGlobal = (n, parent, key) => {
    if (file !== COMPOSITION_ROOT || !ROOT_GLOBALS.has(n.name)) return false;
    if (key !== "value" || parent?.type !== "Property" || parent.computed || parent.shorthand || parent.method || parent.kind !== "init") return false;
    const inObject = up.get(parent);
    if (inObject?.key !== "properties" || inObject.parent?.type !== "ObjectExpression") return false;
    const inCall = up.get(inObject.parent);
    const call = inCall?.parent;
    return inCall?.key === "arguments" && call?.type === "NewExpression" && call.callee?.type === "Identifier" && call.callee.name === "NetTransport" && call.arguments.length === 1;
  };
  const visit = (n, parent, key) => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x, parent, key);
      return;
    }
    if (!n || typeof n !== "object" || typeof n.type !== "string") return;
    up.set(n, { parent, key });
    if (KEYED.has(n.type) && n.computed === true) {
      const k = n.type === "MemberExpression" ? n.property : n.key;
      if (!literalKey(k)) out.push(`uses a computed key the scan cannot read: ${code.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 60)}`);
    }
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        if (!n.source) break;
        const name = n.source.value;
        const p = moduleProblem(name, file, scanned);
        if (p) out.push(p);
        // Every import names what it takes (round 9 review M1): a default or namespace import, or
        // export *, hands over a whole module object.
        if (n.type === "ExportAllDeclaration") out.push(`re-exports the whole of ${JSON.stringify(name)} (export *)`);
        if (n.type === "ImportDeclaration" && n.specifiers.some((s) => s.type !== "ImportSpecifier")) out.push(`imports ${JSON.stringify(name)} as a module object (a default or namespace import)`);
        // The default export by its name is the module object too (round 10 review L2).
        const names = (n.specifiers ?? []).flatMap((s) => [s.imported, s.local].map((x) => x?.name ?? x?.value));
        if (names.includes("default")) out.push(`takes the default export of ${JSON.stringify(name)} by its name`);
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
        // A dynamic import hands back a module object, whose exports Object.entries lists by names
        // the scan cannot read, and the createHash rule has no specifier list to hold it to (round 9
        // review M1). src loads every module by a static named import.
        out.push("uses a dynamic import(); src imports every module statically, by name");
        break;
      }
      case "TSImportEqualsDeclaration": {
        // import n = require("..."): tsc writes a require for it, and no other rule reads its name.
        out.push("uses an import-equals declaration (import x = require(...))");
        break;
      }
      case "Identifier": {
        ids.push(n);
        const ownConstructor = key === "key" && parent?.type === "MethodDefinition" && parent.kind === "constructor";
        const exempt = rootGlobal(n, parent, key);
        if (exempt) {
          rootUses.set(n.name, (rootUses.get(n.name) ?? 0) + 1);
          if (rootUses.get(n.name) > 1) out.push(`names ${n.name} more than once in the composition root`);
        }
        if (BANNED.has(n.name) && !ownConstructor && !exempt) out.push(`uses ${n.name}`);
        else if (/mnemonic/i.test(n.name)) out.push(`uses ${n.name}`);
        else if (INTERNAL.test(n.name)) out.push(`uses the internal ${n.name}`);
        if (n.name === "process") {
          const member = key === "object" && parent?.type === "MemberExpression" && !parent.computed ? parent.property?.name : undefined;
          let allowed = PROCESS_MEMBERS.has(member);
          if (member === "stdout" || member === "stderr") {
            // Only process.stdout.write(...) and process.stderr.write(...).
            const write = up.get(parent);
            const call = write ? up.get(write.parent) : undefined;
            allowed = write?.key === "object" && write.parent?.type === "MemberExpression" && !write.parent.computed && write.parent.property?.name === "write" && call?.key === "callee" && call.parent?.type === "CallExpression";
          } else if (member === "stdin") {
            // Only as the input of a reader: createInterface({ input: process.stdin }), the object
            // being the call's argument, so stdin cannot be read back under another name (round 9
            // review I7).
            const prop = up.get(parent);
            const literal = prop?.parent ? up.get(prop.parent) : undefined;
            const call = literal?.parent ? up.get(literal.parent) : undefined;
            allowed =
              prop?.key === "value" && prop.parent?.type === "Property" && !prop.parent.computed && prop.parent.key?.type === "Identifier" && prop.parent.key.name === "input" &&
              literal?.parent?.type === "ObjectExpression" && call?.key === "arguments" && call.parent?.type === "CallExpression" && call.parent.callee?.type === "Identifier" && call.parent.callee.name === "createInterface";
          }
          if (!allowed) out.push("uses process other than process.version, argv, exit, stdout.write(...), stderr.write(...) or createInterface({ input: process.stdin })");
        }
        break;
      }
      case "MemberExpression": {
        // A literal computed key, as in ["constructor"], is a string, which the Literal rule reads.
        if (!n.computed && n.object?.type === "Identifier" && n.object.name === "api" && n.property?.name === "tx") out.push("uses api.tx");
        const member = n.computed ? (n.property?.type === "Literal" ? n.property.value : undefined) : n.property?.name;
        if (READER_STREAMS.has(member)) out.push(`reads .${member}, a reader's stream`);
        break;
      }
      case "ObjectPattern": {
        // The same read by destructuring: const { input } = rl.
        for (const p of n.properties ?? []) {
          const name = p.type === "Property" ? (p.key?.type === "Identifier" ? p.key.name : p.key?.value) : undefined;
          if (READER_STREAMS.has(name)) out.push(`reads ${name}, a reader's stream, by destructuring`);
        }
        break;
      }
      case "Literal": {
        // A regular expression's pattern can be read back as a string (/constructor/.source).
        if (n.regex && (bannedText(n.regex.pattern) || WRITE_RPC.test(n.regex.pattern))) out.push(`names ${n.regex.pattern} in a regular expression`);
        if (typeof n.value === "string" && WRITE_RPC.test(n.value)) out.push(`names the RPC method ${n.value}`);
        // A string key in a pattern or an object, a computed key or a plain argument: a banned name
        // spelled as a string reaches the same thing (round 7 review M3).
        if (bannedText(n.value)) out.push(`names ${n.value} in a string`);
        break;
      }
      case "TemplateElement": {
        const cooked = n.value?.cooked;
        if (typeof cooked === "string" && WRITE_RPC.test(cooked)) out.push(`names the RPC method ${cooked}`);
        if (bannedText(cooked)) out.push(`names ${cooked} in a template`);
        break;
      }
    }
    for (const k of Object.keys(n)) if (k !== "type") visit(n[k], n, k);
  };
  visit(ast, null, null);
  // The reader createInterface hands back holds stdin, so listing it (Object.entries(rl)) or
  // handing it on hands stdin over by no name the rules above read. createInterface is named only
  // in its import from node:readline and as the whole value of a const that is not exported, and
  // that const is named only as rl.on(event, arrow function) in a statement of its own: on returns
  // the reader, and a listener that is not an arrow function gets the reader as this.
  const readers = new Set();
  const declared = new Set();
  for (const id of ids) {
    if (id.name !== "createInterface") continue;
    const { parent, key } = up.get(id);
    const spec = parent?.type === "ImportSpecifier" ? parent : undefined;
    const from = spec ? up.get(spec)?.parent : undefined;
    const imported =
      spec !== undefined && from?.type === "ImportDeclaration" && from.source?.value === "node:readline" &&
      (spec.imported?.name ?? spec.imported?.value) === "createInterface" && spec.local?.name === "createInterface";
    const init = parent?.type === "CallExpression" && key === "callee" ? up.get(parent) : undefined;
    const declarator = init?.key === "init" && init.parent?.type === "VariableDeclarator" && init.parent.id?.type === "Identifier" ? init.parent : undefined;
    const declaration = declarator ? up.get(declarator)?.parent : undefined;
    const exported = declaration ? up.get(declaration)?.parent?.type === "ExportNamedDeclaration" : false;
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const" && !exported) {
      readers.add(declarator.id.name);
      declared.add(declarator.id);
    } else if (!imported) out.push("names createInterface other than in its import from node:readline and as the whole value of a const that is not exported");
  }
  for (const id of ids) {
    if (!readers.has(id.name) || declared.has(id)) continue;
    const { parent, key } = up.get(id);
    const call = parent?.type === "MemberExpression" && key === "object" && !parent.computed && parent.property?.name === "on" ? up.get(parent) : undefined;
    const statement = call?.key === "callee" && call.parent?.type === "CallExpression" ? up.get(call.parent) : undefined;
    const ok = statement?.key === "expression" && statement.parent?.type === "ExpressionStatement" && call.parent.arguments[1]?.type === "ArrowFunctionExpression";
    if (!ok) out.push(`uses the reader ${id.name} other than as ${id.name}.on(event, arrow function) in a statement of its own`);
  }
  return out;
}

/** Every regular .ts file under dir (as a path with /), and every other file or link there. */
function listSrc(dir) {
  const modules = [];
  const others = [];
  for (const entry of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const st = lstatSync(join(dir, entry));
    if (st.isDirectory()) continue;
    const name = entry.split(sep).join("/");
    if (st.isFile() && name.endsWith(".ts")) modules.push(name);
    else others.push(name);
  }
  return { modules, others };
}
// The modules a relative import may land on: every .ts file in src, guard.ts included (it is
// read by the raw text scan and is the one module allowed to name what it blocks).
const SCANNED = new Set(listSrc(SRC).modules);

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
  // Round 7 review M3: string keys, a template key, a plain string argument, a getter on a
  // prototype, and the Web Crypto global.
  'const { "constructor": C } = () => 0;',
  "const F3 = arrow[`constructor`];",
  'const d2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "constructor");',
  'Object.defineProperty(Object.prototype, "__g", { get() { return this; } });',
  'const { "f\\u0065tch": f3, "W\\u0065bSocket": W3 } = __g;',
  'const { "subtle": s3 } = webcrypto2;',
  'const { "s\\u0069gn": sg, "generateKey": gk, "importKey": ik } = s3;',
  "const r4 = crypto.getRandomValues(buf);",
  // Round 7 review M4: an import-equals, and relative paths that leave src or land on a module no
  // scan reads.
  'import n = require("node:n\\x65t");',
  'import { reach6 } from "./p6_transport.mjs";',
  'const m5 = await import("../scripts/mcp-transcript.mjs");',
  'import ws from "../node_modules/ws/index.js";',
  'import { x } from "./no-such-module.js";',
  // Round 8 review M1: a key that is one literal read back, decoded or listed, then used as a
  // computed key; and a stream src holds asked to connect.
  "const k = /constructor/.source; const C = ((() => 0) as any)[k];",
  // A banned name in a template that is no key: the template rule alone reads it.
  "const k2 = `constructor`;",
  // Round 9 review M1: a module object, by a dynamic import, a default or namespace import or
  // export *, whose exports Object.entries lists; the Web Crypto classes; stdin read back.
  'const c = await import("node:crypto"); for (const [k, v] of Object.entries(c)) use(k, v);',
  'const t = await import("./types.js");',
  'import * as fs from "node:fs"; const all = Object.entries(fs);',
  'import fs2 from "node:fs";',
  'import YAML from "yaml";',
  'export * from "./strict.js";',
  'export * as st from "./strict.js";',
  "const methods = Object.entries(SubtleCrypto.prototype);",
  "const k3 = CryptoKey;",
  "const s5 = { input: process.stdin }.input;",
  "const s6 = make({ input: process.stdin });",
  // Round 10 review L1 to L3: underscore names as strings, the default export by its name, and the
  // reader's stream read back.
  'const pr2 = x["__proto__"];',
  'const { "__proto__": p7 } = x;',
  'const out7 = console["_stdout"];',
  "const h7 = rl.input[`_handle`];",
  'import { default as m7 } from "node:fs";',
  'export { default as pathModule } from "node:path";',
  "const s7 = rl.input;",
  'const s8 = rl["output"];',
  "const { input: s9 } = rl;",
  // Names that newer rules also catch in the samples above, each now in a sample it alone catches,
  // so every ban is shown to bite on its own.
  'Object.defineProperty(o, "x", { value: 1 });',
  "const c9 = sock.connect(443, host);",
  // The reader listed, its listener given it as this, on's value kept, a stand-in createInterface,
  // and the reader exported: each hands stdin over by no name.
  "const rl1 = createInterface({ input: process.stdin }); const all1 = Object.entries(rl1);",
  'const rl2 = createInterface({ input: process.stdin }); rl2.on("line", function (l) { use(this, l); });',
  'const rl3 = createInterface({ input: process.stdin }); const again3 = rl3.on("line", (l) => use(l));',
  "function createInterface(o) { return Object.values(o); } const s10 = createInterface({ input: process.stdin });",
  "export const rl5 = createInterface({ input: process.stdin });",
  "class A { constructor() {} } const k = Object.getOwnPropertyNames(A.prototype)[0] as string; const C = ((() => 0) as any)[k];",
  'const k = atob("Y29uc3RydWN0b3I="); const C = ((() => 0) as any)[k];',
  String.raw`const k = JSON.parse('"\u0063onstructor"') as string; const C = ((() => 0) as any)[k];`,
  'const k = "constructor ".trim(); const C = ((() => 0) as any)[k];',
  "const t = typeof (process.stdout as any).connect;",
  "const t2 = typeof (process.stdin as any).connect;",
  "const v = Object.values(process.stdout);",
  "process.stdin.on(\"data\", f);",
  "const s9 = process.stdin;",
  "const out9 = process.stdout;",
  "rl.input.connect(path);",
  "const h = stream._handle;",
  "const pr = x.__proto__;",
  "Error.prepareStackTrace = (e, s) => s;",
  "const w = await WebAssembly.instantiate(bytes);",
  "Object.assign(Error, extra);",
  "const f4 = run.bind(null);",
  "const r5 = /fetch/;",
  // Every computed key that is not a literal, wherever it sits.
  "const { [k]: C2 } = obj;",
  "const o2 = { [k]: 1 };",
  "class B { [k]() {} }",
  "class B2 { static [k] = 1; }",
  "const v2 = o?.[k];",
  "const v3 = o[`x`];",
  "delete o[k];",
  "o[k] = 1;",
  "o[k] += 1;",
  "for (const k2 in o) use(o[k2]);",
  "class C3 extends A { m() { return super[k]; } }",
  "const v4 = o[null];",
];

// Forms src uses that must pass.
const GOOD = [
  'import { readFileSync } from "node:fs";',
  'import { createHash } from "node:crypto";',
  'import type { Snapshot } from "./types.js";',
  'import { parse } from "yaml";',
  'export { parseZoned } from "./strict.js";',
  "process.stdout.write(out);",
  "const v = process.version;",
  "const a = process.argv.slice(2);",
  "class A { constructor(x: number) { this.x = x; } x: number; }",
  "const fetchedAt = reading.fetched_at;",
  "const signal = 1; const signed = true; const design = 2;",
  "// fetch, WebSocket and process.env in a comment are not code",
  'const note = "a gateway report is not chain proof";',
  'const o = { a: 1, "b-c": 2 }; const w = o["b-c"] + o.a + list[0];',
  'const w2 = own(record, key); const first = list.at(0); const c = text.charAt(i);',
  'import { createInterface } from "node:readline"; const rl = createInterface({ input: process.stdin }); rl.on("line", (line) => use(line));',
  "process.stderr.write(msg);",
  "for (const [k, v] of Object.entries(o)) use(k, v);",
];

// The composition root's exemption, in its one form, and every way it could widen: another use of
// either global there, a second transport, another callee or argument list, a shorthand, computed,
// method or getter property, another global, and the same form in any other module.
const ROOT_FORM = "const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch });";
const ROOT_GOOD = [ROOT_FORM, "const t = new NetTransport({ httpCall: fetch, socketClass: WebSocket, rpcUrl: url });"];
const ROOT_BAD = [
  "const f = fetch;",
  "const r = await fetch(url);",
  "const w = new WebSocket(url);",
  `${ROOT_FORM} const r = await fetch(url);`,
  `${ROOT_FORM} const u = new NetTransport({ socketClass: WebSocket, httpCall: fetch });`,
  "const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch, again: fetch });",
  "const t = new Other({ socketClass: WebSocket, httpCall: fetch });",
  "const t = NetTransport({ socketClass: WebSocket, httpCall: fetch });",
  "const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch }, extra);",
  "const t = new NetTransport({ socketClass: WebSocket, fetch });",
  'const t = new NetTransport({ socketClass: WebSocket, ["httpCall"]: fetch });',
  "const t = new NetTransport({ socketClass: WebSocket, httpCall() { return fetch; } });",
  "const t = new NetTransport({ socketClass: WebSocket, get httpCall() { return fetch; } });",
  "const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch.call });",
  "const t = new NetTransport({ socketClass: WebSocket, httpCall: globalThis.fetch });",
  "const t = new NetTransport({ socketClass: EventSource, httpCall: fetch });",
  'const t = new NetTransport({ socketClass: WebSocket, httpCall: fetch }); const s = "fetch";',
  "const t = new NetTransport({ socketClass: WebSocket, httpCall: (u, o) => fetch(u, o) });",
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
for (const code of ROOT_GOOD) {
  const p = problems(code, COMPOSITION_ROOT);
  record(`allows in src/${COMPOSITION_ROOT}: ${code}`, p.length === 0, p.join("; "));
}
for (const code of ROOT_BAD) {
  const p = problems(code, COMPOSITION_ROOT);
  record(`catches in src/${COMPOSITION_ROOT}: ${code}`, p.length > 0 && !p.some((x) => x.startsWith("does not parse")), p.length ? p.join("; ") : "nothing found");
}
for (const file of ["cli.ts", "net.ts", "live/live-bin.ts", "live-bin.mts.ts", "xlive-bin.ts"]) {
  const p = problems(ROOT_FORM, file);
  record(`catches in src/${file}, which is not the composition root: ${ROOT_FORM}`, p.some((x) => x === "uses WebSocket") && p.some((x) => x === "uses fetch"), p.length ? p.join("; ") : "nothing found");
}
// The file list check, proved on a throwaway folder: a .mts module, a .js file and a link to a
// .ts file are each something tsc may compile that no scan would read.
{
  const box = realpathSync(mkdtempSync(join(tmpdir(), "obs-scan-list-")));
  try {
    mkdirSync(join(box, "live"));
    writeFileSync(join(box, "a.ts"), "");
    writeFileSync(join(box, "live", "b.ts"), "");
    writeFileSync(join(box, "c.mts"), "");
    writeFileSync(join(box, "d.js"), "");
    symlinkSync(join(box, "a.ts"), join(box, "e.ts"));
    const got = listSrc(box);
    record(
      "the file list reads .ts modules in subfolders, and names every other file",
      JSON.stringify(got.modules) === JSON.stringify(["a.ts", "live/b.ts"]) && JSON.stringify(got.others) === JSON.stringify(["c.mts", "d.js", "e.ts"]),
      JSON.stringify(got),
    );
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}
const { modules, others } = listSrc(SRC);
record("src holds the modules the scan expects to read", modules.length > 10 && modules.includes("status.ts") && modules.includes("cli.ts"), `found ${modules.length}: ${modules.join(", ")}`);
record("src holds nothing but regular .ts files, so every file tsc compiles is scanned", others.length === 0, `also found: ${others.join(", ")}`);
for (const f of modules.filter((m) => m !== "guard.ts")) {
  const p = problems(readFileSync(join(SRC, f), "utf8"), f);
  record(`src/${f} passes the syntax tree scan`, p.length === 0, p.join("; "));
}
console.log(JSON.stringify(results, null, 2));
// exitCode, not exit(): the mutation runner reads this report through a pipe, where a write is
// asynchronous and exit() could cut it short.
process.exitCode = bad ? 1 : 0;
