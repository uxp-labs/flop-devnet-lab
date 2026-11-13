// The reviewed shape of spec 1014020 (shapes/tzkv-runtime-1014020.json, the second line of REVIEWED
// in src/scale/shape.ts): derived by deriveShape from the metadata the third recording holds at
// block 3528528, the block that carries the upgrade, whose metadata answers for the next block, and
// derived a second way from the reference decoder's own parse of the same bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMetadata } from "../src/scale/metadata.js";
import { REVIEWED, STATED_ENTRIES, deriveShape, pinShape, shapeText } from "../src/scale/shape.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { referenceShape } from "./helpers/reference-shape.js";
import { UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";
import { HANDLED, SHAPE_SCHEMA as DIFF_SCHEMA, main, readShape, shapeDiff, shapeDiffText, structure } from "../scripts/shape-diff.mjs";
import { SHAPE_SCHEMA } from "../src/scale/shape.js";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const U = recordedUpgrade();
const RESULTS = JSON.parse(readFileSync(new URL("../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));
const [BEFORE, CARRIES, FIRST, LATER] = UPGRADE_BLOCKS;
const NEW = REVIEWED.at(1);
const OLD = REVIEWED.at(0);
// The metadata is found on the tape by the sha256 its REVIEWED line names, never by the block it was read at.
const META = U.metadataBySha(String(NEW?.metadataSha256));
const SHAPE = readFileSync(new URL(`../${NEW?.shapeFile}`, import.meta.url), "utf8");
const OLD_SHAPE = readFileSync(new URL(`../${OLD?.shapeFile}`, import.meta.url), "utf8");

describe("the reviewed shape of spec 1014020", () => {
  it("is the second line of REVIEWED: the spec the new runtime names, the metadata recorded at 3528528 and in the lab's reads by length and sha256, and the committed file by sha256", () => {
    expect(REVIEWED).toHaveLength(2);
    expect(NEW).toEqual({
      specName: U.versionOf(FIRST).specName,
      specVersion: U.versionOf(FIRST).specVersion,
      metadataSha256: RESULTS.boundary[1].metadata.sha256,
      metadataBytes: RESULTS.boundary[1].metadata.bytes,
      shapeFile: "shapes/tzkv-runtime-1014020.json",
      shapeSha256: sha256(SHAPE),
    });
    expect([META.length, sha256(META)]).toEqual([NEW?.metadataBytes, NEW?.metadataSha256]);
    // The one assert that names the block: the metadata found by sha256 is the one recorded at 3528528.
    expect(META).toEqual(U.metadataAt(CARRIES));
    expect(NEW?.specVersion).toBe(RESULTS.boundary[2].last_runtime_upgrade.spec_version);
  });

  it("is, byte for byte, the shape deriveShape gives the recorded metadata, which the strict parser reads whole", () => {
    expect(shapeText(deriveShape(parseMetadata(META)))).toBe(SHAPE);
  });

  it("is the shape derived again from the reference decoder's own parse with an independent namer", () => {
    const mine = referenceShape(META);
    expect(Object.keys(mine.types).length).toBe(482);
    expect([mine.spec_name, mine.spec_version]).toEqual([NEW?.specName, NEW?.specVersion]);
    expect(mine).toEqual(JSON.parse(SHAPE));
  });

  it("states the same pallets and the same 16 entries as spec 1014014's shape", () => {
    const s = JSON.parse(SHAPE);
    const o = JSON.parse(OLD_SHAPE);
    expect(Object.keys(s)).toEqual(Object.keys(o));
    for (const k of ["system", "compute_channel", "flop_session_keys", "model_registry", "miner_staking", "hw_calibration"]) expect(Object.keys(s[k]), k).toEqual(Object.keys(o[k]));
    expect(STATED_ENTRIES).toHaveLength(16);
    const md = parseMetadata(META);
    for (const [p, e] of STATED_ENTRIES) expect(md.pallets.find((x) => x.name === p)?.storage?.entries.some((x) => x.name === e), `${p}.${e}`).toBe(true);
  });

  it("pins a block of the new runtime with its metadata, and refuses the new metadata under the old spec's line", () => {
    const base = { specName: String(NEW?.specName), specVersion: Number(NEW?.specVersion), metadata: META, lastRuntimeUpgrade: U.upgradeOf(LATER), shapeText: SHAPE };
    const p = pinShape(base);
    expect(p.pinned ? p.reviewed : p.refused).toEqual(NEW);
    const q = pinShape({ ...base, specVersion: Number(OLD?.specVersion), shapeText: OLD_SHAPE });
    expect(q.pinned ? "pinned" : q.refused).toBe(`the metadata for spec ${OLD?.specVersion} is ${META.length} bytes with sha256 ${sha256(META)}, not the reviewed ${OLD?.metadataBytes} bytes with sha256 ${OLD?.metadataSha256}`);
    const r = pinShape({ ...base, lastRuntimeUpgrade: U.upgradeOf(BEFORE) });
    expect(r.pinned ? "pinned" : r.refused).toBe(`the block's LastRuntimeUpgrade names spec ${OLD?.specName} ${OLD?.specVersion}, not ${NEW?.specName} ${NEW?.specVersion}`);
  });
});


/** A copy of a shape whose every type id is moved by an offset: the same types, renumbered. */
const renumbered = (text: string, by: number) => JSON.parse(text.replace(/#(\d+)/g, (_m, n) => `#${Number(n) + by}`));
/** The lines after the first, which names the specs. */
const body = (lines: string[]) => lines.slice(1);
const NONE = ["ComputeChannel: no difference in what the shapes state", "FlopSessionKeys: no difference in what the shapes state", "HwCalibration: no difference in what the shapes state", "MinerStaking: no difference in what the shapes state", "ModelRegistry: no difference in what the shapes state", "System: no difference in what the shapes state"];
// biome-ignore lint: hand made shapes are plain JSON
type Shape = any;

describe("the shape diff, scripts/shape-diff.mjs", () => {
  const DIFF = readFileSync(new URL("../shapes/diff-tzkv-runtime-1014014-1014020.txt", import.meta.url), "utf8");

  it("gives, run again, the committed diff of 1014014 against 1014020 byte for byte: the two specs first, then plain lines, sorted, no dashes", () => {
    expect(shapeDiffText(OLD_SHAPE, SHAPE)).toBe(DIFF);
    const lines = DIFF.split("\n").slice(0, -1);
    expect(lines[0]).toBe(`specs: ${OLD?.specName} ${OLD?.specVersion} to ${NEW?.specName} ${NEW?.specVersion}`);
    expect(body(lines)).toEqual([...body(lines)].sort());
    for (const l of lines) expect(l, l).toMatch(/^[^\u0000-\u001f\u007f]+$/);
    for (const l of lines) expect(l, l).not.toMatch(/[‐-―]| - /);
    expect(lines).toContain("FlopSessionKeys: no difference in what the shapes state");
  });

  it("says a shape has no difference from itself, and from itself with every type id renumbered: ids alone are no difference", () => {
    expect(body(shapeDiff(JSON.parse(SHAPE), JSON.parse(SHAPE)))).toEqual(NONE);
    expect(body(shapeDiff(JSON.parse(SHAPE), renumbered(SHAPE, 1000)))).toEqual(NONE);
    expect(shapeDiff(JSON.parse(OLD_SHAPE), renumbered(SHAPE, 7))).toEqual(shapeDiff(JSON.parse(OLD_SHAPE), JSON.parse(SHAPE)));
  });

  it("reports a difference when one field's type is changed in a copy, where the field is", () => {
    const copy = JSON.parse(SHAPE);
    const spent = copy.types[copy.flop_session_keys.sessions.value].fields.find((f: { name: string }) => f.name === "spent");
    expect(spent.type).toBe("u128");
    spent.type = "u64";
    expect(body(shapeDiff(JSON.parse(SHAPE), copy))).toEqual([
      "ComputeChannel: no difference in what the shapes state",
      "FlopSessionKeys.Sessions value.spent: type was u128, now u64",
      "HwCalibration: no difference in what the shapes state", "MinerStaking: no difference in what the shapes state", "ModelRegistry: no difference in what the shapes state",
      "System: no difference in what the shapes state",
    ]);
  });

  it("reports a changed pallet index, storage prefix, hasher and default bytes, each on its own line", () => {
    const copy = JSON.parse(SHAPE);
    copy.flop_session_keys.index += 1;
    copy.compute_channel.storage_prefix = "ComputeChannels";
    copy.flop_session_keys.circuit_breakers.hashers = ["Twox64Concat"];
    copy.flop_session_keys.session_nonces.default = "0x0100000000000000";
    const s = JSON.parse(SHAPE);
    expect(body(shapeDiff(s, copy))).toEqual([
      `ComputeChannel storage prefix: was "${s.compute_channel.storage_prefix}", now "ComputeChannels"`,
      `FlopSessionKeys index: was ${s.flop_session_keys.index}, now ${s.flop_session_keys.index + 1}`,
      `FlopSessionKeys.CircuitBreakers hashers: was ${JSON.stringify(s.flop_session_keys.circuit_breakers.hashers)}, now ["Twox64Concat"]`,
      `FlopSessionKeys.SessionNonces default bytes: was "${s.flop_session_keys.session_nonces.default}", now "0x0100000000000000"`,
      "HwCalibration: no difference in what the shapes state", "MinerStaking: no difference in what the shapes state", "ModelRegistry: no difference in what the shapes state",
      "System: no difference in what the shapes state",
    ]);
  });

  // The reviewer's hand made pairs (review round 23, R5): each change that alters decoding prints a line where it is.
  const changed = (f: (c: Shape) => void) => {
    const c = JSON.parse(SHAPE);
    f(c);
    return body(shapeDiff(JSON.parse(SHAPE), c)).filter((l: string) => !l.endsWith(": no difference in what the shapes state"));
  };
  const ty = (c: Shape, n: string) => c.types[n];
  const s0 = JSON.parse(SHAPE);
  const CHANNEL = s0.compute_channel.channels.value as string;
  const SLA = ty(s0, CHANNEL).fields.find((f: { name: string }) => f.name === "sla").type as string;
  const STATE = ty(s0, CHANNEL).fields.find((f: { name: string }) => f.name === "state").type as string;
  const CASES: [string, (c: Shape) => void, RegExp][] = [
    ["a field renamed", (c) => { ty(c, c.flop_session_keys.sessions.value).fields.find((f: { name: string }) => f.name === "spent").name = "spend"; }, /^FlopSessionKeys\.Sessions value: fields were/],
    ["two same typed fields swapped", (c) => { const f = ty(c, CHANNEL).fields; [f[0], f[1]] = [f[1], f[0]]; }, /^ComputeChannel\.Channels value: fields were \(agent: AccountId32, miner/],
    ["a type changed deep inside", (c) => { ty(c, SLA).fields[0].type = "u64"; }, /^ComputeChannel\.Channels value\.sla\.max_turns: type was u32, now u64$/],
    ["a variant index moved", (c) => { ty(c, STATE).variants[3].index = 4; }, /moved from index 3 to index 4$/],
    ["a variant removed", (c) => { ty(c, STATE).variants.pop(); }, /value\.state: variant PendingAck removed/],
    ["an event removed", (c) => { c.compute_channel.events.pop(); }, /^ComputeChannel events: event \w+ removed/],
    ["a hasher changed", (c) => { c.compute_channel.channels.hashers = ["Twox64Concat"]; }, /^ComputeChannel\.Channels hashers:/],
    ["a modifier changed", (c) => { c.compute_channel.channels.modifier = "Default"; }, /^ComputeChannel\.Channels modifier:/],
    ["default bytes changed", (c) => { c.flop_session_keys.sessions.default = "0x01"; }, /^FlopSessionKeys\.Sessions default bytes:/],
    ["a storage prefix changed", (c) => { c.system.storage_prefix = "Sys"; }, /^System storage prefix:/],
    ["a pallet index changed", (c) => { c.compute_channel.index += 1; }, /^ComputeChannel index:/],
    ["a key type changed to another 32 byte type", (c) => { c.compute_channel.channels.key = "AccountId32#0"; }, /^ComputeChannel\.Channels key: type was H256, now AccountId32$/],
    ["the System.Version type changed", (c) => { ty(c, c.system.version).fields[1].type = "u64"; }, /^System\.Version\.impl_name:/],
    ["a type reachable only from LastRuntimeUpgrade", (c) => { ty(c, c.system.last_runtime_upgrade.value).fields[0].type = "u32"; }, /^System\.LastRuntimeUpgrade value\.spec_version: type was Compact<u32>, now u32$/],
    // Each pair of types is followed once, so the line is where [u8; 32] is first met: a hash in System.Events.
    ["an array length changed", (c) => { ty(c, "[u8; 32]").len = 33; }, /^System\.Events value each\.event variant System variant CodeUpdated\.hash: length was 32, now 33$/],
    ["a compact's inner type changed", (c) => { c.types["Compact<u64>"] = { kind: "compact", path: [], type: "u64" }; ty(c, c.system.last_runtime_upgrade.value).fields[0].type = "Compact<u64>"; }, /^System\.LastRuntimeUpgrade value\.spec_version inner: type was u32, now u64$/],
    ["a tuple key lost a part", (c) => { ty(c, c.flop_session_keys.sessions.key).types.pop(); }, /^FlopSessionKeys\.Sessions key: type was \(AccountId32, AccountId32\), now \(AccountId32, AccountId32\)$/],
    ["a tuple key part changed", (c) => { ty(c, c.flop_session_keys.sessions.key).types[1] = "H256#13"; }, /^FlopSessionKeys\.Sessions key\.1:/],
    // Round 29: the entries and pallets of decoder-shape@3.
    ["a new entry's hasher changed", (c) => { c.miner_staking.miners.hashers = ["Twox64Concat"]; }, /^MinerStaking\.Miners hashers:/],
    ["a new pallet's index changed", (c) => { c.hw_calibration.index += 1; }, /^HwCalibration index:/],
    ["a new entry's value changed deep inside", (c) => { ty(c, c.system.account.value).fields[0].type = "u64"; }, /^System\.Account value\.nonce: type was u32, now u64$/],
    ["a new tuple key part changed", (c) => { ty(c, c.model_registry.measured_roots.key).types[1] = "u8"; }, /^ModelRegistry\.MeasuredRoots key\.1:/],
  ];
  it.each(CASES)("prints a line where the change is: %s", (_what, f, line) => {
    const lines = changed(f);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l: string) => line.test(l)), lines.slice(0, 3).join(" | ")).toBe(true);
  });

  it("compares the stated lists too: a channel's fields, its states, the event record and LastRuntimeUpgrade's fields, each changed in its list alone", () => {
    expect(changed((c) => { c.compute_channel.channels.fields[0].name = "agent_id"; })).toEqual([expect.stringMatching(/^ComputeChannel\.Channels fields: fields were \(agent: AccountId32/)]);
    expect(changed((c) => { c.compute_channel.channel_states.pop(); })).toEqual([expect.stringMatching(/^ComputeChannel channel states: state PendingAck removed/)]);
    expect(changed((c) => { c.system.events.record[0].type = "u32"; })).toEqual([expect.stringMatching(/^System\.Events record\.phase: type was Phase, now u32$/)]);
    expect(changed((c) => { c.system.last_runtime_upgrade.fields[1].name = "name"; })).toEqual([expect.stringMatching(/^System\.LastRuntimeUpgrade fields: fields were/)]);
  });

  /** A shape whose SessionNonces value is a type that refers to itself through an Option, holding a field of type w. */
  const recursive = (w: string) => {
    const c = JSON.parse(SHAPE);
    c.types["Rec#9999"] = { kind: "composite", path: ["x", "Rec"], fields: [{ name: "v", type: w }, { name: "next", type: "Option<Rec#9999>#9998" }] };
    c.types["Option<Rec#9999>#9998"] = { kind: "variant", path: ["Option"], variants: [{ index: 0, name: "None", fields: [] }, { index: 1, name: "Some", fields: [{ name: null, type: "Rec#9999" }] }] };
    c.flop_session_keys.session_nonces.value = "Rec#9999";
    c.flop_session_keys.circuit_breakers.value = "Option<Rec#9999>#9998";
    return c;
  };

  it("ends on a type that refers to itself: no line when it did not change, and when it did, its line once, where it is first met", () => {
    expect(body(shapeDiff(recursive("u32"), recursive("u32")))).toEqual(NONE);
    expect(body(shapeDiff(recursive("u32"), recursive("u64")))).toEqual(["ComputeChannel: no difference in what the shapes state", "FlopSessionKeys.SessionNonces value.v: type was u32, now u64", "HwCalibration: no difference in what the shapes state", "MinerStaking: no difference in what the shapes state", "ModelRegistry: no difference in what the shapes state", "System: no difference in what the shapes state"]);
  });

  it("gives a type the same structure whatever was asked before it, a type that refers to itself included", () => {
    for (const types of [recursive("u32").types, recursive("u64").types, JSON.parse(SHAPE).types]) {
      const names = ["Option<Rec#9999>#9998", "Rec#9999", ...Object.keys(types)].filter((n) => n in types);
      const first = structure(types);
      const walked = names.map((n) => first(n));
      expect(walked, "asked in one order").toEqual(names.map((n) => structure(types)(n)));
      const second = structure(types);
      expect([...names].reverse().map((n) => second(n)), "asked in the other order").toEqual([...walked].reverse());
    }
    expect(structure(recursive("u32").types)("Option<Rec#9999>#9998")).not.toBe(structure(recursive("u64").types)("Option<Rec#9999>#9998"));
  });

  it("reads exactly the parts a shape file holds: every key of each reviewed file is a part the diff handles, and a part it does not handle is refused", () => {
    expect(DIFF_SCHEMA).toBe(SHAPE_SCHEMA);
    for (const text of [OLD_SHAPE, SHAPE]) {
      const s = JSON.parse(text);
      expect(Object.keys(s).sort()).toEqual(HANDLED.top);
      for (const p of ["system", "compute_channel", "flop_session_keys", "model_registry", "miner_staking", "hw_calibration"] as const) expect(Object.keys(s[p]).sort(), p).toEqual(HANDLED[p]);
      // Every stated entry with no list beside it holds exactly the entry's five parts.
      const plain: [string, string][] = [["system", "account"], ["compute_channel", "failed_acks"], ["compute_channel", "channel_authored_opened_at"], ["flop_session_keys", "sessions"], ["flop_session_keys", "session_nonces"], ["flop_session_keys", "circuit_breakers"], ["flop_session_keys", "delegate_sessions"], ["model_registry", "models"], ["model_registry", "measured_roots"], ["model_registry", "allowed_decode_policies"], ["miner_staking", "miners"], ["hw_calibration", "calibration_versions"], ["hw_calibration", "last_initial_calibration"]];
      for (const [p, e] of plain) expect(Object.keys(s[p][e]).sort(), e).toEqual(HANDLED.entry);
      expect(() => readShape(text, "f")).not.toThrow();
    }
    const extra = JSON.parse(SHAPE);
    extra.upgrade_notes = "a part added to the format later";
    expect(() => shapeDiff(JSON.parse(SHAPE), extra)).toThrow("the new shape: the shape holds upgrade_notes, which the diff does not read");
    const extraEntry = JSON.parse(SHAPE);
    extraEntry.flop_session_keys.sessions.since = 1;
    expect(() => shapeDiff(extraEntry, JSON.parse(SHAPE))).toThrow("the old shape: FlopSessionKeys.Sessions holds since, which the diff does not read");
  });

  it("refuses a shape of another format version, and one that lacks a part it reads, with a line of its own and never a TypeError", () => {
    const other = JSON.parse(SHAPE);
    other.schema = "flop-observatory/decoder-shape@4";
    expect(() => shapeDiff(JSON.parse(SHAPE), other)).toThrow(`the new shape: the schema is "flop-observatory/decoder-shape@4", not ${SHAPE_SCHEMA}`);
    const old = JSON.parse(SHAPE);
    delete old.flop_session_keys;
    expect(() => shapeDiff(old, JSON.parse(SHAPE))).toThrow("the old shape: the shape lacks flop_session_keys");
    const noEvents = JSON.parse(SHAPE);
    delete noEvents.compute_channel.events;
    expect(() => shapeDiff(JSON.parse(SHAPE), noEvents)).toThrow("the new shape: ComputeChannel lacks events");
  });

  it("as a command: exit 0 when it compared, a difference or none; exit 2 with one line on stderr for a file it will not read", () => {
    const files: Record<string, string> = { old: OLD_SHAPE, new: SHAPE, bad: "{", v4: SHAPE.replace(SHAPE_SCHEMA, "flop-observatory/decoder-shape@4") };
    const read = (p: string) => {
      const t = files[p];
      if (t === undefined) throw new Error("ENOENT: a stack trace the command must not print");
      return t;
    };
    expect(main(["old", "new"], read)).toEqual({ code: 0, stdout: DIFF, stderr: "" });
    expect(main(["new", "new"], read)).toMatchObject({ code: 0, stderr: "" });
    expect(main(["missing", "new"], read)).toEqual({ code: 2, stdout: "", stderr: "shape-diff refused missing: cannot be read\n" });
    expect(main(["bad", "new"], read)).toEqual({ code: 2, stdout: "", stderr: "shape-diff refused bad: not JSON\n" });
    expect(main(["old", "v4"], read)).toEqual({ code: 2, stdout: "", stderr: `shape-diff refused v4: the schema is "flop-observatory/decoder-shape@4", not ${SHAPE_SCHEMA}\n` });
    expect(main(["old"], read)).toMatchObject({ code: 2, stdout: "" });
  });
});
