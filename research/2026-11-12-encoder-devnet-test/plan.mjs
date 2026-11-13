#!/usr/bin/env node
// plan: turns steps.json into what the lead needs. No network, no key, signs nothing.
//   node plan.mjs table       the steps as the table of plan.md
//   node plan.mjs costs       the fee of each step and the escrows, as the tables of plan.md
//   node plan.mjs stops       what the lead does on each stop, and what is left, as the table of plan.md
//   node plan.mjs commands    the reader's list: the command lines of every step, values as $NAMES
//   node plan.mjs next --run <run folder>
//        only what the lead does next, by the record: the pane and PC lines of the next step with
//        every value filled, or the stop row, or the wait (R4)
//   node plan.mjs template    the empty results form (results.template.json is its output)
//   node plan.mjs md          rewrites each printed block of plan.md (between its markers) from steps.json
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERE, RERUN, loadPlan, readJson, substitute, rerunFee, flopText, RAW, sessionNonceKey } from "./lib.mjs";
import { planStepOf, recordedIds, viewOf, deviceIncluded, afterBlockOf, loadRecord, signedFile } from "./record.mjs";
import { nextOf } from "./judge.mjs";

const SIGNER = "\"$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs\"";
const SIGN_DEVICE = "\"$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs\"";
const KEY = { owner: "$KEY_OWNER", device: "$KEY_DEVICE" };

const amt = (plan, t) => { const v = substitute(t, plan, null); return RAW.test(v) ? `${v} (${flopText(v)} FLOP)` : v; };
const condText = (c) => (c.event ? `${c.step} recorded ${c.event}` : `${c.step} succeeded`);
const afterText = (plan, a) => (a.greatest_of ? `after the greatest of: ${a.greatest_of.map((x) => afterText(plan, x).replace(/^after /, "")).join(" and ")}` : a.event ? `after block ${a.event}` : `after the block of ${a.step} plus ${substitute(a.plus, plan, null, true)} blocks`);

/** What each step expects, in words. */
function expectText(st) {
  if (st.expect === "success") return "success";
  return `recorded, not expected: included in a finalized block, and success or a named error of ${st.errors_allowed_of.join(" or ")}`;
}

