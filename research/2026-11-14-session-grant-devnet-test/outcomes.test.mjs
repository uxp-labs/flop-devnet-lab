// F1 (RG19-8): the lines plan.mjs next prints for a send outcome are made from the outcome row and
// from nothing else. This walks every immortal row of the last batch's send_outcomes, at a first
// send and after a sendSame, at G1 and at a cleanup try of R1, and holds which one kind of line is
// printed: the lead's stop (with the row's case), the same bytes again, a find, or the first send
// again. No send line is printed for a stop row. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, tempDir } from "./fixtures.mjs";
import { nextOf } from "./next.mjs";
import { nextText } from "./plan.mjs";
import { actionOf, immortalRows, immortalClause } from "./outcomes.mjs";
import { started, step, H } from "./records.mjs";
import { sendText, sendFile, signedFile } from "./run.mjs";
import { sha256Text } from "./lib.mjs";

const DIR = tempDir("g19-outcomes");
after(() => rmSync(DIR, { recursive: true, force: true }));
const ROWS = immortalRows(plan);
const key = (r) => `${r.outcome}${r.node_code !== undefined ? ` ${r.node_code}` : ""}${r.node_word ? ` ${r.node_word}` : ""}`;

/** The action of every row, by the row's words: at a first send, and after a sendSame. */
const EXPECTED = {
  "finalized": ["record", "record"],
  "finalized-not-found": ["find", "find"],
  "finalized-not-canonical": ["find", "find"],
  "finalized-unread": ["find", "find"],
  "refused-bundle": ["send", "send"],
  "already-sent": ["find", "find"],
  "not-in-sent-list": ["send", "send"],
  "not-sent": ["send", "send"],
  "refused-at-submission 1010": ["stop", "find"],
  "refused-at-submission 1013": ["find", "find"],
  "refused-at-submission 1014": ["find", "find"],
  "refused-at-submission other": ["sendSame", "sendSame"],
  "deadline": ["find", "find"],
  "connection-lost": ["find", "find"],
  "ended usurped": ["find", "find"],
  "ended finalityTimeout": ["find", "find"],
  "ended dropped": ["find", "find"],
  "ended invalid": ["find", "find"],
  "not-found": ["sendSame", "sendSame"],
  "find-deadline": ["find", "find"],
};

const LINES = {
  stop: /record-step\.mjs" stop (G1|R1)\b/,
  sendSame: /lab\.sendSame\(/,
  send: /lab\.send\(/,
  find: /lab\.find\(/,
  sign: /flop-sign\.mjs" sign/,
  block: /reads\.blockTape\(/,
};

/** A runner reading of a row, as pane-runner.js gives it. */
function readingOf(row, sentBy) {
  const s = { status: row.outcome, sent_by: sentBy };
  if (row.node_code !== undefined) s.node = { code: row.node_code === "other" ? 1012 : row.node_code, message: "made" };
  if (row.node_word) s.node_status = row.node_word;
  if (row.outcome === "finalized") Object.assign(s, { block_number: 4000010, block_hash: H(4000010), extrinsic_index: 1 });
  return s;
}

/** A run folder whose signed file and send file are those the record checked, for an id. */
function folderFor(r, id) {
  const run = join(DIR, `r${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(run, "signed"), { recursive: true });
  const extrinsic = "0x" + "ab".repeat(40);
  writeFileSync(signedFile(run, id), JSON.stringify({ extrinsic, extrinsic_hash: H(1) }));
  const text = sendText(id, extrinsic);
  writeFileSync(sendFile(run, id), text);
  const e = r.steps.find((x) => x.step === id);
  e.signed_check = { ...e.signed_check, send_sha256: sha256Text(text), extrinsic_hash: H(1) };
  return run;
}

const kindsIn = (text) => Object.entries(LINES).filter(([, re]) => re.test(text)).map(([k]) => k);

test("F1: every immortal row names one action, the one this table pins, and the table has every row", () => {
  assert.equal(ROWS.length, 20);
  assert.deepEqual(ROWS.map(key).sort(), Object.keys(EXPECTED).sort());
  for (const r of ROWS) {
    const got = ["send", "sendSame"].map((by) => actionOf(ROWS, r, by).kind);
    assert.deepEqual(got, EXPECTED[key(r)], key(r));
  }
  const c = ROWS.find((r) => r.node_code === 1010);
  assert.equal(actionOf(ROWS, c, "send").case, "c", "the 1010 row names case c of record-step.mjs stop at a first send");
  assert.match(immortalClause(c, "sendSame"), /^lab\.find before anything else/);
});

for (const [at, base] of [["G1", (o) => step(started(), "G1", o)], ["R1", (o) => step(step(started(), "G1"), "R1", o)]]) {
  test(`HOLDS: RG19-8 at ${at}: for each row plan.mjs next prints exactly the line of the row's action, and no send line for a stop row`, async () => {
    for (const row of ROWS) {
      for (const [i, by] of ["send", "sendSame"].entries()) {
        const sent = readingOf(row, by);
        const r = row.outcome === "finalized" ? base({ upTo: "final", sent }) : base({ sent });
        const run = folderFor(r, at);
        const n = nextOf(plan, r);
        const text = await nextText(plan, run, r);
        const want = EXPECTED[key(row)][i];
        const what = `${at} ${key(row)} after ${by}: ${n.word} ${n.phase}`;
        if (want === "record") { assert.deepEqual(kindsIn(text), ["block"], what); continue; }
        assert.deepEqual(kindsIn(text), [want], what);
        if (want === "stop") {
          assert.equal(n.word, "stop", what);
          assert.equal(n.phase, "lead-stop", what);
          assert.match(text, /--case c\b/, what);
          assert.doesNotMatch(text, /lab\.send(Same)?\(/, what);
        } else assert.equal(n.word, "wait", what);
      }
    }
  });
}

test("F1: a reading no row names an action for is a stop with no line that sends", async () => {
  const r = step(started(), "G1", { sent: { status: "a status no row has", sent_by: "send" } });
  const n = nextOf(plan, r);
  assert.equal(n.word, "stop");
  assert.match(n.why, /no row of send_outcomes names an action/);
  const text = await nextText(plan, folderFor(r, "G1"), r);
  assert.deepEqual(kindsIn(text), []);
});
