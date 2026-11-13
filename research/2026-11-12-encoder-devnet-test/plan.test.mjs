// Tests of the plan as data (rules R1, R5, R8, R9, R10): node --test in this folder. No network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, RERUN, readJson, loadPlan, fromSource, computed, substitute, stepOf, RAW, channelId, ss58, fromSs58 } from "./lib.mjs";

const plan = loadPlan();
const V = (n) => plan.values[n].value;
const errors = readJson(join(RERUN, "errors-1014020.json"));
const facts = readJson(join(RERUN, "facts-1014020.json"));
const rerun = readJson(join(RERUN, "results.json"));

test("R10: every value names its source and equals what that file and field give, or is decided or computed with a reason", () => {
  for (const [name, v] of Object.entries(plan.values)) {
    const kinds = ["from", "decided", "computed"].filter((k) => k in v);
    assert.equal(kinds.length, 1, `${name} must have exactly one of from, decided, computed`);
    if (v.from) assert.equal(fromSource(plan, v.from), v.value, `${name} differs from ${v.from.file} ${v.from.path}`);
    if (v.same_as) assert.equal(fromSource(plan, v.same_as), v.value, `${name} differs from ${v.same_as.file} ${v.same_as.path}`);
    if (v.computed) { assert.equal(computed(plan, v.computed), v.value, `${name} is not what its computation gives`); assert.ok(v.why, `${name} says why`); }
    if (v.decided) assert.ok(v.decided.length > 20, `${name} says why it was decided`);
  }
});

