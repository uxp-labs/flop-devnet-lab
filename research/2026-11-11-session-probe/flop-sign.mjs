#!/usr/bin/env node
// flop-sign: builds and signs a few FLOP devnet extrinsics offline, for the session probe.
//
// It talks to no network. It reads a key file and prints a signed extrinsic as hex. Someone else
// sends that hex to a node (author_submitExtrinsic). A signed extrinsic is public once sent.
// The key file is never printed. The tool signs only the call shapes listed in SHAPES below and
// refuses everything else. It prints in plain words what it is about to sign.
//
// Chain facts are from the metadata of FLOP Devnet at spec 1014014 (482132 bytes, sha256
// f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444), read on 2026-11-11:
//   extrinsic version 4; address MultiAddress (0 = Id); signature MultiSignature (0 = Ed25519)
//   signed extensions, in order, with what each adds to the extrinsic and to the signed payload:
//     CheckNonZeroSender        nothing             nothing
//     CheckSpecVersion          nothing             u32 spec version
//     CheckTxVersion            nothing             u32 transaction version
//     CheckGenesis              nothing             genesis hash
//     CheckMortality            era (0x00 immortal) block hash (genesis for an immortal era)
//     CheckNonce                compact nonce       nothing
//     CheckWeight               nothing             nothing
//     ChargeTransactionPayment  compact tip         nothing
//     CheckMetadataHash         mode (0x00 off)     Option hash (0x00 none)
//
// Usage (LIBS is a folder whose node_modules holds @noble/curves, @noble/hashes and @scure/base):
//   node flop-sign.mjs keygen --out <key file>
//   node flop-sign.mjs pub --key <key file>
//   node flop-sign.mjs keys --owner <0x32 bytes> --delegate <0x32 bytes>
//   node flop-sign.mjs call transfer --to <0x32> --amount <raw units>
//   node flop-sign.mjs call sweep --to <0x32>
//   node flop-sign.mjs call create-session --delegate <0x32> --cap <raw> --per-tx <raw> --daily <raw> --blocks <n> --allow <name,name or empty>
//   node flop-sign.mjs call via-session --owner <0x32> --inner timeout:<0x32> | remark:<text> --spend <raw> --nonce <n>
//   node flop-sign.mjs call revoke --delegate <0x32>
//   node flop-sign.mjs sign --key <key file> --call <0x hex> --nonce <n> --out <file.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (i + 1 >= argv.length) fail(`--${name} needs a value`);
  return argv[i + 1];
};
function fail(msg) {
  process.stderr.write(`flop-sign: ${msg}\n`);
  process.exit(2);
}

const LIBS = resolve(flag("libs", process.env.FLOP_SIGN_LIBS ?? `${process.env.HOME}/lab/imd-flop`));
const req = createRequire(`${LIBS}/package.json`);
const load = async (name) => import(req.resolve(name));
const { ed25519 } = await load("@noble/curves/ed25519.js");
const { blake2b } = await load("@noble/hashes/blake2.js");
const { base58, base64 } = await load("@scure/base");

// ---- chain constants -----------------------------------------------------------------------
const SPEC = Number(flag("spec", "1014014"));
const TXV = Number(flag("txv", "2"));
const GENESIS = flag("genesis", "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631");
const FLOP = 10n ** 18n;
const MAX_TRANSFER = FLOP; // this tool never signs a transfer above 1 FLOP
const MAX_SESSION_CAP = FLOP; // nor a session whose lifetime cap is above 1 FLOP
const MAX_SESSION_BLOCKS = 14400; // nor a session longer than about four hours

