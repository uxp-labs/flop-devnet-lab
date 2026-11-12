// The fourth request list, recordings/requests.json: the lab's session rerun at spec 1014020
// (research/2026-11-12-session-rerun-1014020), block by block. It is derived
// (test/helpers/requests/list-4.ts) from recordings/requests-inputs.json and the recorded 1014020
// metadata, and nothing in it is typed by hand. These tests hold the list to that function byte for
// byte, read its design a second way from the rerun's steps.json and results.json, derive every
// storage key a second way with the reference decoder, hold every input to the record it names, and
// hold the core's batch kind to its two refusals. Nothing here reads the network.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { READ_ONLY_RPC_METHODS, guardRpc } from "../src/guard.js";
import { MAX_CALLS, readRequests } from "../src/requests.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { REVIEWED } from "../src/scale/shape.js";
import { REQUESTS_TEXT as LIST_1_TEXT } from "./helpers/recorded.js";
import { STORAGE_REQUESTS_TEXT as LIST_2_TEXT } from "./helpers/recorded-storage.js";
import { UPGRADE_INPUTS_TEXT as LIST_3_INPUTS_TEXT, UPGRADE_REQUESTS_TEXT as LIST_3_TEXT } from "./helpers/recorded-upgrade.js";
import { type Source, batchKeys, deriveCalls as coreDerive } from "./helpers/requests/core.js";
import { readInputs as readList3Inputs } from "./helpers/requests/list-3.js";
import { type Block, type Inputs, type Read, STEPS, type StepId, blockOf, deriveCalls, deriveRequestsText, readInputs } from "./helpers/requests/list-4.js";
import { RERUN_RESULTS, RERUN_SPEC_FIELD, requestsListText, rerunMetadata } from "./helpers/requests-list.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
const LIST_TEXT = repoText("observatory/recordings/requests.json");
const INPUTS_TEXT = repoText("observatory/recordings/requests-inputs.json");
const INPUTS = readInputs(INPUTS_TEXT);
const META = rerunMetadata();
const MD = parseMetadata(META);
const DERIVED = deriveCalls(INPUTS, MD);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(META))));
const RESULTS_FILE = RERUN_RESULTS;
const STEPS_FILE = "research/2026-11-12-session-rerun-1014020/steps.json";
const DENY_FILE = "research/2026-11-11-session-deny-list/results.json";
const ESCROW_FILE = "research/2026-11-11-session-escrow/results.json";
const UP_FILE = "research/2026-11-12-runtime-upgrade/results.json";
const record = (file: string) => JSON.parse(repoText(file)) as Record<string, unknown>;
const RECORDS: Record<string, Record<string, unknown>> = { [RESULTS_FILE]: record(RESULTS_FILE), [DENY_FILE]: record(DENY_FILE) };
const STEPS_JSON = record(STEPS_FILE) as { values: Record<string, { value: string; from: { file: string; path: string } }>; files: Record<string, string>; steps: { id: string; signer: string; call: string[]; expect: string; reads_after?: Record<string, string> }[] };
const RESULTS = RECORDS[RESULTS_FILE] as { spec_version: number; accounts: Record<string, { public_key: string; ss58: string }>; steps: { step: string; finalized_in_block: number; block_hash: string; reads_after: Record<string, unknown> }[] };
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
    ...Object.entries(inputs.blocks).flatMap(([n, b]) => [[`blocks.${n}.height`, b.height] as [string, Source<unknown>], [`blocks.${n}.hash`, b.hash] as [string, Source<unknown>]]),
  ];
}

const label = (r: Read) => `${r.entry}(${r.keys.map((k) => ("account" in k ? k.account : "")).join(",")})`;
const batches = DERIVED.filter((d) => d.call.method === "state_queryStorageAt");
/** The keys of the System entries, as the lab's reads of the upgrade asked them (a name with a dot, so read whole). */
const UP_KEYS = at(record(UP_FILE), "keys") as Record<string, string>;

