// The second request list, recordings/requests.json: the storage the lab's own two devnet tests
// left behind, read block by block. It is derived (test/helpers/requests/list-2.ts) from
// recordings/requests-inputs.json and the recorded metadata, and nothing in it is typed by hand.
// These tests hold the list to that function byte for byte, derive every storage key a second way
// with the reference decoder, and hold every input to the record it names: research/*/results.json
// for the two tests, and the first recording for the gateway channel.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { READ_ONLY_RPC_METHODS } from "../src/guard.js";
import { MAX_CALLS, readRequests } from "../src/requests.js";
import { decodeEvents } from "../src/scale/events.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { RECORDING, recorded } from "./helpers/recorded.js";
import { INPUTS_TEXT } from "./helpers/recorded-storage.js";
import { requestsListText } from "./helpers/requests-list.js";
import { type Block, type DerivedCall, type Inputs, LAST, type Mentioned, PLAN, type Read, type Source, deriveCalls, deriveRequestsText, readInputs } from "./helpers/requests/list-2.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
const LIST_TEXT = repoText("observatory/recordings/requests.json");
const INPUTS = readInputs(INPUTS_TEXT);
const R = recorded();
const MD = parseMetadata(R.metadata);
const DERIVED = deriveCalls(INPUTS, MD);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(R.metadata))));
const PROBE = "research/2026-11-11-session-probe/results.json";
const ESCROW = "research/2026-11-11-session-escrow/results.json";
const TAPE = `observatory/fixtures/${RECORDING}/tape.jsonl`;
const record = (file: string) => JSON.parse(repoText(file)) as Record<string, unknown>;
const RECORDS: Record<string, Record<string, unknown>> = { [PROBE]: record(PROBE), [ESCROW]: record(ESCROW) };
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

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
    ...Object.entries(inputs.mentioned).map(([n, b]) => [`mentioned.${n}.height`, b.height] as [string, Source<unknown>]),
  ];
}

const label = (r: Read) => `${r.entry}(${r.keys.map((k) => ("account" in k ? k.account : k.channel)).join(",")})`;

