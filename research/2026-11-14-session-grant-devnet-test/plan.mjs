#!/usr/bin/env node
// plan: prints the plan of the batch from steps.json, and what the lead does next by the record
// (H9, H10, H12). Every command line the lead runs is printed here from steps.json, the run folder's
// files and the record; none is typed by hand. No network, no key.
//
//   node plan.mjs table          the steps
//   node plan.mjs fence          the fence in numbers (H12)
//   node plan.mjs stops          the stop rule (H10)
//   node plan.mjs outcomes       the immortal rows of send_outcomes, imported from the last batch (H11)
//   node plan.mjs sha256s        the sha256 of each file pasted into the pane
//   node plan.mjs next --run <folder>   the one next action, with every value filled
//   node plan.mjs md             writes the printed blocks of plan.md again
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERE, REPO, atPath, flopText, loadPlan, paneKeys, readJson, sha256Text, substitute, V } from "./lib.mjs";
import { callFile, entryOf, loadRecord, MAX_ATTEMPTS, planStepOf, runFiles, sendFile, signedFile, toolFile, viewOf } from "./run.mjs";
import { nextOf } from "./next.mjs";
import { nonceOf } from "../2026-11-12-encoder-devnet-test/research-signed.mjs";
import { outcomeRow, NODE_CODES } from "../2026-11-12-encoder-devnet-test/plan.mjs";

