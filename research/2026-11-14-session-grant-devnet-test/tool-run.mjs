#!/usr/bin/env node
// tool-run: runs the tool's own code once over one relayed tape, on the PC, and writes one file (H5).
//
//   node tool-run.mjs <id> <purpose> --run <folder> --tape '<relay>' --tape-sha256 <sha>
//
//   purpose show   P0 only: imd-flop session show
//           call   the step's own command, session grant or session revoke (steps.json command)
//           after  session show after the step, over a tape at or above its block
//           block  the tool's readBlockEvents of the step's block, as the record names it
//
// The tool is imd-flop's built code, imd-flop/dist: `main` of cli.js with the batch's seat home as
// IMD_FLOP_HOME, --json and the tape's transport (the io.transport the README's "Session commands"
// names), or chain-read's readBlockEvents over the same transport. It writes
// <folder>/tool/<id>.<purpose>.json (the argv, the tape's sha256, the exit code, the printed JSON)
// and the tape's relay text, byte for byte, as <folder>/tapes/<id>.<purpose>.json.
//
// It refuses, and writes nothing (H6), when: the tape's block 0 hash is not the plan's genesis; the
// tape's head is below the block of the last finalized step of the record; the metadata's sha256 is
// not the committed one; the tape is named by an earlier output (a tape is used for one command);
// the tool asked a question the tape does not hold; the head the tool printed is not the tape's; the
// tape holds a question with no answer, or two different answers to one question (tape.mjs takeTape,
// F10); the id and the purpose are not what the record is at (atPhase, F10). An after tape's head
// below the step's block is the stale tape above, as the step's block is the record's last. The tape's own refusals come first, so their words name the tape.
// No network: the transport answers only from the tape. It signs nothing and reads no key file.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPlan, loadTool, stepOf, substitute, V } from "./lib.mjs";
import { committedMetadata, genesisOf, metadataIsCommitted, takeTape, tapeTransport, TapeError } from "./tape.mjs";
import { lastFinalizedBlock, loadRecord, planStepOf, runFiles, tapeFile, toolFile, toolOutputs, viewOf } from "./run.mjs";
import { nextOf } from "./next.mjs";

export class ToolRunError extends Error {}
const no = (m) => { throw new ToolRunError(m); };

export const PURPOSES = ["show", "call", "after", "block"];

/** The step and the tool's argv of an id and a purpose, or a refusal. */
export function argvOf(plan, results, id, purpose) {
  if (!PURPOSES.includes(purpose)) no(`the purpose is one of ${PURPOSES.join(", ")}`);
  if (id === "P0") {
    if (purpose !== "show") no("P0 runs show only");
    return { step: stepOf(plan, "P0"), argv: plan.commands.show.map((a) => substitute(a, plan, results, true)) };
  }
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}, and ${id} is not an attempt the record allows`);
  if (step.signer !== "owner") no(`${id} is not a step the tool prints a call for`);
  if (purpose === "show") no(`show is P0's; after a step, the purpose is after`);
  if (purpose === "block") return { step, argv: null };
  const cmd = purpose === "call" ? step.command : "show";
  return { step, argv: plan.commands[cmd].map((a) => substitute(a, plan, results, true)) };
}

/**
 * The tool's own code once over a taken tape, with no file read or written but the seat home's: main
 * of cli.js for argv, or readBlockEvents of block. Refuses a question the tape does not hold, a head
 * the tool printed that is not the tape's, and a block read that is not the block named. Used by
 * runTool and, over committed tapes, by replay.mjs (H16). Returns { output: { exit, json, stderr }, asked }.
 */
export async function runOver({ t, md, argv, block, home }) {
  const asked = [], missed = [];
  const transport = tapeTransport(t, md, { asked, missed });
  const tool = await loadTool();
  let output;
  if (block) {
    const r = await tool.readBlockEvents(transport, block);
    output = { exit: r.kind === "known" ? 0 : 1, json: r.kind === "known" ? r.value : { unknown: r.reason }, stderr: [] };
    if (r.kind === "known" && (r.value.number !== block.number || r.value.hash !== block.hash)) no(`readBlockEvents read block ${r.value.number} ${r.value.hash}, not ${block.number} ${block.hash}`);
  } else {
    const lines = [], errs = [];
    const exit = await tool.main(argv, { out: (s) => lines.push(s), err: (s) => errs.push(s), env: { IMD_FLOP_HOME: home }, transport });
    let json = null;
    if (lines.length) { try { json = JSON.parse(lines.join("\n")); } catch { no("the tool printed something that is not JSON with --json"); } }
    output = { exit, json, stderr: errs };
    if (json && json.head && (json.head.number !== t.head.number || json.head.hash !== t.head.hash)) no(`the tool printed the head ${json.head.number} ${json.head.hash}, not the tape's ${t.head.number} ${t.head.hash}`);
  }
  if (missed.length) no(`the tool asked what the tape does not answer: ${missed.map((m) => `${m.method} ${JSON.stringify(m.params)} (${m.why})`).join("; ")}`);
  return { output, asked };
}

/**
 * The record is at this id and purpose (F10): P0's show only before the record is started; any other
 * id only when plan.mjs next names that id and that phase. Throws a refusal otherwise. An after read
 * is at the id's phase only once the id is in a finalized block, which is then the record's last, so
 * the stale check of runTool holds its tape's head at or above the id's block.
 */
