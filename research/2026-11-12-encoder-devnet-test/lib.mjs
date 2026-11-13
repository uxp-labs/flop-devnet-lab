// The shared part of plan.mjs, sign-device.mjs and check.mjs: reads steps.json and the files it
// names, and resolves each $NAME. No network, no key.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { substitute as rerunSubstitute } from "../2026-11-12-session-rerun-1014020/rerun-lib.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const RERUN = resolve(HERE, "..", "2026-11-12-session-rerun-1014020");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const loadPlan = (dir = HERE) => readJson(join(dir, "steps.json"));
export const RAW = /^(0|[1-9][0-9]*)$/;
export const HASH = /^0x[0-9a-f]{64}$/;

// blake2b of the @noble/hashes that imd-flop/node_modules holds (no new dependency).
const { blake2b } = await import(pathToFileURL(createRequire(join(REPO, "imd-flop", "package.json")).resolve("@noble/hashes/blake2.js")).href);
const unhex = (h, n) => {
  if (typeof h !== "string" || !/^0x([0-9a-f]{2})*$/.test(h) || (n !== undefined && h.length !== 2 + 2 * n)) throw new Error(`${h} is not 0x and ${n ?? "whole"} bytes of lower case hex`);
  return Uint8Array.from(Buffer.from(h.slice(2), "hex"));
};
const hexOf = (b) => "0x" + Buffer.from(b).toString("hex");
/** The blake2b-256 of bytes, as 0x hex: the hash of an extrinsic. */
export const blake2b256Hex = (bytes) => hexOf(blake2b(bytes, { dkLen: 32 }));

/** The sha256 of a text, as lower case hex: what the PC checks of every text the lead relays. */
export const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The id of a channel, in our own lines: blake2b-256("FLOP/COMPUTE_CHANNEL/ID" || 0x01 || genesis
 * || agent || miner || u64 little endian nonce). The lead read the formula in FLOP's SDK 0.6.0
 * (channelIdV1) and checked it against the rerun's force_open (lead-measurements-2026-11-13.json,
 * measurements.channel_id_formula). It is shown for force_open only.
 */
export function channelId(genesis, agent, miner, nonce) {
  const n = BigInt(nonce);
  if (n < 0n || n >= 1n << 64n) throw new Error(`the channel nonce ${nonce} is not a u64`);
  const le = Buffer.alloc(8); le.writeBigUInt64LE(n);
  const msg = Buffer.concat([Buffer.from("FLOP/COMPUTE_CHANNEL/ID", "ascii"), Buffer.of(1), unhex(genesis, 32), unhex(agent, 32), unhex(miner, 32), le]);
  return hexOf(blake2b(msg, { dkLen: 32 }));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_PREFIX = 42; // every account of the earlier records starts with 5: the generic prefix 42
const ss58Sum = (body) => Buffer.from(blake2b(Buffer.concat([Buffer.from("SS58PRE", "ascii"), body]), { dkLen: 64 })).subarray(0, 2);
/**
 * The storage key of FlopSessionKeys.SessionNonces(owner, delegate): the twox128 prefixes of steps.json
 * (TWOX_FLOP_SESSION_KEYS, TWOX_SESSION_NONCES, from the research signer's table) and blake2_128
 * concat of each key, as the research signer's keys command makes it.
 */
export function sessionNonceKey(plan, owner, delegate) {
  const b2concat = (h) => Buffer.from(blake2b(unhex(h, 32), { dkLen: 16 })).toString("hex") + h.slice(2);
  return "0x" + plan.values.TWOX_FLOP_SESSION_KEYS.value + plan.values.TWOX_SESSION_NONCES.value + b2concat(owner) + b2concat(delegate);
}

/** The SS58 text of a 32 byte account, prefix 42. */
export function ss58(publicKey) {
  const body = Buffer.concat([Buffer.of(SS58_PREFIX), unhex(publicKey, 32)]);
  const all = Buffer.concat([body, ss58Sum(body)]);
  let n = BigInt(hexOf(all)), out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of all) { if (b !== 0) break; out = "1" + out; }
  return out;
}
/** The 32 byte account of an SS58 text of prefix 42, as 0x hex; null when it is not one or its checksum is wrong. */
export function fromSs58(text) {
  if (typeof text !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(text)) return null;
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c));
  let h = n.toString(16); if (h.length % 2) h = "0" + h;
  const bytes = Buffer.from(h, "hex");
  if (bytes.length !== 35 || bytes[0] !== SS58_PREFIX) return null;
  if (!ss58Sum(bytes.subarray(0, 33)).equals(bytes.subarray(33))) return null;
  return hexOf(bytes.subarray(1, 33));
}

