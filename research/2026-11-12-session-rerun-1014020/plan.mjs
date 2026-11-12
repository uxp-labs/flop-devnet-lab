#!/usr/bin/env node
// plan: turns steps.json into what the lead needs. No network, no key, signs nothing.
//   node plan.mjs commands [--results <results.json>] [--fo-out <folder>]
//        prints, for each step, the flop-sign.mjs command lines that make and sign it. With a
//        results file whose accounts are filled, DEV1, DEV2 and the owner's nonce are put in, and
//        with --fo-out the three force_open files are written there. Without, they stay $NAMES.
//   node plan.mjs totals      the number of transactions, the fee estimate and what moves
//   node plan.mjs table       the transactions as the markdown table of plan.md
//   node plan.mjs template    the empty results form (results.template.json is its output)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlan, readJson, substitute, fromSource, earlierFee, READ_KEYS } from "./rerun-lib.mjs";

const SIGNER = "\"$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs\"";
const KEY = { owner: "$KEY_OWNER", dev1: "$KEY_DEV1", dev2: "$KEY_DEV2" };
const FLOP = 10n ** 18n;
const flopText = (raw) => { const f = (raw % FLOP).toString().padStart(18, "0").replace(/0+$/, ""); return `${raw / FLOP}${f ? "." + f : ""}`; };

/** The force_open file of a name in steps.json, with every field from a value or a recorded account. */
export function forceOpenFile(plan, name, results, strict = true) {
  const spec = plan.force_open_files[name];
  const s = (t) => substitute(t, plan, results, strict);
  const escrow = s(spec.escrow);
  if (strict && BigInt(escrow) >= BigInt(plan.values.MIN_FAILED_ACK.value)) throw new Error(`${name}: an escrow of ${escrow} would count against the named miner`);
  return { miner: s("$NAMED"), model_hash: s("$MODEL"), measured_root: s("$ROOT"), decode_policy_hash: s("$POLICY"), agent_key: s(spec.agent_key), precision: s("$PRECISION"),
    max_turns: Number(s("$MAX_TURNS")), max_duration: Number(s("$MAX_DURATION")), reattest_every: Number(s("$REATTEST")), escrow, nonce: s(spec.nonce) };
}

