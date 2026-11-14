// T3, rule H4: session-reads.js over a fake WebSocket fed from the rerun's recording, through
// pane-runner.js wsTransport, as the last batch's pane-runner.test.mjs runs its file: it asks only
// the methods the tool's two reads ask, at one head, in the tool's order; the metadata goes out as
// its sha256 and length only; and its relay's sha256 is right. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { paneKeys, sha256Text, loadTool } from "./lib.mjs";
import { plan, V } from "./fixtures.mjs";
import { PANE_RUNNER, readerOver, plain } from "./pane.mjs";
import { rerunNode, RERUN, metadataHex } from "./rerun-node.mjs";
import { committedMetadata, tapeTransport } from "./tape.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const KEYS = await paneKeys(plan, V("OWNER"), DEV1);
const sessionKeysOf = (k) => ({ lru: k.lru, sessions: k.sessions, nonces: k.nonces, breakers: k.breakers, session_count: k.session_count, rotation_history: k.rotation_history });
const READ_METHODS = ["chain_getFinalizedHead", "chain_getHeader", "chain_getBlockHash", "state_getStorage", "state_getMetadata"];
const tool = await loadTool();
const md = await committedMetadata(plan);

test("T3: pane-runner.js is the last batch's file, byte for byte: its sha256 is the one that README names", () => {
  assert.equal(createHash("sha256").update(readFileSync(PANE_RUNNER)).digest("hex"), "f034f6edc5d3a81218b67c3545bc5ba43d363ffd0fbd39a625c315cf235b5a78");
});

test("T3: a session tape at A6: the tool's questions at one head, the metadata by its sha256, and a right relay", async () => {
  const node = rerunNode("A6");
  const { reader } = readerOver(node);
  const r = plain(await reader.sessionTape(sessionKeysOf(KEYS)));
  assert.equal(r.relay_sha256, sha256Text(r.relay));
  const { relay, relay_sha256, ...value } = r;
  assert.equal(relay, JSON.stringify(value), "the relay is the value's JSON, as pane-runner.js withRelay makes it");
  assert.equal(r.kind, "session");
  assert.deepEqual(r.head, node.blockOf("A6"));
  // only the five read methods, and each storage read at the one head
  assert.deepEqual([...new Set(node.log.map((c) => c.method))].sort(), [...READ_METHODS].sort());
  assert.equal(node.log.filter((c) => c.method === "chain_getFinalizedHead").length, 1, "the head is asked once");
  for (const c of node.log.filter((c) => c.method === "state_getStorage")) assert.equal(c.params[1], r.head.hash);
  // the metadata is not in the tape: its sha256 and length are, and they are the facts file's
  assert.equal(r.tape.some((c) => c.method === "state_getMetadata"), false);
  assert.equal(r.metadata.sha256, V("METADATA_SHA256"));
  assert.equal(r.metadata.length, Number(V("METADATA_BYTES")));
  assert.ok(!r.relay.includes(metadataHex().slice(2, 200)), "no metadata bytes in the relay");
  // the tape is exactly what readSessionState and holdGenesis ask, in their order
  const asked = [];
  const owner = { hex: V("OWNER") };
  const t = tapeTransport(r, md, { asked });
  assert.equal(await t("chain_getBlockHash", [0]), V("GENESIS"));
  const s = await (await import("../../imd-flop/dist/chain-read/read.js")).readSessionState(t, owner.hex, DEV1);
  assert.equal(s.kind, "known");
  assert.deepEqual(asked.filter((c) => c.method !== "state_getMetadata").map((c) => [c.method, c.params]), r.tape.map((c) => [c.method, c.params]));
  // SessionCount and RotationHistory are beside the tape, not in it; the recording holds neither, so each is the node's error
  assert.equal(r.owner_reads.session_count.params[0], V("SESSION_COUNT_KEY"));
  assert.equal(r.owner_reads.rotation_history.params[0], V("ROTATION_HISTORY_KEY"));
  assert.match(r.owner_reads.session_count.error.message, /the recording holds no answer/);
});

test("T3: a block tape of A2: exactly the questions of readBlockEvents, and the events it decodes are the record's", async () => {
  const node = rerunNode("A6");
  const { reader } = readerOver(node);
  const b = node.blockOf("A2");
  const r = plain(await reader.blockTape({ lru: KEYS.lru, events: KEYS.events }, b.number, b.hash));
  assert.equal(r.relay_sha256, sha256Text(r.relay));
  assert.equal(r.kind, "block");
  assert.deepEqual(r.block, b);
  assert.deepEqual([...new Set(node.log.map((c) => c.method))].sort(), [...READ_METHODS].sort());
  const asked = [];
  const t = tapeTransport(r, md, { asked });
  await t("chain_getBlockHash", [0]);
  const e = await tool.readBlockEvents(t, b);
  assert.equal(e.kind, "known");
  assert.deepEqual(asked.filter((c) => c.method !== "state_getMetadata").map((c) => [c.method, c.params]), r.tape.map((c) => [c.method, c.params]));
  assert.ok(e.value.events.some((x) => x.pallet === "FlopSessionKeys" && x.event === "SessionCreated"));
});

test("T3: the probe of H7 asks state_call Core_version 0x at the block PROBE_BACK below the head; a refusal is recorded, never a value", async () => {
  const node = rerunNode("A6");
  const { reader } = readerOver(node);
  const back = Number(V("PROBE_BACK"));
  const r = plain(await reader.probe(back));
  const call = node.log.find((c) => c.method === "state_call");
  assert.deepEqual(call.params.slice(0, 2), ["Core_version", "0x"]);
  assert.equal(r.at.number, r.head.number - back);
  assert.deepEqual(node.log.filter((c) => c.method === "chain_getBlockHash").at(-1).params, [r.head.number - back], "the hash asked is of the block PROBE_BACK below the head");
  assert.equal(call.params[2], r.at.hash, "state_call is made at that block's hash");
  assert.equal(r.answered, false);
  assert.equal(r.length, null);
  assert.match(r.refusal.message, /no state_call/);
  const answering = rerunNode("A6");
  const base = answering.answer;
  answering.answer = (m, p) => (m === "state_call" ? "0x" + "ab".repeat(70) : base(m, p));
  const ok = plain(await readerOver(answering).reader.probe(back));
  assert.equal(ok.answered, true);
  assert.equal(ok.length, 70);
  assert.equal(ok.relay_sha256, sha256Text(ok.relay));
});

test("T3: keys the PC did not print, or that are not hex, are refused before any question", () => {
  const node = rerunNode("A6");
  const { reader } = readerOver(node);
  assert.throws(() => reader.sessionTape({ ...sessionKeysOf(KEYS), extra: KEYS.lru }), /unknown key extra/);
  assert.throws(() => reader.sessionTape({ ...sessionKeysOf(KEYS), sessions: "0xABCD" }), /the key sessions is not 0x/);
  assert.throws(() => reader.blockTape({ lru: KEYS.lru, events: KEYS.events }, -1, node.head), /number and its 32 byte hash/);
  assert.equal(node.log.length, 0);
});