/** The parts of a path like steps[5].events[1].fields.to or keys["System.Events"]. */
export function pathParts(path) {
  const parts = [];
  const re = /\["([^"]+)"\]|\[(\d+)\]|\.?([^.[\]]+)/g;
  let m;
  while ((m = re.exec(path)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

/** The value at a path of a JSON value, or an error naming the path. */
export function atPath(obj, path) {
  let v = obj;
  for (const part of pathParts(path)) {
    if (v === null || typeof v !== "object" || !(part in v)) throw new Error(`no ${path}`);
    v = v[part];
  }
  return v;
}

/** The value a values entry names in its source file: the field, or the regex group in it. Arrays are joined with commas. */
export function fromSource(plan, from, repo = REPO) {
  const file = join(repo, plan.files[from.file]);
  let v = from.path === undefined ? readFileSync(file, "utf8") : atPath(readJson(file), from.path);
  if (Array.isArray(v)) v = v.join(",");
  v = String(v);
  if (from.re) {
    const m = new RegExp(from.re).exec(v);
    if (!m) throw new Error(`${from.file} ${from.path} does not match ${from.re}`);
    v = m[1];
  }
  return v;
}

/** A computed value from the values it names: whole division, or a channel id of four values. */
export function computed(plan, spec) {
  if (spec.channel_id) {
    const [g, a, m, n] = spec.channel_id.map((k) => plan.values[k].value);
    return channelId(g, a, m, n);
  }
  if (spec.div) {
    const [a, b] = spec.div;
    const n = BigInt(plan.values[a].value), d = BigInt(b);
    if (n % d !== 0n) throw new Error(`${a} / ${b} is not whole`);
    return (n / d).toString();
  }
  throw new Error(`unknown computation ${JSON.stringify(spec)}`);
}

/**
 * Replaces each $NAME in a text: DEVICE from the recorded accounts, the rest as the rerun's
 * library does (a value of steps.json, or step.Pallet.Event.field from the recorded events).
 * An unknown name is left as it is unless strict is set.
 */
export function substitute(text, plan, results, strict = false) {
  const device = results?.accounts?.device?.public_key;
  const withDevice = String(text).replace(/\$DEVICE\b/g, (w) => (device ? device : w));
  if (strict && /\$DEVICE\b/.test(withDevice)) throw new Error("$DEVICE is not known");
  return rerunSubstitute(withDevice, plan, results, strict);
}

export const isUnresolved = (t) => /\$[A-Z]/.test(String(t));

/** The fee the rerun recorded for a step of its own, as a raw string, or null for none. */
export function rerunFee(id, rerunResults = readJson(join(RERUN, "results.json"))) {
  if (id === null) return null;
  const s = rerunResults.steps.find((x) => x.step === id);
  if (!s) throw new Error(`the rerun has no step ${id}`);
  return s.fee_raw;
}

/** The runtime of the plan: steps.json SPEC_NAME, SPEC, TXV and GENESIS, in the encoder's names. */
export const planRuntime = (plan) => ({ specName: plan.values.SPEC_NAME.value, specVersion: Number(plan.values.SPEC.value), transactionVersion: Number(plan.values.TXV.value), genesisHash: plan.values.GENESIS.value });

export const stepOf = (plan, id) => {
  const s = plan.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const FLOP = 10n ** 18n;
/** A raw amount as FLOP text. */
export const flopText = (raw) => {
  const r = BigInt(raw);
  const f = (r % FLOP).toString().padStart(18, "0").replace(/0+$/, "");
  return `${r / FLOP}${f ? "." + f : ""}`;
};
