// The upgrade watch in the live run (RULES.md 7.2): its two reads on the tape, right after
// state_getRuntimeVersion(F), over the synthetic tapes in fixtures/upgrade-* and the 18 tapes that
// gained them; a run on a log compared with the watch before it; what every output holds; and that
// the watch adds no conflict and changes no exit code.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feedText, upgradeFeed } from "../src/feed.js";
import { guardRpc } from "../src/guard.js";
import { earlierOf, readHistory } from "../src/history.js";
import { noticeLine, runLive } from "../src/live-run.js";
import { LiveSource } from "../src/live-source.js";
import { handleMcp } from "../src/mcp.js";
import { renderPage } from "../src/page.js";
import { PUBLISHED_FILES, judgeLatest } from "../src/published.js";
import { EXIT } from "../src/run-command.js";
import { checkSnapshot } from "../src/snapshot-check.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { sumsOf } from "../src/sums.js";
import { TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { Snapshot } from "../src/types.js";
import { DETAIL, UPGRADE_KEYS } from "../src/upgrade-watch.js";
import { UPGRADE_ANSWERS } from "./helpers/tapes.js";
import { AUTHORIZED_BYTES, NOT_REVIEWED, NOT_REVIEWED_HEX, RESULTS } from "./helpers/upgrade.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const fixture = (dir: string, name: string) => readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
const tapeOf = (dir: string) => TapeTransport.parse(fixture(dir, "tape.jsonl"), `tape:${dir}`);
const RES = "research/2026-11-12-runtime-upgrade/results.json ";
/** A field of results.json by its path, as a meta.json names it. */
const field = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], RESULTS);
const DAY = "2026-11-11.jsonl";
const UPGRADE_DIRS = ["upgrade-authorized", "upgrade-before", "upgrade-hostile", "upgrade-landed", "upgrade-not-reviewed", "upgrade-read-failed"];

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-upgrade-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