export function atPhase(plan, results, id, purpose) {
  if (id === "P0") { if (results) no("P0's show is read before the start, and the record is started: P0 is not what the record is at"); return; }
  const n = nextOf(plan, results);
  if (n.step !== id || n.phase !== purpose) no(`${id} ${purpose} is not what the record is at: ${n.word}${n.step ? ` ${n.step} ${n.phase}` : ""}: ${n.why}. Nothing is written`);
}

/** Runs the tool once over a tape. Returns { file, output } or throws ToolRunError; writes nothing on a refusal. */
export async function runTool({ plan, run, id, purpose, tapeText, tapeSha256, nowIso = new Date().toISOString() }) {
  const results = loadRecord(run);
  if (id !== "P0" && !results) no("the run folder has no results.json: make it with record-step.mjs start after P0");
  const { argv } = argvOf(plan, results, id, purpose);
  let t;
  try { t = takeTape(tapeText, tapeSha256); } catch (e) { if (e instanceof TapeError) no(e.message); throw e; }
  const wantKind = purpose === "block" ? "block" : "session";
  if (t.kind !== wantKind) no(`a ${purpose} reads a ${wantKind} tape, not a ${t.kind} tape`);
  const out = toolFile(run, id, purpose);
  if (existsSync(out)) no(`${out} exists: an output is never written over`);
  // H6: the genesis, the head, the metadata, a tape used once
  const g = genesisOf(t);
  if (g !== V(plan, "GENESIS")) no(`the tape's block 0 is ${g ?? "not answered"}, not the plan's genesis ${V(plan, "GENESIS")}`);
  const last = results ? lastFinalizedBlock(plan, results) : null;
  if (last !== null && t.head.number < last) no(`the tape's head ${t.head.number} is below block ${last}, the last finalized step of the record: a stale tape`);
  const md = await committedMetadata(plan);
  if (!metadataIsCommitted(t, md)) no(`the tape's metadata has sha256 ${t.metadata?.sha256 ?? "none"} and length ${t.metadata?.length ?? "none"}, not the committed ${md.sha256} of ${md.length} bytes`);
  const earlier = toolOutputs(run).find((o) => o.tape_sha256 === tapeSha256);
  if (earlier) no(`the tape ${tapeSha256} was used already, for ${earlier.file}: a tape is used for one command`);
  let block = null;
  if (purpose === "block") {
    const v = viewOf(results, id);
    if (!v?.final) no(`the record holds no finalized block for ${id}`);
    block = { number: v.block_number, hash: v.block_hash };
    if (t.block?.number !== block.number || t.block?.hash !== block.hash) no(`the tape is of block ${t.block?.number} ${t.block?.hash}, not ${id}'s ${block.number} ${block.hash}`);
  }
  const home = runFiles(run).seat;
  if (purpose !== "block" && !existsSync(home)) no(`the seat home ${home} is not in the run folder: make it with imd-flop init and cap set`);
  const { output, asked } = await runOver({ t, md, argv, block, home });
  atPhase(plan, results, id, purpose);
  const record = {
    id, purpose, argv: argv ?? ["readBlockEvents", block.number, block.hash], tape_sha256: tapeSha256, tape_file: `tapes/${id}.${purpose}.json`,
    tape_head: t.head, tape_read_utc: t.read_utc ?? null, metadata: { at: t.metadata.at, sha256: t.metadata.sha256, length: t.metadata.length, answered_with: "the committed bytes of that sha256 (imd-flop/scripts/chain-table.mjs readSource)" },
    owner_reads: t.owner_reads ?? null, asked: asked.length, exit: output.exit, json: output.json, stderr: output.stderr, run_utc: nowIso,
  };
  mkdirSync(runFiles(run).tool, { recursive: true });
  mkdirSync(runFiles(run).tapes, { recursive: true });
  writeFileSync(tapeFile(run, id, purpose), tapeText, { flag: "wx" });
  writeFileSync(out, JSON.stringify(record, null, 1) + "\n", { flag: "wx" });
  return { file: out, output: record };
}

function flags(argv, names) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : null;
    if (!names.includes(name)) no(`${argv[i]} is not a flag here (flags: ${names.map((n) => `--${n}`).join(", ")})`);
    if (i + 1 >= argv.length) no(`${argv[i]} needs a value`);
    out[name] = argv[++i];
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const [id, purpose, ...rest] = process.argv.slice(2);
    if (!id || !purpose || id.startsWith("--") || purpose.startsWith("--")) no("usage: node tool-run.mjs <id> <show|call|after|block> --run <folder> --tape '<relay>' --tape-sha256 <sha>");
    const f = flags(rest, ["run", "tape", "tape-sha256"]);
    const r = await runTool({ plan: loadPlan(), run: resolve(f.run ?? no("--run <run folder> is required")), id, purpose, tapeText: f.tape, tapeSha256: f["tape-sha256"] });
    console.log(JSON.stringify({ wrote: r.file, exit: r.output.exit, tape_sha256: r.output.tape_sha256 }));
  } catch (e) {
    process.stderr.write(`tool-run: ${e instanceof ToolRunError ? e.message : `failed (${e?.constructor?.name ?? typeof e})`}\n`);
    process.exit(2);
  }
}