test("R10: every $NAME in the steps is a value, DEVICE, or a field of an earlier step's event", () => {
  const ids = plan.steps.map((s) => s.id);
  const walk = (x, at, id) => {
    if (typeof x === "string") {
      for (const [, name] of x.matchAll(/\$([A-Z][A-Za-z0-9_.]*)/g)) {
        if (name === "DEVICE" || name in plan.values) continue;
        const [step, pallet, event, field] = name.split(".");
        assert.ok(ids.indexOf(step) >= 0 && ids.indexOf(step) < ids.indexOf(id), `${id} ${at}: ${name} is not an earlier step`);
        const ev = facts.events[pallet]?.events.find((e) => e.name === event);
        assert.ok(ev && ev.fields.includes(field), `${id} ${at}: no event field ${pallet}.${event}.${field} at spec 1014020`);
      }
    } else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`, id);
  };
  for (const st of plan.steps) walk(st, "", st.id);
});

test("the device's fund covers its transactions at the rerun's largest fee, with the stated margin", () => {
  const max = rerun.steps.reduce((m, s) => (BigInt(s.fee_raw) > m ? BigInt(s.fee_raw) : m), 0n);
  assert.equal(plan.values.MAX_FEE.value, max.toString(), "MAX_FEE is the largest fee the rerun recorded");
  const r = plan.fund_rule;
  assert.deepEqual(r.transactions_of_the_device, plan.steps.filter((s) => s.signer === "device").map((s) => s.id));
  const need = BigInt(r.margin_times) * BigInt(r.transactions_of_the_device.length) * BigInt(plan.values[r.fee_each].value);
  assert.ok(BigInt(plan.values.FUND.value) >= need, `FUND ${plan.values.FUND.value} is below ${need}`);
});

test("the steps are T1 to T9 with the brief's signer, tool and expectation", () => {
  const want = {
    T1: ["owner", "research-signer", "success"], T2: ["owner", "research-signer", "success"],
    T3: ["device", "encoder", "success"], T4: ["device", "encoder", "recorded"], T5: ["device", "encoder", "recorded"],
    T6: ["device", "encoder", "success"], T7: ["device", "encoder", "success"], T8: ["owner", "research-signer", "success"], T9: ["device", "research-signer", "success"],
  };
  assert.deepEqual(plan.steps.map((s) => s.id), Object.keys(want));
  for (const s of plan.steps) assert.deepEqual([s.signer, s.tool, s.expect], want[s.id], s.id);
  assert.deepEqual(plan.steps.map((s) => s.inner?.call ?? s.call[0]), ["transfer", "create-session", "force_open", "top_up_escrow", "open_channel", "expire_force_open", "timeout", "revoke", "sweep"]);
});

test("R2: the declared spend of each encoder step is what the encoder computes: the escrow, the top up, or 0", () => {
  const field = { force_open: "escrow", open_channel: "escrow", top_up_escrow: "additional", expire_force_open: null, timeout: null };
  for (const s of plan.steps.filter((x) => x.tool === "encoder")) {
    const f = field[s.inner.call];
    assert.equal(s.declared, f === null ? "0" : s.inner[f], s.id);
  }
  assert.equal(stepOf(plan, "T3").declared, "$ESCROW_1");
});

test("the session caps hold every spend of the batch, and the escrows stay below the failed ack floor", () => {
  const v = (n) => BigInt(plan.values[n].value);
  const spends = plan.steps.filter((s) => s.tool === "encoder").map((s) => BigInt(substitute(s.declared, plan, null, true)));
  for (const x of spends) assert.ok(x <= v("A_PER_TX"));
  const sum = spends.reduce((a, b) => a + b, 0n);
  assert.ok(sum <= v("A_DAILY") && sum <= v("A_CAP"), `the batch declares ${sum}`);
  assert.ok(v("ESCROW_1") + v("TOP_UP") < v("MIN_FAILED_ACK"), "the escrow of T3 with its top up would count against the named account");
  const d2 = Number(plan.values.MAX_DURATION_D2.value);
  assert.ok(d2 >= 1 && d2 <= Number(plan.values.MAX_UNCONSENTED.value) && d2 < Number(plan.values.ACK_WINDOW.value));
  assert.ok(Number(plan.values.MAX_TURNS.value) <= Number(plan.values.MAX_SETTLEMENT_TURNS.value));
});

test("every expected event, field and finding exists at spec 1014020", () => {
  for (const st of plan.steps) {
    for (const w of [...(st.events ?? []), ...(st.events_if_success ?? [])]) {
      const [p, n] = w.event.split(".");
      const ev = facts.events[p]?.events.find((e) => e.name === n);
      assert.ok(ev, `${st.id}: no event ${w.event}`);
      for (const f of Object.keys(w.fields)) assert.ok(ev.fields.includes(f), `${st.id}: ${w.event} has no field ${f}`);
    }
    for (const e of Object.keys(st.finding_if ?? {})) { const [p, n] = e.split("."); assert.ok(errors.errors.some((x) => x.pallet === p && x.name === n), e); }
    for (const p of st.errors_allowed_of ?? []) assert.ok(errors.errors.some((x) => x.pallet === p), p);
    if (st.refund_event) { const [p, n, f] = st.refund_event.split("."); assert.ok(facts.events[p].events.find((e) => e.name === n).fields.includes(f)); }
  }
});

test("R8: every step says what the lead does on an unexpected answer, and the cleanup steps are T6 to T9", () => {
  for (const s of plan.steps) assert.ok(["stop", "continue"].includes(s.on_unexpected), s.id);
  assert.deepEqual(plan.steps.filter((s) => s.cleanup).map((s) => s.id), ["T6", "T7", "T8", "T9"]);
  for (const s of plan.steps.filter((x) => x.cleanup)) assert.ok(s.only_if, `${s.id} says when it is needed`);
});

test("R9: every fee estimate names a like step of the rerun, or none", () => {
  for (const s of plan.steps) if (s.fee_like !== null) assert.match(rerun.steps.find((x) => x.step === s.fee_like)?.fee_raw ?? "", RAW, s.id);
  assert.deepEqual(plan.steps.filter((s) => s.fee_like === null).map((s) => s.id), ["T4", "T5"]);
});

test("the owner's account nonces follow one another", () => {
  assert.deepEqual(plan.steps.filter((s) => s.signer === "owner").map((s) => s.nonce), [0, 1, 2]);
  for (const s of plan.steps.filter((x) => x.signer === "device")) assert.equal(s.nonce, undefined, `${s.id}: a device nonce is read from the chain`);
});

// ---- plan.mjs and plan.md ----------------------------------------------------------------------
import { table, costsText, stopsText, commandsText, costs, printedBlocks, blocksIn, outcomesText, caps, capsText, ANSWER_KINDS, pastedSha256 } from "./plan.mjs";
import { nextOf } from "./judge.mjs";
import { asPlanned } from "./fixtures.mjs";
import vm from "node:vm";

test("R1: plan.md holds every block plan.mjs prints, exactly, and nothing else between the markers", () => {
  const md = readFileSync(join(HERE, "plan.md"), "utf8");
  const want = printedBlocks(plan), got = blocksIn(md);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const k of Object.keys(want)) assert.equal(got[k], want[k], `the printed block ${k}: run node plan.mjs md`);
});

test("R1: a change to steps.json shows in the printed table", () => {
  const changed = structuredClone(plan);
  changed.values.ESCROW_1.value = "20000000000000000";
  assert.notEqual(table(changed), table(plan));
});

test("R5: the owner's calls and the sweep are research signer command lines, immortal, with the spec, version and genesis of steps.json, and a short send file", () => {
  const text = commandsText(plan, null);
  for (const st of plan.steps.filter((s) => s.tool === "research-signer")) {
    const block = text.split("\n\n").find((b) => b.startsWith(`# ${st.id}:`));
    assert.ok(block.includes(`flop-sign.mjs" call ${st.call[0]}`), st.id);
    assert.ok(block.includes(`--spec ${plan.values.SPEC.value} --txv ${plan.values.TXV.value} --genesis ${plan.values.GENESIS.value}`), st.id);
    assert.ok(block.includes(`record-step.mjs" send-file ${st.id} --run "$RUN"`), st.id);
    assert.ok(block.includes("immortal"), st.id);
    assert.ok(!block.includes("sign-device.mjs"), st.id);
  }
});