describe("the second request list, recordings/requests.json", () => {
  const read = readRequests(new TextEncoder().encode(LIST_TEXT));
  const calls = typeof read === "string" ? [] : read.calls;

  it("is in the written form, holds 56 calls (at most MAX_CALLS), and every method in it is one the guard allows", () => {
    expect(read).not.toBeTypeOf("string");
    expect(calls.length).toBe(56);
    expect(calls.length).toBeLessThanOrEqual(MAX_CALLS);
    for (const c of calls) expect(READ_ONLY_RPC_METHODS.has(c.method), c.method).toBe(true);
  });

  it("is, byte for byte, the list derived from recordings/requests-inputs.json and the recorded metadata", () => {
    expect(LIST_TEXT).toBe(deriveRequestsText(INPUTS, MD));
    expect(calls).toEqual(DERIVED.map((d) => d.call));
  });

  it("is what the committed writer writes: scripts/write-requests.mjs writes requestsListText, the same derive function, and nothing of its own", () => {
    expect(requestsListText()).toBe(LIST_TEXT);
    const script = repoText("observatory/scripts/write-requests.mjs");
    expect(script).toContain('const { requestsListText } = await import("../test/helpers/requests-list.ts");');
    expect(script).toContain("writeFileSync(args[1], requestsListText());");
    for (const name of ["deriveCalls", "deriveRequestsText", "storageKey", "feedText", "PLAN"]) expect(script, name).not.toContain(name);
  });

  it("asks the heads, then for each block of the lead's design its hash by height, its LastRuntimeUpgrade and the reads named, then the runtime and metadata at the last block", () => {
    // The lead's design, as the brief of Nov 11 gives it, read here a second way from the derived calls.
    const want: [number, string[]][] = [
      [3497525, ["Sessions(owner,device_2)", "SessionNonces(owner,device_2)"]],
      [3497567, ["Events()", "Sessions(owner,device_2)", "SessionNonces(owner,device_2)", "CircuitBreakers(device_2)", "Channels(ours)"]],
      [3497611, ["Events()", "Sessions(owner,device_2)", "SessionNonces(owner,device_2)", "CircuitBreakers(device_2)", "Channels(ours)"]],
      [3497716, ["Sessions(owner,device_2)", "SessionNonces(owner,device_2)", "CircuitBreakers(device_2)"]],
      [3498234, ["Events()", "Sessions(owner,device_2)", "SessionNonces(owner,device_2)", "CircuitBreakers(device_2)", "Channels(ours)"]],
      [3498288, ["Events()", "Sessions(owner,device_2)"]],
      [3492718, ["Sessions(owner,device_1)"]],
      [3492760, ["Events()"]],
      [3492808, ["Events()"]],
      [3492879, ["Sessions(owner,device_1)"]],
      [3479299, ["Channels(gateway)"]],
      [3498313, ["Channels(gateway)"]],
    ];
    const heightOf = (b: Block) => INPUTS.blocks[b].height.value;
    const hashOf = (b: Block) => INPUTS.blocks[b].hash.value;
    expect(DERIVED.slice(0, 2).map((d) => [d.call.method, d.call.params])).toEqual([
      ["chain_getFinalizedHead", []],
      ["chain_getBlockHash", [0]],
    ]);
    const groups: [number, string[]][] = [];
    let i = 2;
    while (DERIVED[i]?.call.method === "chain_getBlockHash") {
      const block = DERIVED[i]?.block as Block;
      expect(DERIVED[i]?.call.params).toEqual([heightOf(block)]);
      expect(DERIVED[i + 1]?.call.params).toEqual([BUILDER.buildStorage("System", "LastRuntimeUpgrade").keys.enc(), hashOf(block)]);
      const reads: DerivedCall[] = [];
      for (i += 2; DERIVED[i]?.read; i++) reads.push(DERIVED[i] as DerivedCall);
      for (const d of reads) expect([d.block, d.call.method, d.call.params[1]]).toEqual([block, "state_getStorage", hashOf(block)]);
      groups.push([heightOf(block), reads.map((d) => label(d.read as Read))]);
    }
    expect(groups).toEqual(want);
    expect(DERIVED.slice(i).map((d) => [d.call.method, d.call.params])).toEqual([
      ["state_getRuntimeVersion", [hashOf(LAST)]],
      ["state_getMetadata", [hashOf(LAST)]],
    ]);
    expect(heightOf(LAST)).toBe(3498313);
  });

  it("says why for each call in one plain line, naming the height of its block, and the hash it compares with", () => {
    for (const d of DERIVED) {
      expect(d.call.why, d.call.why).toMatch(/^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/);
      expect(d.call.why, d.call.why).not.toMatch(/[‒-―]| - /);
      if (d.block === null) continue;
      expect(d.call.why, d.call.why).toContain(`${d.call.method === "chain_getBlockHash" ? "height" : "block"} ${INPUTS.blocks[d.block].height.value}`);
      if (d.call.method === "chain_getBlockHash") expect(d.call.why).toContain(INPUTS.blocks[d.block].hash.value);
    }
  });

  it("builds every storage key a second way with the reference decoder, from the ss58 addresses the test records give", () => {
    const ss58: Record<string, string> = {
      owner: at(RECORDS[ESCROW], "owner.ss58") as string,
      device_1: at(RECORDS[PROBE], "device.ss58") as string,
      device_2: at(RECORDS[ESCROW], "device.ss58") as string,
    };
    expect(at(RECORDS[PROBE], "owner.ss58")).toBe(ss58.owner);
    const account = BUILDER.buildDefinition(0);
    for (const [name, address] of Object.entries(ss58)) expect(`0x${Buffer.from(account.enc(address)).toString("hex")}`, name).toBe(INPUTS.accounts[name as keyof Inputs["accounts"]].value);
    let n = 0;
    for (const d of DERIVED) {
      if (d.read === null) continue;
      const args = d.read.keys.map((k) => ("account" in k ? ss58[k.account] : INPUTS.channels[k.channel].value));
      expect(d.call.params[0], d.call.why).toBe(BUILDER.buildStorage(d.read.pallet, d.read.entry).keys.enc(...args));
      n++;
    }
    expect(n).toBe(28);
    expect(BUILDER.buildStorage("System", "Events").keys.enc()).toBe("0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7");
  });

  it("reads entries as the recorded metadata states them: FlopSessionKeys (94) by two accounts or one, ComputeChannel (103) Channels by an H256", () => {
    const pallet = (name: string) => MD.pallets.find((p) => p.name === name);
    expect([pallet("FlopSessionKeys")?.index, pallet("ComputeChannel")?.index]).toEqual([94, 103]);
    const entry = (p: string, e: string) => pallet(p)?.storage?.entries.find((x) => x.name === e);
    const path = (t: number | undefined) => MD.types.at(t ?? -1)?.path.join("::");
    for (const e of ["Sessions", "SessionNonces"]) {
      const s = entry("FlopSessionKeys", e);
      const key = MD.types.at(s?.key ?? -1)?.def;
      expect([e, s?.hashers, key?.kind === "tuple" ? key.types.map(path) : null]).toEqual([e, ["Blake2_128Concat", "Blake2_128Concat"], ["sp_core::crypto::AccountId32", "sp_core::crypto::AccountId32"]]);
    }
    expect([entry("FlopSessionKeys", "CircuitBreakers")?.hashers, path(entry("FlopSessionKeys", "CircuitBreakers")?.key ?? undefined)]).toEqual([["Blake2_128Concat"], "sp_core::crypto::AccountId32"]);
    expect([entry("ComputeChannel", "Channels")?.hashers, path(entry("ComputeChannel", "Channels")?.key ?? undefined)]).toEqual([["Blake2_128Concat"], "primitive_types::H256"]);
    // SessionNonces has a default: a node answers null where it holds none, and the runtime reads 0.
    expect(["Sessions", "SessionNonces", "CircuitBreakers"].map((e) => entry("FlopSessionKeys", e)?.modifier)).toEqual(["Optional", "Default", "Optional"]);
  });
});

