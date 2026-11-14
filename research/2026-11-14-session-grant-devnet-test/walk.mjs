// The rehearsal's walk of the run time record (H13, H14, H16): record-step.mjs's own functions and
// tool-run.mjs over tapes session-reads.js makes from the rerun's recording (rerun-node.mjs), with the
// seat of dev1. record-flow.test.mjs walks it step by step and holds each state; `node walk.mjs
// <folder>` writes it into a folder, whose seat home (identity.json and config.json, no key file),
// tapes, tool outputs and results.json are the first data of replay.test.mjs.
//
// What is made, and said here (the recording does not hold it):
//  - the pair absent at A1, and SessionCount(S) not stored there: their answers are set to null;
//  - at A10 the recording reads no session nonce and no breaker of dev1: they are set to null too;
//  - the runner's and the explorer's relays are made in their forms, from the recorded rerun step;
//  - the signed files are flop-sign.mjs sign's with a test key from a fixed seed, and recordSigned
//    runs with the plan's OWNER set to that key in a copy held in memory (owner-signed.test.mjs holds
//    the check itself). They stay in the walk's temporary folder and are not written by `node walk.mjs`.
// No network, no real key.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO, plan, V, tempDir, testKey, runWithSeat, sessionTapeOf, blockTapeOf, keysFor, relay, writeRecord } from "./fixtures.mjs";
import { readJson, sha256Text, ss58 } from "./lib.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { readerOver, plain } from "./pane.mjs";
import { runTool } from "./tool-run.mjs";
import { recordCall, recordReading, recordSigned, recordTool, startRecord } from "./record-step.mjs";
import { callFile, sendFile, signedFile } from "./run.mjs";

export const DEV1 = RERUN.accounts.dev1.public_key;
const ERRORS = readJson(join(REPO, plan.files.errors));