test("R2 S1: the device's session calls are command lines for sign-device.mjs only, in the run folder", () => {
  const text = commandsText(plan, null);
  for (const st of plan.steps.filter((s) => s.tool === "encoder")) {
    const block = text.split("\n\n").find((b) => b.startsWith(`# ${st.id}:`));
    assert.ok(block.includes(`sign-device.mjs" ${st.id} --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>`), st.id);
    assert.ok(!block.split("\n").some((l) => l.startsWith(`node ${"\""}$LAB/research/2026-11-11`)), st.id);
  }
});

test("R8 P4: after a stop the judge sends the cleanup steps whose condition stands, never a later test step", () => {
  const errs = readJson(join(RERUN, "errors-1014020.json"));
  const DEV = "0x" + "d9".repeat(32);
  const stopAt = (id, err) => nextOf(plan, asPlanned(DEV, id, { outcomes: { [id]: err }, errors: errs }).results);
  assert.deepEqual(stopAt("T1", "FlopSessionKeys.SessionNotFound").cleanup, []);
  assert.deepEqual(stopAt("T2", "FlopSessionKeys.SessionNotFound").cleanup, ["T9"]);
  assert.deepEqual(stopAt("T3", "ComputeChannel.BadState").cleanup, ["T8", "T9"]);
  const t5 = asPlanned(DEV, "T5").results;
  t5.steps.find((x) => x.step === "T5").run_time.explorer.success = false;
  t5.steps.find((x) => x.step === "T5").run_time.explorer.error = { pallet_index: 4, error_index: 2, name: null };
  t5.steps.find((x) => x.step === "T5").run_time.explorer.names = ["System.ExtrinsicFailed"]; // F2: the names agree with success
  const n = nextOf(plan, t5);
  assert.equal(n.stopped_at, "T5");
  assert.deepEqual(n.cleanup, ["T6", "T8", "T9"], "T7 does not apply: T5 opened nothing");
  assert.equal(n.step, "T6");
});