describe("the inputs, recordings/requests-inputs.json", () => {
  it("is in the written form, and refuses a file that is not or that lacks a name the plan uses", () => {
    expect(() => readInputs(INPUTS_TEXT)).not.toThrow();
    expect(() => readInputs(JSON.stringify(JSON.parse(INPUTS_TEXT)))).toThrow("the inputs file is not in the written form");
    const v = JSON.parse(INPUTS_TEXT) as { accounts: Record<string, unknown> };
    delete v.accounts.device_1;
    expect(() => readInputs(feedText(v))).toThrow("accounts must hold exactly owner, device_1, device_2");
  });

  it("names only the two test records and the first recording, and every block of the plan, each from one step", () => {
    expect([...new Set(sources(INPUTS).map(([, s]) => s.file))].sort()).toEqual([TAPE, ESCROW, PROBE].sort());
    const blocks: [string, { height: Source<number>; hash?: Source<string> }][] = [...Object.entries(INPUTS.blocks), ...Object.entries(INPUTS.mentioned)];
    for (const [name, b] of blocks) {
      if (b.height.file === TAPE) continue;
      const step = /^steps\.(\d+)\.finalized_in_block$/.exec(b.height.field)?.[1];
      if (b.hash !== undefined) expect([name, b.height.file, b.hash.field], name).toEqual([name, b.hash.file, `steps.${step}.block_hash`]);
      const prefix = b.height.file === ESCROW ? "session-escrow" : "session-probe";
      expect(`${prefix}/${String(at(RECORDS[b.height.file], `steps.${step}.step`))}`).toBe(name);
    }
  });

  it("holds every input taken from a test record to the value at its field there", () => {
    let n = 0;
    for (const [where, s] of sources(INPUTS)) {
      if (s.file === TAPE) continue;
      expect(at(RECORDS[s.file], s.field), `${where}: ${s.file} ${s.field}`).toEqual(s.value);
      n++;
    }
    expect(n).toBe(27);
  });

  it("takes the gateway channel and block 3479299 from the first recording: the hash it answered, and the one Settled event there", () => {
    const g = INPUTS.blocks["gateway/settled"];
    expect([g.height.file, g.hash.file, INPUTS.channels.gateway.file]).toEqual([TAPE, TAPE, TAPE]);
    const block = R.blocks.find((b) => b.number === g.height.value);
    expect(block?.hash).toBe(g.hash.value);
    // The tape numbers its calls from 0, in the order judgeRecording gives them.
    const seq = R.calls.findIndex((c) => c.method === "chain_getBlockHash" && c.params[0] === g.height.value);
    expect(seq).toBe(18);
    expect(g.height.field).toBe(`the params of the chain_getBlockHash call at seq ${seq}`);
    expect(g.hash.field).toBe(`the answer to the chain_getBlockHash call at seq ${seq}`);
    expect(JSON.parse(repoText(TAPE).split("\n")[seq + 1] ?? "null")).toMatchObject({ seq, request: { method: "chain_getBlockHash", params: [g.height.value] }, answer: { result: g.hash.value } });
    const settled = decodeEvents(MD, block?.events ?? new Uint8Array()).filter((e) => e.event === "Settled");
    expect(settled.map((e) => [e.pallet, (e.fields as Record<string, unknown>).channel_id])).toEqual([["ComputeChannel", INPUTS.channels.gateway.value]]);
    expect(INPUTS.channels.gateway.field).toBe(`the channel_id of the one ComputeChannel.Settled event in System.Events at seq ${seq + 2}`);
    expect(R.calls.at(seq + 2)?.params).toEqual(["0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7", g.hash.value]);
  });

  it("is on the chain and metadata of the recording, and each outcome the whys name is the one the test record gives", () => {
    for (const file of [PROBE, ESCROW]) {
      expect(at(RECORDS[file], "chain.genesis"), file).toBe(R.genesis);
      expect(at(RECORDS[file], "chain.spec_version"), file).toBe(1014014);
      expect(at(RECORDS[file], "chain.metadata_sha256"), file).toBe(sha256(R.metadata));
    }
    let n = 0;
    for (const step of PLAN) {
      for (const o of step.outcomes) {
        const b = o.block in INPUTS.blocks ? INPUTS.blocks[o.block as Block] : INPUTS.mentioned[o.block as Mentioned];
        const result = String(at(RECORDS[b.height.file], b.height.field.replace("finalized_in_block", "result")));
        if (o.error === null) expect(result, o.block).toMatch(/^(?:success|ExtrinsicSuccess)$/);
        else expect(result, o.block).toMatch(new RegExp(`^(?:failed|ExtrinsicFailed): .*\\.${o.error}\\b`));
        if (o.error !== null) expect(DERIVED.find((d) => d.block === step.block && d.read !== null)?.call.why, o.block).toContain(o.error);
        n++;
      }
    }
    expect(n).toBe(12);
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