describe("the fourth request list, recordings/requests.json", () => {
  const read = readRequests(new TextEncoder().encode(LIST_TEXT));
  const calls = typeof read === "string" ? [] : read.calls;

  it("is in the written form, holds 48 calls (at most MAX_CALLS), every method one the guard allows, and these many of each", () => {
    expect(read).not.toBeTypeOf("string");
    expect(calls.length).toBe(48);
    expect(MAX_CALLS).toBe(64);
    expect(calls.length).toBeLessThanOrEqual(MAX_CALLS);
    for (const c of calls) expect(READ_ONLY_RPC_METHODS.has(c.method), c.method).toBe(true);
    const by: Record<string, number> = {};
    for (const c of calls) by[c.method] = (by[c.method] ?? 0) + 1;
    expect(by).toEqual({ chain_getFinalizedHead: 1, chain_getBlockHash: 24, state_queryStorageAt: 23 });
  });

  it("passes the read only guard on every call, as the derived list does", () => {
    for (const c of [...calls, ...DERIVED.map((d) => d.call)]) expect(() => guardRpc(c.method), c.method).not.toThrow();
  });

  it("asks one method no earlier list asked, state_queryStorageAt, and every other method one of them asked", () => {
    const earlier = new Set([LIST_1_TEXT, LIST_2_TEXT, LIST_3_TEXT].flatMap((t) => (JSON.parse(t) as { calls: { method: string }[] }).calls.map((c) => c.method)));
    expect([...new Set(DERIVED.map((d) => d.call.method).filter((m) => !earlier.has(m)))]).toEqual(["state_queryStorageAt"]);
  });

  it("is, byte for byte, the list derived from recordings/requests-inputs.json and the recorded 1014020 metadata", () => {
    expect(LIST_TEXT).toBe(deriveRequestsText(INPUTS, MD));
    expect(calls).toEqual(DERIVED.map((d) => d.call));
  });

  it("is what the committed writer writes: scripts/write-requests.mjs writes requestsListText, the same derive function, and nothing of its own", () => {
    expect(requestsListText()).toBe(LIST_TEXT);
    const script = repoText("observatory/scripts/write-requests.mjs");
    expect(script).toContain('const { requestsListText } = await import("../test/helpers/requests-list.ts");');
    expect(script).toContain("writeFileSync(args[1], requestsListText());");
    for (const name of ["deriveCalls", "deriveRequestsText", "storageKey", "feedText", "PLAN", "plan("]) expect(script, name).not.toContain(name);
    expect(repoText("observatory/test/helpers/requests-list.ts")).toContain('from "./requests/list-4.js";');
  });

  it("builds its keys from the reviewed metadata of the spec results.json names, found on the third recording's tape by its sha256", () => {
    const line = REVIEWED.find((r) => r.specVersion === RESULTS.spec_version);
    expect(RERUN_SPEC_FIELD).toBe("spec_version");
    expect(RESULTS.spec_version).toBe(1014020);
    expect([META.length, sha256(META)]).toEqual([line?.metadataBytes, line?.metadataSha256]);
  });

  it("asks the heads, then for each step of results.json in its order the hash at its height and one batch at its hash", () => {
    // Read a second way: the heights and hashes from results.json's own steps.
    expect(DERIVED.map((d) => [d.call.method, d.call.method === "state_queryStorageAt" ? (d.call.params as unknown[])[1] : d.call.params])).toEqual([
      ["chain_getFinalizedHead", []],
      ["chain_getBlockHash", [0]],
      ...RESULTS.steps.flatMap((s) => [
        ["chain_getBlockHash", [s.finalized_in_block]],
        ["state_queryStorageAt", s.block_hash],
      ]),
    ]);
    expect(RESULTS.steps.map((s) => s.step)).toEqual(STEPS.map((s) => s.id));
    expect(STEPS_JSON.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(DERIVED.slice(2).map((d) => d.block)).toEqual(STEPS.flatMap((s) => [blockOf(s.id), blockOf(s.id)]));
  });

  it("asks every batch as exactly state_queryStorageAt [[key, ...], block hash], System.Events and System.LastRuntimeUpgrade first, by the keys the lab's reads of the upgrade asked", () => {
    expect(batches).toHaveLength(23);
    for (const d of batches) {
      expect(d.call.params, d.call.why).toHaveLength(2);
      const [keys, hash] = d.call.params as [string[], string];
      expect(Array.isArray(keys)).toBe(true);
      expect(hash).toBe(INPUTS.blocks[d.block as Block].hash.value);
      expect(keys.slice(0, 2)).toEqual([UP_KEYS["System.Events"], UP_KEYS["System.LastRuntimeUpgrade"]]);
      expect(keys).toHaveLength(d.reads?.length ?? -1);
      expect(new Set(keys).size, d.call.why).toBe(keys.length);
    }
  });

  it("reads after each step, in a fixed order, exactly the entries the fields of its reads_after in steps.json come from, for the device of its session", () => {
    // Read a second way: the fields from steps.json, the device from who signs or whom the call names.
    const entryOf: Record<string, string> = {
      session_active: "Sessions",
      spent_raw: "Sessions",
      epoch_spent_raw: "Sessions",
      session_nonce: "SessionNonces",
      breaker_tx_count: "CircuitBreakers",
      failed_acks_of_named: "FailedAcks",
      delegate_sessions_of_device: "DelegateSessions",
    };
    const order = ["Sessions", "SessionNonces", "CircuitBreakers", "FailedAcks", "DelegateSessions"];
    const keysOf: Record<string, (d: string) => string> = {
      Sessions: (d) => `Sessions(owner,${d})`,
      SessionNonces: (d) => `SessionNonces(owner,${d})`,
      CircuitBreakers: (d) => `CircuitBreakers(${d})`,
      FailedAcks: () => "FailedAcks(named)",
      DelegateSessions: (d) => `DelegateSessions(${d})`,
    };
    let reads = 0;
    for (const [i, s] of STEPS_JSON.steps.entries()) {
      const fields = Object.keys(s.reads_after ?? {});
      expect(fields.sort(), s.id).toEqual(Object.keys(RESULTS.steps[i]?.reads_after ?? {}).sort());
      expect([...(STEPS[i]?.fields ?? [])].sort(), s.id).toEqual(fields.sort());
      const delegate = s.call[s.call.indexOf("--delegate") + 1];
      const device = s.signer !== "owner" ? s.signer : delegate === "$DEV1" ? "dev1" : delegate === "$DEV2" ? "dev2" : "none";
      const want = order.filter((e) => fields.some((f) => entryOf[f] === e)).map((e) => keysOf[e]?.(device));
      const got = batches[i]?.reads?.map(label) ?? [];
      expect(got, s.id).toEqual(["Events()", "LastRuntimeUpgrade()", ...want]);
      reads += want.length;
    }
    expect(reads).toBe(26);
    expect(batches.reduce((n, d) => n + (d.reads?.length ?? 0), 0)).toBe(72);
  });

  it("builds every key a second way with the reference decoder over the 1014020 metadata, from the ss58 addresses the records give", () => {
    const ss58: Record<string, string> = {
      owner: RESULTS.accounts.owner?.ss58 as string,
      dev1: RESULTS.accounts.dev1?.ss58 as string,
      dev2: RESULTS.accounts.dev2?.ss58 as string,
      named: at(RECORDS[DENY_FILE], "other_account_named.ss58") as string,
    };
    const account = BUILDER.buildDefinition(0);
    for (const [name, address] of Object.entries(ss58)) expect(`0x${Buffer.from(account.enc(address)).toString("hex")}`, name).toBe(INPUTS.accounts[name as keyof Inputs["accounts"]].value);
    let n = 0;
    for (const d of batches) {
      const keys = (d.call.params as [string[], string])[0];
      for (const [j, r] of (d.reads ?? []).entries()) {
        const args = r.keys.map((k) => ("account" in k ? ss58[k.account] : ""));
        expect(keys[j], `${d.block} ${label(r)}`).toBe(BUILDER.buildStorage(r.pallet, r.entry).keys.enc(...args));
        n++;
      }
    }
    expect(n).toBe(72);
  });

  it("says why for each call in one plain line, naming the height of its block, the hash it compares with, the step and what steps.json expects of it", () => {
    for (const d of DERIVED) {
      expect(d.call.why, d.call.why).toMatch(/^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/);
      expect(d.call.why, d.call.why).not.toMatch(/[‒-―]| - /);
      if (d.block === null) continue;
      const b = INPUTS.blocks[d.block];
      const id = d.block.split("/")[1] as StepId;
      expect(d.call.why, d.call.why).toContain(`${d.call.method === "chain_getBlockHash" ? "height" : "block"} ${b.height.value}`);
      expect(d.call.why, d.call.why).toContain(`step ${id}`);
      if (d.call.method === "chain_getBlockHash") expect(d.call.why).toContain(b.hash.value);
    }
    for (const [i, s] of STEPS_JSON.steps.entries()) {
      expect(STEPS[i]?.expect, s.id).toBe(s.expect);
      const why = batches[i]?.call.why ?? "";
      expect(why, s.id).toContain(s.expect === "success" ? "steps.json expects success" : `steps.json expects it refused with ${s.expect}`);
      expect(why, s.id).toContain("a key that holds nothing listed with null");
    }
  });
});

describe("the batch kind of the request core", () => {
  const step = (reads: Read[]) => [{ kind: "batch" as const, block: blockOf("A1"), reads, why: "a batch" }];
  const events: Read = { pallet: "System", entry: "Events", keys: [] };
  const nonce = (d: "dev1" | "dev2"): Read => ({ pallet: "FlopSessionKeys", entry: "SessionNonces", keys: [{ account: "owner" }, { account: d }] });

  it("asks exactly state_queryStorageAt with the keys in the order given and the block's hash, and keeps the reads in that order", () => {
    const [d] = coreDerive(step([nonce("dev2"), events, nonce("dev1")]), INPUTS, MD);
    const keys = batchKeys(INPUTS, [nonce("dev2"), events, nonce("dev1")], MD);
    expect(d?.call).toEqual({ method: "state_queryStorageAt", params: [keys, INPUTS.blocks[blockOf("A1")].hash.value], why: "a batch" });
    expect(d?.reads?.map(label)).toEqual(["SessionNonces(owner,dev2)", "Events()", "SessionNonces(owner,dev1)"]);
    expect([d?.read, d?.block]).toEqual([null, blockOf("A1")]);
  });

  it("refuses a batch that reads nothing", () => {
    expect(() => coreDerive(step([]), INPUTS, MD)).toThrow("a batch must read at least one storage entry");
  });

  it("refuses a batch that asks the same key twice, the same read or another read of the same key", () => {
    expect(() => coreDerive(step([events, nonce("dev1"), nonce("dev1")]), INPUTS, MD)).toThrow("a batch asks the same storage key twice");
    expect(() => coreDerive(step([events, { pallet: "System", entry: "Events", keys: [] }]), INPUTS, MD)).toThrow("a batch asks the same storage key twice");
  });
});

describe("the inputs of the fourth list, recordings/requests-inputs.json", () => {
  it("is in the written form, and refuses a file that is not or that lacks a name the plan uses; the third list's inputs are not the fourth's", () => {
    expect(() => readInputs(INPUTS_TEXT)).not.toThrow();
    expect(() => readInputs(JSON.stringify(JSON.parse(INPUTS_TEXT)))).toThrow("the inputs file is not in the written form");
    const v = JSON.parse(INPUTS_TEXT) as { accounts: Record<string, unknown> };
    delete v.accounts.named;
    expect(() => readInputs(feedText(v))).toThrow("accounts must hold exactly owner, dev1, dev2, named");
    expect(() => readList3Inputs(INPUTS_TEXT)).toThrow();
    expect(() => readInputs(LIST_3_INPUTS_TEXT)).toThrow();
  });

  it("names only the session rerun's results.json and the deny list test's record", () => {
    expect([...new Set(sources(INPUTS).map(([, s]) => s.file))].sort()).toEqual([RESULTS_FILE, DENY_FILE].sort());
  });

  it("holds every input to the value at its field in the record it names", () => {
    let n = 0;
    for (const [where, s] of sources(INPUTS)) {
      expect(at(RECORDS[s.file], s.field), `${where}: ${s.file} ${s.field}`).toEqual(s.value);
      n++;
    }
    expect(n).toBe(50);
  });

  it("takes the owner and both devices from results.json's accounts, and the named account where steps.json says NAMED comes from", () => {
    for (const a of ["owner", "dev1", "dev2"] as const) expect([INPUTS.accounts[a].file, INPUTS.accounts[a].field]).toEqual([RESULTS_FILE, `accounts.${a}.public_key`]);
    const named = STEPS_JSON.values.NAMED;
    expect([STEPS_JSON.files[named?.from.file ?? ""], named?.from.path]).toEqual([DENY_FILE, "other_account_named.public_key"]);
    expect([INPUTS.accounts.named.file, INPUTS.accounts.named.field, INPUTS.accounts.named.value]).toEqual([DENY_FILE, "other_account_named.public_key", named?.value]);
    expect(at(record(ESCROW_FILE), "named_miner.public_key")).toBe(INPUTS.accounts.named.value);
    expect(STEPS_JSON.values.OWNER?.value).toBe(INPUTS.accounts.owner.value);
  });

  it("names each block by its step in results.json, height and hash from that one step", () => {
    expect(STEPS.map((s) => [INPUTS.blocks[blockOf(s.id)].height.file, INPUTS.blocks[blockOf(s.id)].height.field, INPUTS.blocks[blockOf(s.id)].hash.file, INPUTS.blocks[blockOf(s.id)].hash.field])).toEqual(
      RESULTS.steps.map((_, i) => [RESULTS_FILE, `steps.${i}.finalized_in_block`, RESULTS_FILE, `steps.${i}.block_hash`]),
    );
  });

  it("reads blocks that rise step by step, each above the first block the 1014020 runtime executed", () => {
    const heights = STEPS.map((s) => INPUTS.blocks[blockOf(s.id)].height.value);
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