test("P4: the stop table has a row for every cell of the reviewer's table F, and one for a lapsed session, each saying what is on chain and what brings it back", () => {
  const F = readFileSync(join(HERE, "REVIEW-PROGRESS.md"), "utf8").split("## Table F")[1];
  const answers = /^Answers: (.*)$/m.exec(F)[1].split(/, (?![^(]*\))/).map((a) => a.split(" ")[0]);
  assert.deepEqual([...new Set(answers)], ["ok", "err", "sub", "nf", "none"], "the answers of table F");
  for (const st of plan.steps) for (const a of ANSWER_KINDS) {
    const rows = plan.stop_table.filter((r) => r.step === st.id && r.answer === a);
    assert.equal(rows.length, 1, `${st.id} ${a}`);
    assert.ok(rows[0].on_chain.length > 10 && rows[0].brings_back.length > 3, `${st.id} ${a} says something`);
  }
  const lapsed = plan.stop_table.filter((r) => r.answer === "lapsed");
  assert.equal(lapsed.length, 1);
  assert.match(lapsed[0].brings_back, /the owner's own call/);
  assert.match(lapsed[0].brings_back, /later piece of work/);
  assert.equal(plan.stop_table.length, plan.steps.length * ANSWER_KINDS.length + 1);
  for (const r of plan.stop_table.filter((x) => x.answer !== "lapsed" && x.answer !== "ok" && x.answer !== "err")) {
    const mortal = plan.steps.find((s) => s.id === r.step).tool === "encoder";
    if (mortal && r.answer !== "sub") assert.match(r.brings_back, /last valid block|S4/, `${r.step} ${r.answer}`);
    if (!mortal) assert.doesNotMatch(r.brings_back, /S4/, `${r.step} ${r.answer}: an immortal step has no second copy`);
  }
  const t = stopsText(plan);
  for (const r of plan.stop_table) assert.ok(t.includes(r.on_chain), `${r.step} ${r.answer} is printed`);
});

test("P2: send_outcomes has a row for every outcome the runner lists, and one for each node word that ends a watch", () => {
  const src = readFileSync(join(HERE, "pane-runner.js"), "utf8");
  const g = { crypto: globalThis.crypto, TextEncoder };
  vm.runInNewContext(src, g);
  const outcomes = [...g.paneRunner.OUTCOMES];
  const ends = Object.entries(g.paneRunner.STATUSES).filter(([, k]) => k === "end").map(([w]) => w);
  assert.ok(ends.length === 4);
  for (const o of outcomes) {
    if (o === "ended") for (const w of ends) assert.equal(plan.send_outcomes.filter((r) => r.outcome === "ended" && r.node_word === w).length, 1, `ended ${w}`);
    else assert.equal(plan.send_outcomes.filter((r) => r.outcome === o).length, 1, o);
  }
  assert.deepEqual([...new Set(plan.send_outcomes.map((r) => r.outcome))].sort(), [...outcomes].sort(), "no row for an outcome the runner does not give");
  for (const r of plan.send_outcomes) for (const k of ["known", "lead", "second_copy"]) assert.ok(r[k]?.length > 3, `${r.outcome} ${r.node_word ?? ""} ${k}`);
  for (const r of plan.send_outcomes.filter((x) => !/^(never|not needed)/.test(x.second_copy))) assert.match(r.second_copy, /S4/, `${r.outcome}: a mortal copy only by S4`);
  const md = readFileSync(join(HERE, "plan.md"), "utf8");
  assert.ok(md.includes(outcomesText(plan)));
  assert.match(md, /An immortal step \(T1, T2, T8, T9\) is never signed to different\s+bytes: the lead uses `lab.find`, then `lab.sendSame`/);
});

test("P3: the caps per device step, computed from steps.json: declared spend, per transaction limit, running sums against the daily and the session cap, and the cap that binds", () => {
  const c = caps(plan);
  assert.deepEqual(c.map((x) => x.id), ["T3", "T4", "T5", "T6", "T7"]);
  assert.deepEqual(c.map((x) => x.sum), ["10000000000000000", "11000000000000000", "21000000000000000", "21000000000000000", "21000000000000000"]);
  assert.deepEqual(c.map((x) => x.binds), ["per transaction limit", "daily cap", "daily cap", "daily cap", "daily cap"]);
  assert.ok(c.every((x) => x.within));
  assert.equal(c[2].daily_left, String(BigInt(V("A_DAILY")) - 21000000000000000n));
  const tight = structuredClone(plan); tight.values.A_DAILY.value = "20000000000000000";
  assert.equal(caps(tight)[2].within, false, "a daily cap below the sum is caught");
  assert.ok(readFileSync(join(HERE, "plan.md"), "utf8").includes(capsText(plan)));
});

test("P5 P7 P8: plan.md names the measurement file, the three hops and the send file, and says what is not known", () => {
  const md = readFileSync(join(HERE, "plan.md"), "utf8");
  const m = readJson(join(HERE, "lead-measurements-2026-11-13.json")).measurements;
  assert.match(md, /lives about 58 blocks, about a minute/);
  assert.equal(m.mortal_life_blocks.value, "58");
  for (const k of ["block_time_s", "mortal_life_blocks", "relay_hop_s", "send_text_chars", "pane_call_limit_s"]) assert.ok(md.includes(k), k);
  assert.match(md, /three hops/);
  assert.match(md, /what crosses is the send file/i);
  for (const t of [/Whether `expire_force_open` refunds a top up/, /Whether T5's `opened_at` is T5's block/, /The fees of T4 and T5/, /shown for `force_open` only/]) assert.match(md.split("## What is not known")[1], t);
});

test("R9: the cost table sums the known fees and names the unknown ones", () => {
  const c = costs(plan);
  assert.equal(c.known_sum_raw, c.rows.filter((r) => r.fee_raw).reduce((n, r) => n + BigInt(r.fee_raw), 0n).toString());
  assert.deepEqual(c.unknown, ["T4", "T5"]);
  assert.deepEqual(c.escrows.map((e) => [e.id, e.amount]), [["T3", plan.values.ESCROW_1.value], ["T4", plan.values.TOP_UP.value], ["T5", plan.values.ESCROW_1.value]]);
});

// ---- the words (R11, R12) -----------------------------------------------------------------------
const prose = (text) => {
  let code = false;
  return text.split("\n").filter((l) => { if (l.startsWith("```")) { code = !code; return false; } return !code && !/^\|[-|]+\|$/.test(l); });
};

test("R12: the README says nothing was sent, how to run the tests, and the exact lines of one device and one owner step", () => {
  const md = readFileSync(join(HERE, "README.md"), "utf8");
  assert.match(md, /Nothing in this folder has been signed with a real key or sent to any network/);
  assert.match(md, /`node --test` in this folder/);
  const text = commandsText(plan, null);
  const t2 = text.split("\n\n").find((b) => b.startsWith("# T2:")).split("\n").filter((l) => l.startsWith("node ") || l.startsWith("sha256sum"));
  for (const l of t2) assert.ok(md.includes(l), `the README holds ${l}`);
  const t3 = text.split("\n\n").find((b) => b.startsWith("# T3:")).split("\n").find((l) => l.startsWith("node "));
  assert.ok(md.includes(t3), "the README holds the sign-device line of T3");
});

test("R12: no dashes in the prose of the README and plan.md", () => {
  for (const f of ["README.md", "plan.md", "PROGRESS.md"]) {
    for (const l of prose(readFileSync(join(HERE, f), "utf8"))) {
      assert.doesNotMatch(l, /[–—]/, `${f}: ${l}`);
      assert.doesNotMatch(l.replace(/^\s*- /, "").replace(/`[^`]*`/g, ""), / - | -- /, `${f}: ${l}`);
    }
  }
});

test("P1: the channel id of every ForceOpenRequested in the rerun's record is derived from that record's own fields and the rerun's steps.json", () => {
  const rerunPlan = readJson(join(RERUN, "steps.json"));
  let seen = 0;
  for (const s of rerun.steps) for (const e of s.events.filter((x) => x.pallet === "ComputeChannel" && x.name === "ForceOpenRequested")) {
    const call = rerunPlan.steps.find((x) => x.id === s.step).call;
    const file = call[call.indexOf("--inner") + 1].replace(/^force-open:/, "");
    const nonce = rerunPlan.values[rerunPlan.force_open_files[file].nonce.slice(1)].value;
    assert.equal(channelId(rerun.chain.genesis, e.fields.agent, e.fields.miner, nonce), e.fields.channel_id, s.step);
    seen += 1;
  }
  assert.ok(seen >= 1, "the rerun holds a ForceOpenRequested");
});

test("P1: CH_T3 and CH_T5 are derived from GENESIS, OWNER, NAMED and N_T3 or N_T5; T4 and T6 use CH_T3, T7 uses CH_T5, and the events of T3 and T5 name them", () => {
  assert.deepEqual(plan.values.CH_T3.computed, { channel_id: ["GENESIS", "OWNER", "NAMED", "N_T3"] });
  assert.deepEqual(plan.values.CH_T5.computed, { channel_id: ["GENESIS", "OWNER", "NAMED", "N_T5"] });
  assert.equal(plan.values.CH_T3.value, channelId(V("GENESIS"), V("OWNER"), V("NAMED"), V("N_T3")));
  assert.notEqual(plan.values.CH_T3.value, plan.values.CH_T5.value);
  const step = (id) => plan.steps.find((s) => s.id === id);
  assert.equal(step("T4").inner.channel_id, "$CH_T3");
  assert.equal(step("T6").inner.channel_id, "$CH_T3");
  assert.equal(step("T7").inner.channel_id, "$CH_T5");
  assert.equal(step("T3").events.find((e) => e.event === "ComputeChannel.ForceOpenRequested").fields.channel_id, "$CH_T3");
  assert.equal(step("T5").events_if_success.find((e) => e.event === "ComputeChannel.ChannelOpened").fields.channel_id, "$CH_T5");
  assert.doesNotMatch(JSON.stringify(plan.steps), /\$T[35]\.ComputeChannel\.[A-Za-z]+\.channel_id/, "no channel id is read from an event");
  assert.match(plan.values.CH_T3.why, /SDK 0\.6\.0/);
  assert.match(plan.values.CH_T3.why, /lead-measurements-2026-11-13\.json/);
  assert.match(plan.values.CH_T3.why, /force_open only/);
});

test("P1: the SS58 text of an account is the one the earlier records give, and it reads back; a wrong checksum is refused", () => {
  for (const a of Object.values(rerun.accounts)) {
    assert.equal(ss58(a.public_key), a.ss58);
    assert.equal(fromSs58(a.ss58), a.public_key);
  }
  const t = rerun.accounts.owner.ss58;
  const bad = t.slice(0, -1) + (t.endsWith("z") ? "y" : "z");
  assert.equal(fromSs58(bad), null);
});

test("P6 P8: the README says who carries the batch out and when the owner is told, how the pane lines and the pasted files work, and that the final record is a later piece of work", () => {
  const md = readFileSync(join(HERE, "README.md"), "utf8");
  assert.match(md, /the lead carries out by hand, with real test money, after the independent\s+review of this work and its fixes\. The owner gave devnet test batches to the lead on 2026-11-12;\s+the owner is told after the batch/);
  assert.doesNotMatch(md, /owner's yes/);
  assert.match(md, /keep the promise on `window` and read it in a second call/);
  assert.match(md, /`pane-runner.js` is pasted into a tab on the node's own origin,\s+`https:\/\/rpc\.devnet\.flop\.network\/`, and `explorer-reader.js` into a tab on the explorer's own\s+origin/);
  assert.match(md, /Each pasted file is checked by its sha256 in the\s+pane before use/);
  for (const [f, sha] of Object.entries(pastedSha256())) assert.ok(md.includes(`sha256 of ${f}: ${sha}`), `the README gives the current sha256 of ${f}`);
  const p8 = md.split("## Not done here: the final record")[1].split("\n## ")[0];
  for (const t of [/request list/, /recording/, /fill helper beside/, /by position/, /reviewed shape/, /later piece of work with its own brief/, /nothing here promises it/]) assert.match(p8, t);
});

test("F11: fromSs58 takes only canonical text: leading 1s added to a valid address are refused", () => {
  const owner = ss58(plan.values.OWNER.value);
  assert.equal(fromSs58(owner), plan.values.OWNER.value);
  for (const t of ["1" + owner, "11" + owner]) assert.equal(fromSs58(t), null, t);
});
