// Tests of the run folder of 2026-11-13, run-2026-11-13/ (rule A4 of the list 5 brief): node --test
// in this folder. No network, no key. The folder holds what the lab's tools wrote when the lead
// signed: the calls of the research signer's steps, each signed extrinsic with its hash, and the
// exact text sent. These tests hold it byte for byte by its SHA256SUMS, hold each extrinsic's hash to
// its bytes and to results.json, each send file to its signed file, and each era to the block the
// step landed in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HERE, blake2b256Hex, readJson } from "./lib.mjs";

const RUN = join(HERE, "run-2026-11-13");
const record = () => readJson(join(HERE, "results.json"));
/** The steps of results.json that were sent, each with its run time reading. */
const sent = () => record().steps.filter((s) => s.run_time !== null);
const signed = (id) => readJson(join(RUN, "signed", `${id}.json`));
const bytesOf = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

test("A4: run-2026-11-13 holds exactly the files its SHA256SUMS names, each with that sha256", () => {
  const lines = readFileSync(join(RUN, "SHA256SUMS"), "utf8").trimEnd().split("\n");
  const sums = lines.map((l) => /^([0-9a-f]{64}) {2}\.\/(calls|signed)\/([A-Za-z0-9.]+)$/.exec(l));
  assert.ok(sums.every((m) => m !== null), "every line is <sha256>  ./<calls|signed>/<file>");
  const listed = sums.map((m) => `${m[2]}/${m[3]}`).sort();
  const present = ["calls", "signed"].flatMap((d) => readdirSync(join(RUN, d)).map((f) => `${d}/${f}`)).sort();
  assert.deepEqual(present, listed);
  assert.deepEqual(readdirSync(RUN).sort(), ["SHA256SUMS", "calls", "signed"]);
  for (const m of sums) assert.equal(createHash("sha256").update(readFileSync(join(RUN, m[2], m[3]))).digest("hex"), m[1], `${m[2]}/${m[3]}`);
  assert.equal(listed.length, 20);
});

// Z7: the one value of this folder typed by hand, as the sha256 of results.json is in results.test.mjs.
// SHA256SUMS lists the folder's files; this pins SHA256SUMS itself, so a signed file changed with the
// sums written again fails here.
test("Z7: the sha256 of run-2026-11-13/SHA256SUMS is the one pinned here", () => {
  assert.equal(createHash("sha256").update(readFileSync(join(RUN, "SHA256SUMS"))).digest("hex"), "cf987b7cbdfe03c9b8d8c2a642684b983c2238c96980a583b1c3aede4e9572f3");
});

test("A4: for each sent step the blake2b-256 of the signed extrinsic is its extrinsic_hash and the run time extrinsic_hash of results.json", () => {
  const steps = sent();
  assert.equal(steps.length, 8);
  for (const s of steps) {
    const f = signed(s.step);
    assert.equal(blake2b256Hex(bytesOf(f.extrinsic)), f.extrinsic_hash, s.step);
    assert.equal(f.extrinsic_hash, s.run_time.extrinsic_hash, s.step);
  }
});

test("A4: each send file is exactly the step and the extrinsic of its signed file, and its sha256 is the bundle sha256 results.json records", () => {
  for (const s of sent()) {
    const text = readFileSync(join(RUN, "signed", `${s.step}.send.json`));
    const send = JSON.parse(text.toString("utf8"));
    assert.deepEqual(Object.keys(send), ["step", "extrinsic"], s.step);
    assert.deepEqual(send, { step: s.step, extrinsic: signed(s.step).extrinsic }, s.step);
    assert.equal(createHash("sha256").update(text).digest("hex"), s.run_time.bundle_sha256, s.step);
  }
});

test("A4: T1, T2, T8 and T9 are immortal; T3, T4, T5 and T6 have an era of 64 blocks born at or below the block the step landed in, valid at least until it", () => {
  const mortal = [];
  for (const s of sent()) {
    const era = signed(s.step).era;
    if (era === "immortal") continue;
    mortal.push(s.step);
    const landed = s.run_time.sent.block_number;
    assert.equal(era.period, 64, s.step);
    assert.equal(era.last_valid_block, era.birth_number + era.period - 1, s.step);
    assert.ok(era.birth_number <= landed, `${s.step} born at ${era.birth_number}, landed at ${landed}`);
    assert.ok(era.last_valid_block >= landed, `${s.step} valid until ${era.last_valid_block}, landed at ${landed}`);
    assert.match(era.birth_hash, /^0x[0-9a-f]{64}$/, s.step);
  }
  assert.deepEqual(mortal, ["T3", "T4", "T5", "T6"]);
  assert.deepEqual(sent().filter((s) => signed(s.step).era === "immortal").map((s) => s.step), ["T1", "T2", "T8", "T9"]);
});