// ---- bytes ----------------------------------------------------------------------------------
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const unhex = (h, len) => {
  if (typeof h !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(h)) fail(`not lower case hex: ${String(h).slice(0, 24)}`);
  const b = Uint8Array.from(Buffer.from(h.slice(2), "hex"));
  if (len !== undefined && b.length !== len) fail(`expected ${len} bytes, got ${b.length}`);
  return b;
};
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const uint = (v, bytes) => {
  let n = BigInt(v);
  if (n < 0n || n >= 1n << BigInt(8 * bytes)) fail(`${v} does not fit in ${bytes} bytes`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const compact = (v) => {
  const n = BigInt(v);
  if (n < 0n) fail("a compact number is not negative");
  if (n < 1n << 6n) return uint(n << 2n, 1);
  if (n < 1n << 14n) return uint((n << 2n) | 1n, 2);
  if (n < 1n << 30n) return uint((n << 2n) | 2n, 4);
  let len = 0;
  for (let x = n; x > 0n; x >>= 8n) len++;
  return cat(Uint8Array.of(((len - 4) << 2) | 3), uint(n, len));
};
const amount = (s, what) => {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s)) fail(`${what} must be a whole number of raw units`);
  return BigInt(s);
};
const flopText = (raw) => {
  const whole = raw / FLOP;
  const frac = (raw % FLOP).toString().padStart(18, "0").replace(/0+$/, "");
  return `${raw} raw (${whole}${frac ? "." + frac : ""} FLOP)`;
};

