// The third request list, recordings/requests.json: FLOP devnet's runtime upgrade, the lab's own
// storage records on both sides of it, and the blocks of the lab's deny list test. It is derived
// (test/helpers/requests/list-3.ts) from recordings/requests-inputs.json and the recorded metadata,
// and nothing in it is typed by hand. These tests hold the list to that function byte for byte,
// read its design a second way, derive every storage key a second way with the reference decoder,
// hold every input to the record it names (research/2026-11-12-runtime-upgrade/results.json for the
// upgrade, research/2026-11-11-session-deny-list/results.json for the deny list test, and the
// sources list 2 had for the rest), and hold the lab's reads of the upgrade to themselves where that
// can be done offline. Nothing here reads the network or decodes anything of the new runtime but
// its System.LastRuntimeUpgrade record, the one value the shape pin reads to refuse it.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { READ_ONLY_RPC_METHODS } from "../src/guard.js";
import { MAX_CALLS, readRequests } from "../src/requests.js";
import { decodeValue } from "../src/scale/decode.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { fromHex } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { RECORDING, recorded } from "./helpers/recorded.js";
import { INPUTS_TEXT as LIST_2_INPUTS_TEXT, STORAGE_REQUESTS_TEXT } from "./helpers/recorded-storage.js";
import type { Source } from "./helpers/requests/core.js";
import { readInputs as readList2Inputs } from "./helpers/requests/list-2.js";
import { ACROSS, type Block, DENY, DENY_BLOCKS, type Inputs, type Read, UPGRADE_BLOCKS, deriveCalls, deriveRequestsText, readInputs } from "./helpers/requests/list-3.js";
import { requestsListText } from "./helpers/requests-list.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
const LIST_TEXT = repoText("observatory/recordings/requests.json");
const INPUTS_TEXT = repoText("observatory/recordings/requests-inputs.json");
const INPUTS = readInputs(INPUTS_TEXT);
const R = recorded();
const MD = parseMetadata(R.metadata);
const DERIVED = deriveCalls(INPUTS, MD);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(R.metadata))));
const UP = "research/2026-11-12-runtime-upgrade/results.json";
const DENY_FILE = "research/2026-11-11-session-deny-list/results.json";
const PROBE = "research/2026-11-11-session-probe/results.json";
const ESCROW = "research/2026-11-11-session-escrow/results.json";
const TAPE = `observatory/fixtures/${RECORDING}/tape.jsonl`;
const record = (file: string) => JSON.parse(repoText(file)) as Record<string, unknown>;
const RECORDS: Record<string, Record<string, unknown>> = { [UP]: record(UP), [DENY_FILE]: record(DENY_FILE), [PROBE]: record(PROBE), [ESCROW]: record(ESCROW) };
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
  ];
}

const label = (r: Read) => `${r.entry}(${r.keys.map((k) => ("account" in k ? k.account : k.channel)).join(",")})`;
const heightOf = (b: Block) => INPUTS.blocks[b].height.value;
const hashOf = (b: Block) => INPUTS.blocks[b].hash.value;

/** The lab's reads of the four upgrade blocks, in their order: the three boundary blocks it names, then the later block. */
const UPGRADE_READS = [...(at(RECORDS[UP], "boundary") as Record<string, unknown>[]).slice(0, 3), at(RECORDS[UP], "a_later_block_of_the_new_spec") as Record<string, unknown>];
/** The storage keys the lab's reads of the upgrade asked, named there by entry (a name with a dot, so read whole). */
const UP_KEYS = at(RECORDS[UP], "keys") as Record<string, string>;
const LRU_KEY = UP_KEYS["System.LastRuntimeUpgrade"] as string;
const EVENTS_KEY = UP_KEYS["System.Events"] as string;
/** The deny list test's steps this list reads at, by their place in the record's steps: steps 2, 3, 10, 11 and 12. */
const DENY_STEPS = [1, 2, 9, 10, 11];