/** A walk in a new run folder with the seat of dev1. */
export async function newWalk(name = "g19-walk") {
  const keys = tempDir(`${name}-keys`);
  const run = runWithSeat(DEV1, name);
  const owner = testKey(keys, "walk-owner");
  const signerPlan = structuredClone(plan);
  signerPlan.values.OWNER.value = owner.public_key;
  const K = await keysFor(DEV1);
  const w = {
    run, K, results: null, utc: 0,
    done: () => { rmSync(keys, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); },
    /** A node over the recording at a rerun step, with keys set to null (made, said in the head of this file). */
    node: (at, absent = []) => { const n = rerunNode(at); for (const k of absent) n.set(K[k], null); return n; },
    /** A session tape over a node; each read has its own time, as two reads of the pane have. */
    tape: async (node) => {
      const t = plain(await readerOver(node).reader.sessionTape({ lru: K.lru, sessions: K.sessions, nonces: K.nonces, breakers: K.breakers, session_count: K.session_count, rotation_history: K.rotation_history }));
      const { relay: _r, relay_sha256: _s, ...v } = t;
      return relay({ ...v, read_utc: `2026-11-14T00:00:${String(w.utc++).padStart(2, "0")}.000Z` });
    },
    use: async (id, purpose, t) => { if (w.results) writeRecord(run, w.results); return (await runTool({ plan, run, id, purpose, tapeText: t.text, tapeSha256: t.sha, nowIso: "2026-11-14T00:00:00.000Z" })).output; },
    p0: async () => {
      const out = await w.use("P0", "show", await w.tape(w.node("A1", ["sessions", "nonces", "breakers", "session_count"])));
      const probe = plain(await readerOver(rerunNode("A1")).reader.probe(Number(V("PROBE_BACK"))));
      const reads = { account: V("OWNER_SS58"), runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") }, finalized: { number: rerunStep("A1").finalized_in_block, hash: rerunStep("A1").block_hash }, account_nonce: 9 };
      w.results = await startRecord({ plan, run, reads, readsSha256: sha256Text(JSON.stringify(reads)), probe, probeSha256: probe.relay_sha256, nowIso: "2026-11-14T00:00:00.000Z" });
      writeRecord(run, w.results);
      return out;
    },
    call: async (id, node) => {
      await w.use(id, "call", await w.tape(node));
      const c = recordCall(plan, run, w.results, id);
      w.results = c.results;
      if (c.callText) { mkdirSync(join(run, "calls"), { recursive: true }); writeFileSync(callFile(run, id), c.callText); }
      return c;
    },
    sign: (id) => {
      const call = readJson(callFile(run, id)).call;
      const nonce = String(BigInt(w.results.owner_account_nonce_at_start) + BigInt(w.results.steps.filter((e) => e.run_time?.sent?.status === "finalized").length));
      mkdirSync(join(run, "signed"), { recursive: true });
      execFileSync(process.execPath, [join(REPO, plan.files.signer), "sign", "--key", owner.path, "--call", call, "--nonce", nonce, "--out", signedFile(run, id), "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"), "--libs", join(REPO, "imd-flop")], { stdio: ["ignore", "pipe", "pipe"] });
      const s = recordSigned(signerPlan, run, w.results, id);
      w.results = s.results;
      if (s.sendText) writeFileSync(sendFile(run, id), s.sendText);
      return s;
    },
    /** The runner's reading of a recorded rerun step, as pane-runner.js send relays a finalized one (made). */
    sent: (id, rerunId) => {
      const s = rerunStep(rerunId), signed = readJson(signedFile(run, id));
      const r = relay({ step: id, bundle_sha256: sha256Text(readFileSync(sendFile(run, id), "utf8")), extrinsic_sha256: sha256Text(signed.extrinsic), extrinsic_hash: signed.extrinsic_hash, sent_by: "send", statuses: ["ready", "inBlock", "finalized"], status: "finalized", block_hash: s.block_hash, block_number: s.finalized_in_block, extrinsic_index: s.extrinsic_index, events_sha256: s.events_value_sha256, events_length: 1, finalized_utc: "2026-11-14T00:00:00.000Z" });
      w.results = recordReading({ plan, run, results: w.results, id, sent: JSON.parse(r.text), sentSha256: r.sha, errors: ERRORS });
    },
    block: async (id, node, rerunId) => {
      await w.use(id, "block", await blockTapeOf(node, DEV1, node.blockOf(rerunId)));
      w.results = recordTool(plan, run, w.results, id, "block", ERRORS);
    },
    after: async (id, node) => {
      await w.use(id, "after", await w.tape(node));
      w.results = recordTool(plan, run, w.results, id, "after", ERRORS);
      writeRecord(run, w.results);
    },
    /** The explorer's reading of a step, made in its form from the decoder's events and the recorded block (made). */
    explorer: (id, rerunId, change = (x) => x) => {
      const e = w.results.steps.find((x) => x.step === id);
      const toExplorer = (v) => (typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) ? ss58(v) : typeof v === "string" && /^[0-9]+$/.test(v) ? BigInt(v).toLocaleString("en-US") : typeof v === "number" ? v.toLocaleString("en-US") : v);
      const camel = (k) => k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
      const events = e.decoder.events.filter((x) => x.pallet === "FlopSessionKeys").map((x) => ({ section: "flopSessionKeys", method: x.name, data: Object.fromEntries(Object.entries(x.fields).map(([k, v]) => [camel(k), toExplorer(v)])) }));
      const names = e.decoder.events.map((x) => `${x.pallet.charAt(0).toLowerCase()}${x.pallet.slice(1)}.${x.name}`);
      const xr = change({ source: `${V("EXPLORER")}/api/transactions/${e.run_time.extrinsic_hash}`, read_utc: "2026-11-14T00:01:00.000Z", hash: e.run_time.extrinsic_hash, block_hash: rerunStep(rerunId).block_hash, success: e.decoder.success, error: null, failed_data: null, names, events });
      const r = relay(xr);
      w.results = recordReading({ plan, run, results: w.results, id, explorer: JSON.parse(r.text), explorerSha256: r.sha, errors: ERRORS });
      writeRecord(run, w.results);
    },
  };
  return w;
}

/** The whole rehearsal: P0 at A1, G1 landing at A2 (found not the plan's), R1 at A10, then the stop. */
export async function wholeWalk(name) {
  const w = await newWalk(name);
  await w.p0();
  await w.call("G1", w.node("A1", ["sessions", "nonces", "breakers"]));
  w.sign("G1"); w.sent("G1", "A2");
  await w.block("G1", rerunNode("A6"), "A2");
  await w.after("G1", rerunNode("A6"));
  w.explorer("G1", "A2");
  await w.call("R1", rerunNode("A8"));
  w.sign("R1"); w.sent("R1", "A10");
  await w.block("R1", rerunNode("A10"), "A10");
  await w.after("R1", w.node("A10", ["nonces", "breakers"]));
  w.explorer("R1", "A10");
  return w;
}

/** The files of a run folder that replay.test.mjs reads, copied into a folder: no calls, no signed files, no key. */
export function keep(run, out) {
  mkdirSync(out, { recursive: true });
  for (const d of ["tapes", "tool"]) cpSync(join(run, d), join(out, d), { recursive: true });
  for (const f of ["seat/config.json", "seat/seats/unassigned/identity.json", "results.json"]) { mkdirSync(join(out, f, ".."), { recursive: true }); cpSync(join(run, f), join(out, f)); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const out = resolve(process.argv[2] ?? (process.stderr.write("usage: node walk.mjs <folder>\n"), process.exit(2)));
  const w = await wholeWalk("g19-walk-write");
  try { keep(w.run, out); console.log(`wrote the rehearsal's run folder to ${out}`); } finally { w.done(); }
}
