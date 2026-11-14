// The fifth request list: the lab's devnet test of the chain encoder
// (research/2026-11-12-encoder-devnet-test), run on 2026-11-13, its nine blocks. It was
// recordings/requests.json until the sixth list replaced it, and its recording's fixture keeps it and
// its inputs, frozen. It is derived (test/helpers/requests/list-5.ts) from those inputs and the
// recorded 1014020 metadata, and nothing in it is typed by hand. These tests hold the list to that function byte for
// byte, read its design a second way from the encoder test's steps.json and results.json, derive
// every storage key a second way with the reference decoder, and hold every input to the record it
// names. Since its recording became a fixture (fixtures/recording-20261113182100-8769e8d2841bf49a,
// review round 32), they read the list and the inputs the fixture keeps. Nothing here reads the
// network or runs a research script.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { blake2b } from "@noble/hashes/blake2.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { READ_ONLY_RPC_METHODS, guardRpc } from "../src/guard.js";
import { MAX_CALLS, readRequests } from "../src/requests.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { fromHex, toHex } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { REQUESTS_TEXT as LIST_1_TEXT } from "./helpers/recorded.js";
import { RERUN_INPUTS_TEXT as LIST_4_INPUTS_TEXT, RERUN_REQUESTS_TEXT as LIST_4_TEXT } from "./helpers/recorded-rerun.js";
import { STORAGE_REQUESTS_TEXT as LIST_2_TEXT } from "./helpers/recorded-storage.js";
import { UPGRADE_REQUESTS_TEXT as LIST_3_TEXT } from "./helpers/recorded-upgrade.js";
import { type Source, deriveCalls as coreDerive } from "./helpers/requests/core.js";
import { readInputs as readList4Inputs } from "./helpers/requests/list-4.js";
import { BIRTHS, BLOCKS, type Block, type Inputs, MORTAL_IDS, READS, type Read, START, STEPS, STEP_IDS, birthOf, blockOf, deriveCalls, deriveRequestsText, readInputs } from "./helpers/requests/list-5.js";
import { ENCODER_INPUTS_TEXT, ENCODER_REQUESTS_TEXT, ENCODER_RUN_TIME, ENCODER_SPEC_FIELD, encoderMetadata } from "./helpers/recorded-encoder.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
// The list and its inputs as the fifth recording's fixture keeps them, frozen with it (A2, RULES.md
// section 8): the tests of the list read those copies, and nothing of recordings/.
const LIST_TEXT = ENCODER_REQUESTS_TEXT;
const INPUTS_TEXT = ENCODER_INPUTS_TEXT;
const INPUTS = readInputs(INPUTS_TEXT);
const META = encoderMetadata();
const MD = parseMetadata(META);
const DERIVED = deriveCalls(INPUTS, MD);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(META))));
const RESULTS_FILE = ENCODER_RUN_TIME;
const STEPS_FILE = "research/2026-11-12-encoder-devnet-test/steps.json";
const UP_FILE = "research/2026-11-12-runtime-upgrade/results.json";
/** The signed file of a step, as the lab's tools wrote it when the lead signed. */
const SIGNED_FILE = (id: string) => `research/2026-11-12-encoder-devnet-test/run-2026-11-13/signed/${id}.json`;
const record = (file: string) => JSON.parse(repoText(file)) as Record<string, unknown>;
const RECORDS: Record<string, Record<string, unknown>> = {
  [RESULTS_FILE]: record(RESULTS_FILE),
  [STEPS_FILE]: record(STEPS_FILE),
  ...Object.fromEntries(STEP_IDS.map((id) => [SIGNED_FILE(id), record(SIGNED_FILE(id))])),
};
/** The era of a step's signed file: "immortal", or its period, birth and last valid block. */
type Era = "immortal" | { period: number; birth_number: number; birth_hash: string; last_valid_block: number };
const eraOf = (id: string) => (RECORDS[SIGNED_FILE(id)] as { era: Era }).era;
type Explorer = { success: boolean; error: { name: string } | null; events: { pallet: string; name: string; fields: Record<string, string> }[] };
type Sent = { status: string; block_number: number; block_hash: string };
const RESULTS = RECORDS[RESULTS_FILE] as {
  spec_version: number;
  accounts: Record<string, { public_key: string; ss58: string }>;
  start: { finalized: { number: number; hash: string } };
  steps: { step: string; run_time: { sent: Sent; explorer: Explorer } | null }[];
};
const STEPS_JSON = RECORDS[STEPS_FILE] as { values: Record<string, { value: string }>; steps: { id: string; inner?: { call: string }; call?: string[] }[] };
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The value at a dotted field of a record: names, and list positions as digits. */
function at(v: unknown, field: string): unknown {
  let x = v;
  for (const part of field.split(".")) {
    if (Array.isArray(x) && /^\d+$/.test(part)) x = x[Number(part)];
    else if (x !== null && typeof x === "object" && !Array.isArray(x) && Object.hasOwn(x, part)) x = (x as Record<string, unknown>)[part];
    else return undefined;
  }
  return x;
}