describe("the third request list, recordings/requests.json", () => {
  const read = readRequests(new TextEncoder().encode(LIST_TEXT));
  const calls = typeof read === "string" ? [] : read.calls;

  it("is in the written form, holds 63 calls (at most MAX_CALLS), every method one the guard allows, and these many of each", () => {
    expect(read).not.toBeTypeOf("string");
    expect(calls.length).toBe(63);
    expect(MAX_CALLS).toBe(64);
    expect(calls.length).toBeLessThanOrEqual(MAX_CALLS);
    for (const c of calls) expect(READ_ONLY_RPC_METHODS.has(c.method), c.method).toBe(true);
    const by: Record<string, number> = {};
    for (const c of calls) by[c.method] = (by[c.method] ?? 0) + 1;
    expect(by).toEqual({ chain_getFinalizedHead: 1, chain_getBlockHash: 10, state_getRuntimeVersion: 4, state_getMetadata: 2, state_getStorage: 46 });
  });

  it("asks no method the first two lists did not ask", () => {
    const earlier = new Set([...(JSON.parse(repoText(`observatory/fixtures/${RECORDING}/requests.json`)) as { calls: { method: string }[] }).calls, ...(JSON.parse(STORAGE_REQUESTS_TEXT) as { calls: { method: string }[] }).calls].map((c) => c.method));
    for (const c of calls) expect(earlier.has(c.method), c.method).toBe(true);
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
    for (const name of ["deriveCalls", "deriveRequestsText", "storageKey", "feedText", "PLAN", "plan("]) expect(script, name).not.toContain(name);
    expect(repoText("observatory/test/helpers/requests-list.ts")).toContain('from "./requests/list-3.js";');
  });

  it("asks part A, the upgrade, as the lead ordered it: the heads, each block's hash, the version at each, the metadata at the two blocks of the old runtime's last answer, then LastRuntimeUpgrade and System.Events at each", () => {
    // Read a second way: the heights and hashes from the lab's reads of the upgrade, the keys as that file gives them.
    const heights = UPGRADE_READS.map((b) => b.height as number);
    const hashes = UPGRADE_READS.map((b) => b.hash as string);
    expect(heights).toEqual([3528527, 3528528, 3528529, 3530299]);
    expect(DERIVED.slice(0, 20).map((d) => [d.call.method, d.call.params])).toEqual([
      ["chain_getFinalizedHead", []],
      ["chain_getBlockHash", [0]],
      ...heights.map((h) => ["chain_getBlockHash", [h]]),
      ...hashes.map((h) => ["state_getRuntimeVersion", [h]]),
      ["state_getMetadata", [hashes[0]]],
      ["state_getMetadata", [hashes[1]]],
      ...hashes.map((h) => ["state_getStorage", [LRU_KEY, h]]),
      ...hashes.map((h) => ["state_getStorage", [EVENTS_KEY, h]]),
    ]);
    expect(DERIVED.slice(2, 20).map((d) => d.block)).toEqual([...UPGRADE_BLOCKS, ...UPGRADE_BLOCKS, UPGRADE_BLOCKS[0], UPGRADE_BLOCKS[1], ...UPGRADE_BLOCKS, ...UPGRADE_BLOCKS]);
  });

  it("asks part B, our own records, at the last block before the upgrade and at the later block of the new runtime, the same 12 keys in the same order", () => {
    const want = [
      "Sessions(owner,device_1)",
      "SessionNonces(owner,device_1)",
      "CircuitBreakers(device_1)",
      "Sessions(owner,device_2)",
      "SessionNonces(owner,device_2)",
      "CircuitBreakers(device_2)",
      "Sessions(owner,device_3)",
      "SessionNonces(owner,device_3)",
      "CircuitBreakers(device_3)",
      "Channels(ours)",
      "Channels(gateway)",
      "SessionNonces(device_1,owner)",
    ];
    const part = DERIVED.slice(20, 44);
    const [control, after] = ACROSS;
    expect([heightOf(control), heightOf(after)]).toEqual([UPGRADE_READS[0]?.height, UPGRADE_READS[3]?.height]);
    for (const [i, d] of part.entries()) {
      const block = i < 12 ? control : after;
      expect([d.block, d.call.method, d.call.params[1], label(d.read as Read)]).toEqual([block, "state_getStorage", hashOf(block), want[i % 12]]);
    }
    for (let i = 0; i < 12; i++) expect(part[i + 12]?.call.params[0], want[i]).toBe(part[i]?.call.params[0]);
  });

  it("asks part C, the deny list test, at each of its blocks by its step: the hash, LastRuntimeUpgrade and System.Events, then the session at the create and revoke blocks and the nonce and breaker at the success", () => {
    const steps = at(RECORDS[DENY_FILE], "steps") as { step: string; finalized_in_block: number; block_hash: string }[];
    const blocks = DENY_STEPS.map((i) => steps[i] as (typeof steps)[number]);
    expect(blocks.map((s) => s.step.split("-")[0])).toEqual(["2", "3", "10", "11", "12"]);
    expect(DERIVED.slice(44).map((d) => [d.call.method, d.call.params, d.read === null ? null : label(d.read)])).toEqual([
      ...blocks.flatMap((s) => [
        ["chain_getBlockHash", [s.finalized_in_block], null],
        ["state_getStorage", [LRU_KEY, s.block_hash], null],
        ["state_getStorage", [EVENTS_KEY, s.block_hash], "Events()"],
      ]),
      ["state_getStorage", [expect.any(String), blocks[0]?.block_hash], "Sessions(owner,device_3)"],
      ["state_getStorage", [expect.any(String), blocks[4]?.block_hash], "Sessions(owner,device_3)"],
      ["state_getStorage", [expect.any(String), blocks[3]?.block_hash], "SessionNonces(owner,device_3)"],
      ["state_getStorage", [expect.any(String), blocks[3]?.block_hash], "CircuitBreakers(device_3)"],
    ]);
    expect(DERIVED.slice(44, 59).map((d) => d.block)).toEqual(DENY_BLOCKS.flatMap((b) => [b, b, b]));
  });

  it("says why for each call in one plain line, naming the height of its block, and the hash it compares with", () => {
    for (const d of DERIVED) {
      expect(d.call.why, d.call.why).toMatch(/^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/);
      expect(d.call.why, d.call.why).not.toMatch(/[‒-―]| - /);
      if (d.block === null) continue;
      expect(d.call.why, d.call.why).toContain(`${d.call.method === "chain_getBlockHash" ? "height" : "block"} ${heightOf(d.block)}`);
      if (d.call.method === "chain_getBlockHash") expect(d.call.why).toContain(hashOf(d.block));
    }
  });

  it("says of the version and the metadata at the block that carries the upgrade that they answer for the runtime of the next block, and of LastRuntimeUpgrade there that it names the runtime that executed it", () => {
    const carries = UPGRADE_BLOCKS[1];
    const at1 = (method: string) => DERIVED.filter((d) => d.block === carries && d.call.method === method).map((d) => d.call.why);
    for (const why of [...at1("state_getRuntimeVersion"), ...at1("state_getMetadata")]) {
      expect(why).toContain("it answers for the runtime of the next block");
      expect(why).toContain(`${heightOf(UPGRADE_BLOCKS[2])}`);
    }
    expect(at1("state_getMetadata")).toHaveLength(1);
    const upgrade = DERIVED.filter((d) => d.block === carries && d.call.method === "state_getStorage" && d.read === null).map((d) => d.call.why);
    expect(upgrade).toHaveLength(1);
    expect(upgrade[0]).toContain("the runtime that executed the block");
    expect(upgrade[0]).toContain("still name the old runtime");
  });

  it("says of every read of ours at the block of the new runtime that its key is built from the old metadata, that a null there is not read as absent yet, and that the read before the upgrade is its control", () => {
    const [control, after] = ACROSS;
    const ours = DERIVED.filter((d) => d.read !== null && d.read.entry !== "Events");
    const later = ours.filter((d) => d.block === after);
    expect(later).toHaveLength(12);
    for (const d of later) {
      expect(d.call.why).toContain("the key is built from the old runtime's metadata");
      expect(d.call.why).toContain("a null here is not read as absent until the next phase has built the same key again from the recorded new metadata");
      expect(d.call.why).toContain(`the read at block ${heightOf(control)} is the control`);
    }
    for (const d of ours.filter((x) => x.block === control)) expect(d.call.why).toContain(`the control for the same key at block ${heightOf(after)}`);
  });

  it("builds every storage key a second way with the reference decoder, from the ss58 addresses the test records give", () => {
    const ss58: Record<string, string> = {
      owner: at(RECORDS[ESCROW], "owner.ss58") as string,
      device_1: at(RECORDS[PROBE], "device.ss58") as string,
      device_2: at(RECORDS[ESCROW], "device.ss58") as string,
      device_3: at(RECORDS[DENY_FILE], "device.ss58") as string,
    };
    expect(at(RECORDS[DENY_FILE], "owner.ss58")).toBe(ss58.owner);
    const account = BUILDER.buildDefinition(0);
    for (const [name, address] of Object.entries(ss58)) expect(`0x${Buffer.from(account.enc(address)).toString("hex")}`, name).toBe(INPUTS.accounts[name as keyof Inputs["accounts"]].value);
    let n = 0;
    for (const d of DERIVED) {
      if (d.call.method !== "state_getStorage") continue;
      const r = d.read ?? { pallet: "System", entry: "LastRuntimeUpgrade", keys: [] };
      const args = r.keys.map((k) => ("account" in k ? ss58[k.account] : INPUTS.channels[k.channel].value));
      expect(d.call.params[0], d.call.why).toBe(BUILDER.buildStorage(r.pallet, r.entry).keys.enc(...args));
      n++;
    }
    expect(n).toBe(46);
    expect(DERIVED.filter((d) => d.read !== null)).toHaveLength(37);
  });

  it("builds the two System keys exactly as the lab's reads of the upgrade asked them, at blocks of both runtimes", () => {
    expect(BUILDER.buildStorage("System", "LastRuntimeUpgrade").keys.enc()).toBe(LRU_KEY);
    expect(BUILDER.buildStorage("System", "Events").keys.enc()).toBe(EVENTS_KEY);
    expect(at(RECORDS[UP], "method")).toEqual(expect.stringContaining("state_getStorage (System.LastRuntimeUpgrade, System.Events, Timestamp.Now)"));
  });
});

