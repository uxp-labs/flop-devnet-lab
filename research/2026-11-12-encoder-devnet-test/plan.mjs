#!/usr/bin/env node
// plan: turns steps.json into what the lead needs. No network, no key, signs nothing.
//   node plan.mjs table       the steps as the table of plan.md
//   node plan.mjs costs       the fee of each step and the escrows, as the tables of plan.md
//   node plan.mjs stops       what the lead does on each stop, and what is left, as the table of plan.md
//   node plan.mjs commands [--results <results.json>]
//        the command lines of every step: the research signer's for the owner's calls and the sweep,
//        sign-device.mjs and the pane for the device's calls. With a results file, the device's
//        account and the owner's nonce are put in; without, they stay $NAMES.
//   node plan.mjs template    the empty results form (results.template.json is its output)
import { join } from "node:path";
import { RERUN, loadPlan, readJson, substitute, rerunFee, flopText, RAW } from "./lib.mjs";

const SIGNER = "\"$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs\"";
const SIGN_DEVICE = "\"$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs\"";
const KEY = { owner: "$KEY_OWNER", device: "$KEY_DEVICE" };

const amt = (plan, t) => { const v = substitute(t, plan, null); return RAW.test(v) ? `${v} (${flopText(v)} FLOP)` : v; };
const condText = (c) => (c.event ? `${c.step} recorded ${c.event}` : `${c.step} succeeded`);
const afterText = (plan, a) => (a.event ? `after block ${a.event}` : `after the block of ${a.step} plus ${substitute(a.plus, plan, null, true)} blocks`);

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

/** The command lines of one step. */
export function commandsOf(plan, st, results) {
  const q = (a) => (/^[A-Za-z0-9_:.,\/=$-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  const head = `# ${st.id}: ${st.signer} signs with the ${st.tool}; expect ${st.expect === "success" ? "success" : "the outcome to be recorded"}${st.only_if ? `; only if ${condText(st.only_if)}` : ""}${st.after_block ? `; ${afterText(plan, st.after_block)}` : ""}`;
  const pane = `#    in the pane: await lab.send(<text of signed/${st.id}.json>, "<its sha256, printed above>")`;
  if (st.tool === "encoder") {
    const chan = /\$T\d/.test(JSON.stringify(st.inner)) ? "; the channel id is taken from results.json" : "";
    return [head,
      `#    in the pane, moments before: copy(JSON.stringify(await lab.deviceReads("$DEVICE", "<session_nonce key of flop-sign.mjs keys>")))`,
      `node ${SIGN_DEVICE} ${st.id} --key ${KEY.device} --results results.json --reads '<what deviceReads printed>'${chan ? `  ${chan}` : ""}`,
      pane].join("\n");
  }
  const args = st.call.map((a) => substitute(a, plan, results));
  let nonce;
  if (st.signer === "owner") {
    const start = results?.owner_account_nonce_at_start;
    nonce = RAW.test(start ?? "") ? String(BigInt(start) + BigInt(st.nonce)) : `$((OWNER_NONCE+${st.nonce}))`;
  } else nonce = "$DEVICE_NONCE";
  return [head,
    `node ${SIGNER} call ${args.map(q).join(" ")} > calls/${st.id}.json`,
    `node ${SIGNER} sign --key ${KEY[st.signer]} --call "$(node -p 'require("./calls/${st.id}.json").call')" --nonce ${nonce} --out signed/${st.id}.json --spec ${plan.values.SPEC.value} --txv ${plan.values.TXV.value} --genesis ${plan.values.GENESIS.value}`,
    `sha256sum signed/${st.id}.json`,
    pane].join("\n");
}

/** Every step's command lines, with the header that says how to run them. */
export function commandsText(plan, results) {
  const head = [
    "# run in a working folder outside the repo, after: mkdir calls signed",
    "# LAB is the repo checkout; KEY_OWNER and KEY_DEVICE name the key files; FLOP_SIGN_LIBS names the libraries (LAB/imd-flop)",
    "# OWNER_NONCE is the owner's account nonce read before T1; DEVICE_NONCE the device's, read before T9",
    `# the pane: paste pane-runner.js, then: const lab = paneRunner.createRunner({ transport: paneRunner.wsTransport("${plan.values.RPC.value}"), eventsKey: "${plan.values.EVENTS_KEY.value}" })`,
    "# the research signer signs immortal; sign-device.mjs signs mortal, 64 blocks: read, sign and send it within a minute",
    "", ""].join("\n");
  return head + plan.steps.map((st) => commandsOf(plan, st, results) + "\n\n").join("");
}

/** The empty results form. */
export function template(plan) {
  const account = () => ({ free: null, reserved: null, nonce: null, absent: null });
  const state = () => ({ accounts: { owner: account(), device: account() }, session: { active: null, spent_raw: null, epoch_spent_raw: null }, session_nonce: null, breaker_tx_count: null });
  return {
    schema: "encoder-devnet-test/results@0",
    what: "Filled by the lead while running steps.json. Every null is filled or left null; check.mjs says what is missing. Unknown stays null, never 0.",
    spec_version: plan.spec_version,
    chain: { genesis: plan.values.GENESIS.value, rpc: plan.values.RPC.value, spec_name_at_start: null, spec_version_at_start: null, transaction_version_at_start: null },
    accounts: { owner: { public_key: null, ss58: null }, device: { public_key: null, ss58: null } },
    owner_account_nonce_at_start: null,
    before: { block_number: null, block_hash: null, ...state(), raw_reads: {} },
    steps: plan.steps.map((st) => ({
      step: st.id, signer: null, account_nonce: null, call: null, extrinsic_hash: null,
      era: st.tool === "encoder" ? { birth_number: null, birth_hash: null, last_valid_block: null } : "immortal",
      submitted_utc: null, finalized_in_block: null, block_hash: null, extrinsic_index: null,
      last_runtime_upgrade_spec: null, events_value_sha256: null, events: [], result: null, fee_raw: null,
      after: state(), raw_reads: {}, note: null,
    })),
    events_form: "events of this extrinsic only, in order, as { pallet, name, fields }: field names as facts-1014020.json gives them, amounts as decimal strings, accounts and hashes as 0x lower case hex. An ExtrinsicFailed carries fields.dispatch_error = { type: \"Module\", value: { index: <pallet index>, error: \"0x<4 bytes>\" } }.",
    reads_form: "after: the reads at the finalized block that holds the step. An account is { free, reserved, nonce } as decimal strings, or { absent: true } when the node holds no System.Account for it. session.active \"true\" or \"false\". raw_reads: each storage key read and the node's answer, 0x hex or null, as pane-runner.js returned it.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const plan = loadPlan();
  const cmd = argv[0];
  if (cmd === "table") console.log(table(plan));
  else if (cmd === "costs") console.log(costsText(plan));
  else if (cmd === "stops") console.log(stopsText(plan));
  else if (cmd === "commands") process.stdout.write(commandsText(plan, flag("results") ? readJson(flag("results")) : null));
  else if (cmd === "template") console.log(JSON.stringify(template(plan), null, 1));
  else { process.stderr.write("commands: table, costs, stops, commands, template\n"); process.exit(2); }
}
export const errorsOf = () => readJson(join(RERUN, "errors-1014020.json"));
