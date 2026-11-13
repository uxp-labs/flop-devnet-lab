// Tests of explorer-reader.js (E1 to E3): node --test in this folder. No network. The explorer's
// answers are written here by the builder in the shape the lead described
// (lead-measurements-2026-11-13.json measurements.explorer_answer_shape); none is copied from the
// explorer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE, loadPlan, sha256Text } from "./lib.mjs";
import { explorerAnswer as answer } from "./fixtures.mjs";

const SRC = readFileSync(join(HERE, "explorer-reader.js"), "utf8");
const plan = loadPlan();
const load = () => { const g = { crypto: webcrypto, TextEncoder }; vm.runInNewContext(SRC, g); return g.explorerReader; };
const XH = "0x" + "ab".repeat(32), BH = "0x" + "cd".repeat(32);

function fetcher(status, body) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { status, url, json: async () => (typeof body === "string" ? JSON.parse(body) : body) }; };
  return { f, calls };
}

test("E1: one host, a constant equal to steps.json EXPLORER, GET only, no import and no library", async () => {
  const er = load();
  assert.equal(er.EXPLORER, plan.values.EXPLORER.value);
  assert.match(plan.values.EXPLORER.decided, /lead-measurements-2026-11-13\.json/);
  const { f, calls } = fetcher(200, answer());
  await er.createReader({ fetch: f }).read(XH);
  assert.deepEqual(calls.map((c) => c.url), [`${plan.values.EXPLORER.value}/api/transactions/${XH}`]);
  assert.doesNotMatch(SRC, /^\s*import\b|\bimport\(|\brequire\(|^\s*export\b/m);
  assert.doesNotMatch(SRC, /method:\s*"(POST|PUT|DELETE|PATCH)"/);
  assert.match(SRC, /method: "GET"/);
  assert.ok([...SRC.matchAll(/https?:\/\/[^\s"',)]+/g)].every((m) => m[0].replace(/\/$/, "") === plan.values.EXPLORER.value), "no other host");
  assert.doesNotMatch(SRC, /WebSocket|XMLHttpRequest/);
});

test("E2: found: the relay text is one JSON object of the hash, the block hash, success, the names in order and the events of computeChannel and flopSessionKeys unchanged", async () => {
  const a = answer();
  const r = await load().createReader({ fetch: fetcher(200, a).f, nowIso: () => "2026-11-13T03:00:00.000Z" }).read(XH);
  assert.equal(r.status, "found");
  const v = JSON.parse(r.relay);
  assert.equal(r.relay_sha256, sha256Text(r.relay));
  assert.deepEqual(Object.keys(v), ["source", "read_utc", "hash", "block_hash", "success", "error", "failed_data", "names", "events"]);
  assert.equal(v.source, `${plan.values.EXPLORER.value}/api/transactions/${XH}`);
  assert.equal(v.read_utc, "2026-11-13T03:00:00.000Z");
  assert.equal(v.hash, XH);
  assert.equal(v.block_hash, BH);
  assert.equal(v.success, true);
  assert.equal(v.error, null);
  assert.equal(v.failed_data, null);
  assert.deepEqual(v.names, ["balances.Withdraw", "balances.Transfer", "computeChannel.ForceOpenRequested", "flopSessionKeys.SessionCallExecuted", "system.ExtrinsicSuccess"]);
  assert.deepEqual(v.events, a.events.filter((e) => ["computeChannel", "flopSessionKeys"].includes(e.section)).map(({ section, method, data }) => ({ section, method, data })), "unchanged: commas, camel case and SS58 stay");
});

test("E2: a failed extrinsic gives its error as numbers from the last system.ExtrinsicFailed: pallet index, and the error index in the first byte", async () => {
  const r = await load().createReader({ fetch: fetcher(200, answer({ success: false, failedWith: { Module: { index: "94", error: "0x14000000" } } })).f }).read(XH);
  const v = JSON.parse(r.relay);
  assert.equal(v.success, false);
  assert.deepEqual(v.error, { index: 94, error: 20 });
  assert.deepEqual(v.failed_data, { Module: { index: "94", error: "0x14000000" } }, "F2: the event's dispatchError, unchanged, so the PC derives the error itself");
  const other = await load().createReader({ fetch: fetcher(200, answer({ success: false, failedWith: { Token: "FundsUnavailable" } })).f }).read(XH);
  assert.deepEqual(JSON.parse(other.relay).error, { index: null, error: null }, "not a module error: nothing is guessed");
});

test("E2: not-found is the 404; any other status is failed with it; an answer of another shape is failed; a bad hash is not asked", async () => {
  const er = load();
  assert.deepEqual({ ...(await er.createReader({ fetch: fetcher(404, { error: "Transaction not found" }).f }).read(XH)) }, { status: "not-found", http_status: 404, hash: XH });
  const f500 = await er.createReader({ fetch: fetcher(502, "{}").f }).read(XH);
  assert.equal(f500.status, "failed");
  assert.equal(f500.http_status, 502);
  for (const bad of [{ ...answer(), hash: "0x" + "ee".repeat(32) }, { ...answer(), success: "true" }, { ...answer(), blockHash: undefined }, { ...answer(), events: "none" }]) {
    assert.equal((await er.createReader({ fetch: fetcher(200, bad).f }).read(XH)).status, "failed");
  }
  const none = fetcher(200, answer());
  assert.equal((await er.createReader({ fetch: none.f }).read("0xAB")).status, "failed");
  assert.equal(none.calls.length, 0);
  const thrown = await er.createReader({ fetch: async () => { throw new Error("blocked"); } }).read(XH);
  assert.equal(thrown.status, "failed");
  assert.equal(thrown.http_status, null);
});

test("F9: the request follows no redirect, and an answer whose url is not the address asked for is failed", async () => {
  const { f, calls } = fetcher(200, answer());
  await load().createReader({ fetch: f }).read(XH);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.method, "GET");
  const moved = async (url) => ({ status: 200, url: url.replace("explorer.devnet", "explorer2.devnet"), json: async () => answer() });
  const r = await load().createReader({ fetch: moved }).read(XH);
  assert.equal(r.status, "failed");
  assert.match(r.problem, /not the address asked for/);
  const none = await load().createReader({ fetch: async () => ({ status: 200, json: async () => answer() }) }).read(XH);
  assert.equal(none.status, "failed", "an answer with no url is failed");
});