/** The command lines of one step, as text. */
export function commandsOf(plan, step, results) {
  const q = (a) => (/^[A-Za-z0-9_:.,\/=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  const args = step.call.map((a) => substitute(a, plan, results));
  const start = step.signer === "owner" ? results?.owner_account_nonce_at_start : "0";
  const nonce = /^(0|[1-9][0-9]*)$/.test(start ?? "") ? String(BigInt(start) + BigInt(step.nonce)) : `$((OWNER_NONCE+${step.nonce}))`;
  return [
    `# ${step.id}: signed by the ${step.signer} key, account nonce ${nonce}, expect ${step.expect}`,
    `node ${SIGNER} call ${args.map(q).join(" ")} > calls/${step.id}.json`,
    `node ${SIGNER} sign --key ${KEY[step.signer]} --call "$(node -p 'require("./calls/${step.id}.json").call')" --nonce ${nonce} --out signed/${step.id}.json --spec ${plan.spec_version} --txv ${plan.values.TXV.value} --genesis ${plan.values.GENESIS.value}`,
  ].join("\n");
}

/** Every step's command lines, with the header that says how to run them. */
export function commandsText(plan, results) {
  const head = `# run in a working folder outside the repo that holds the force_open files (--fo-out), after: mkdir calls signed\n# LAB is the repo checkout; KEY_OWNER, KEY_DEV1, KEY_DEV2 name the key files; FLOP_SIGN_LIBS names the libraries\n# a $NAME in single quotes is not known yet: the signer refuses it. Rerun with --results once it is recorded.\n\n`;
  return head + plan.steps.map((st) => commandsOf(plan, st, results) + "\n\n").join("");
}

/** Counts, fees and amounts of the plan, all as raw strings. */
export function totals(plan) {
  const by = {};
  let fee = 0n;
  for (const st of plan.steps) {
    by[st.signer] = (by[st.signer] ?? 0) + 1;
    fee += BigInt(earlierFee(plan, st.fee_like));
  }
  const v = (n) => BigInt(plan.values[n].value);
  return { transactions: plan.steps.length, by_signer: by, fee_estimate_raw: fee.toString(),
    sent_to_devices_raw: v("FUND").toString(), escrow_locked_raw: v("ESCROW_1").toString(), escrow_locked_for_blocks_at_least: plan.values.ACK_WINDOW.value,
    owner_net_cost_estimate_raw: fee.toString(),
    owner_before_raw: fromSource(plan, { file: "deny", path: "owner_balance.after_raw" }),
    owner_after_estimate_raw: (BigInt(fromSource(plan, { file: "deny", path: "owner_balance.after_raw" })) - fee).toString() };
}

/** The plan's transactions as a markdown table, with each expected refusal's indexes read from the error table. */
export function table(plan, errors) {
  const amt = (t) => { const v = substitute(t, plan, null); return /^(0|[1-9][0-9]*)$/.test(v) ? `${v} (${flopText(BigInt(v))} FLOP)` : v; };
  const rows = plan.steps.map((st) => {
    let expect = "success";
    if (st.expect !== "success") {
      const [p, n] = st.expect.split(".");
      const e = errors.errors.find((x) => x.pallet === p && x.name === n);
      expect = `refused: ${st.expect} (pallet ${e.pallet_index}, error ${e.error_index})`;
    }
    const inner = st.call[0] === "via-session" ? ` ${st.call[st.call.indexOf("--inner") + 1].replace(/:.*$/, (m) => (m.length > 24 ? m.slice(0, 1) + "…" : m))}` : "";
    const moves = st.moves.length ? st.moves.map((m) => `${amt(m.amount)} ${m.from} to ${m.to}; ${m.comes_back}`).join("<br>") : "nothing";
    return `| ${st.id} | ${st.signer} | ${st.call[0]}${inner} | ${moves} | ${st.declared === null ? "none" : amt(st.declared)} | ${expect} | ${st.on_unexpected} |`;
  });
  return ["| # | Signs | Call | Moves | Declared | Expected | If not |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

/** The totals as printed, raw and in FLOP. */
export function totalsText(plan) {
  const t = totals(plan);
  const f = (k) => flopText(BigInt(t[k + "_raw"]));
  return JSON.stringify({ ...t, fee_estimate_flop: f("fee_estimate"), sent_to_devices_flop: f("sent_to_devices"), escrow_locked_flop: f("escrow_locked"), owner_before_flop: f("owner_before"), owner_after_estimate_flop: f("owner_after_estimate") }, null, 1);
}

/** The empty results form. */
export function template(plan) {
  const acct = { public_key: null, ss58: null };
  return {
    schema: "session-rerun-1014020/results@0",
    what: "Filled by the lead while running steps.json. Every null is filled or left null; check.mjs says what is missing.",
    spec_version: plan.spec_version,
    chain: { genesis: plan.values.GENESIS.value, rpc: null, metadata_sha256_at_start: null, spec_version_at_start: null },
    accounts: { owner: { ...acct }, dev1: { ...acct }, dev2: { ...acct } },
    owner_account_nonce_at_start: null,
    owner_free_balance_raw: { before: null, after: null },
    steps: plan.steps.map((st) => ({
      step: st.id, signer: null, account_nonce: null, call: null, extrinsic_hash: null, finalized_in_block: null, block_hash: null, extrinsic_index: null,
      last_runtime_upgrade_spec: null, events_value_sha256: null, events: [], result: null, fee_raw: null,
      reads_after: Object.fromEntries(Object.keys(st.reads_after ?? {}).map((k) => [k, null])), utc: null, note: null,
    })),
    events_form: "events of this extrinsic only, in order, as { pallet, name, fields }: field names as facts-1014020.json gives them, amounts and numbers as decimal strings or numbers, accounts and hashes as 0x lower case hex. An ExtrinsicFailed carries fields.dispatch_error = { type: \"Module\", value: { index: <pallet index>, error: \"0x<4 bytes>\" } }.",
    reads_form: `reads_after keys: ${READ_KEYS.join(", ")}. Values as decimal strings; session_active "true" or "false"; failed_acks_of_named "absent" or the stored value; delegate_sessions_of_device "empty" or the stored value.`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const plan = loadPlan();
  const cmd = argv[0];
  if (cmd === "commands") {
    const results = flag("results") ? readJson(flag("results")) : null;
    const foOut = flag("fo-out");
    if (foOut) {
      if (!results) { process.stderr.write("plan: --fo-out needs --results with the device keys\n"); process.exit(2); }
      mkdirSync(foOut, { recursive: true });
      for (const name of Object.keys(plan.force_open_files)) {
        const p = join(foOut, name);
        if (existsSync(p)) { process.stderr.write(`plan: ${p} exists\n`); process.exit(2); }
        writeFileSync(p, JSON.stringify(forceOpenFile(plan, name, results), null, 1) + "\n", { flag: "wx" });
      }
    }
    process.stdout.write(commandsText(plan, results));
  } else if (cmd === "totals") {
    console.log(totalsText(plan));
  } else if (cmd === "table") {
    console.log(table(plan, readJson(new URL("./errors-1014020.json", import.meta.url))));
  } else if (cmd === "template") {
    console.log(JSON.stringify(template(plan), null, 1));
  } else { process.stderr.write("commands: commands, totals, table, template\n"); process.exit(2); }
}
// fromSource is used by the test that every value matches its source.
export { fromSource };