function asLive(inner: Transport): Transport {
  return { trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network", rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}
let serial = 0;
async function run(transport: Transport, log: string) {
  const out = join(box, "runs", String(++serial));
  const r = await runLive(transport, { out, log, sourceSha: null, clock: () => "2026-11-11T13:00:00.000Z" });
  return { out, r, s: r.snapshot as Snapshot };
}
const publish = (out: string, log: string) => {
  mkdirSync(log, { recursive: true });
  appendFileSync(join(log, DAY), readFileSync(join(out, "snapshots.jsonl")));
};
const files = (out: string) => Object.fromEntries(readdirSync(out).map((n) => [n, readFileSync(join(out, n), "utf8")]));
/** The tape's calls, as method and params. */
const calls = (dir: string) =>
  fixture(dir, "tape.jsonl")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((l) => JSON.parse(l).request)
    .filter((q) => q.kind === "rpc")
    .map((q) => `${q.method} ${JSON.stringify(q.params)}`);

describe("the tapes that read the watch", () => {
  const withReads = readdirSync(FIXTURES).filter((d) => /^(live|memory|anchor|upgrade)-/.test(d) && fixture(d, "tape.jsonl").includes('"state_getRuntimeVersion"'));

  it("are the 18 synthetic tapes that read a runtime version, and the six upgrade tapes", () => {
    expect(withReads.filter((d) => !d.startsWith("upgrade-"))).toHaveLength(18);
    expect(withReads.filter((d) => d.startsWith("upgrade-"))).toEqual(UPGRADE_DIRS);
    for (const d of UPGRADE_DIRS) {
      const meta = JSON.parse(fixture(d, "meta.json"));
      expect([meta.scenario, meta.synthetic], d).toEqual([d, true]);
      expect(readdirSync(new URL(`${d}/`, FIXTURES)).sort(), d).toEqual(["meta.json", "tape.jsonl"]);
    }
  });

  it("each makes both reads at F, right after state_getRuntimeVersion(F) and before anything else", () => {
    for (const d of withReads) {
      const c = calls(d);
      const i = c.findIndex((x) => x.startsWith("state_getRuntimeVersion"));
      const F = JSON.parse(c[i]?.slice("state_getRuntimeVersion ".length) ?? "[]")[0];
      expect(c.slice(i + 1, i + 3), d).toEqual([`state_getStorage ${JSON.stringify([UPGRADE_KEYS.lastRuntimeUpgrade, F])}`, `state_getStorage ${JSON.stringify([UPGRADE_KEYS.authorizedUpgrade, F])}`]);
      expect(c.filter((x) => x.startsWith("state_getStorage")), d).toHaveLength(2);
    }
  });

  it("answers each read with the value its meta.json names, from results.json, or the one made for the test that it says", () => {
    for (const d of withReads) {
      const meta = JSON.parse(fixture(d, "meta.json"));
      const answers = fixture(d, "tape.jsonl")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((e) => e.request?.method === "state_getStorage");
      const source = meta.upgrade_answers as Record<string, string>;
      expect(Object.keys(source).sort(), d).toEqual(["System.AuthorizedUpgrade", "System.LastRuntimeUpgrade"]);
      for (const [name, e] of [["System.LastRuntimeUpgrade", answers[0]], ["System.AuthorizedUpgrade", answers[1]]] as const) {
        const s = source[name] as string;
        expect(meta.description, d).toContain(name);
        if (s.startsWith(RES) && s.endsWith(", in upper case")) expect(e.answer, `${d} ${name}`).toEqual({ result: String(field(s.slice(RES.length, -", in upper case".length))).toUpperCase().replace("0X", "0x") });
        else if (s.startsWith(RES)) expect(e.answer, `${d} ${name}`).toEqual({ result: field(s.slice(RES.length)) });
        else expect(s, `${d} ${name}`).toBe("made for this test, as the description says");
      }
    }
    // The made ones: a record no reviewed line names, a number, and the transport's own time limit.
    expect(JSON.parse(fixture("upgrade-not-reviewed", "tape.jsonl").split("\n")[11] as string).answer).toEqual({ result: NOT_REVIEWED_HEX });
    expect(JSON.parse(fixture("upgrade-hostile", "tape.jsonl").split("\n")[11] as string).answer).toEqual({ result: 42 });
  });

  it("each upgrade tape reads at the block its meta.json names from results.json", () => {
    for (const d of UPGRADE_DIRS) {
      const meta = JSON.parse(fixture(d, "meta.json"));
      const head = (meta.from_results["finalized head"] as string).slice(RES.length).split(" and ")[0]?.replace(/\.hash$/, "") as string;
      const at = field(head) as { hash: string; height: number };
      const c = calls(d);
      expect(c[2], d).toBe("chain_getFinalizedHead []");
      const t = fixture(d, "tape.jsonl").trimEnd().split("\n").map((l) => JSON.parse(l));
      const header = t.find((e) => e.request?.method === "chain_getHeader" && e.request.params.length === 1);
      expect([t.find((e) => e.request?.method === "chain_getFinalizedHead").answer.result, header.request.params[0], header.answer.result.number], d).toEqual([at.hash, at.hash, `0x${at.height.toString(16)}`]);
    }
  });

  it("are refused by a replay when the two reads come in the other order, and a tape without them is refused at the first", async () => {
    const lines = fixture("upgrade-authorized", "tape.jsonl").trimEnd().split("\n");
    const swapped = [...lines];
    [swapped[11], swapped[12]] = [lines[12] as string, lines[11] as string];
    const fix = (l: string, seq: number) => JSON.stringify({ ...JSON.parse(l), seq });
    const text = swapped.map((l, i) => (i === 0 ? l : fix(l, i - 1))).join("\n") + "\n";
    await expect(new LiveSource(TapeTransport.parse(text)).read()).rejects.toThrow(`request 10 is rpc state_getStorage ["${UPGRADE_KEYS.lastRuntimeUpgrade}"`);
    // A real tape, recorded before the watch, holds neither read.
    await expect(new LiveSource(tapeOf("published-2026-11-11-0808")).read()).rejects.toThrow(`request 10 is rpc state_getStorage ["${UPGRADE_KEYS.lastRuntimeUpgrade}"`);
  });

  it("are made only at a valid finalized head: none when F is no hash, both when only its header failed, at a height not known", async () => {
    for (const d of ["live-rpc-down", "live-timeout", "memory-rpc-down", "memory-best-below-floor", "published-2026-11-11-1206"]) {
      expect(calls(d).filter((c) => c.startsWith("state_getStorage")), d).toEqual([]);
      if (d.startsWith("live-")) expect(await new LiveSource(tapeOf(d)).upgradeReading(), d).toBeNull();
    }
    const s = new LiveSource(tapeOf("live-malformed-header"));
    const r = await s.upgradeReading();
    expect([r?.hash, r?.number, (await s.rpcHead()).finalized]).toEqual(["0x" + "7a".repeat(32), null, null]);
  });

  it("passes the read only guard, whose list is unchanged", () => {
    expect(() => guardRpc("state_getStorage")).not.toThrow();
  });

  it("answers the real tapes that read a finalized head, in UPGRADE_ANSWERS, with the old runtime's record and no authorisation", () => {
    const real = readdirSync(FIXTURES).filter((d) => d.startsWith("published-") && fixture(d, "tape.jsonl").includes('"state_getRuntimeVersion"'));
    expect(Object.keys(UPGRADE_ANSWERS).sort()).toEqual(real.sort());
    for (const a of Object.values(UPGRADE_ANSWERS)) expect(a).toEqual({ lastRuntimeUpgrade: { result: RESULTS.boundary[0].last_runtime_upgrade.hex }, authorizedUpgrade: { result: null } });
  });
});

describe("a live run's watch, first runs", () => {
  it("before the authorisation: the old runtime, reviewed, and no authorisation", async () => {
    const { r, s } = await run(tapeOf("upgrade-before"), join(box, "no-log"));
    expect(r.code).toBe(EXIT.ok);
    expect(s.upgrade).toEqual({
      schema: "flop-observatory/upgrade-watch@0",
      observed_at: "2026-11-11T06:00:00.400Z",
      trust: "fixture",
      at: { hash: RESULTS.authorization.authorizing_block.block_before.hash, number: RESULTS.authorization.authorizing_block.block_before.height },
      executing: { state: "reviewed", spec_name: "tzkv-runtime", spec_version: 1014014, detail: null },
      authorized: { state: "absent", bytes: null, length: null, detail: null },
      compared_with: null,
      executing_changed: null,
      authorization_appeared: null,
    });
    expect(s.upgrade?.at.hash).toBe(s.status.finalized_hash);
  });

  it("a runtime no reviewed line names: named, not reviewed, and the run goes on as before", async () => {
    const { r, s } = await run(tapeOf("upgrade-not-reviewed"), join(box, "no-log"));
    expect(s.upgrade?.executing).toEqual({ state: "not reviewed", spec_name: NOT_REVIEWED.specName, spec_version: NOT_REVIEWED.specVersion, detail: DETAIL.notReviewed });
    expect([r.code, s.status.conflicts, s.status.reset_detected]).toEqual([EXIT.ok, [], false]);
  });

  it("both reads failed: unknown, never absent, each named by its call", async () => {
    const { r, s } = await run(tapeOf("upgrade-read-failed"), join(box, "no-log"));
    expect(s.upgrade?.executing).toEqual({ state: "unknown", spec_name: null, spec_version: null, detail: DETAIL.lruFailed });
    expect(s.upgrade?.authorized).toEqual({ state: "unknown", bytes: null, length: null, detail: DETAIL.auFailed });
    // The status and its RPC health are what they were: the watch adds no error and no conflict.
    expect([r.code, s.status.conflicts, s.status.rpc.health, s.status.rpc.detail]).toEqual([EXIT.ok, [], "ok", null]);
  });

  it("answers that are no storage answer: unknown, and no output but the tape holds them", async () => {
    const { out, r, s } = await run(tapeOf("upgrade-hostile"), join(box, "no-log"));
    expect([s.upgrade?.executing.state, s.upgrade?.executing.detail, s.upgrade?.authorized.state, s.upgrade?.authorized.detail]).toEqual(["unknown", DETAIL.lruMalformed, "unknown", DETAIL.auMalformed]);
    expect(r.code).toBe(EXIT.ok);
    const upper = AUTHORIZED_BYTES.slice(2).toUpperCase();
    for (const [name, text] of Object.entries(files(out))) expect(text.includes(upper), name).toBe(name === "tape.jsonl");
    expect(renderPage(s).includes(upper)).toBe(false);
  });
});

describe("a live run's watch on a log: compared with the one before", () => {
  it("3528477, then 3528478 where the authorisation appears, then 3528529 where the new runtime executes", async () => {
    const log = join(box, "log");
    const a = await run(tapeOf("upgrade-before"), log);
    publish(a.out, log);
    const b = await run(tapeOf("upgrade-authorized"), log);
    expect(b.r.code).toBe(EXIT.ok);
    expect(b.s.upgrade?.authorized).toEqual({ state: "present", bytes: AUTHORIZED_BYTES, length: 33, detail: null });
    expect([b.s.upgrade?.compared_with, b.s.upgrade?.executing_changed, b.s.upgrade?.authorization_appeared]).toEqual([a.s.upgrade?.at.number, false, true]);
    publish(b.out, log);
    expect(earlierOf(readHistory(log).snapshots, DEVNET_GENESIS).earlierUpgrades.map((e) => [e.genesis, e.watch.at.number])).toEqual([
      [DEVNET_GENESIS, a.s.upgrade?.at.number],
      [DEVNET_GENESIS, b.s.upgrade?.at.number],
    ]);
    const c = await run(tapeOf("upgrade-landed"), log);
    expect(c.r.code).toBe(EXIT.ok);
    expect(c.s.upgrade?.executing).toEqual({ state: "reviewed", spec_name: "tzkv-runtime", spec_version: RESULTS.boundary[2].last_runtime_upgrade.spec_version, detail: null });
    expect([c.s.upgrade?.compared_with, c.s.upgrade?.executing_changed, c.s.upgrade?.authorization_appeared]).toEqual([b.s.upgrade?.at.number, true, false]);
    // The runtime version is the status's, unchanged: a higher one is an upgrade, and no conflict.
    expect([c.s.status.runtime_version, c.s.status.conflicts, c.s.status.reset_detected]).toEqual([RESULTS.boundary[2].state_getRuntimeVersion_spec, [], false]);
    for (const x of [a, b, c]) expect(checkSnapshot(x.s), x.out).toEqual([]);
  });

  it("an @0 line in the log holds no watch to compare with, and reads", async () => {
    const log = join(box, "log");
    mkdirSync(log);
    appendFileSync(join(log, DAY), fixture("published-2026-11-11-0808", `log/${DAY}`));
    const h = readHistory(log);
    expect([h.state, h.snapshots[0]?.schema, earlierOf(h.snapshots, DEVNET_GENESIS).earlierUpgrades]).toEqual(["read", "flop-observatory/snapshot@0", []]);
  });
});

describe("the watch in every output", () => {
  /** The authorised reading as the network would answer, on a log holding the reading before it. */
  const authorised = async () => {
    const log = join(box, "log");
    publish((await run(asLive(tapeOf("upgrade-before")), log)).out, log);
    return run(asLive(tapeOf("upgrade-authorized")), log);
  };
  it("upgrade.json is the part, get_upgrade is that file byte for byte, and the notice names the runtime and the authorisation", async () => {
    const { out, r, s } = await authorised();
    const f = files(out);
    expect(f["upgrade.json"]).toBe(feedText(upgradeFeed(s)));
    expect(JSON.parse(f["upgrade.json"] as string)).toEqual({ schema: "flop-observatory/feed-upgrade@0", snapshot_hash: s.hash, observed_at: s.upgrade?.observed_at, trust: "trusted RPC", upgrade: s.upgrade });
    const answer = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_upgrade", arguments: {} } }, { snapshot: s });
    expect(answer?.result).toEqual({ content: [{ type: "text", text: f["upgrade.json"] }] });
    expect(r.notice).toBe(noticeLine(s));
    expect(r.notice).toContain('"runtime_version":1014014,"executing_state":"reviewed","executing_spec_name":"tzkv-runtime","executing_spec_version":1014014,"authorized_state":"present"');
    // The reader serves it: ten files with SHA256SUMS.
    expect(Object.keys(f).sort()).toEqual([...PUBLISHED_FILES, "SHA256SUMS"].sort());
    expect(judgeLatest(f, { now: "2026-11-11T06:40:00.000Z", maxAgeSeconds: 3600 })).toEqual({ usable: true, snapshot: s, reset: null });
  });

  it("a latest/ written before the watch, nine files and no upgrade.json, is refused by the new reader", async () => {
    const { out } = await authorised();
    const { "upgrade.json": _u, SHA256SUMS: _s, ...nine } = files(out);
    const old = { ...nine, SHA256SUMS: sumsOf(Object.keys(nine).sort().map((n) => [n, nine[n] as string] as const)) };
    expect(judgeLatest(old, { now: "2026-11-11T06:40:00.000Z", maxAgeSeconds: 3600 })).toEqual({ usable: false, refused: ["missing upgrade.json"] });
  });

  it("with none read, the notice says null, upgrade.json holds null, and the page one blank upgrade row", async () => {
    const { out, s, r } = await run(tapeOf("live-rpc-down"), join(box, "no-log"));
    expect(s.upgrade).toBeNull();
    expect(JSON.parse(readFileSync(join(out, "upgrade.json"), "utf8")).upgrade).toBeNull();
    expect(r.notice).toContain('"executing_state":null,"executing_spec_name":null,"executing_spec_version":null,"authorized_state":null');
    expect(renderPage(s)).toContain('<h2>Runtime upgrade</h2>\n<div class="card"><table data-section="upgrade"><tr><th scope="row" data-for="upgrade">upgrade</th><td data-k="upgrade" class="unk"></td></tr></table></div>');
  });

  it("on the page: a row for every field under Runtime upgrade, an unknown state blank and marked unknown", async () => {
    const { s } = await run(tapeOf("upgrade-read-failed"), join(box, "no-log"));
    const h = renderPage(s);
    expect(h).toContain('<td data-k="upgrade.executing.state" data-v="unknown" class="unk" aria-label="unknown"></td>');
    expect(h).toContain(`<td data-k="upgrade.authorized.detail" data-v="${DETAIL.auFailed}">${DETAIL.auFailed}</td>`);
    const keys = [...h.matchAll(/data-k="(upgrade[^"]*)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["upgrade.observed_at", "upgrade.trust", "upgrade.at.hash", "upgrade.at.number", "upgrade.executing.state", "upgrade.executing.spec_name", "upgrade.executing.spec_version", "upgrade.executing.detail", "upgrade.authorized.state", "upgrade.authorized.bytes", "upgrade.authorized.length", "upgrade.authorized.detail", "upgrade.compared_with", "upgrade.executing_changed", "upgrade.authorization_appeared"]);
    expect(h.indexOf("<h2>Network status</h2>")).toBeLessThan(h.indexOf("<h2>Runtime upgrade</h2>"));
    expect(h.indexOf("<h2>Runtime upgrade</h2>")).toBeLessThan(h.indexOf("<h2>Escrows</h2>"));
  });

  it("adds no conflict and changes no exit code: each tape's status and exit with the watch are those of live-healthy's chain", async () => {
    const healthy = await run(tapeOf("live-healthy"), join(box, "no-log"));
    for (const d of ["upgrade-not-reviewed", "upgrade-read-failed", "upgrade-hostile"]) {
      const { r, s } = await run(tapeOf(d), join(box, "no-log"));
      expect([r.code, s.status.conflicts, s.status.reset_detected, s.status.rpc], d).toEqual([healthy.r.code, [], false, { ...healthy.s.status.rpc }]);
    }
  });
});