/** Every input with the place it is given in the inputs file. */
function sources(inputs: Inputs): [string, Source<unknown>][] {
  return [
    ...Object.entries(inputs.accounts).map(([n, s]) => [`accounts.${n}`, s] as [string, Source<unknown>]),
    ...Object.entries(inputs.channels).map(([n, s]) => [`channels.${n}`, s] as [string, Source<unknown>]),
    ...Object.entries(inputs.blocks).flatMap(([n, b]) => [[`blocks.${n}.height`, b.height] as [string, Source<unknown>], [`blocks.${n}.hash`, b.hash] as [string, Source<unknown>]]),
  ];
}

const label = (r: Read) => `${r.pallet}.${r.entry}(${r.keys.map((k) => ("account" in k ? k.account : k.channel)).join(",")})`;
const batches = DERIVED.filter((d) => d.call.method === "state_queryStorageAt");
/** The keys of the System entries, as the lab's reads of the upgrade asked them (a name with a dot, so read whole). */
const UP_KEYS = at(record(UP_FILE), "keys") as Record<string, string>;
/** The steps of results.json that were sent, in order: every step with a run time reading. */
const SENT = RESULTS.steps.filter((s) => s.run_time !== null) as { step: string; run_time: { sent: Sent; explorer: Explorer } }[];
const T3 = RESULTS.steps.findIndex((s) => s.step === "T3");
/** Where the explorer's ForceOpenRequested of T3 is in results.json. */
const FORCE_OPEN = (RESULTS.steps[T3]?.run_time?.explorer.events ?? []).findIndex((e) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested");

describe("the fifth request list, frozen in its recording's fixture", () => {
  const read = readRequests(new TextEncoder().encode(LIST_TEXT));
  const calls = typeof read === "string" ? [] : read.calls;

  it("is in the written form, holds 32 calls (at most MAX_CALLS), every method one the guard allows, and only the finalized head, block hashes, batches and blocks", () => {
    expect(read).not.toBeTypeOf("string");
    expect(calls.length).toBe(32);
    expect(MAX_CALLS).toBe(64);
    expect(calls.length).toBeLessThanOrEqual(MAX_CALLS);
    for (const c of calls) expect(READ_ONLY_RPC_METHODS.has(c.method), c.method).toBe(true);
    const by: Record<string, number> = {};
    for (const c of calls) by[c.method] = (by[c.method] ?? 0) + 1;
    expect(by).toEqual({ chain_getFinalizedHead: 1, chain_getBlockHash: 14, state_queryStorageAt: 9, chain_getBlock: 8 });
  });

  it("passes the read only guard on every call, as the derived list does", () => {
    for (const c of [...calls, ...DERIVED.map((d) => d.call)]) expect(() => guardRpc(c.method), c.method).not.toThrow();
  });

  it("asks one method no earlier list asked, chain_getBlock, and every other method one the fourth list asked", () => {
    const earlier = new Set([LIST_1_TEXT, LIST_2_TEXT, LIST_3_TEXT, LIST_4_TEXT].flatMap((t) => (JSON.parse(t) as { calls: { method: string }[] }).calls.map((c) => c.method)));
    const four = new Set((JSON.parse(LIST_4_TEXT) as { calls: { method: string }[] }).calls.map((c) => c.method));
    expect([...new Set(DERIVED.map((d) => d.call.method).filter((m) => !earlier.has(m)))]).toEqual(["chain_getBlock"]);
    for (const d of DERIVED) if (d.call.method !== "chain_getBlock") expect(four.has(d.call.method), d.call.method).toBe(true);
  });

  it("is, byte for byte, the list derived from its frozen inputs and the recorded 1014020 metadata", () => {
    expect(LIST_TEXT).toBe(deriveRequestsText(INPUTS, MD));
    expect(calls).toEqual(DERIVED.map((d) => d.call));
  });

  it("builds its keys from the reviewed metadata of the spec the encoder test's results.json names, found on the third recording's tape by its sha256", () => {
    const line = REVIEWED.find((r) => r.specVersion === RESULTS.spec_version);
    expect(ENCODER_SPEC_FIELD).toBe("spec_version");
    expect(RESULTS.spec_version).toBe(1014020);
    expect([META.length, sha256(META)]).toEqual([line?.metadataBytes, line?.metadataSha256]);
  });

  it("asks the heads, then for the start and each sent step of results.json in its order the hash at its height and one batch at its hash, then for a step the block, then for a mortal step the hash at its era's birth height", () => {
    // Read a second way: the heights and hashes from results.json's start and its steps' run time
    // readings, the mortal steps and their birth heights from the signed files the run left.
    expect(DERIVED.map((d) => [d.call.method, d.call.method === "state_queryStorageAt" ? (d.call.params as unknown[])[1] : d.call.params])).toEqual([
      ["chain_getFinalizedHead", []],
      ["chain_getBlockHash", [0]],
      ["chain_getBlockHash", [RESULTS.start.finalized.number]],
      ["state_queryStorageAt", RESULTS.start.finalized.hash],
      ...SENT.flatMap((s) => {
        const era = eraOf(s.step);
        return [
          ["chain_getBlockHash", [s.run_time.sent.block_number]],
          ["state_queryStorageAt", s.run_time.sent.block_hash],
          ["chain_getBlock", [s.run_time.sent.block_hash]],
          ...(era === "immortal" ? [] : [["chain_getBlockHash", [era.birth_number]]]),
        ];
      }),
    ]);
    expect(SENT.filter((s) => eraOf(s.step) !== "immortal").map((s) => s.step)).toEqual([...MORTAL_IDS]);
    for (const s of SENT) expect(s.run_time.sent.status, s.step).toBe("finalized");
    expect(SENT.map((s) => s.step)).toEqual([...STEP_IDS]);
    expect(STEPS_JSON.steps.map((s) => s.id).filter((id) => SENT.some((s) => s.step === id))).toEqual([...STEP_IDS]);
    expect(STEPS_JSON.steps.map((s) => s.id).filter((id) => !(STEP_IDS as readonly string[]).includes(id))).toEqual(["T7"]);
    expect(BLOCKS).toEqual([START, ...STEP_IDS.map(blockOf)]);
    expect(DERIVED.slice(2).map((d) => d.block)).toEqual([
      START,
      START,
      ...STEP_IDS.flatMap((id) => [blockOf(id), blockOf(id), blockOf(id), ...((MORTAL_IDS as readonly string[]).includes(id) ? [birthOf(id as (typeof MORTAL_IDS)[number])] : [])]),
    ]);
  });

  it("asks each chain_getBlock at the hash of its step's block, the block the run time record names, and at no other block", () => {
    const blocks = DERIVED.filter((d) => d.call.method === "chain_getBlock");
    expect(blocks.map((d) => d.block)).toEqual(STEP_IDS.map(blockOf));
    for (const [i, d] of blocks.entries()) {
      expect(d.call.params).toEqual([INPUTS.blocks[d.block as Block].hash.value]);
      expect(d.call.params).toEqual([SENT[i]?.run_time.sent.block_hash]);
      expect([d.read, d.reads]).toEqual([null, null]);
    }
  });

  it("asks at every block the same eight keys in one fixed order, System.Events and System.LastRuntimeUpgrade first by the keys the lab's reads of the upgrade asked", () => {
    expect(batches).toHaveLength(9);
    for (const d of batches) {
      expect(d.call.params, d.call.why).toHaveLength(2);
      const [keys, hash] = d.call.params as [string[], string];
      expect(hash).toBe(INPUTS.blocks[d.block as Block].hash.value);
      expect(keys.slice(0, 2)).toEqual([UP_KEYS["System.Events"], UP_KEYS["System.LastRuntimeUpgrade"]]);
      expect(d.reads?.map(label)).toEqual([
        "System.Events()",
        "System.LastRuntimeUpgrade()",
        "System.Account(owner)",
        "System.Account(device)",
        "FlopSessionKeys.Sessions(owner,device)",
        "FlopSessionKeys.SessionNonces(owner,device)",
        "FlopSessionKeys.CircuitBreakers(device)",
        "ComputeChannel.Channels(t3)",
      ]);
      expect(keys).toHaveLength(8);
      expect(new Set(keys).size).toBe(8);
      expect(keys).toEqual((batches[0]?.call.params as [string[], string])[0]);
    }
    expect(READS.every((r) => r.keys.every((k) => !("account" in k) || k.account !== "named"))).toBe(true);
  });

  it("builds every key a second way with the reference decoder over the 1014020 metadata, from the ss58 addresses results.json gives and the channel of T3", () => {
    const ss58: Record<string, string> = { owner: RESULTS.accounts.owner?.ss58 as string, device: RESULTS.accounts.device?.ss58 as string };
    const account = BUILDER.buildDefinition(0);
    for (const [name, address] of Object.entries(ss58)) expect(`0x${Buffer.from(account.enc(address)).toString("hex")}`, name).toBe(INPUTS.accounts[name as "owner" | "device"].value);
    let n = 0;
    for (const d of batches) {
      const keys = (d.call.params as [string[], string])[0];
      for (const [j, r] of (d.reads ?? []).entries()) {
        const args = r.keys.map((k) => ("account" in k ? ss58[k.account] : INPUTS.channels[k.channel].value));
        expect(keys[j], `${d.block} ${label(r)}`).toBe(BUILDER.buildStorage(r.pallet, r.entry).keys.enc(...args));
        n++;
      }
    }
    expect(n).toBe(72);
  });

  it("says why for each call in one plain line, naming the height of its block, the hash it compares with, the step, what was sent and the outcome its run time record gives", () => {
    for (const d of DERIVED) {
      expect(d.call.why, d.call.why).toMatch(/^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/);
      expect(d.call.why, d.call.why).not.toMatch(/[‒-―]| - /);
      if (d.block === null) continue;
      const b = INPUTS.blocks[d.block];
      const id = d.block.split("/")[1]?.replace(/-birth$/, "");
      expect(d.call.why, d.call.why).toContain(`${d.call.method === "chain_getBlockHash" ? "height" : "block"} ${b.height.value}`);
      expect(d.call.why, d.call.why).toContain(d.block !== START ? `step ${id}` : d.call.method === "chain_getBlockHash" ? "for the start of the run" : "the finalized block the run started from, before any step");
      if (d.call.method === "chain_getBlockHash") expect(d.call.why).toContain(b.hash.value);
      if (d.call.method === "chain_getBlock") expect(d.call.why).toContain(`the extrinsic at the index the run time record names for step ${id} must be byte for byte the signed extrinsic of step ${id}`);
      if ((BIRTHS as readonly string[]).includes(d.block)) expect(d.call.why).toContain(`the birth block of the mortal era step ${id} was signed with: the signature of step ${id} binds this block's hash`);
    }
    for (const [i, s] of SENT.entries()) {
      const ex = s.run_time.explorer;
      expect(STEPS[i]?.outcome, s.step).toBe(ex.success ? "success" : `refused with ${ex.error?.name}`);
      const why = batches[i + 1]?.call.why ?? "";
      expect(why, s.step).toContain(`(step ${s.step}; the run time record says ${ex.success ? "success" : `refused with ${ex.error?.name}`})`);
      expect(why, s.step).toContain(STEPS[i]?.sent as string);
      const plan = STEPS_JSON.steps.find((p) => p.id === s.step);
      const call = plan?.inner?.call;
      if (call !== undefined) expect(why, s.step).toContain(`ComputeChannel.${call}`);
    }
    for (const d of batches) {
      expect(d.call.why).toContain("a key that holds nothing listed with null");
      expect(d.call.why).toContain(`the named miner ${INPUTS.accounts.named.value};`);
    }
  });
});

describe("the inputs of the fifth list, frozen in its recording's fixture", () => {
  it("is in the written form, and refuses a file that is not or that lacks a name the plan uses; the fourth list's inputs are not the fifth's", () => {
    expect(() => readInputs(INPUTS_TEXT)).not.toThrow();
    expect(() => readInputs(JSON.stringify(JSON.parse(INPUTS_TEXT)))).toThrow("the inputs file is not in the written form");
    const v = JSON.parse(INPUTS_TEXT) as { accounts: Record<string, unknown>; channels: Record<string, unknown> };
    delete v.accounts.named;
    expect(() => readInputs(feedText(v))).toThrow("accounts must hold exactly owner, device, named");
    const w = JSON.parse(INPUTS_TEXT) as { channels: Record<string, unknown> };
    delete w.channels.t3;
    expect(() => readInputs(feedText(w))).toThrow("channels must hold exactly t3");
    expect(() => readList4Inputs(INPUTS_TEXT)).toThrow();
    expect(() => readInputs(LIST_4_INPUTS_TEXT)).toThrow();
  });

  it("names only the encoder test's results.json and steps.json, and the signed files of its four mortal steps", () => {
    expect([...new Set(sources(INPUTS).map(([, s]) => s.file))].sort()).toEqual([RESULTS_FILE, STEPS_FILE, ...MORTAL_IDS.map(SIGNED_FILE)].sort());
  });

  it("holds every input to the value at its field in the record it names", () => {
    let n = 0;
    for (const [where, s] of sources(INPUTS)) {
      expect(at(RECORDS[s.file], s.field), `${where}: ${s.file} ${s.field}`).toEqual(s.value);
      n++;
    }
    expect(n).toBe(30);
  });

  it("takes the owner and the device from results.json's accounts, and the named account from the value NAMED of steps.json, the miner of T3's force_open", () => {
    for (const a of ["owner", "device"] as const) expect([INPUTS.accounts[a].file, INPUTS.accounts[a].field]).toEqual([RESULTS_FILE, `accounts.${a}.public_key`]);
    expect([INPUTS.accounts.named.file, INPUTS.accounts.named.field]).toEqual([STEPS_FILE, "values.NAMED.value"]);
    expect(at(RESULTS, `steps.${T3}.run_time.explorer.events.${FORCE_OPEN}.fields.miner`)).toBe(INPUTS.accounts.named.value);
    expect(STEPS_JSON.values.OWNER?.value).toBe(INPUTS.accounts.owner.value);
  });

  it("takes the channel t3 from the ForceOpenRequested the explorer gave for T3, and it is the id steps.json derives for T3's channel", () => {
    expect(FORCE_OPEN).toBeGreaterThanOrEqual(0);
    expect([INPUTS.channels.t3.file, INPUTS.channels.t3.field]).toEqual([RESULTS_FILE, `steps.${T3}.run_time.explorer.events.${FORCE_OPEN}.fields.channel_id`]);
    // Derived a second way: blake2b-256("FLOP/COMPUTE_CHANNEL/ID" || 0x01 || genesis || agent || miner || u64 LE nonce), steps.json's CH_T3.
    const v = (name: string) => STEPS_JSON.values[name]?.value as string;
    const nonce = new Uint8Array(8);
    new DataView(nonce.buffer).setBigUint64(0, BigInt(v("N_T3")), true);
    const preimage = [new TextEncoder().encode("FLOP/COMPUTE_CHANNEL/ID"), Uint8Array.of(1), fromHex(v("GENESIS")), fromHex(v("OWNER")), fromHex(v("NAMED")), nonce];
    const bytes = new Uint8Array(preimage.reduce((n, p) => n + p.length, 0));
    preimage.reduce((o, p) => (bytes.set(p, o), o + p.length), 0);
    const derived = toHex(blake2b(bytes, { dkLen: 32 }));
    expect(derived).toBe(v("CH_T3"));
    expect(INPUTS.channels.t3.value).toBe(derived);
  });

  it("names the start by results.json's start.finalized, and each step's block by its run time reading in results.json", () => {
    expect([INPUTS.blocks[START].height.field, INPUTS.blocks[START].hash.field, INPUTS.blocks[START].height.file]).toEqual(["start.finalized.number", "start.finalized.hash", RESULTS_FILE]);
    expect(STEP_IDS.map((id) => [INPUTS.blocks[blockOf(id)].height.file, INPUTS.blocks[blockOf(id)].height.field, INPUTS.blocks[blockOf(id)].hash.file, INPUTS.blocks[blockOf(id)].hash.field])).toEqual(
      STEP_IDS.map((id) => {
        const i = RESULTS.steps.findIndex((s) => s.step === id);
        return [RESULTS_FILE, `steps.${i}.run_time.sent.block_number`, RESULTS_FILE, `steps.${i}.run_time.sent.block_hash`];
      }),
    );
  });

  it("takes each birth block from era.birth_number and era.birth_hash of its step's signed file, at or below the step's block and within the era's 64 blocks of it", () => {
    expect(BIRTHS).toEqual(MORTAL_IDS.map(birthOf));
    for (const id of MORTAL_IDS) {
      const birth = INPUTS.blocks[birthOf(id)];
      expect([birth.height.file, birth.height.field, birth.hash.file, birth.hash.field], id).toEqual([SIGNED_FILE(id), "era.birth_number", SIGNED_FILE(id), "era.birth_hash"]);
      const era = eraOf(id);
      if (era === "immortal") throw new Error(`${id} is immortal`);
      const landed = INPUTS.blocks[blockOf(id)].height.value;
      expect(era.period, id).toBe(64);
      expect(birth.height.value, id).toBeLessThanOrEqual(landed);
      expect(landed - birth.height.value, id).toBeLessThan(era.period);
      expect(birth.height.value, id).toBeGreaterThan(INPUTS.blocks[START].height.value);
    }
  });

  it("reads blocks that rise from the start step by step, the start above the first block the 1014020 runtime executed", () => {
    const heights = BLOCKS.map((b) => INPUTS.blocks[b].height.value);
    for (let i = 1; i < heights.length; i++) expect(heights[i] as number).toBeGreaterThan(heights[i - 1] as number);
    expect(at(record(UP_FILE), "boundary.2.last_runtime_upgrade.spec_version")).toBe(RESULTS.spec_version);
    expect(heights[0] as number).toBeGreaterThan(at(record(UP_FILE), "boundary.2.height") as number);
  });

  it("changes the list when any one input changes, so the byte comparison bites on each", () => {
    const base = deriveRequestsText(INPUTS, MD);
    for (const [where, s] of sources(INPUTS)) {
      const original = s.value;
      s.value = typeof original === "number" ? original + 1 : `${String(original).slice(0, -1)}${String(original).endsWith("0") ? "1" : "0"}`;
      try {
        expect(deriveRequestsText(INPUTS, MD), where).not.toBe(base);
      } finally {
        s.value = original;
      }
    }
    expect(deriveRequestsText(INPUTS, MD)).toBe(base);
  });
});

describe("the block kind of the request core", () => {
  it("asks exactly chain_getBlock with the hash of the block named, and carries the block and no read", () => {
    const [d] = coreDerive([{ kind: "block" as const, block: START, why: "a block" }], INPUTS, MD);
    expect(d).toEqual({ call: { method: "chain_getBlock", params: [INPUTS.blocks[START].hash.value], why: "a block" }, block: START, read: null, reads: null });
  });
});
