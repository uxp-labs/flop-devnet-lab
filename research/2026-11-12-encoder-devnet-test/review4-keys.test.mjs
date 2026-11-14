// Review 4 (list 5): every storage key of the fifth request list derived a third way,
// with a twox128 written here from the xxHash64 specification and blake2b from @noble/hashes in
// imd-flop/node_modules. No observatory code, no reference decoder. Nothing here reads the network.
// After this review the list grew to 32 calls (chain_getBlock and the birth hashes, rule B10); the one
// assertion that changed is the heights of the chain_getBlockHash calls, by the lead's rule.
// The list is read from the fifth recording's fixture, its frozen copy of observatory/recordings/requests.json as
// that file was when the recording was made: recordings/requests.json itself is the current list, and a later list
// replaced the fifth (the sixth, 2026-11-14). A test holds the copy to the sha256 the recording's run.json names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const REPO = new URL("../../", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, REPO), "utf8"));
const { blake2b } = await import(new URL("imd-flop/node_modules/@noble/hashes/blake2.js", REPO).href);

const M = (1n << 64n) - 1n;
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n, P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;
const u64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const u32 = (b, o) => BigInt(b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + BigInt(b[o + 3]) * 16777216n;
const round = (acc, lane) => (rotl((acc + lane * P2) & M, 31) * P1) & M;
const merge = (acc, v) => (((acc ^ round(0n, v)) * P1 + P4) & M);
function xxh64(b, seed) {
  const len = b.length; let o = 0; let h;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M, v2 = (seed + P2) & M, v3 = seed, v4 = (seed - P1) & M;
    while (o + 32 <= len) { v1 = round(v1, u64(b, o)); v2 = round(v2, u64(b, o + 8)); v3 = round(v3, u64(b, o + 16)); v4 = round(v4, u64(b, o + 24)); o += 32; }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = (seed + P5) & M;
  h = (h + BigInt(len)) & M;
  while (o + 8 <= len) { h ^= round(0n, u64(b, o)); h = (rotl(h, 27) * P1 + P4) & M; o += 8; }
  if (o + 4 <= len) { h ^= (u32(b, o) * P1) & M; h = (rotl(h, 23) * P2 + P3) & M; o += 4; }
  while (o < len) { h ^= (BigInt(b[o]) * P5) & M; h = (rotl(h, 11) * P1) & M; o++; }
  h ^= h >> 33n; h = (h * P2) & M; h ^= h >> 29n; h = (h * P3) & M; h ^= h >> 32n;
  return h;
}
const le = (v) => { let s = ""; for (let i = 0; i < 8; i++) s += Number((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"); return s; };
const twox128 = (s) => { const b = new TextEncoder().encode(s); return le(xxh64(b, 0n)) + le(xxh64(b, 1n)); };
const hex = (u) => Buffer.from(u).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const b128c = (h) => hex(blake2b(bytes(h), { dkLen: 16 })) + h.replace(/^0x/, "");

const RECORDING = "observatory/fixtures/recording-20261113182100-8769e8d2841bf49a";
const LIST_FILE = `${RECORDING}/requests.json`;
const LIST = json(LIST_FILE);
const RESULTS = json("research/2026-11-12-encoder-devnet-test/results.json");
const STEPS = json("research/2026-11-12-encoder-devnet-test/steps.json");
const owner = RESULTS.accounts.owner.public_key;
const device = RESULTS.accounts.device.public_key;
const t3 = RESULTS.steps.find((s) => s.step === "T3");
const forceOpen = t3.run_time.explorer.events.find((e) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested");

test("the list read is the fifth recording's own: its sha256 is the one that recording's run.json names", () => {
  const sha = createHash("sha256").update(readFileSync(new URL(LIST_FILE, REPO))).digest("hex");
  assert.equal(sha, json(`${RECORDING}/run.json`).request_list_sha256);
});

test("the twox128 written here agrees with the prefixes the lab recorded (System.Events, FlopSessionKeys, SessionNonces)", () => {
  assert.equal(`0x${twox128("System")}${twox128("Events")}`, STEPS.values.EVENTS_KEY.value);
  assert.equal(twox128("FlopSessionKeys"), STEPS.values.TWOX_FLOP_SESSION_KEYS.value);
  assert.equal(twox128("SessionNonces"), STEPS.values.TWOX_SESSION_NONCES.value);
});

test("the channel of T3 is the one T3's ForceOpenRequested names, the one steps.json derives, with T3's agent the owner and its miner NAMED", () => {
  assert.equal(forceOpen.fields.channel_id, STEPS.values.CH_T3.value);
  assert.equal(forceOpen.fields.agent, owner);
  assert.equal(forceOpen.fields.miner, STEPS.values.NAMED.value);
  const expired = RESULTS.steps.find((s) => s.step === "T6").run_time.explorer.events.find((e) => e.name === "ForceOpenExpired");
  assert.equal(expired.fields.channel_id, forceOpen.fields.channel_id);
});

test("every batch of the list asks these eight keys, derived a third way, at the block hashes of results.json in order", () => {
  const sk = (p, e, ...args) => `0x${twox128(p)}${twox128(e)}${args.map(b128c).join("")}`;
  const want = [
    sk("System", "Events"),
    sk("System", "LastRuntimeUpgrade"),
    sk("System", "Account", owner),
    sk("System", "Account", device),
    sk("FlopSessionKeys", "Sessions", owner, device),
    sk("FlopSessionKeys", "SessionNonces", owner, device),
    sk("FlopSessionKeys", "CircuitBreakers", device),
    sk("ComputeChannel", "Channels", forceOpen.fields.channel_id),
  ];
  const batches = LIST.calls.filter((c) => c.method === "state_queryStorageAt");
  const hashes = [RESULTS.start.finalized.hash, ...RESULTS.steps.filter((s) => s.run_time !== null).map((s) => s.run_time.sent.block_hash)];
  assert.equal(batches.length, 9);
  for (const [i, b] of batches.entries()) assert.deepEqual(b.params, [want, hashes[i]]);
  const MORTAL = ["T3", "T4", "T5", "T6"];
  // A birth hash is a chain_getBlockHash that no batch follows, other than the genesis.
  const isBirth = (c, i) => c.method === "chain_getBlockHash" && c.params[0] !== 0 && LIST.calls[i + 1]?.method !== "state_queryStorageAt";
  const afterBlock = LIST.calls.flatMap((c, i) => (isBirth(c, i) ? [[LIST.calls[i - 1]?.method, LIST.calls[i - 1]?.params[0], c.params[0]]] : []));
  const heights = LIST.calls.filter((c, i) => c.method === "chain_getBlockHash" && !isBirth(c, i)).map((c) => c.params[0]);
  assert.deepEqual(heights, [0, RESULTS.start.finalized.number, ...RESULTS.steps.filter((s) => s.run_time !== null).map((s) => s.run_time.sent.block_number)]);
  assert.deepEqual(afterBlock, MORTAL.map((id) => ["chain_getBlock", RESULTS.steps.find((s) => s.step === id).run_time.sent.block_hash, json(`research/2026-11-12-encoder-devnet-test/run-2026-11-13/signed/${id}.json`).era.birth_number]));
});
