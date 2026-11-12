/**
 * Shared inputs of the chain encoder's tests. The metadata, the genesis and the runtime's names come from
 * the committed recording through scripts/chain-table.mjs readSource and the reference decoder
 * (@polkadot-api, dev dependencies). Test keys are made here in memory and never written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { InnerCall } from "../../src/chain/calls.js";
import type { DeviceSigner } from "../../src/chain/extrinsic.js";
import { RUNTIMES } from "../../src/chain/runtimes.js";
import type { RuntimeId } from "../../src/chain/table.js";
import { readSource, SOURCES } from "../../scripts/chain-table.mjs";

export const PKG = join(import.meta.dirname, "..", "..");
export const REPO = join(PKG, "..");
export const readJson = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));

export const RERUN = "research/2026-11-12-session-rerun-1014020";
export const results = readJson(`${RERUN}/results.json`);
export const steps = readJson(`${RERUN}/steps.json`);

export const source = readSource(SOURCES[0]) as { metadata: Uint8Array; genesisHash: string; metadataSha256: string };
export const metadata = unifyMetadata(decAnyMetadata(source.metadata));
export const lookup = getLookupFn(metadata);
export const ref = getDynamicBuilder(lookup);
/** The reference codec of RuntimeCall. */
export const refCall = ref.buildDefinition(lookup.call as number);

export const RT = RUNTIMES[0];
export const RUNTIME_ID: RuntimeId = { specName: RT.specName, specVersion: RT.specVersion, transactionVersion: RT.transactionVersion, genesisHash: RT.genesisHash };

export const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
export const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
export const filled = (byte: number) => new Uint8Array(32).fill(byte);
export const U128_MAX = (1n << 128n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
export const U32_MAX = 2 ** 32 - 1;

/** A device key made in memory for one test file. The seed never leaves this closure. */
export function testDevice(): DeviceSigner & { calls: Uint8Array[] } {
  const seed = ed25519.utils.randomSecretKey();
  const calls: Uint8Array[] = [];
  return {
    publicKey: ed25519.getPublicKey(seed),
    calls,
    sign(message: Uint8Array) {
      calls.push(Uint8Array.from(message));
      return ed25519.sign(message, seed);
    },
  };
}

export const OWNER = unhex(steps.values.OWNER.value);

/** Ordinary values for each of the five inner calls. */
export function sampleInner(): Record<InnerCall["call"], InnerCall> {
  const sla = { max_turns: Number(steps.values.MAX_TURNS.value), max_duration: Number(steps.values.MAX_DURATION.value), reattest_every: Number(steps.values.REATTEST.value) };
  const common = {
    miner: unhex(steps.values.NAMED.value),
    model_hash: unhex(steps.values.MODEL.value),
    measured_root: unhex(steps.values.ROOT.value),
    decode_policy_hash: unhex(steps.values.POLICY.value),
    precision: steps.values.PRECISION.value as string,
    agent_key: unhex(results.accounts.dev1.public_key),
    sla,
  };
  return {
    open_channel: { call: "open_channel", ...common, enclave_key: filled(0xe5), escrow: BigInt(steps.values.ESCROW_1.value), nonce: BigInt(steps.values.N1.value), settlement_class: "Standard" },
    top_up_escrow: { call: "top_up_escrow", channel_id: unhex(steps.values.CH_PROBE.value), additional: BigInt(steps.values.ESCROW_3.value) },
    timeout: { call: "timeout", channel_id: unhex(steps.values.CH_PROBE.value) },
    force_open: { call: "force_open", ...common, escrow: BigInt(steps.values.ESCROW_2.value), nonce: BigInt(steps.values.N2.value) },
    expire_force_open: { call: "expire_force_open", channel_id: unhex(steps.values.CH_DENY.value) },
  };
}

/** Boundary values for each of the five inner calls: zero and maximum widths, the last enum variants. */
export function boundaryInner(): InnerCall[] {
  const z = filled(0);
  const f = filled(0xff);
  return [
    { call: "open_channel", miner: f, model_hash: z, measured_root: f, decode_policy_hash: z, precision: "Mixed", enclave_key: f, agent_key: z, sla: { max_turns: U32_MAX, max_duration: 0, reattest_every: U32_MAX }, escrow: U128_MAX, nonce: U64_MAX, settlement_class: "CertificatePremium" },
    { call: "open_channel", miner: z, model_hash: f, measured_root: z, decode_policy_hash: f, precision: "FP32", enclave_key: z, agent_key: f, sla: { max_turns: 0, max_duration: U32_MAX, reattest_every: 0 }, escrow: 0n, nonce: 0n, settlement_class: "Standard" },
    { call: "top_up_escrow", channel_id: f, additional: U128_MAX },
    { call: "top_up_escrow", channel_id: z, additional: 0n },
    { call: "timeout", channel_id: z },
    { call: "force_open", miner: f, model_hash: f, measured_root: f, decode_policy_hash: f, precision: "INT4", agent_key: f, sla: { max_turns: U32_MAX, max_duration: U32_MAX, reattest_every: U32_MAX }, escrow: U128_MAX, nonce: U64_MAX },
    { call: "force_open", miner: z, model_hash: z, measured_root: z, decode_policy_hash: z, precision: "FP16", agent_key: z, sla: { max_turns: 0, max_duration: 0, reattest_every: 0 }, escrow: 1n, nonce: 0n },
    { call: "expire_force_open", channel_id: f },
  ];
}

/** The reference decoder's value tree, with accounts and byte strings as lower case hex and enums as names. */
export function plain(v: unknown, accountCodec = ref.buildDefinition(0)): unknown {
  if (typeof v === "string") return /^0x[0-9a-f]*$/i.test(v) ? v.toLowerCase() : hex(accountCodec.enc(v));
  if (typeof v === "bigint" || typeof v === "number") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.type === "string" && Object.keys(o).length <= 2 && ("value" in o || Object.keys(o).length === 1)) {
      return o.value === undefined ? o.type : { [o.type]: plain(o.value, accountCodec) };
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x, accountCodec)]));
  }
  return v;
}

/** An input value tree in the same form as plain(): bytes as hex, the inner call keyed by name. */
export function plainInput(owner: Uint8Array, inner: InnerCall, spend: bigint, nonce: bigint): unknown {
  const conv = (x: unknown): unknown =>
    x instanceof Uint8Array ? hex(x) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, conv(y)])) : x;
  const { call, ...fields } = inner as unknown as Record<string, unknown> & { call: string };
  return { FlopSessionKeys: { execute_via_session: { owner: hex(owner), call: { ComputeChannel: { [call]: conv(fields) } }, spend_amount: spend, nonce } } };
}
