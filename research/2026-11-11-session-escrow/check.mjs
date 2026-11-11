#!/usr/bin/env node
// check: compares what flop-sign.mjs (version 2) builds with a reference encoder, before anything is signed
// for the chain. It needs two things this folder does not hold:
//   OBS   an observatory checkout with its dev dependencies installed (@polkadot-api/substrate-bindings,
//         @polkadot-api/metadata-builders) and the recorded metadata fixture (branch claude/observatory-decoder)
//   LIBS  a folder whose node_modules holds @noble/curves, @noble/hashes and @scure/base (imd-flop after npm ci)
// Usage: OBS=<observatory> FLOP_SIGN_LIBS=<imd-flop> node check.mjs
// It makes two throwaway keys in a temporary folder and talks to no network.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OBS = process.env.OBS ?? "/home/claude/wt-decoder/observatory";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(OBS + "/package.json");
const sb = await import(require.resolve("@polkadot-api/substrate-bindings"));
const mb = await import(require.resolve("@polkadot-api/metadata-builders"));
const tape = readFileSync(`${OBS}/fixtures/recording-20261111160917-3c228907aa129a01/tape.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let mhex = null;
const walk = (o) => { if (typeof o === "string" && o.startsWith("0x6d657461")) mhex = o; else if (o && typeof o === "object") Object.values(o).forEach(walk); };
tape.forEach(walk);
const dyn = mb.getDynamicBuilder(mb.getLookupFn(sb.unifyMetadata(sb.decAnyMetadata(Buffer.from(mhex.slice(2), "hex")))));
const sign = join(here, "flop-sign.mjs");
const run = (...a) => JSON.parse(execFileSync("node", [sign, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const refused = (...a) => { try { execFileSync("node", [sign, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return null; } catch (e) { return String(e.stderr).trim(); } };
const hx = (u) => "0x" + Buffer.from(u).toString("hex");
const refCall = (p, n, args) => { const { location, codec } = dyn.buildCall(p, n); return hx(Uint8Array.from([...location, ...codec.enc(args)])); };

const tmp = mkdtempSync(join(tmpdir(), "flop-sign-check-"));
const owner = run("keygen", "--out", join(tmp, "owner.key")), dev = run("keygen", "--out", join(tmp, "dev.key")), miner = run("keygen", "--out", join(tmp, "miner.key"));
const H = (b) => "0x" + b.repeat(32);
const fo = { miner: miner.public_key, model_hash: H("1a"), measured_root: H("2b"), decode_policy_hash: H("3c"), precision: "BF16", agent_key: dev.public_key,
  max_turns: 1024, max_duration: 1200, reattest_every: 1, escrow: "10000000000000000", nonce: "11025758754529391116" };
let files = 0;
const file = (name, o) => { const p = join(tmp, `${files++}-${name}`); writeFileSync(p, JSON.stringify(o)); return p; };
const foRef = (f) => ({ type: "ComputeChannel", value: { type: "force_open", value: { miner: miner.ss58, model_hash: f.model_hash, measured_root: f.measured_root, decode_policy_hash: f.decode_policy_hash,
  precision: { type: f.precision, value: undefined }, agent_key: f.agent_key, sla: { max_turns: f.max_turns, max_duration: f.max_duration, reattest_every: f.reattest_every }, escrow: BigInt(f.escrow), nonce: BigInt(f.nonce) } } });
const CH = H("9f");
let bad = 0;
const same = (name, mine, ref, what) => { const ok = mine === ref; if (!ok) bad++; console.log(ok ? "same " : "DIFF ", name, ok ? "" : `\n  mine ${mine}\n  ref  ${ref}`, what ? "\n    " + what : ""); };

for (const [name, f, spend, nonce] of [["force-open declared 0", fo, "0", "0"], ["force-open declared escrow", fo, fo.escrow, "1"], ["force-open INT4, largest dust", { ...fo, precision: "INT4", escrow: "49999999999999999", nonce: "18446744073709551615" }, "49999999999999999", "7"]]) {
  const mine = run("call", "via-session", "--owner", owner.public_key, "--inner", "force-open:" + file("fo.json", f), "--spend", spend, "--nonce", nonce);
  let ref; try { ref = refCall("FlopSessionKeys", "execute_via_session", { owner: owner.ss58, call: foRef(f), spend_amount: BigInt(spend), nonce: BigInt(nonce) }); } catch (e) { ref = "REF-ERROR " + e.message; }
  same(name, mine.call, ref, mine.what);
}
{
  const mine = run("call", "via-session", "--owner", owner.public_key, "--inner", "expire:" + CH, "--spend", "0", "--nonce", "4");
  same("expire", mine.call, refCall("FlopSessionKeys", "execute_via_session", { owner: owner.ss58, call: { type: "ComputeChannel", value: { type: "expire_force_open", value: { channel_id: CH } } }, spend_amount: 0n, nonce: 4n }), mine.what);
  const t = run("call", "via-session", "--owner", owner.public_key, "--inner", "timeout:" + CH, "--spend", "0", "--nonce", "5");
  same("timeout", t.call, refCall("FlopSessionKeys", "execute_via_session", { owner: owner.ss58, call: { type: "ComputeChannel", value: { type: "timeout", value: { channel_id: CH } } }, spend_amount: 0n, nonce: 5n }), t.what);
}
// storage keys
const k = run("channel-keys", "--channel", CH, "--miner", miner.public_key);
const st = (p, i, ...a) => dyn.buildStorage(p, i).keys.enc(...a);
same("key channel", k.channel, st("ComputeChannel", "Channels", CH));
same("key decode policy", k.decode_policy, st("ComputeChannel", "ChannelDecodePolicies", CH));
same("key failed acks", k.failed_acks_miner, st("ComputeChannel", "FailedAcks", miner.ss58));
same("key events", k.events, st("System", "Events"));
// refusals: each must print a reason and sign nothing
const inner = (f) => ["call", "via-session", "--owner", owner.public_key, "--inner", "force-open:" + file("bad.json", f), "--spend", "0", "--nonce", "0"];
const good = run(...inner(fo)).call;
const bare = "0x" + good.slice(2 + 2 * 34, 2 + 2 * 34 + 2 * 231); // the force_open alone, not inside a session
for (const [what, args] of [
  ["escrow of exactly 0.05 FLOP", inner({ ...fo, escrow: "50000000000000000" })],
  ["escrow of 1 FLOP", inner({ ...fo, escrow: "1000000000000000000" })],
  ["zero escrow", inner({ ...fo, escrow: "0" })],
  ["unknown precision", inner({ ...fo, precision: "FP64" })],
  ["a short miner id", inner({ ...fo, miner: "0x1234" })],
  ["force_open outside a session", ["sign", "--key", join(tmp, "dev.key"), "--call", bare, "--nonce", "0", "--out", join(tmp, "x1.json")]],
  ["a trailing byte", ["sign", "--key", join(tmp, "dev.key"), "--call", good + "00", "--nonce", "0", "--out", join(tmp, "x2.json")]],
]) { const r = refused(...args); if (r === null) bad++; console.log(r === null ? "NOT REFUSED" : "refused", what, r === null ? "" : "\n    " + r); }
// one signature, taken apart again
const s = run("sign", "--key", join(tmp, "dev.key"), "--call", good, "--nonce", "0", "--out", join(tmp, "s.json"));
const libs = createRequire((process.env.FLOP_SIGN_LIBS ?? `${process.env.HOME}/lab/imd-flop`) + "/package.json");
const { ed25519 } = await import(libs.resolve("@noble/curves/ed25519.js"));
const { blake2b } = await import(libs.resolve("@noble/hashes/blake2.js"));
const x = Buffer.from(s.extrinsic.slice(2), "hex");
const m = x[0] & 3, lenBytes = m === 0 ? 1 : m === 1 ? 2 : 4;
const len = m === 0 ? x[0] >> 2 : m === 1 ? x.readUInt16LE(0) >> 2 : x.readUInt32LE(0) >> 2;
const body = x.subarray(lenBytes);
const pub = body.subarray(2, 34), sig = body.subarray(35, 99), extra = body.subarray(99, 103), call = body.subarray(103);
const gen = Buffer.from("99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631", "hex");
const spec = Buffer.alloc(4); spec.writeUInt32LE(1014014);
const payload = Buffer.concat([call, extra, spec, Buffer.from([2, 0, 0, 0]), gen, gen, Buffer.from([0])]);
const msg = payload.length > 256 ? blake2b(payload, { dkLen: 32 }) : payload;
const checks = { "length prefix": len === body.length, "call inside": hx(call) === good, "signer": hx(pub) === dev.public_key, "signature verifies": ed25519.verify(sig, msg, pub), "payload hashed (over 256 bytes)": payload.length > 256 };
for (const [n, ok] of Object.entries(checks)) { if (!ok) bad++; console.log(ok ? "ok   " : "BAD  ", n); }
const back = dyn.buildCall("FlopSessionKeys", "execute_via_session").codec.dec(Uint8Array.from(call.subarray(2)));
console.log("reference reads it back:", JSON.stringify(back, (key, v) => (typeof v === "bigint" ? v.toString() : v && v.asHex ? v.asHex() : v)).slice(0, 420));
console.log(bad === 0 ? "ALL GOOD" : `${bad} PROBLEMS`);
process.exit(bad === 0 ? 0 : 1);