describe("the inputs, recordings/requests-inputs.json", () => {
  it("is in the written form, and refuses a file that is not or that lacks a name the plan uses", () => {
    expect(() => readInputs(INPUTS_TEXT)).not.toThrow();
    expect(() => readInputs(JSON.stringify(JSON.parse(INPUTS_TEXT)))).toThrow("the inputs file is not in the written form");
    const v = JSON.parse(INPUTS_TEXT) as { accounts: Record<string, unknown>; mentioned: Record<string, unknown> };
    delete v.accounts.device_3;
    expect(() => readInputs(feedText(v))).toThrow("accounts must hold exactly owner, device_1, device_2, device_3");
    expect(() => readList2Inputs(INPUTS_TEXT)).toThrow();
    expect(() => readInputs(LIST_2_INPUTS_TEXT)).toThrow();
  });

  it("keeps every source list 2 had for the accounts and channels it shares, and takes device D3 from the deny list test", () => {
    const two = readList2Inputs(LIST_2_INPUTS_TEXT);
    for (const [n, s] of Object.entries(two.accounts)) expect(INPUTS.accounts[n as keyof Inputs["accounts"]], n).toEqual(s);
    for (const [n, s] of Object.entries(two.channels)) expect(INPUTS.channels[n as keyof Inputs["channels"]], n).toEqual(s);
    expect([INPUTS.accounts.device_3.file, INPUTS.accounts.device_3.field]).toEqual([DENY_FILE, "device.public_key"]);
  });

  it("names only the upgrade reads, the three test records and the first recording", () => {
    expect([...new Set(sources(INPUTS).map(([, s]) => s.file))].sort()).toEqual([UP, DENY_FILE, ESCROW, PROBE, TAPE].sort());
  });

  it("holds every input taken from a JSON record to the value at its field there", () => {
    let n = 0;
    for (const [where, s] of sources(INPUTS)) {
      if (s.file === TAPE) continue;
      expect(at(RECORDS[s.file], s.field), `${where}: ${s.file} ${s.field}`).toEqual(s.value);
      n++;
    }
    expect(n).toBe(23);
  });

  it("takes the four upgrade blocks from the lab's reads of the upgrade, the three boundary blocks it names and the later block, height and hash from one place each", () => {
    const want = ["boundary.0", "boundary.1", "boundary.2", "a_later_block_of_the_new_spec"];
    expect(UPGRADE_BLOCKS.map((b) => [INPUTS.blocks[b].height.file, INPUTS.blocks[b].height.field, INPUTS.blocks[b].hash.file, INPUTS.blocks[b].hash.field])).toEqual(want.map((f) => [UP, `${f}.height`, UP, `${f}.hash`]));
  });

  it("names each block of the deny list test by its step in the record, height and hash from that one step", () => {
    const steps = at(RECORDS[DENY_FILE], "steps") as { step: string }[];
    expect(DENY_BLOCKS.map((b) => [b, INPUTS.blocks[b].height.file, INPUTS.blocks[b].height.field, INPUTS.blocks[b].hash.file, INPUTS.blocks[b].hash.field])).toEqual(
      DENY_STEPS.map((i) => [`session-deny-list/${steps[i]?.step}`, DENY_FILE, `steps.${i}.finalized_in_block`, DENY_FILE, `steps.${i}.block_hash`]),
    );
    expect(DENY.map((s) => s.block)).toEqual([...DENY_BLOCKS]);
  });

  it("gives each deny list step the outcome its record gives, and names the error in the why of its events", () => {
    for (const s of DENY) {
      const b = INPUTS.blocks[s.block];
      const result = String(at(RECORDS[DENY_FILE], b.height.field.replace("finalized_in_block", "result")));
      if (s.error === null) expect(result, s.block).toMatch(/^(?:success|ExtrinsicSuccess)$/);
      else expect(result, s.block).toMatch(new RegExp(`^(?:failed|ExtrinsicFailed): .*\\.${s.error}\\b`));
      const events = DERIVED.find((d) => d.block === s.block && d.read?.entry === "Events");
      if (s.error !== null) expect(events?.call.why, s.block).toContain(s.error);
    }
    expect(DENY.filter((s) => s.error !== null)).toHaveLength(2);
  });

  it("reads the deny list test's blocks and the control of part B at the runtime whose metadata builds every key, and part B's later block on the same chain", () => {
    for (const file of [DENY_FILE, ESCROW, PROBE]) {
      expect(at(RECORDS[file], "chain.genesis"), file).toBe(R.genesis);
      expect(at(RECORDS[file], "chain.spec_version"), file).toBe(REVIEWED[0]?.specVersion);
      expect(at(RECORDS[file], "chain.metadata_sha256"), file).toBe(sha256(R.metadata));
    }
    expect(at(RECORDS[UP], "genesis")).toBe(R.genesis);
    expect(at(RECORDS[UP], "boundary.0.metadata.sha256")).toBe(sha256(R.metadata));
    expect(at(RECORDS[UP], "boundary.0.metadata.bytes")).toBe(R.metadata.length);
    expect(at(RECORDS[UP], "boundary.0.last_runtime_upgrade.spec_version")).toBe(REVIEWED[0]?.specVersion);
    for (const b of DENY_BLOCKS) expect(heightOf(b), b).toBeLessThan(heightOf(UPGRADE_BLOCKS[0]));
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

describe("the lab's reads of the runtime upgrade, results.json, where they can be held offline", () => {
  const boundary = at(RECORDS[UP], "boundary") as Record<string, unknown>[];
  const later = at(RECORDS[UP], "a_later_block_of_the_new_spec") as Record<string, unknown>;
  const lruType = MD.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "LastRuntimeUpgrade")?.value ?? -1;

  it("names four boundary blocks in a row, each the child of the one before, and a later block above them", () => {
    expect(boundary).toHaveLength(4);
    for (let i = 1; i < boundary.length; i++) {
      expect(boundary[i]?.height, `boundary ${i}`).toBe((boundary[i - 1]?.height as number) + 1);
      expect(boundary[i]?.parent, `boundary ${i}`).toBe(boundary[i - 1]?.hash);
    }
    expect(later.height as number).toBeGreaterThan(boundary.at(-1)?.height as number);
    expect(at(RECORDS[UP], "upgrade_block.height")).toBe(boundary[1]?.height);
  });

  it("gives each block's LastRuntimeUpgrade as hex that decodes to the spec it states, with our decoder and the reference, by the old metadata's type of that record", () => {
    const reference = BUILDER.buildStorage("System", "LastRuntimeUpgrade").value;
    for (const [i, b] of [...boundary, later].entries()) {
      const lru = b.last_runtime_upgrade as { hex: string; spec_version: number; spec_name: string };
      expect(decodeValue(MD, lruType, fromHex(lru.hex)), `block ${i}`).toEqual({ spec_version: lru.spec_version, spec_name: lru.spec_name });
      expect(reference.dec(lru.hex), `block ${i}`).toEqual({ spec_version: lru.spec_version, spec_name: lru.spec_name });
    }
  });

  it("shows the rule: LastRuntimeUpgrade changes at the first block the new runtime executed, one block after the version read there changes", () => {
    const spec = (b: Record<string, unknown> | undefined) => (b?.last_runtime_upgrade as { spec_version: number }).spec_version;
    const version = (b: Record<string, unknown> | undefined) => b?.state_getRuntimeVersion_spec as number;
    expect(boundary.map(spec)).toEqual([spec(boundary[0]), spec(boundary[0]), spec(later), spec(later)]);
    expect(spec(boundary[0])).not.toBe(spec(later));
    expect(boundary.map(version)).toEqual([spec(boundary[0]), spec(later), spec(later), spec(later)]);
    expect([version(later), spec(later)]).toEqual([spec(later), spec(later)]);
    // Each block's version is the next block's LastRuntimeUpgrade.
    for (let i = 0; i + 1 < boundary.length; i++) expect(version(boundary[i]), `boundary ${i}`).toBe(spec(boundary[i + 1]));
  });

  it("agrees with itself on the upgrade block: its events and sums, its extrinsic, the code hash, and the 64 events counted", () => {
    const upgrade = at(RECORDS[UP], "upgrade_block") as Record<string, unknown>;
    const carries = boundary[1] as Record<string, unknown>;
    expect([at(RECORDS[UP], "sum_check.events_3528528_bytes"), at(RECORDS[UP], "sum_check.events_3528528_sha256")]).toEqual([at(carries, "events.bytes"), at(carries, "events.sha256")]);
    expect(upgrade.extrinsic).toEqual((carries.extrinsics as unknown[])[upgrade.extrinsic_index as number]);
    const codeUpdated = (upgrade.events_of_extrinsic_2 as { event: string; fields: { hash?: string } }[]).find((e) => e.event === "System.CodeUpdated");
    for (const b of [carries, boundary[2], boundary[3], later]) expect(at(b, "code.storage_hash")).toBe(codeUpdated?.fields.hash);
    expect(at(boundary[0], "code.storage_hash")).not.toBe(codeUpdated?.fields.hash);
    expect(Object.values(upgrade.event_counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(64);
    expect(at(upgrade, "events_decoded_with.metadata_sha256")).toBe(REVIEWED[0]?.metadataSha256);
    expect(at(upgrade, "events_decoded_with.shape_sha256")).toBe(REVIEWED[0]?.shapeSha256);
    expect(at(upgrade, "events_decoded_with.last_runtime_upgrade_given")).toBe(at(carries, "last_runtime_upgrade.hex"));
  });
});