export { NODE_CODES };
const DIR = "\"$LAB/research/2026-11-14-session-grant-devnet-test";
const TOOL_RUN = `node ${DIR}/tool-run.mjs"`, RECORD = `node ${DIR}/record-step.mjs"`;
const SIGNER = "node \"$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs\"";
const TOOL = (run) => `IMD_FLOP_HOME="${run}/seat" node "$LAB/imd-flop/dist/bin.js"`;
const NODE_TAB = "https://rpc.devnet.flop.network/", EXPLORER_TAB = "https://explorer.devnet.flop.network/";
const PASTED = { "pane-runner.js": join(HERE, "..", "2026-11-12-encoder-devnet-test", "pane-runner.js"), "session-reads.js": join(HERE, "session-reads.js"), "explorer-reader.js": join(HERE, "..", "2026-11-12-encoder-devnet-test", "explorer-reader.js") };
const q = (a) => (/^[A-Za-z0-9_:.,\/=$-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const amt = (raw) => `${raw} (${flopText(raw)} FLOP)`;

/** The sha256 of each file the lead pastes into the pane. */
export const pastedSha256 = () => Object.fromEntries(Object.entries(PASTED).map(([f, p]) => [f, sha256Text(readFileSync(p, "utf8"))]));

/** The immortal rows of the last batch's send_outcomes (H11), imported by steps.json send_outcomes_from. */
export function immortalRows(plan) {
  const rows = atPath(readJson(join(REPO, plan.files[plan.send_outcomes_from.file])), plan.send_outcomes_from.path);
  return rows.map((r) => {
    const m = /Immortal: (.*)$/.exec(r.second_copy);
    return { ...r, second_copy: m ? m[1] : r.second_copy };
  });
}

// ---- the fence (H12) ---------------------------------------------------------------------------

/** The fence in numbers: what moves, the expected fees of each branch of G2, the worst case and the fence. */
export function costs(plan) {
  const fee = (st) => BigInt(substitute(st.fee, plan, null, true));
  const sends = plan.steps.filter((s) => s.signer === "owner");
  const moved = sends.flatMap((s) => s.moves);
  const taken = sends.reduce((a, s) => a + fee(s), 0n);
  const refusedKnown = sends.filter((s) => s.id === "G1" || s.id === "R1").reduce((a, s) => a + fee(s), 0n);
  const tries = sends.reduce((a, s) => a + BigInt(s.cleanup ? MAX_ATTEMPTS : 1), 0n);
  const worst = tries * BigInt(V(plan, "MAX_FEE"));
  const fence = BigInt(V(plan, "FENCE"));
  return { moved, expected_taken: taken, expected_refused: { known: refusedKnown, plus: "G2's fee, unknown, at most MAX_FEE" }, tries, worst, fence, within: worst <= fence };
}

export function fenceText(plan) {
  const c = costs(plan);
  return [
    `- moved to any account: ${c.moved.length ? c.moved.join(", ") : "nothing"}`,
    `- expected fees, G2 taken (G1, R1, G2, R2): ${amt(c.expected_taken.toString())}`,
    `- expected fees, G2 refused (G1, R1, G2): ${amt(c.expected_refused.known.toString())} plus G2's fee, which no committed file records, at most ${amt(V(plan, "MAX_FEE"))}`,
    `- worst case: ${c.tries} sends (each owner step once, each revoke ${MAX_ATTEMPTS} times) at the most per step ${amt(V(plan, "MAX_FEE"))}: ${amt(c.worst.toString())}`,
    `- the fence: ${amt(c.fence.toString())}; the worst case is ${c.within ? "at or under it" : "ABOVE IT"}`,
  ].join("\n");
}

// ---- the plan for a reader ------------------------------------------------------------------------

export function table(plan) {
  const head = "| Step | Signer | Call | Expected events | Expected fee | Only if | Cleanup |\n|---|---|---|---|---|---|---|";
  const rows = plan.steps.map((s) => {
    const call = s.command ? `session ${s.command} printed by the tool; second encoder: flop-sign.mjs call ${s.second_encoder[0]}` : "reads only";
    const ev = s.events ? s.events.map((e) => `${e.event} {${Object.entries(e.fields).map(([k, v]) => `${k} ${substitute(v, plan, null)}`).join(", ")}${e.expires_at ? `, expires_at ${substitute(e.expires_at, plan, null)}` : ""}}`).join("; ") : "none";
    const fee = s.fee === "0" ? "0" : amt(substitute(s.fee, plan, null, true));
    return `| ${s.id} | ${s.signer ?? "none"} | ${call} | ${ev}${s.u1 ? `. U1: ${substitute(s.u1, plan, null)}` : ""} | ${fee}${s.fee_refused ? `; refused: ${substitute(s.fee_refused, plan, null)}` : ""} | ${s.only_if ? `${s.only_if.step} succeeded` : ""} | ${s.cleanup ? `yes, ${MAX_ATTEMPTS} tries` : "no"} |`;
  });
  return [head, ...rows].join("\n");
}

/** The stop rule, as the lead reads it (H10). */
export const STOPS = [
  "P0: the runtime, the genesis or the transaction version at the start is not the plan's",
  "P0: SessionCount(S) is SESSION_COUNT_STOP or more, or cannot be read",
  "P0: the pair (S, D) is not absent",
  "P0, and every call, block and after reading: the tool exits other than 0",
  "before a signature: the tool's call is not the plan's (owner, device, runtime, caps, stored record line), or its hex differs from the second encoder's",
  "the signed file check refuses: nothing is sent",
  "a send outcome that is not a clean inclusion: the immortal rows of send_outcomes (plan.mjs outcomes)",
  "G1 failed in its block: stop, nothing is active, one fee is lost",
  "G1 succeeded but its SessionCreated fields are not the derived caps, owner and delegate, or its expires_at is not its block plus DURATION, or show after G1 does not say active with those caps: R1, then stop",
  "a step's fee above MAX_FEE: stop after the cleanups that apply",
  "a revoke failed in its block: a cleanup try at the next nonce, MAX_ATTEMPTS tries at most; then stop, and an active session is left until its expiry",
  "a revoke that succeeded but is not the plan's (no SessionRevoked of the pair, or show after it does not say revoked): stop",
  "G2 refused with FlopSessionKeys.ALREADY_EXISTS: the end, U1 answered. Another error: the end, U1 stays open. Taken: R2",
  "an outcome that cannot be read from the block's events: stop",
];
export const stopsText = (plan) => STOPS.map((s) => `- ${s.replace(/\b(SESSION_COUNT_STOP|MAX_FEE|MAX_ATTEMPTS|ALREADY_EXISTS|DURATION)\b/g, (w) => (w === "MAX_ATTEMPTS" ? String(MAX_ATTEMPTS) : V(plan, w)))}`).join("\n");

export const outcomesText = (plan) => immortalRows(plan).map((r) => `- ${r.outcome}${r.node_code !== undefined ? ` (node code ${r.node_code})` : ""}${r.node_word ? ` (${r.node_word})` : ""}: ${r.known}. The lead: ${r.lead}. A second copy: ${r.second_copy}`).join("\n");

// ---- the lines the lead runs ---------------------------------------------------------------------

const PANE_SHA = "[...new Uint8Array(await crypto.subtle.digest(\"SHA-256\", new TextEncoder().encode(window.__src)))].map((b) => b.toString(16).padStart(2, \"0\")).join(\"\")";

/** How the pane is made ready: each pasted file checked by its sha256. */
export function paneSetup() {
  const s = pastedSha256();
  return [
    `# the node's tab, ${NODE_TAB}: put the text of pane-runner.js in window.__src, check its sha256 there, run it; then the same with session-reads.js`,
    `#   sha256 of pane-runner.js: ${s["pane-runner.js"]}`,
    `#   sha256 of session-reads.js: ${s["session-reads.js"]}`,
    `#   ${PANE_SHA}`,
    "#   (0, eval)(window.__src)   once for each file, in that order; then: const lab = paneRunner.createRunner(); const reads = sessionReads.createReader()",
    `# the explorer's tab, ${EXPLORER_TAB}: the same with explorer-reader.js`,
    `#   sha256 of explorer-reader.js: ${s["explorer-reader.js"]}`,
    "#   (0, eval)(window.__src); const explorer = explorerReader.createReader()",
    "# a pane call ends after 45 s: keep each promise on window and read it in a second call",
  ];
}

const paneAwait = (name, call) => [`#  pane, tab on the node (${NODE_TAB}):`, `window.${name} = ${call}`, `await window.${name}   (its relay and relay_sha256)`];
const sessionKeysArg = (k) => JSON.stringify({ lru: k.lru, sessions: k.sessions, nonces: k.nonces, breakers: k.breakers, session_count: k.session_count, rotation_history: k.rotation_history });
const blockKeysArg = (k) => JSON.stringify({ lru: k.lru, events: k.events });

/** The lines of a session tape and the tool over it. */
const tapeAndTool = (run, keys, id, purpose) => [
  ...paneAwait("__t", `reads.sessionTape(${sessionKeysArg(keys)})`),
  "#  PC:",
  `${TOOL_RUN} ${id} ${purpose} --run "${run}" --tape '<relay>' --tape-sha256 <relay_sha256>`,
];

function explorerLines(run, id, results) {
  const rt = entryOf(results, id).run_time;
  return [`#  ${id}, the explorer's reading (a second, weaker source), pane, tab on the explorer (${EXPLORER_TAB}):`, `window.__e = explorer.read("${rt.extrinsic_hash}")`, "await window.__e   (its relay and relay_sha256)", "#  PC:", `${RECORD} step ${id} --run "${run}" --explorer '<relay>' --explorer-sha256 <relay_sha256>`];
}

/** The lines of one phase of one id, with every value filled from the plan, the run folder and the record. */
async function phaseLines(plan, run, results, n) {
  const id = n.step, keys = await paneKeys(plan, V(plan, "OWNER"), results.accounts.device.public_key);
  const st = planStepOf(plan, id);
  const head = `# ${id}: ${n.phase}: ${n.why}`;
  if (n.phase === "call") return [head, `#  read before ${id}: a session tape; the tool prints ${st.command === "grant" ? "the grant" : "the revoke"} over it`, ...tapeAndTool(run, keys, id, "call"), `${RECORD} call ${id} --run "${run}"`];
  if (n.phase === "sign") {
    const nonce = nonceOf(plan, results, id);
    return [head, "#  immortal: never signed to different bytes. The call is the tool's, held equal to the second encoder's in calls/" + id + ".json", "#  PC:", `mkdir -p "${run}/signed"`,
      `${SIGNER} sign --key "$KEY_OWNER" --call "$(node -p 'require(process.argv[1]).call' "${callFile(run, id)}")" --nonce ${nonce} --out "${signedFile(run, id)}" --spec ${V(plan, "SPEC")} --txv ${V(plan, "TXV")} --genesis ${V(plan, "GENESIS")} --libs "$LAB/imd-flop"`,
      "#  send-file writes the send file only when the signed file is the tool's call for the owner, this nonce, the plan's runtime and chain (H3)",
      `${RECORD} send-file ${id} --run "${run}"`];
  }
  if (n.phase === "send") {
    const text = readFileSync(sendFile(run, id), "utf8");
    return [head, ...paneAwait("__s", `lab.send('${text}', "${sha256Text(text)}")`), "#  PC:", `${RECORD} step ${id} --run "${run}" --sent '<relay>' --sent-sha256 <relay_sha256>`];
  }
  if (n.phase === "wait") {
    const row = outcomeRow({ send_outcomes: immortalRows(plan) }, n.sent);
    const signed = readJson(signedFile(run, id)), text = readFileSync(sendFile(run, id), "utf8");
    return [`# wait: ${id}: the runner said ${n.sent?.status}`, ...(row ? [`# known: ${row.known}`, `# the lead: ${row.lead}`, `# a second copy: ${row.second_copy}`] : ["# no row of send_outcomes names this outcome: the lead rules"]),
      ...paneAwait("__f", `lab.find("${signed.extrinsic}", ${results.start.finalized.number})`), "#  PC, if it says finalized:", `${RECORD} step ${id} --run "${run}" --sent '<relay>' --sent-sha256 <relay_sha256>`,
      "#  if not found: the same bytes again, never other bytes", ...paneAwait("__s", `lab.sendSame('${text}', "${sha256Text(text)}")`), "#  PC:", `${RECORD} step ${id} --run "${run}" --sent '<relay>' --sent-sha256 <relay_sha256>`];
  }
  if (n.phase === "block") {
    const v = viewOf(results, id);
    return [head, `#  the events and the fee of ${id} by the lab's own decoder, from a block tape of block ${v.block_number}`, ...paneAwait("__b", `reads.blockTape(${blockKeysArg(keys)}, ${v.block_number}, "${v.block_hash}")`), "#  PC:",
      `${TOOL_RUN} ${id} block --run "${run}" --tape '<relay>' --tape-sha256 <relay_sha256>`, `${RECORD} tool ${id} block --run "${run}"`];
  }
  if (n.phase === "after") return [head, `#  read after ${id}: a session tape at a head at or above its block; the tool's session show over it`, ...tapeAndTool(run, keys, id, "after"), `${RECORD} tool ${id} after --run "${run}"`];
  throw new Error(`no lines for the phase ${n.phase}`);
}

/** The lines of P0: the seat home first (init and cap set), then the reads and the start. */
async function p0Lines(plan, run) {
  const seat = V(plan, "SEAT");
  if (!existsSync(join(runFiles(run).seat, "seats", seat, "identity.json"))) {
    return ["# P0: the seat home of the batch, made by the tool itself (H8). Its key file stays there and is never read", "#  PC:", `mkdir -p "${run}"`,
      `${TOOL(run)} ${plan.seat.init.map((a) => q(substitute(a, plan, null, true))).join(" ")}`,
      `${TOOL(run)} ${plan.seat.cap_set.map((a) => q(substitute(a, plan, null, true))).join(" ")}`,
      `#  then: node ${DIR}/plan.mjs" next --run "${run}"`];
  }
  const { deviceOfSeat } = await import("./lib.mjs");
  const device = await deviceOfSeat(runFiles(run).seat, seat);
  const keys = await paneKeys(plan, V(plan, "OWNER"), device);
  const lines = ["# P0: reads only. The owner's reads, the free read of H7, and one session tape; then the tool's session show over it", ...paneSetup()];
  lines.push(...paneAwait("__r", `lab.accountReads("${V(plan, "OWNER_SS58")}")`), ...paneAwait("__p", `reads.probe(${V(plan, "PROBE_BACK")})`));
  if (!existsSync(toolFile(run, "P0", "show"))) lines.push(...tapeAndTool(run, keys, "P0", "show"));
  lines.push("#  PC:", `${RECORD} start --run "${run}" --reads '<relay of __r>' --reads-sha256 <its relay_sha256> --probe '<relay of __p>' --probe-sha256 <its relay_sha256>`);
  return lines;
}

/** What the lead does next, by the run folder (H10): the lines, or the stop and why, or the end. */
export async function nextText(plan, run, results) {
  if (!results) return (await p0Lines(plan, run)).join("\n") + "\n";
  const n = nextOf(plan, results);
  const out = [];
  for (const f of n.findings) out.push(`# finding: ${f}`);
  for (const l of n.left) out.push(`# left: ${l}`);
  if (n.word === "stop") { out.push(`# STOP at ${n.stopped_at}: ${n.why}`, "# send nothing more; the lead rules"); return out.join("\n") + "\n"; }
  if (n.word === "end") out.push(`# the end: ${n.why}`, `node ${DIR}/check.mjs" "${run}/results.json"`);
  else {
    if (n.cleanup.length) out.push(`# cleanup steps that apply: ${n.cleanup.join(", ")}`);
    out.push(...(await phaseLines(plan, run, results, n)));
  }
  for (const e of results.steps) if (viewOf(results, e.step)?.final && !e.run_time.explorer) out.push(...explorerLines(run, e.step, results));
  return out.join("\n") + "\n";
}

// ---- plan.md -------------------------------------------------------------------------------------

export const printedBlocks = (plan) => ({ table: table(plan), fence: fenceText(plan), stops: stopsText(plan), outcomes: outcomesText(plan), pane: paneSetup().join("\n") });
const MARK = /<!-- printed by plan\.mjs: ([a-z_]+) -->\n([\s\S]*?)\n<!-- end of printed -->/g;
export const blocksIn = (md) => Object.fromEntries([...md.matchAll(MARK)].map((m) => [m[1], m[2]]));
export const renderMd = (md, plan) => { const b = printedBlocks(plan); return md.replace(MARK, (all, name) => (name in b ? `<!-- printed by plan.mjs: ${name} -->\n${b[name]}\n<!-- end of printed -->` : all)); };

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const plan = loadPlan();
  const cmd = argv[0];
  if (cmd === "table") console.log(table(plan));
  else if (cmd === "fence") console.log(fenceText(plan));
  else if (cmd === "stops") console.log(stopsText(plan));
  else if (cmd === "outcomes") console.log(outcomesText(plan));
  else if (cmd === "sha256s") console.log(JSON.stringify(pastedSha256(), null, 1));
  else if (cmd === "next") {
    const f = flag("run");
    if (!f) { process.stderr.write("plan.mjs next --run <run folder>\n"); process.exit(2); }
    const run = resolve(f);
    process.stdout.write(await nextText(plan, run, loadRecord(run)));
  } else if (cmd === "md") { const f = join(HERE, "plan.md"); writeFileSync(f, renderMd(readFileSync(f, "utf8"), plan)); }
  else { process.stderr.write("commands: table, fence, stops, outcomes, sha256s, next, md\n"); process.exit(2); }
}