/** The steps as a markdown table. */
export function table(plan) {
  const rows = plan.steps.map((st) => {
    const call = st.tool === "encoder" ? `execute_via_session(${st.inner.call})` : st.call[0];
    const moves = st.moves.length ? st.moves.map((m) => `${m.amount === "rest" ? "all it holds" : amt(plan, m.amount)} ${m.from} to ${m.to}${m.when ? ` if ${m.when.step} ${m.when.outcome === "success" ? "succeeded" : m.when.outcome}` : ""}`).join("<br>") : "nothing";
    const when = [st.only_if ? `only if ${condText(st.only_if)}` : "", st.after_block ? afterText(plan, st.after_block) : ""].filter(Boolean).join("; ") || "in order";
    return `| ${st.id} | ${st.signer} | ${st.tool} | ${call} | ${moves} | ${st.declared === null ? "none" : amt(plan, st.declared)} | ${expectText(st)} | ${when} | ${st.on_unexpected}${st.cleanup ? " (cleanup)" : ""} |`;
  });
  return ["| # | Signs | Tool | Call | Moves | Declared | Expected | When | If not |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

/** Fees and escrows of the plan, as raw strings, from the rerun's recorded fees. */
export function costs(plan) {
  const rows = plan.steps.map((st) => ({ id: st.id, like: st.fee_like, fee_raw: rerunFee(st.fee_like) }));
  const known = rows.filter((r) => r.fee_raw !== null);
  const sum = known.reduce((n, r) => n + BigInt(r.fee_raw), 0n);
  const escrows = plan.steps.flatMap((st) => st.moves.filter((m) => m.to === "pallet").map((m) => ({ id: st.id, amount: substitute(m.amount, plan, null, true), comes_back: m.comes_back })));
  return { rows, known_sum_raw: sum.toString(), unknown: rows.filter((r) => r.fee_raw === null).map((r) => r.id), escrows };
}

/** The cost tables as markdown. */
export function costsText(plan) {
  const c = costs(plan);
  const fee = ["| # | Like step of the rerun | Fee there (raw) | FLOP |", "|---|---|---|---|",
    ...c.rows.map((r) => `| ${r.id} | ${r.like ?? "none"} | ${r.fee_raw ?? "unknown"} | ${r.fee_raw ? flopText(r.fee_raw) : "unknown"} |`),
    `| sum | | ${c.known_sum_raw} and ${c.unknown.join(", ")} unknown | ${flopText(c.known_sum_raw)} and ${c.unknown.length} unknown |`];
  const esc = ["| Locked at | Amount (raw) | FLOP | Comes back |", "|---|---|---|---|",
    ...c.escrows.map((e) => `| ${e.id} | ${e.amount} | ${flopText(e.amount)} | ${e.comes_back} |`)];
  return fee.join("\n") + "\n\n" + esc.join("\n");
}

/** For a stop at a step, the cleanup steps the lead then sends, each with its condition. */
export function cleanupAfterStop(plan, stopId) {
  const ids = plan.steps.map((s) => s.id);
  const at = ids.indexOf(stopId);
  return plan.steps.filter((s) => s.cleanup && ids.indexOf(s.id) > at && ids.indexOf(s.only_if.step) <= at)
    .map((s) => ({ id: s.id, needs: s.only_if, sure: ids.indexOf(s.only_if.step) < at }));
}

/** The stop rule as a markdown table: each way the batch can stop, what the lead sends then, and what is left. */
export function stopsText(plan) {
  const rows = [];
  for (const st of plan.steps.filter((s) => !s.cleanup && s.on_unexpected === "stop")) {
    const then = cleanupAfterStop(plan, st.id);
    const send = then.length ? then.map((c) => (c.sure ? c.id : `${c.id} if ${condText(c.needs)}`)).join(", ") : "nothing";
    const left = then.length ? `until those are final: ${then.map((c) => plan.steps.find((s) => s.id === c.id).shows.replace(/^the /, "")).join("; ")}` : "nothing but the owner's fee";
    rows.push(`| ${st.id} answers otherwise | stop the test steps | ${send} | ${left} |`);
  }
  for (const st of plan.steps.filter((s) => s.cleanup)) rows.push(`| ${st.id} fails | stop | the cleanup steps after it that apply | ${st.left_if_it_fails} |`);
  return ["| Stop | The lead | Then sends | Left on chain, and how it comes back |", "|---|---|---|---|", ...rows].join("\n");
}

const RECORD = "\"$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs\"";
const NODE_TAB = "https://rpc.devnet.flop.network/", EXPLORER_TAB = "https://explorer.devnet.flop.network/";
const q = (a) => (/^[A-Za-z0-9_:.,\/=$-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/**
 * The values the lines of a step need. Without a record they stay placeholders for the reader's
 * list (plan.mjs commands). With a run folder and its record every value is filled (plan.mjs next).
 */
export function lineValues(plan, run, results) {
  if (!results) return { run: "$RUN", device_ss58: "$DEVICE_SS58", device: "$DEVICE", session_key: "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>", owner_nonce: (st) => `$((OWNER_NONCE+${st.nonce}))`, device_nonce: "$DEVICE_NONCE", filled: false };
  const device = results.accounts.device.public_key;
  const ownerIncluded = recordedIds(plan, results).filter((id) => planStepOf(plan, id).signer === "owner" && viewOf(results, id).final).length;
  return {
    run, device_ss58: results.accounts.device.ss58, device, session_key: sessionNonceKey(plan, plan.values.OWNER.value, device),
    owner_nonce: () => String(BigInt(results.owner_account_nonce_at_start) + BigInt(ownerIncluded)), device_nonce: String(deviceIncluded(plan, results)), filled: true,
  };
}

/** The pane and PC lines that send a signed bundle and record it, for an id. */
function sendAndRecord(id, v, bundle, sha, how = "send") {
  return [
    `#  pane, tab on the node (${NODE_TAB}):`,
    `window.__s = lab.${how}('${bundle}', "${sha}")`,
    "await window.__s   (its relay and relay_sha256)",
    "#  PC:",
    `node ${RECORD} step ${id} --run "${v.run}" --sent '<relay>' --sent-sha256 <relay_sha256>`,
    `#  pane, tab on the explorer (${EXPLORER_TAB}):`,
    `window.__e = explorer.read("<extrinsic_hash of signed/${id}.json>")`,
    "await window.__e   (its relay and relay_sha256)",
    "#  PC:",
    `node ${RECORD} step ${id} --run "${v.run}" --explorer '<relay>' --explorer-sha256 <relay_sha256>`,
  ];
}

/** The command lines of one id of a step (an attempt of a cleanup step is signed like the step). */
export function commandsOf(plan, st, results, v = lineValues(plan, null, null), id = st.id, again = false) {
  const head = `# ${id}: ${st.signer} signs with the ${st.tool}; expect ${st.expect === "success" ? "success" : "the outcome to be recorded"}${st.only_if ? `; only if ${condText(st.only_if)}` : ""}${st.after_block ? `; ${afterText(plan, st.after_block)}` : ""}`;
  if (st.tool === "encoder") {
    return [head,
      "#  mortal, 64 blocks: read, sign and send it within a minute",
      `#  pane, tab on the node (${NODE_TAB}):`,
      `window.__r = lab.deviceReads("${v.device_ss58}", "${v.session_key}")`,
      "await window.__r   (its relay and relay_sha256)",
      "#  PC:",
      `node ${SIGN_DEVICE} ${id} --run "${v.run}" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>${again ? " --again" : ""}`,
      ...sendAndRecord(id, v, "<the second line sign-device printed: the text of signed/" + id + ".send.json>", "<its send_sha256>"),
    ].join("\n");
  }
  const args = st.call.map((a) => (a === "$DEVICE" ? v.device : substitute(a, plan, results)));
  const nonce = st.signer === "owner" ? v.owner_nonce(st) : v.device_nonce;
  return [head,
    "#  immortal: never signed to different bytes",
    "#  PC:",
    `mkdir -p "${v.run}/calls" "${v.run}/signed"`,
    `node ${SIGNER} call ${args.map(q).join(" ")} > "${v.run}/calls/${id}.json"`,
    `node ${SIGNER} sign --key "${KEY[st.signer]}" --call "$(node -p 'require(process.argv[1]).call' "${v.run}/calls/${id}.json")" --nonce ${nonce} --out "${v.run}/signed/${id}.json" --spec ${plan.values.SPEC.value} --txv ${plan.values.TXV.value} --genesis ${plan.values.GENESIS.value}`,
    `node ${RECORD} send-file ${id} --run "${v.run}"`,
    ...sendAndRecord(id, v, `<the second line send-file printed: the text of signed/${id}.send.json>`, "<its send_sha256>"),
  ].join("\n");
}

/** Every step's command lines, with the header that says how to run them: the reader's list. */
export function commandsText(plan, results) {
  const head = [
    "# RUN is the run folder on the PC (record-step.mjs start makes its results.json); LAB is the repo checkout",
    "# KEY_OWNER and KEY_DEVICE name the key files; FLOP_SIGN_LIBS names the libraries (LAB/imd-flop)",
    "# OWNER_NONCE is the owner's next nonce at the start; DEVICE_NONCE the device's transactions included before T9",
    `# the node's tab: paste pane-runner.js, check its sha256, then: const lab = paneRunner.createRunner()`,
    `# the explorer's tab: paste explorer-reader.js, check its sha256, then: const explorer = explorerReader.createReader()`,
    "# a pane call ends after 45 s: keep each promise on window and read it in a second call",
    "# plan.mjs next --run \"$RUN\" prints the lines of the next step only, with every value filled",
    "", ""].join("\n");
  return head + plan.steps.map((st) => commandsOf(plan, st, results) + "\n\n").join("");
}

/** The send_outcomes row of a runner outcome, or null. */
export const outcomeRow = (plan, status, word = null) => (plan.send_outcomes ?? []).find((r) => r.outcome === status && (r.node_word ?? null) === (status === "ended" ? word : null)) ?? null;

/** What the lead does next, by the record of a run folder (R4): the next lines with every value filled, the stop row, or the wait. */
export function nextText(plan, run, results) {
  const n = nextOf(plan, results);
  const v = lineValues(plan, run, results);
  const out = [];
  if (n.word === "stop") out.push(`# stop at ${n.stopped_at}: ${n.row}`, `# cleanup steps that apply: ${n.cleanup.join(", ") || "none"}`);
  for (const f of n.findings) out.push(`# finding: ${f}`);
  for (const l of n.left) out.push(`# left: ${l}`);
  if (!n.step) { out.push(`# ${n.word === "stop" ? "the cleanup is done" : "go on"}: ${n.why}`); return out.join("\n") + "\n"; }
  const st = planStepOf(plan, n.step);
  if (n.word === "wait" && n.waiting === "outcome" && viewOf(results, n.step)) {
    const rt = viewOf(results, n.step).entry.run_time;
    out.push(`# wait: ${n.why}`, `#  pane, tab on the explorer (${EXPLORER_TAB}):`, `window.__e = explorer.read("${rt.extrinsic_hash}")`, "await window.__e   (its relay and relay_sha256)", "#  PC:",
      `node ${RECORD} step ${n.step} --run "${run}" --explorer '<relay>' --explorer-sha256 <relay_sha256>`);
    return out.join("\n") + "\n";
  }
  if (n.word === "wait" && n.waiting === "outcome") { out.push(`# wait: ${n.why}`); return out.join("\n") + "\n"; }
  if (n.word === "wait") {
    const rt = viewOf(results, n.step).entry.run_time;
    const row = outcomeRow(plan, rt.sent.status, rt.sent.node_status ?? null);
    const signed = readJson(signedFile(run, n.step));
    out.push(`# wait: ${n.why}`);
    if (row) out.push(`# known: ${row.known}`, `# the lead: ${row.lead}`, `# a second copy: ${row.second_copy}`);
    const from = signed.era?.birth_number ?? results.start.finalized.number;
    out.push(`#  pane, tab on the node (${NODE_TAB}): look for it in finalized blocks from ${signed.era ? "its birth block" : "the start of the run"}`, `window.__f = lab.find("${signed.extrinsic}", ${from})`, "await window.__f   (its relay and relay_sha256)", "#  PC, if it says finalized:",
      `node ${RECORD} step ${n.step} --run "${run}" --sent '<relay>' --sent-sha256 <relay_sha256>`);
    if (st.tool === "encoder") out.push(`#  if not found and the finalized head is above ${signed.era.last_valid_block}, its era is over: a second copy (S4)`, commandsOf(plan, st, results, v, n.step, true));
    else out.push("#  if not found: the same bytes again, never other bytes", ...sendAndRecord(n.step, v, `<the text of signed/${n.step}.send.json>`, "<its sha256>", "sendSame"));
    return out.join("\n") + "\n";
  }
  const after = afterBlockOf(plan, st, results);
  if (after !== null && typeof after === "number") out.push(`# ${n.step} is signed only from a birth block above ${after}`);
  out.push(commandsOf(plan, st, results, v, n.step));
  return out.join("\n") + "\n";
}

/** The empty results form. */
export function template(plan) {
  const account = () => ({ free: null, reserved: null, nonce: null, absent: null });
  const state = () => ({ accounts: { owner: account(), device: account() }, session: { active: null, spent_raw: null, epoch_spent_raw: null }, session_nonce: null, breaker_tx_count: null });
  return {
    schema: "encoder-devnet-test/results@1",
    what: "The record of the batch. record-step.mjs start makes it from this form as a run time record, and record-step.mjs step writes each step's run_time from what the pane relayed. Nothing in it is called verified. A block is called finalized only where the node reported it so, with the block hash beside it. No balance is written at run time. The final record (record \"final\", balances_source \"decoder\" or \"by position\") is filled later from an observatory recording; check.mjs says what is missing. Unknown stays null, never 0.",
    record: "run-time",
    balances_source: null,
    spec_version: plan.spec_version,
    chain: { genesis: plan.values.GENESIS.value, rpc: plan.values.RPC.value, explorer: plan.values.EXPLORER.value, spec_name_at_start: null, spec_version_at_start: null, transaction_version_at_start: null },
    accounts: { owner: { public_key: null, ss58: null }, device: { public_key: null, ss58: null } },
    owner_account_nonce_at_start: null,
    start: null,
    before: { block_number: null, block_hash: null, ...state(), raw_reads: {} },
    steps: plan.steps.map((st) => ({
      step: st.id, signer: null, account_nonce: null, call: null, extrinsic_hash: null,
      era: st.tool === "encoder" ? { birth_number: null, birth_hash: null, last_valid_block: null } : "immortal",
      submitted_utc: null, finalized_in_block: null, block_hash: null, extrinsic_index: null,
      last_runtime_upgrade_spec: null, events_value_sha256: null, events: [], result: null, fee_raw: null,
      after: state(), raw_reads: {}, note: null, run_time: null,
    })),
    run_time_form: "run_time of a step: { extrinsic_hash and bundle_sha256 of the file in signed/ that was sent, sent: the runner's relay text read back (status, block_hash, block_number, extrinsic_index, events_sha256, events_length, ...), sent_sha256, explorer: null or { source, read_utc, hash, block_hash, success, error: null or { pallet_index, error_index, name }, names, events, relay_sha256 }, earlier_readings: the readings it replaced that held no finalized block, earlier_copies: the copies --again retired }. An attempt of a cleanup step (S5) is its own entry, step \"T6.2\".",
    events_form: "events of this extrinsic only, in order, as { pallet, name, fields }: field names as facts-1014020.json gives them, amounts as decimal strings, accounts and hashes as 0x lower case hex. An ExtrinsicFailed carries fields.dispatch_error = { type: \"Module\", value: { index: <pallet index>, error: \"0x<4 bytes>\" } }.",
    reads_form: "after: the reads at the finalized block that holds the step. An account is { free, reserved, nonce } as decimal strings, or { absent: true } when the node holds no System.Account for it. session.active \"true\" or \"false\". raw_reads: each storage key read and the node's answer, 0x hex or null, as pane-runner.js returned it.",
  };
}

/** The blocks of plan.md that plan.mjs prints, by the name in their marker. */
export function printedBlocks(plan) {
  return { table: table(plan), costs: costsText(plan), stops: stopsText(plan), commands: "```\n" + commandsText(plan, null).trimEnd() + "\n```" };
}
const MARK = /<!-- printed by plan\.mjs: ([a-z_]+) -->\n([\s\S]*?)\n<!-- end of printed -->/g;
/** The printed blocks plan.md holds now, by name. */
export const blocksIn = (md) => Object.fromEntries([...md.matchAll(MARK)].map((m) => [m[1], m[2]]));
/** plan.md with every printed block made again from steps.json; a marker plan.mjs does not know is an error. */
export function renderMd(md, plan) {
  const b = printedBlocks(plan);
  return md.replace(MARK, (all, name) => {
    if (!(name in b)) throw new Error(`plan.md has a printed block ${name} plan.mjs does not print`);
    return `<!-- printed by plan.mjs: ${name} -->\n${b[name]}\n<!-- end of printed -->`;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const plan = loadPlan();
  const cmd = argv[0];
  if (cmd === "table") console.log(table(plan));
  else if (cmd === "costs") console.log(costsText(plan));
  else if (cmd === "stops") console.log(stopsText(plan));
  else if (cmd === "commands") process.stdout.write(commandsText(plan, null));
  else if (cmd === "next") { const run = resolve(flag("run") ?? (process.stderr.write("plan.mjs next --run <run folder>\n"), process.exit(2))); const r = loadRecord(run); if (!r) { process.stderr.write("the run folder has no results.json: make it with record-step.mjs start\n"); process.exit(2); } process.stdout.write(nextText(plan, run, r)); }
  else if (cmd === "template") console.log(JSON.stringify(template(plan), null, 1));
  else if (cmd === "md") { const f = join(HERE, "plan.md"); writeFileSync(f, renderMd(readFileSync(f, "utf8"), plan)); }
  else { process.stderr.write("commands: table, costs, stops, commands, next, template, md\n"); process.exit(2); }
}
export const errorsOf = () => readJson(join(RERUN, "errors-1014020.json"));