// ---- a strict reader for the calls this tool signs --------------------------------------------
class In {
  constructor(bytes) { this.b = bytes; this.o = 0; }
  take(n) {
    if (this.o + n > this.b.length) fail("the call ends early");
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  u(bytes) {
    let n = 0n;
    const b = this.take(bytes);
    for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    return n;
  }
  compact() {
    const first = this.take(1)[0];
    const mode = first & 3;
    if (mode === 0) return BigInt(first >> 2);
    if (mode === 1) { this.o -= 1; return this.u(2) >> 2n; }
    if (mode === 2) { this.o -= 1; return this.u(4) >> 2n; }
    return this.u((first >> 2) + 4);
  }
  done() { if (this.o !== this.b.length) fail(`the call has ${this.b.length - this.o} bytes too many`); }
}

/** Reads a call and says in plain words what it does. Refuses any call it does not know. */
function describe(callBytes, nested = false) {
  const r = new In(callBytes);
  const pallet = r.take(1)[0];
  const index = r.take(1)[0];
  const id = `${pallet}/${index}`;
  let text;
  if (id === "4/3" && !nested) {
    if (r.take(1)[0] !== 0) fail("the destination must be an account id");
    const to = hex(r.take(32));
    const value = r.compact();
    if (value > MAX_TRANSFER) fail(`this tool signs no transfer above ${flopText(MAX_TRANSFER)}`);
    text = `Balances.transfer_keep_alive: send ${flopText(value)} to ${to}`;
  } else if (id === "4/4" && !nested) {
    if (r.take(1)[0] !== 0) fail("the destination must be an account id");
    const to = hex(r.take(32));
    const keep = r.take(1)[0];
    if (keep > 1) fail("keep_alive must be 0 or 1");
    text = `Balances.transfer_all: send everything the signer has to ${to} (keep_alive ${keep === 1})`;
  } else if (id === "94/0" && !nested) {
    const delegate = hex(r.take(32));
    const cap = r.u(16), perTx = r.u(16), daily = r.u(16);
    const blocks = Number(r.u(4));
    const n = Number(r.compact());
    const names = [];
    for (let i = 0; i < n; i++) names.push(Buffer.from(r.take(Number(r.compact()))).toString("utf8"));
    if (cap > MAX_SESSION_CAP) fail(`this tool signs no session with a lifetime cap above ${flopText(MAX_SESSION_CAP)}`);
    if (blocks > MAX_SESSION_BLOCKS) fail(`this tool signs no session longer than ${MAX_SESSION_BLOCKS} blocks`);
    text = `FlopSessionKeys.create_session: let ${delegate} spend from the signer's account, lifetime cap ${flopText(cap)}, per call ${flopText(perTx)}, per day ${flopText(daily)}, for ${blocks} blocks, allowed pallets ${n === 0 ? "(none listed: every pallet the chain permits)" : names.join(", ")}`;
  } else if (id === "94/1" && !nested) {
    text = `FlopSessionKeys.revoke_session: end the session of delegate ${hex(r.take(32))}`;
  } else if (id === "94/2" && !nested) {
    const owner = hex(r.take(32));
    const rest = callBytes.subarray(r.o);
    const innerLen = innerLength(rest);
    const inner = describe(r.take(innerLen), true);
    const spend = r.u(16);
    const nonce = r.u(8);
    text = `FlopSessionKeys.execute_via_session: as owner ${owner}, declared spend ${flopText(spend)}, session nonce ${nonce}, run: ${inner}`;
  } else if (id === "103/5" && nested) {
    text = `ComputeChannel.timeout on channel ${hex(r.take(32))}`;
  } else if (id === "0/0" && nested) {
    text = `System.remark "${Buffer.from(r.take(Number(r.compact()))).toString("utf8")}"`;
  } else {
    fail(`this tool does not sign call ${id}${nested ? " inside a session" : ""}`);
  }
  r.done();
  return text;
}
/** The length of the one inner call a session may carry here: timeout (2 + 32) or remark (2 + compact + bytes). */
function innerLength(rest) {
  if (rest.length >= 2 && rest[0] === 103 && rest[1] === 5) return 34;
  if (rest.length >= 3 && rest[0] === 0 && rest[1] === 0) {
    const r = new In(rest.subarray(2));
    const n = Number(r.compact());
    return 2 + r.o + n;
  }
  fail("the inner call must be ComputeChannel.timeout or System.remark");
}

// ---- keys --------------------------------------------------------------------------------------
const SS58PRE = new TextEncoder().encode("SS58PRE");
const ss58 = (pub) => {
  const body = cat(Uint8Array.of(42), pub);
  return base58.encode(cat(body, blake2b(cat(SS58PRE, body), { dkLen: 64 }).subarray(0, 2)));
};
const readSeed = (file) => {
  const seed = base64.decode(JSON.parse(readFileSync(file, "utf8")).seed_b64);
  if (seed.length !== 32) fail("the key file does not hold a 32 byte seed");
  return seed;
};
const twox128 = { // precomputed: twox128 of the names, as the metadata and the chain give them
  System: "26aa394eea5630e07c48ae0c9558cef7", Account: "b99d880ec681799c0cf30e8886371da9",
  FlopSessionKeys: "26d6680094539fc341d5ea8ffc79d76f", Sessions: "028685274e698e781f7f2766cba0cc83",
  SessionNonces: "a8bf8c9b4fb4963e0d891d0ea6eb7b2c", CircuitBreakers: "8ab2f41796e7514fa8610f8d361c94e7",
  DelegateSessions: "27cdbf61319cbf5774a1df6f3711570f",
};
const b2concat = (key) => hex(cat(blake2b(key, { dkLen: 16 }), key)).slice(2);

// ---- commands ----------------------------------------------------------------------------------
const cmd = argv[0];
if (cmd === "keygen") {
  const out = flag("out") ?? fail("--out is required");
  if (existsSync(out)) fail(`${out} exists; this tool never replaces a key`);
  const seed = Uint8Array.from(randomBytes(32));
  writeFileSync(out, JSON.stringify({ v: 0, alg: "ed25519", seed_b64: base64.encode(seed) }) + "\n", { flag: "wx", mode: 0o600 });
  const pub = ed25519.getPublicKey(seed);
  console.log(JSON.stringify({ made: out, public_key: hex(pub), ss58: ss58(pub) }));
} else if (cmd === "pub") {
  const pub = ed25519.getPublicKey(readSeed(flag("key") ?? fail("--key is required")));
  console.log(JSON.stringify({ public_key: hex(pub), ss58: ss58(pub) }));
} else if (cmd === "keys") {
  const owner = unhex(flag("owner"), 32), delegate = unhex(flag("delegate"), 32);
  const k = (pallet, item, ...parts) => "0x" + twox128[pallet] + twox128[item] + parts.map(b2concat).join("");
  console.log(JSON.stringify({
    account_owner: k("System", "Account", owner), account_delegate: k("System", "Account", delegate),
    session: k("FlopSessionKeys", "Sessions", owner, delegate), session_nonce: k("FlopSessionKeys", "SessionNonces", owner, delegate),
    breaker_delegate: k("FlopSessionKeys", "CircuitBreakers", delegate), delegate_sessions: k("FlopSessionKeys", "DelegateSessions", delegate),
  }, null, 1));
} else if (cmd === "call") {
  const kind = argv[1];
  let call;
  if (kind === "transfer") call = cat(Uint8Array.of(4, 3, 0), unhex(flag("to"), 32), compact(amount(flag("amount"), "--amount")));
  else if (kind === "sweep") call = cat(Uint8Array.of(4, 4, 0), unhex(flag("to"), 32), Uint8Array.of(0));
  else if (kind === "create-session") {
    const names = (flag("allow") ?? fail("--allow is required (may be empty)")).split(",").filter((s) => s.length > 0).map((s) => new TextEncoder().encode(s));
    call = cat(Uint8Array.of(94, 0), unhex(flag("delegate"), 32), uint(amount(flag("cap"), "--cap"), 16), uint(amount(flag("per-tx"), "--per-tx"), 16), uint(amount(flag("daily"), "--daily"), 16), uint(amount(flag("blocks"), "--blocks"), 4), compact(names.length), ...names.flatMap((n) => [compact(n.length), n]));
  } else if (kind === "revoke") call = cat(Uint8Array.of(94, 1), unhex(flag("delegate"), 32));
  else if (kind === "via-session") {
    const spec = flag("inner") ?? fail("--inner is required");
    let inner;
    if (spec.startsWith("timeout:")) inner = cat(Uint8Array.of(103, 5), unhex(spec.slice(8), 32));
    else if (spec.startsWith("remark:")) { const t = new TextEncoder().encode(spec.slice(7)); inner = cat(Uint8Array.of(0, 0), compact(t.length), t); }
    else fail("--inner must be timeout:<0x32 bytes> or remark:<text>");
    call = cat(Uint8Array.of(94, 2), unhex(flag("owner"), 32), inner, uint(amount(flag("spend"), "--spend"), 16), uint(amount(flag("nonce"), "--nonce"), 8));
  } else fail(`unknown call ${kind}`);
  console.log(JSON.stringify({ call: hex(call), what: describe(call) }));
} else if (cmd === "sign") {
  const keyFile = flag("key") ?? fail("--key is required");
  const out = flag("out") ?? fail("--out is required");
  if (existsSync(out)) fail(`${out} exists; pick a new name so no signed call is lost`);
  const call = unhex(flag("call") ?? fail("--call is required"));
  const nonce = amount(flag("nonce") ?? fail("--nonce is required"), "--nonce");
  const what = describe(call);
  const seed = readSeed(keyFile);
  const pub = ed25519.getPublicKey(seed);
  const genesis = unhex(GENESIS, 32);
  const extra = cat(Uint8Array.of(0), compact(nonce), compact(0), Uint8Array.of(0));
  const additional = cat(uint(SPEC, 4), uint(TXV, 4), genesis, genesis, Uint8Array.of(0));
  const payload = cat(call, extra, additional);
  const toSign = payload.length > 256 ? blake2b(payload, { dkLen: 32 }) : payload;
  const sig = ed25519.sign(toSign, seed);
  if (!ed25519.verify(sig, toSign, pub)) fail("the signature does not verify");
  const body = cat(Uint8Array.of(0x84, 0), pub, Uint8Array.of(0), sig, extra, call);
  const xt = cat(compact(body.length), body);
  const record = {
    what, signer: hex(pub), signer_ss58: ss58(pub), account_nonce: nonce.toString(), tip: "0", era: "immortal",
    spec_version: SPEC, transaction_version: TXV, genesis: GENESIS,
    call: hex(call), extrinsic: hex(xt), extrinsic_hash: hex(blake2b(xt, { dkLen: 32 })),
  };
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  process.stderr.write(`signing as ${record.signer_ss58} (account nonce ${nonce}, spec ${SPEC}, no tip, immortal):\n  ${what}\n`);
  console.log(JSON.stringify({ extrinsic: record.extrinsic, extrinsic_hash: record.extrinsic_hash, saved: out }));
} else {
  fail("commands: keygen, pub, keys, call, sign (see the head of this file)");
}
