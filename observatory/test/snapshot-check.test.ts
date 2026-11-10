// The checks the MCP binary makes before it serves a snapshot (src/snapshot-check.ts, RULES.md
// section 5). Each case edits an honest snapshot and names every check the edit must break, so a
// case passes only when its edit breaks exactly those checks: a check that stopped firing, or one
// that started to fire on something else, fails it. A last test shows every check has a case.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS, checkSnapshot } from "../src/snapshot-check.js";
import { buildSnapshot } from "../src/snapshot.js";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { hashSnapshot } from "../src/store.js";

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

/** [name, edit, every check the edit breaks]. An empty list is a snapshot the binary must serve. */
const CASES: readonly (readonly [string, (s: Json) => void, readonly string[]])[] = [
  ["honest", () => {}, []],
  // Values the snapshot command writes, which the binary must serve (seventh rerun U1).
  ["a source sha of unknown, as check.sh passes outside a checkout", (s) => (s.pin.source_sha = "unknown"), []],
  ["a short source sha", (s) => (s.pin.source_sha = "979298d"), []],
  ["a gateway http status of -1", (s) => (s.status.gateway.http = -1), []],
  ["a faucet http status of -1", (s) => (s.status.faucet.http = -1), []],
  // Snapshots the settlement rules allow, so a rule made stricter than RULES.md fails too.
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
  ["another snapshot schema", (s) => (s.schema = "flop-observatory/snapshot@1"), ["snapshot.schema"]],
  ["a seq of 1 as text", (s) => (s.seq = "1"), ["snapshot.seq"]],
  ["a seq of -1", (s) => (s.seq = -1), ["snapshot.seq"]],
  ["a seq of 1.5", (s) => (s.seq = 1.5), ["snapshot.seq"]],
  ["a prev_hash that is no hash", (s) => (s.prev_hash = "x"), ["snapshot.prev_hash"]],
  ["a hash of 63 hex", (s) => (s.hash = "a".repeat(63)), ["snapshot.hash"]],
  ["a hash in upper case", (s) => (s.hash = "AB".repeat(32)), ["snapshot.hash"]],
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
  ["conflicts that are not text", (s) => (s.status.conflicts = [1, null]), ["status.conflicts"]],
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
  ["reset_detected true on the pinned genesis", (s) => (s.status.reset_detected = true), ["status.reset-true-on-another-genesis"]],
  ["reset_detected true with no faucet genesis", (s) => ((s.status.genesis.faucet = null), (s.status.reset_detected = true)), ["status.reset-true-on-another-genesis"]],
  [
    "reset_detected true with no rpc genesis",
    (s) => {
      s.status.genesis.rpc = null;
      s.pin.genesis = null;
      s.status.reset_detected = true;
      for (const e of s.escrows) e.finalized_height = null;
    },
    ["status.reset-true-on-another-genesis"],
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
    "one release as evidence for two escrows",
    (s) => {
      s.escrows[1].state = "claimed";
      s.escrows[1].evidence = [{ ...s.escrows[0].evidence[0] }];
    },
    ["evidence.used-once"],
  ],
  ["one event as both open and release", (s) => s.escrows[0].evidence.unshift({ ...s.escrows[0].evidence[0], event: "hasStation.EscrowOpened" }), ["evidence.used-once"]],
  ["a bound other than the status's height", (s) => (s.escrows[0].finalized_height = 5), ["escrow.bound-is-the-status-height"]],
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
  ["a pin naming another height", (s) => (s.pin.finalized_height = 7), ["pin.height-is-the-status-height"]],
  ["a pin naming another hash", (s) => (s.pin.finalized_hash = "0x" + "ef".repeat(32)), ["pin.hash-is-the-status-hash"]],
  ["a snapshot trusted though its parts are fixtures", (s) => (s.trust = "trusted RPC"), ["snapshot.fixture-when-a-part-is"]],
  ...(
    [
      ["the status", (s: Json) => (s.status.trust = "fixture")],
      ["one escrow", (s: Json) => (s.escrows[2].trust = "fixture")],
      ["the census", (s: Json) => (s.census = { schema: "flop-observatory/census@0", trust: "fixture" })],
      ["the drift report", (s: Json) => (s.drift = { schema: "flop-observatory/drift@0", trust: "fixture" })],
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
