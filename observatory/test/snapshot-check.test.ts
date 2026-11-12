// The checks the MCP binary makes before it serves a snapshot (src/snapshot-check.ts, RULES.md
// section 5). Each case edits an honest snapshot and names every check the edit must break, so a
// case passes only when its edit breaks exactly those checks: a check that stopped firing, or one
// that started to fire on something else, fails it. A last test shows every check has a case.
// Firing alone is not being exact, so comparisons have refused cases on both sides and the fields
// the command may write as none, or write at an edge, have served cases (tenth rerun U1, and a
// sweep of weaker and stricter forms in round 15). The forms tried are mutants in
// mutants/snapshot-check.json; the table is no proof that every other form fails.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS, checkSnapshot } from "../src/snapshot-check.js";
import { buildSnapshot } from "../src/snapshot.js";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { hashSnapshot } from "../src/store.js";
import { watchOf } from "./helpers/upgrade.js";

const fx = (name: string) => FixtureSource.fromDir(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
// The snapshot the command line checks serve: the healthy status with the two real escrows (claimed
// and refunded) and one with no event, on the fixture's own time.
const escrows = fx("escrows-verification");
const made = await buildSnapshot(
  { status: fx("status-healthy"), escrows: { source: escrows, ids: escrows.data.meta.escrow_ids ?? [] } },
  { pinnedGenesis: DEVNET_GENESIS, now: "2026-11-09T23:47:53Z", sourceSha: "test" },
);
const first = { ...made, seq: 0, prev_hash: null };
const BASE = { ...first, hash: hashSnapshot(first) };

// Edits work on plain JSON, as the binary reads it, so they may write any value to any field.
type Json = any;
const OTHER = "0x" + "ab".repeat(32);
const hex = (n: number) => "0x" + "a".repeat(n);
// An honest upgrade watch at BASE's finalized head, every field set (test/helpers/upgrade.ts).
const WATCH: Json = JSON.parse(JSON.stringify(watchOf(BASE)));
/** The snapshot given the honest watch, then edited. */
const watched =
  (edit: (u: Json, s: Json) => void = () => {}) =>
  (s: Json) => {
    s.upgrade = structuredClone(WATCH);
    edit(s.upgrade, s);
  };
const NONE = { spec_name: null, spec_version: null };

/** [name, edit, every check the edit breaks]. An empty list is a snapshot the binary must serve. */
const CASES: readonly (readonly [string, (s: Json) => void, readonly string[]])[] = [
  ["honest", () => {}, []],
  // Values the snapshot command writes, which the binary must serve (seventh rerun U1).
  ["a source sha of unknown, as check.sh passes outside a checkout", (s) => (s.pin.source_sha = "unknown"), []],
  ["a short source sha", (s) => (s.pin.source_sha = "979298d"), []],
  ["a gateway http status of -1", (s) => (s.status.gateway.http = -1), []],
  ["a faucet http status of -1", (s) => (s.status.faucet.http = -1), []],
  // Snapshots the settlement rules allow, so a rule made stricter than RULES.md on these fields fails.
  ["reset_detected true with the faucet on another genesis", (s) => ((s.status.genesis.faucet = OTHER), (s.status.reset_detected = true)), []],
  [
    "reset_detected true with the rpc on another genesis and no bound",
    (s) => {
      s.status.genesis.rpc = OTHER;
      s.pin.genesis = OTHER;
      s.status.reset_detected = true;
      for (const e of s.escrows) e.finalized_height = null;
    },
    [],
  ],
  ["a best height below the finalized one, with no lag", (s) => ((s.status.best_height = s.status.finalized_height - 1), (s.status.finality_lag = null)), []],
  ["funded on one open", (s) => ((s.escrows[0].state = "funded"), (s.escrows[0].evidence[0].event = "hasStation.EscrowOpened")), []],
  [
    "claimed on an open and a release in one block",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].evidence = [{ ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }, r];
    },
    [],
  ],
  [
    "refunded on an open and a refund in one block",
    (s) => {
      const r = s.escrows[1].evidence[0];
      s.escrows[1].evidence = [{ ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }, r];
    },
    [],
  ],
  ["evidence at its bound itself", (s) => (s.escrows[0].evidence[0].block_number = s.status.finalized_height), []],
  // Tenth rerun U1: each field the command may write as none, a time with an offset, and a head
  // whose best height is its finalized one, which the command writes with a lag of 0.
  ["a runtime version of none", (s) => (s.status.runtime_version = null), []],
  ["a service time of none", (s) => (s.status.gateway.observed_at = null), []],
  ["an rpc stale of none", (s) => (s.status.rpc.stale = null), []],
  ["a faucet ready of none", (s) => (s.status.faucet.ready = null), []],
  ["faucet limits of none", (s) => (s.status.faucet.limits = null), []],
  ["a pin source sha of none", (s) => (s.pin.source_sha = null), []],
  ["a time with an offset", (s) => (s.observed_at = "2026-11-10T00:47:53+01:00"), []],
  ["a best height equal to the finalized one, with a lag of 0", (s) => ((s.status.best_height = s.status.finalized_height), (s.status.finality_lag = 0)), []],
  // The lead's sweep of stricter forms (round 15): a value at the low edge of its type.
  [
    "a chain at its first block, finalized and best height 0",
    (s) => {
      Object.assign(s.status, { finalized_height: 0, best_height: 0, finality_lag: 0 });
      s.pin.finalized_height = 0;
      for (const e of s.escrows) e.finalized_height = null;
    },
    [],
  ],
  ["a runtime version of 0", (s) => (s.status.runtime_version = 0), []],
  ["evidence in block 0", (s) => (s.escrows[0].evidence[0].block_number = 0), []],
  ["an empty service detail", (s) => (s.status.gateway.detail = ""), []],
  ["empty faucet limits", (s) => (s.status.faucet.limits = {}), []],
  [
    "a trusted snapshot whose parts are all trusted",
    (s) => {
      s.trust = "trusted RPC";
      s.status.trust = "trusted RPC";
      for (const e of s.escrows) e.trust = "trusted RPC";
    },
    [],
  ],

  // Shapes: the snapshot.
  ["an object that is no snapshot", (s) => Object.keys(s).forEach((k) => delete s[k]), ["snapshot.fields"]],
  ["a snapshot with an extra field", (s) => (s.approved = true), ["snapshot.fields"]],
  ["another snapshot schema", (s) => (s.schema = "flop-observatory/snapshot@2"), ["snapshot.schema"]],
  ["the snapshot schema before the watch, @1 fields kept", (s) => (s.schema = "flop-observatory/snapshot@0"), ["snapshot.fields"]],
  ["an @0 snapshot with no upgrade part, as the log's old lines hold", (s) => ((s.schema = "flop-observatory/snapshot@0"), delete s.upgrade), []],
  ["an @0 snapshot of another schema spelling and no upgrade part", (s) => ((s.schema = "flop-observatory/snapshot@0 "), delete s.upgrade), ["snapshot.fields"]],
  ["an @1 snapshot with no upgrade part", (s) => delete s.upgrade, ["snapshot.fields"]],
  ["an upgrade part that is no object", (s) => (s.upgrade = []), ["snapshot.upgrade"]],
  ["an upgrade part that is text", (s) => (s.upgrade = "reviewed"), ["snapshot.upgrade"]],
  // The upgrade watch (RULES.md 7.2): values the live run writes, which the binary must serve.
  ["an upgrade watch at the finalized head, every field set", watched(), []],
  ["an upgrade watch at a head whose height is not known, compared with none", watched((u) => Object.assign(u, { at: { ...u.at, number: null }, compared_with: null, executing_changed: null, authorization_appeared: null })), []],
  ["an upgrade watch at another hash, the status having read no finalized hash", watched((u, s) => ((u.at.hash = OTHER), (s.status.finalized_hash = null), (s.pin.finalized_hash = null))), []],
  ["an upgrade watch at block 0, compared with none", watched((u) => Object.assign(u, { at: { ...u.at, number: 0 }, compared_with: null, executing_changed: null, authorization_appeared: null })), []],
  ["a runtime no reviewed line names", watched((u) => (u.executing = { state: "not reviewed", spec_name: "tzkv-runtime", spec_version: 1014021, detail: "no reviewed line names the runtime this record states" })), []],
  ["a runtime whose name is empty", watched((u) => (u.executing = { state: "not reviewed", spec_name: "", spec_version: 0, detail: "" })), []],
  ["no LastRuntimeUpgrade at the block", watched((u) => Object.assign(u, { executing: { state: "absent", ...NONE, detail: "none" }, executing_changed: null })), []],
  ["an executing runtime not known", watched((u) => Object.assign(u, { executing: { state: "unknown", ...NONE, detail: "failed" }, executing_changed: null })), []],
  ["no authorisation at the block", watched((u) => Object.assign(u, { authorized: { state: "absent", bytes: null, length: null, detail: null }, authorization_appeared: false })), []],
  ["an authorisation of no bytes", watched((u) => Object.assign(u, { authorized: { state: "present", bytes: "0x", length: 0, detail: null } })), []],
  ["an authorisation not known", watched((u) => Object.assign(u, { authorized: { state: "unknown", bytes: null, length: null, detail: "failed" }, authorization_appeared: null })), []],
  ["a change of runtime and an authorisation gone, said as true and false", watched((u) => Object.assign(u, { executing_changed: true, authorized: { state: "absent", bytes: null, length: null, detail: null }, authorization_appeared: false })), []],
  // Its shapes.
  ["an upgrade watch with a field more", watched((u) => (u.approved = true)), ["upgrade.fields"]],
  ["an upgrade watch with a field left out, whose parts are not read", watched((u) => (delete u.compared_with, (u.at = 1))), ["upgrade.fields"]],
  ["an upgrade watch of another schema", watched((u) => (u.schema = "flop-observatory/upgrade-watch@1")), ["upgrade.schema"]],
  ["an upgrade watch at no time", watched((u) => (u.observed_at = "2026-11-12 04:04:20")), ["upgrade.observed_at"]],
  ["an upgrade watch of another trust", watched((u) => (u.trust = "proof")), ["upgrade.trust"]],
  ["an upgrade watch whose block is no object", watched((u) => (u.at = null)), ["upgrade.at"]],
  ["an upgrade watch whose executing runtime is no object", watched((u) => (u.executing = "reviewed")), ["upgrade.executing"]],
  ["an upgrade watch whose authorisation is no object", watched((u) => (u.authorized = [])), ["upgrade.authorized"]],
  ["compared with a height that is no count", watched((u) => (u.compared_with = -1)), ["upgrade.compared_with"]],
  ["a change said as text", watched((u) => (u.executing_changed = "false")), ["upgrade.executing_changed"]],
  ["an authorisation's appearance said as a number", watched((u) => (u.authorization_appeared = 1)), ["upgrade.authorization_appeared"]],
  ["a block with a field more", watched((u) => (u.at.parent = OTHER)), ["upgrade.at.fields"]],
  ["a block hash in upper case", watched((u, s) => ((u.at.hash = u.at.hash.toUpperCase().replace("0X", "0x")), (s.status.finalized_hash = null), (s.pin.finalized_hash = null))), ["upgrade.at.hash"]],
  ["a block height that is a fraction", watched((u) => (u.at.number = 1.5)), ["upgrade.at.number"]],
  ["an executing runtime with a field left out", watched((u) => delete u.executing.detail), ["upgrade.executing.fields"]],
  ["an executing state of another word", watched((u) => (u.executing.state = "Reviewed")), ["upgrade.executing.state"]],
  ["an executing spec name that is a number", watched((u) => (u.executing.spec_name = 1014014)), ["upgrade.executing.spec_name"]],
  ["an executing spec version that is text", watched((u) => (u.executing.spec_version = "1014014")), ["upgrade.executing.spec_version"]],
  ["an executing detail that is a flag", watched((u) => ((u.executing.state = "absent"), Object.assign(u.executing, NONE), (u.executing.detail = false), (u.executing_changed = null))), ["upgrade.executing.detail"]],
  ["an authorisation with a field more", watched((u) => (u.authorized.decoded = {})), ["upgrade.authorized.fields"]],
  ["an authorisation state of another word", watched((u) => (u.authorized.state = "authorized")), ["upgrade.authorized.state"]],
  ["authorised bytes in upper case hex", watched((u) => (u.authorized.bytes = u.authorized.bytes.toUpperCase().replace("0X", "0x"))), ["upgrade.authorized.bytes"]],
  ["authorised bytes of half a byte", watched((u) => ((u.authorized.bytes = "0xabc"), (u.authorized.length = 1))), ["upgrade.authorized.bytes"]],
  ["authorised bytes with no 0x", watched((u) => ((u.authorized.bytes = u.authorized.bytes.slice(2)), (u.authorized.length = u.authorized.length))), ["upgrade.authorized.bytes"]],
  ["an authorisation length that is text", watched((u) => (u.authorized.length = "33")), ["upgrade.authorized.length"]],
  ["an authorisation detail that is a number", watched((u) => ((u.authorized = { state: "unknown", bytes: null, length: null, detail: 0 }), (u.authorization_appeared = null))), ["upgrade.authorized.detail"]],
  // Its agreements.
  ["an upgrade watch at another block than the status's finalized head", watched((u) => (u.at.hash = OTHER)), ["upgrade.at-is-the-status-finalized-head"]],
  ["a reviewed runtime with no name", watched((u) => (u.executing.spec_name = null)), ["upgrade.executing-names-a-spec-only-when-read"]],
  ["a reviewed runtime with no version", watched((u) => (u.executing.spec_version = null)), ["upgrade.executing-names-a-spec-only-when-read"]],
  ["no LastRuntimeUpgrade, yet a runtime named", watched((u) => ((u.executing.state = "absent"), (u.executing.detail = "none"), (u.executing_changed = null))), ["upgrade.executing-names-a-spec-only-when-read"]],
  ["an executing runtime not known, yet a version named", watched((u) => ((u.executing = { state: "unknown", spec_name: null, spec_version: 1014014, detail: "x" }), (u.executing_changed = null))), ["upgrade.executing-names-a-spec-only-when-read"]],
  ["a reviewed runtime that says why", watched((u) => (u.executing.detail = "reviewed")), ["upgrade.executing-says-why-unless-reviewed"]],
  ["a runtime not reviewed that says nothing of why", watched((u) => ((u.executing.state = "not reviewed"), (u.executing.detail = null))), ["upgrade.executing-says-why-unless-reviewed"]],
  ["an authorisation present with no bytes", watched((u) => Object.assign(u.authorized, { bytes: null, length: null })), ["upgrade.authorized-bytes-only-when-present"]],
  ["an authorisation present with bytes and no length", watched((u) => (u.authorized.length = null)), ["upgrade.authorized-bytes-only-when-present", "upgrade.authorized-length-counts-the-bytes"]],
  ["no authorisation, yet bytes kept", watched((u) => ((u.authorized.state = "absent"), (u.authorization_appeared = false))), ["upgrade.authorized-bytes-only-when-present"]],
  ["an authorisation length one more than its bytes", watched((u) => (u.authorized.length += 1)), ["upgrade.authorized-length-counts-the-bytes"]],
  ["an authorisation length one less than its bytes", watched((u) => (u.authorized.length -= 1)), ["upgrade.authorized-length-counts-the-bytes"]],
  ["an authorisation length counting the 0x", watched((u) => (u.authorized.length = u.authorized.bytes.length / 2)), ["upgrade.authorized-length-counts-the-bytes"]],
  ["an authorisation length counting hex digits", watched((u) => (u.authorized.length = u.authorized.bytes.length - 2)), ["upgrade.authorized-length-counts-the-bytes"]],
  ["an authorisation present that says why", watched((u) => (u.authorized.detail = "present")), ["upgrade.authorized-says-why-only-when-unknown"]],
  ["no authorisation, saying why", watched((u) => ((u.authorized = { state: "absent", bytes: null, length: null, detail: "absent" }), (u.authorization_appeared = false))), ["upgrade.authorized-says-why-only-when-unknown"]],
  ["an authorisation not known, saying nothing of why", watched((u) => ((u.authorized = { state: "unknown", bytes: null, length: null, detail: null }), (u.authorization_appeared = null))), ["upgrade.authorized-says-why-only-when-unknown"]],
  ["a runtime change said with nothing compared", watched((u) => Object.assign(u, { compared_with: null, authorization_appeared: null })), ["upgrade.changes-only-when-compared"]],
  ["an authorisation's appearance said with nothing compared", watched((u) => Object.assign(u, { compared_with: null, executing_changed: null })), ["upgrade.changes-only-when-compared"]],
  ["compared with the same block", watched((u) => (u.compared_with = u.at.number)), ["upgrade.compared-with-a-lower-block"]],
  ["compared with a later block", watched((u) => (u.compared_with = u.at.number + 1)), ["upgrade.compared-with-a-lower-block"]],
  ["compared with a block, at a height not known", watched((u) => (u.at.number = null)), ["upgrade.compared-with-a-lower-block"]],
  ["a runtime change said of a runtime not known", watched((u) => (u.executing = { state: "unknown", ...NONE, detail: "x" })), ["upgrade.executing-changed-only-when-named"]],
  ["a runtime change said of no LastRuntimeUpgrade", watched((u) => (u.executing = { state: "absent", ...NONE, detail: "x" })), ["upgrade.executing-changed-only-when-named"]],
  ["an authorisation's appearance said of one not known", watched((u) => ((u.authorized = { state: "unknown", bytes: null, length: null, detail: "x" }), (u.authorization_appeared = false))), ["upgrade.appeared-only-when-known"]],
  ["an authorisation said to appear though none is there", watched((u) => (u.authorized = { state: "absent", bytes: null, length: null, detail: null })), ["upgrade.appeared-only-when-present"]],
  ["a seq of 1 as text", (s) => (s.seq = "1"), ["snapshot.seq"]],
  ["a seq of -1", (s) => (s.seq = -1), ["snapshot.seq"]],
  ["a seq of 1.5", (s) => (s.seq = 1.5), ["snapshot.seq"]],
  ["a prev_hash that is no hash", (s) => (s.prev_hash = "x"), ["snapshot.prev_hash"]],
  ["a hash of 63 hex", (s) => (s.hash = "a".repeat(63)), ["snapshot.hash"]],
  ["a hash in upper case", (s) => (s.hash = "AB".repeat(32)), ["snapshot.hash"]],
  ["a hash with junk before it", (s) => (s.hash = "x" + "ab".repeat(32)), ["snapshot.hash"]],
  ["a schema in upper case", (s) => (s.schema = "FLOP-OBSERVATORY/SNAPSHOT@0"), ["snapshot.schema"]],
  ["an observed_at of yesterday", (s) => (s.observed_at = "yesterday"), ["snapshot.observed_at"]],
  ["an observed_at with no zone", (s) => (s.observed_at = "2026-11-09T23:47:53"), ["snapshot.observed_at"]],
  ["an observed_at on a day that does not exist", (s) => (s.observed_at = "2026-02-30T00:00:00Z"), ["snapshot.observed_at"]],
  ["a snapshot trust of certified", (s) => (s.trust = "certified"), ["snapshot.trust"]],
  ["a pin that is no object", (s) => (s.pin = 5), ["snapshot.pin"]],
  ["a pin of null", (s) => (s.pin = null), ["snapshot.pin"]],
  ["a pin that is a list", (s) => (s.pin = []), ["snapshot.pin"]],
  ["a status that is no object", (s) => (s.status = 5), ["snapshot.status"]],
  ["escrows that are no list", (s) => (s.escrows = {}), ["snapshot.escrows"]],
  ["a snapshot with an extra field, whose pin is not read", (s) => ((s.approved = true), (s.pin.node = 22)), ["snapshot.fields"]],
  ["another census schema", (s) => (s.census = { schema: "flop-observatory/census@1" }), ["snapshot.census"]],
  ["another drift schema", (s) => (s.drift = { schema: "flop-observatory/drift@1" }), ["snapshot.drift"]],
  // The pin.
  ["a pin with an extra field", (s) => (s.pin.approved = true), ["pin.fields"]],
  ["a pin with a field renamed", (s) => ((s.pin.nodes = s.pin.node), delete s.pin.node), ["pin.fields"]],
  ["a pin source_sha that is a number", (s) => (s.pin.source_sha = 5), ["pin.source_sha"]],
  ["a pin source that is a number", (s) => (s.pin.source = 5), ["pin.source"]],
  ["a pin genesis that is no hash", (s) => (s.pin.genesis = "x"), ["pin.genesis"]],
  ["a pin height of -1", (s) => (s.pin.finalized_height = -1), ["pin.finalized_height"]],
  ["a pin hash that is no hash", (s) => (s.pin.finalized_hash = "x"), ["pin.finalized_hash"]],
  ["a pin node that is a number", (s) => (s.pin.node = 22), ["pin.node"]],
  // The status.
  ["a status that is an empty shell", (s) => (s.status = { schema: s.status.schema }), ["status.fields"]],
  ["a status with an extra field", (s) => (s.status.approved = true), ["status.fields"]],
  ["a status with an extra field, whose rpc is not read", (s) => ((s.status.approved = true), (s.status.rpc.health = "great")), ["status.fields"]],
  ["another status schema", (s) => (s.status.schema = "flop-observatory/network-status@1"), ["status.schema"]],
  ["a status observed_at of yesterday", (s) => (s.status.observed_at = "yesterday"), ["status.observed_at"]],
  ["a status trust of approved", (s) => (s.status.trust = "approved"), ["status.trust"]],
  ["a genesis that is no object", (s) => (s.status.genesis = 5), ["status.genesis"]],
  ["a reset_detected of no", (s) => (s.status.reset_detected = "no"), ["status.reset_detected"]],
  ["a reset_detected of 1", (s) => (s.status.reset_detected = 1), ["status.reset_detected"]],
  ["conflicts that are not text", (s) => (s.status.conflicts = [1, null]), ["status.conflicts"]],
  ["conflicts holding text and a number", (s) => (s.status.conflicts = ["a conflict", 1]), ["status.conflicts"]],
  ["a finalized height as text", (s) => (s.status.finalized_height = "3341575"), ["status.finalized_height"]],
  ["a finalized hash that is no hash", (s) => (s.status.finalized_hash = "x"), ["status.finalized_hash"]],
  ["a best height as text", (s) => (s.status.best_height = "3341577"), ["status.best_height"]],
  ["a best height of -1", (s) => (s.status.best_height = -1), ["status.best_height"]],
  ["a best height of 1.5", (s) => (s.status.best_height = 1.5), ["status.best_height"]],
  ["a lag as text", (s) => (s.status.finality_lag = "2"), ["status.finality_lag"]],
  ["a runtime version as text", (s) => (s.status.runtime_version = "1014002"), ["status.runtime_version"]],
  // 2^53 is written and read back as itself, so it reaches this check from a file.
  ["a runtime version of 2^53", (s) => (s.status.runtime_version = 2 ** 53), ["status.runtime_version"]],
  ["an rpc that is no object", (s) => (s.status.rpc = 5), ["status.rpc"]],
  ["a gateway that is no object", (s) => (s.status.gateway = 5), ["status.gateway"]],
  ["a faucet that is no object", (s) => (s.status.faucet = 5), ["status.faucet"]],
  ["a genesis with an extra field", (s) => (s.status.genesis.approved = s.status.genesis.pinned), ["status.genesis.fields"]],
  ["a pinned genesis that is no hash", (s) => (s.status.genesis.pinned = "x"), ["status.genesis.pinned"]],
  ["a faucet genesis that is no hash", (s) => (s.status.genesis.faucet = "x"), ["status.genesis.faucet"]],
  ["an rpc genesis that is no hash", (s) => (s.status.genesis.rpc = "x"), ["status.genesis.rpc"]],
  ["an rpc with an extra field", (s) => (s.status.rpc.approved = true), ["status.rpc.fields"]],
  ["an rpc health of great", (s) => (s.status.rpc.health = "great"), ["status.rpc.health"]],
  ["an rpc health in upper case", (s) => (s.status.rpc.health = "OK"), ["status.rpc.health"]],
  ["an rpc http of 1.5", (s) => (s.status.rpc.http = 1.5), ["status.rpc.http"]],
  ["an rpc detail that is a number", (s) => (s.status.rpc.detail = 5), ["status.rpc.detail"]],
  ["an rpc time that is a number", (s) => (s.status.rpc.observed_at = 5), ["status.rpc.observed_at"]],
  ["an rpc stale of no", (s) => (s.status.rpc.stale = "no"), ["status.rpc.stale"]],
  ["a gateway holding a health word alone", (s) => (s.status.gateway = { health: "ok" }), ["status.gateway.fields"]],
  ["a gateway with an extra field", (s) => (s.status.gateway.approved = true), ["status.gateway.fields"]],
  ["a gateway health of great", (s) => (s.status.gateway.health = "great"), ["status.gateway.health"]],
  ["a gateway http of 200 as text", (s) => (s.status.gateway.http = "200"), ["status.gateway.http"]],
  ["a gateway http of 1.5", (s) => (s.status.gateway.http = 1.5), ["status.gateway.http"]],
  ["a gateway http of 2^53", (s) => (s.status.gateway.http = 2 ** 53), ["status.gateway.http"]],
  ["a gateway detail that is a number", (s) => (s.status.gateway.detail = 5), ["status.gateway.detail"]],
  ["a gateway time that is a number", (s) => (s.status.gateway.observed_at = 5), ["status.gateway.observed_at"]],
  ["a faucet with an extra field", (s) => (s.status.faucet.approved = true), ["status.faucet.fields"]],
  ["a faucet health of great", (s) => (s.status.faucet.health = "great"), ["status.faucet.health"]],
  ["a faucet http of 200 as text", (s) => (s.status.faucet.http = "200"), ["status.faucet.http"]],
  ["a faucet detail that is a number", (s) => (s.status.faucet.detail = 5), ["status.faucet.detail"]],
  ["a faucet time that is a number", (s) => (s.status.faucet.observed_at = 5), ["status.faucet.observed_at"]],
  ["a faucet ready of yes", (s) => (s.status.faucet.ready = "yes"), ["status.faucet.ready"]],
  ["faucet limits of none as text", (s) => (s.status.faucet.limits = "none"), ["status.faucet.limits"]],
  ["faucet limits of 5", (s) => (s.status.faucet.limits = 5), ["status.faucet.limits"]],
  ["faucet limits as a list", (s) => (s.status.faucet.limits = [1]), ["status.faucet.limits"]],
  ["a faucet limit that is a word", (s) => (s.status.faucet.limits = { a: "x" }), ["status.faucet.limits"]],
  // No file holds Infinity in the written form; a caller of the function can still pass it.
  ["a faucet limit of Infinity", (s) => (s.status.faucet.limits.ipCooldownMs = Infinity), ["status.faucet.limits"]],
  // Escrows and their evidence.
  ["an escrow that is an empty shell", (s) => (s.escrows = [{ schema: s.escrows[0].schema, escrow_id: s.escrows[0].escrow_id, state: "claimed" }]), ["escrow.fields"]],
  ["an escrow marked approved", (s) => (s.escrows[0].approved = true), ["escrow.fields"]],
  ["an escrow with an extra field, whose evidence is not read", (s) => ((s.escrows[0].approved = true), (s.escrows[0].evidence[0].event = "x")), ["escrow.fields"]],
  ["another escrow schema", (s) => (s.escrows[0].schema = "flop-observatory/escrow-state@1"), ["escrow.schema"]],
  ["an escrow id of x", (s) => (s.escrows[0].escrow_id = "x"), ["escrow.escrow_id"]],
  ["a state of settled", (s) => (s.escrows[0].state = "settled"), ["escrow.state"]],
  ["evidence that is no list", (s) => (s.escrows[0].evidence = {}), ["escrow.evidence"]],
  ["notes that are not text", (s) => (s.escrows[0].notes = [5]), ["escrow.notes"]],
  ["an escrow bound as text", (s) => (s.escrows[0].finalized_height = "1"), ["escrow.finalized_height"]],
  ["an escrow observed_at of yesterday", (s) => (s.escrows[0].observed_at = "yesterday"), ["escrow.observed_at"]],
  ["an escrow trust of approved", (s) => (s.escrows[0].trust = "approved"), ["escrow.trust"]],
  ["another escrow scope", (s) => (s.escrows[0].scope = "everything"), ["escrow.scope"]],
  ["an evidence item with an extra field", (s) => (s.escrows[0].evidence[0].approved = true), ["evidence.fields"]],
  ["an evidence item that is null", (s) => (s.escrows[0].evidence = [null]), ["evidence.fields"]],
  ["an unknown evidence event", (s) => (s.escrows[0].evidence[0].event = "hasStation.EscrowSettled"), ["evidence.event"]],
  ["an upper case block hash", (s) => (s.escrows[0].evidence[0].block_hash = "0x" + "AB".repeat(32)), ["evidence.block_hash"]],
  ["a block hash of 63 hex", (s) => (s.escrows[0].evidence[0].block_hash = hex(63)), ["evidence.block_hash"]],
  ["a block hash of 65 hex", (s) => (s.escrows[0].evidence[0].block_hash = hex(65)), ["evidence.block_hash"]],
  ["a block hash with no 0x", (s) => (s.escrows[0].evidence[0].block_hash = "ab".repeat(32)), ["evidence.block_hash"]],
  ["a block hash with junk before it", (s) => (s.escrows[0].evidence[0].block_hash = "junk0x" + "ab".repeat(32)), ["evidence.block_hash"]],
  ["a block number as text", (s) => (s.escrows[0].evidence[0].block_number = "5"), ["evidence.block_number"]],
  ["an event index as text", (s) => (s.escrows[0].evidence[0].event_index = "0"), ["evidence.event_index"]],
  ["an event index of 1.5", (s) => (s.escrows[0].evidence[0].event_index = 1.5), ["evidence.event_index"]],
  ["an event index of -1", (s) => (s.escrows[0].evidence[0].event_index = -1), ["evidence.event_index"]],
  ["an evidence genesis that is no hash", (s) => (s.escrows[0].evidence[0].genesis = "x"), ["evidence.genesis"]],
  ["two broken shapes at once", (s) => ((s.status.rpc.health = "great"), (s.escrows[0].trust = "approved")), ["status.rpc.health", "escrow.trust"]],
  // Named in the fixed order, not the order read: escrow 0's evidence is read before escrow 1.
  ["a broken evidence item, then a broken escrow after it", (s) => ((s.escrows[0].evidence[0].event = "x"), (s.escrows[1].trust = "approved")), ["escrow.trust", "evidence.event"]],

  // Agreements: each edit keeps every shape and breaks one.
  ["a first line that names a line before it", (s) => (s.prev_hash = "ab".repeat(32)), ["snapshot.prev_hash-follows-seq"]],
  ["a later line that names no line before it", (s) => (s.seq = 1), ["snapshot.prev_hash-follows-seq"]],
  [
    "reset_detected false with no rpc genesis",
    (s) => {
      s.status.genesis.rpc = null;
      s.pin.genesis = null;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["status.reset-false-on-the-pinned-genesis"],
  ],
  [
    "reset_detected false with the rpc on another genesis",
    (s) => {
      s.status.genesis.rpc = OTHER;
      s.pin.genesis = OTHER;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["status.reset-false-on-the-pinned-genesis"],
  ],
  ["reset_detected false with no faucet genesis", (s) => (s.status.genesis.faucet = null), ["status.reset-false-on-the-pinned-genesis"]],
  ["reset_detected false with the faucet on another genesis", (s) => (s.status.genesis.faucet = OTHER), ["status.reset-false-on-the-pinned-genesis"]],
  [
    "reset_detected false with no heights",
    (s) => {
      Object.assign(s.status, { finalized_height: null, finalized_hash: null, best_height: null, finality_lag: null });
      Object.assign(s.pin, { finalized_height: null, finalized_hash: null });
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["status.reset-false-with-both-heights"],
  ],
  ["reset_detected false with no best height", (s) => ((s.status.best_height = null), (s.status.finality_lag = null)), ["status.reset-false-with-both-heights"]],
  [
    "reset_detected false with no finalized height",
    (s) => {
      s.status.finalized_height = null;
      s.status.finality_lag = null;
      s.pin.finalized_height = null;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["status.reset-false-with-both-heights"],
  ],
  ["reset_detected true on the pinned genesis", (s) => (s.status.reset_detected = true), ["status.reset-true-on-another-genesis-or-a-lost-anchor"]],
  // A lost anchor is a reset that kept the genesis (RULES.md 1.1): its conflict carries the rule.
  [
    "reset_detected true on the pinned genesis, with a lost anchor's conflict",
    (s) => ((s.status.reset_detected = true), (s.status.conflicts = [`finalized block 9 was ${OTHER} when an earlier snapshot logged it, and the node now has no block at that height: the finalized chain is not the one the log saw`])),
    [],
  ],
  ["reset_detected true on the pinned genesis, with a conflict that is no lost anchor's", (s) => ((s.status.reset_detected = true), (s.status.conflicts = ["finalized height went backwards from 9 to 8 on the same genesis"])), ["status.reset-true-on-another-genesis-or-a-lost-anchor"]],
  [
    "reset_detected true on the pinned genesis, with a lost anchor's words inside another conflict",
    (s) => ((s.status.reset_detected = true), (s.status.conflicts = ["it is said that the finalized chain is not the one the log saw, but not here"])),
    ["status.reset-true-on-another-genesis-or-a-lost-anchor"],
  ],
  ["reset_detected true with no faucet genesis", (s) => ((s.status.genesis.faucet = null), (s.status.reset_detected = true)), ["status.reset-true-on-another-genesis-or-a-lost-anchor"]],
  [
    "reset_detected true with no rpc genesis",
    (s) => {
      s.status.genesis.rpc = null;
      s.pin.genesis = null;
      s.status.reset_detected = true;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["status.reset-true-on-another-genesis-or-a-lost-anchor"],
  ],
  ["a lag that does not add up", (s) => (s.status.finality_lag = 99), ["status.lag-adds-up"]],
  ["no lag though both heights are read", (s) => (s.status.finality_lag = null), ["status.lag-adds-up"]],
  ["a lag with no best height", (s) => ((s.status.best_height = null), (s.status.reset_detected = null)), ["status.lag-adds-up"]],
  ["an escrow listed twice, with two states", (s) => (s.escrows[1].escrow_id = s.escrows[0].escrow_id), ["escrows.listed-once"]],
  [
    "an unverified escrow holding an event of its own",
    (s) => {
      const u = s.escrows.find((e: Json) => e.state === "unverified");
      u.evidence = [{ ...s.escrows[0].evidence[0], event_index: s.escrows[0].evidence[0].event_index + 7 }];
    },
    ["escrow.unverified-holds-no-evidence"],
  ],
  [
    "an unverified escrow holding an open of its own",
    (s) => {
      const u = s.escrows.find((e: Json) => e.state === "unverified");
      u.evidence = [{ ...s.escrows[0].evidence[0], event: "hasStation.EscrowOpened", event_index: s.escrows[0].evidence[0].event_index + 7 }];
    },
    ["escrow.unverified-holds-no-evidence"],
  ],
  [
    "funded on no event",
    (s) => {
      s.escrows[0].state = "funded";
      s.escrows[0].evidence = [];
    },
    ["escrow.funded-on-one-open"],
  ],
  [
    "funded on two opens",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].state = "funded";
      s.escrows[0].evidence = [{ ...r, event: "hasStation.EscrowOpened" }, { ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }];
    },
    ["escrow.funded-on-one-open"],
  ],
  [
    "funded on an open and a release",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].state = "funded";
      s.escrows[0].evidence = [{ ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }, r];
    },
    ["escrow.funded-with-no-release"],
  ],
  [
    "funded on an open and a refund",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].state = "funded";
      s.escrows[0].evidence = [{ ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }, { ...r, event: "hasStation.EscrowRefunded" }];
    },
    ["escrow.funded-with-no-refund"],
  ],
  [
    "claimed on no event",
    (s) => (s.escrows[0].evidence = []),
    ["escrow.claimed-on-one-release"],
  ],
  ["claimed on an open alone", (s) => (s.escrows[0].evidence[0].event = "hasStation.EscrowOpened"), ["escrow.claimed-on-one-release"]],
  [
    "claimed on two releases",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].evidence = [r, { ...r, event_index: r.event_index + 1 }];
    },
    ["escrow.claimed-on-one-release"],
  ],
  [
    "claimed with a refund too",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].evidence = [r, { ...r, event: "hasStation.EscrowRefunded", event_index: r.event_index + 1 }];
    },
    ["escrow.claimed-with-no-refund"],
  ],
  [
    "claimed on two opens",
    (s) => {
      const r = s.escrows[0].evidence[0];
      s.escrows[0].evidence = [{ ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }, { ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 2 }, r];
    },
    ["escrow.claimed-on-at-most-one-open"],
  ],
  ["refunded on no event", (s) => (s.escrows[1].evidence = []), ["escrow.refunded-on-one-refund"]],
  [
    "refunded on two refunds",
    (s) => {
      const r = s.escrows[1].evidence[0];
      s.escrows[1].evidence = [r, { ...r, event_index: r.event_index + 1 }];
    },
    ["escrow.refunded-on-one-refund"],
  ],
  [
    "refunded with a release too",
    (s) => {
      const r = s.escrows[1].evidence[0];
      s.escrows[1].evidence = [r, { ...r, event: "hasStation.EscrowReleased", event_index: r.event_index + 1 }];
    },
    ["escrow.refunded-with-no-release"],
  ],
  [
    "refunded on two opens",
    (s) => {
      const r = s.escrows[1].evidence[0];
      s.escrows[1].evidence = [{ ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 1 }, { ...r, event: "hasStation.EscrowOpened", event_index: r.event_index + 2 }, r];
    },
    ["escrow.refunded-on-at-most-one-open"],
  ],
  ["evidence from another genesis", (s) => (s.escrows[0].evidence[0].genesis = OTHER), ["evidence.on-the-pinned-genesis"]],
  [
    "evidence on the other genesis the rpc reads",
    (s) => {
      s.status.genesis.rpc = OTHER;
      s.pin.genesis = OTHER;
      s.status.reset_detected = true;
      for (const e of s.escrows) e.finalized_height = null;
      s.escrows[0].evidence[0].genesis = OTHER;
    },
    ["evidence.on-the-pinned-genesis"],
  ],
  [
    "evidence on the other genesis the faucet reads",
    (s) => {
      s.status.genesis.faucet = OTHER;
      s.status.reset_detected = true;
      s.escrows[0].evidence[0].genesis = OTHER;
    },
    ["evidence.on-the-pinned-genesis"],
  ],
  [
    "one release as evidence for two escrows",
    (s) => {
      s.escrows[1].state = "claimed";
      s.escrows[1].evidence = [{ ...s.escrows[0].evidence[0] }];
    },
    ["evidence.used-once"],
  ],
  ["one event as both open and release", (s) => s.escrows[0].evidence.unshift({ ...s.escrows[0].evidence[0], event: "hasStation.EscrowOpened" }), ["evidence.used-once"]],
  ["a bound other than the status's height", (s) => (s.escrows[0].finalized_height = 5), ["escrow.bound-is-the-status-height"]],
  ["a bound above the status's height", (s) => (s.escrows[0].finalized_height = s.status.finalized_height + 1), ["escrow.bound-is-the-status-height"]],
  [
    "a bound though the status read no height",
    (s) => {
      Object.assign(s.status, { finalized_height: null, finality_lag: null, reset_detected: null });
      s.pin.finalized_height = null;
    },
    ["escrow.bound-is-the-status-height"],
  ],
  [
    "a bound from a head on another genesis",
    (s) => {
      s.status.genesis.rpc = OTHER;
      s.pin.genesis = OTHER;
      s.status.reset_detected = true;
    },
    ["escrow.bound-only-from-the-pinned-genesis"],
  ],
  [
    "a bound with no rpc genesis read",
    (s) => {
      s.status.genesis.rpc = null;
      s.pin.genesis = null;
      s.status.reset_detected = null;
    },
    ["escrow.bound-only-from-the-pinned-genesis"],
  ],
  ["evidence above its bound", (s) => (s.escrows[0].evidence[0].block_number = s.status.finalized_height + 1), ["escrow.no-evidence-above-the-bound"]],
  ["a pin naming another genesis", (s) => (s.pin.genesis = "0x" + "cd".repeat(32)), ["pin.genesis-is-the-status-rpc-genesis"]],
  ["a pin naming no genesis though the status read one", (s) => (s.pin.genesis = null), ["pin.genesis-is-the-status-rpc-genesis"]],
  [
    "a pin naming a genesis though the status read none",
    (s) => {
      s.status.genesis.rpc = null;
      s.status.reset_detected = null;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["pin.genesis-is-the-status-rpc-genesis"],
  ],
  [
    "a pin naming the pinned genesis though the rpc read another",
    (s) => {
      s.status.genesis.rpc = OTHER;
      s.status.reset_detected = true;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["pin.genesis-is-the-status-rpc-genesis"],
  ],
  ["a pin naming another height", (s) => (s.pin.finalized_height = 7), ["pin.height-is-the-status-height"]],
  ["a pin height above the status's", (s) => (s.pin.finalized_height = s.status.finalized_height + 1), ["pin.height-is-the-status-height"]],
  [
    "a pin naming a height though the status read none",
    (s) => {
      Object.assign(s.status, { finalized_height: null, finality_lag: null, reset_detected: null });
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["pin.height-is-the-status-height"],
  ],
  ["a pin naming another hash", (s) => (s.pin.finalized_hash = "0x" + "ef".repeat(32)), ["pin.hash-is-the-status-hash"]],
  ["a pin naming no hash though the status read one", (s) => (s.pin.finalized_hash = null), ["pin.hash-is-the-status-hash"]],
  ["a pin naming a hash though the status read none", (s) => (s.status.finalized_hash = null), ["pin.hash-is-the-status-hash"]],
  ["a snapshot trusted though its parts are fixtures", (s) => (s.trust = "trusted RPC"), ["snapshot.fixture-when-a-part-is"]],
  ...(
    [
      ["the status", (s: Json) => (s.status.trust = "fixture")],
      ["one escrow", (s: Json) => (s.escrows[2].trust = "fixture")],
      ["the census", (s: Json) => (s.census = { schema: "flop-observatory/census@0", trust: "fixture" })],
      ["the drift report", (s: Json) => (s.drift = { schema: "flop-observatory/drift@0", trust: "fixture" })],
      ["the upgrade watch", (s: Json) => (s.upgrade = structuredClone(WATCH))],
    ] as const
  ).map(
    ([part, edit]) =>
      [
        `a trusted snapshot whose only fixture part is ${part}`,
        (s: Json) => {
          s.trust = "trusted RPC";
          s.status.trust = "trusted RPC";
          for (const e of s.escrows) e.trust = "trusted RPC";
          edit(s);
        },
        ["snapshot.fixture-when-a-part-is"],
      ] as const,
  ),
];

describe("checkSnapshot names every check a snapshot breaks, and only those", () => {
  it("serves the honest snapshot the check builds on", () => {
    expect(BASE.status.reset_detected).toBe(false);
    expect(BASE.escrows.map((e) => e.state)).toEqual(["claimed", "refunded", "unverified"]);
    expect(checkSnapshot(JSON.parse(JSON.stringify(BASE)))).toEqual([]);
  });

  // One test per case, named as the case is in full, so a report says which case failed.
  for (const [name, edit, broken] of CASES)
    it(name, () => {
      const s = JSON.parse(JSON.stringify(BASE));
      edit(s);
      expect(checkSnapshot(s)).toEqual(broken);
    });

  it("has a case for every check it makes, so none can stop firing unseen", () => {
    const covered = new Set(CASES.flatMap(([, , broken]) => broken));
    expect(CHECKS.filter((c) => !covered.has(c))).toEqual([]);
    expect([...covered].filter((c) => !CHECKS.includes(c))).toEqual([]);
    expect(new Set(CASES.map(([name]) => name)).size).toBe(CASES.length);
  });

  it("refuses what is not an object at all, and reads only the snapshot it is given", () => {
    for (const v of [null, 5, "snapshot", [], [BASE]]) expect(checkSnapshot(v)).toEqual(["snapshot.fields"]);
    const s = JSON.parse(JSON.stringify(BASE));
    checkSnapshot(s);
    expect(s).toEqual(JSON.parse(JSON.stringify(BASE)));
  });
});
