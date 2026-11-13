/**
 * Review of P2 (reviewer, not the builder): the three things the lead saw, L1, L2 and L3.
 *
 * Which test is which:
 *  - "RULE X..." tests were the reviewer's DEFECT tests: each failed on fcf75d0 and now holds the lead's rule of
 *    that id (the P2 fix round), so its name states the rule.
 *  - "HOLDS ..." tests are controls. They pass on fcf75d0.
 *
 * Every hash, account and answer comes from a committed recording through test/lib/recorded-node.ts and
 * research/2026-11-12-session-rerun-1014020/results.json (fields named where used). No socket is opened: a fake
 * WebSocket class stands in for the global one, as the builder's timeout test does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { hexOf } from "../src/chain-read/bytes.js";
import { crossCheck } from "../src/chain-read/cross-check.js";
import { accountOf, sessionKeys } from "../src/chain-read/keys.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { nodeTransport, READ_METHODS } from "../src/chain-read/node.js";
import { readBlockEvents, readSessionState } from "../src/chain-read/read.js";
import { RERUN_RESULTS, repoJson, rerunScript, type Script, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
/** results.json accounts.owner / dev1 / dev2 .public_key */
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const DEV2: string = RESULTS.accounts.dev2.public_key;
/** results.json steps: A6 is dev1's first successful session call; B10 is dev2's successful session call. */
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const B10 = RESULTS.steps.find((s: any) => s.step === "B10");
const LINE = KEY_TABLE.runtimes[0] as (typeof KEY_TABLE.runtimes)[number];
const keysOf = (o: string, d: string) => (sessionKeys(LINE, (accountOf(o) as any).value, (accountOf(d) as any).value) as any).value;

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

/**
 * A fake WebSocket that answers each request frame from a scripted recorded node. frameFor may replace the frame
 * the node sends back. sent collects every request frame put on the wire.
 */
function fakeSocket(script: Script, sent: any[], frameFor: (req: any, honest: string) => string = (_r, h) => h) {
  const t = transportOf(script);
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }
    send(text: string) {
      const req = JSON.parse(text);
      sent.push(req);
      (async () => {
        let honest: string;
        try {
          honest = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: await t(req.method, req.params) });
        } catch (e) {
          honest = JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: (e as Error).message } });
        }
        this.onmessage?.({ data: frameFor(req, honest) });
      })();
    }
    close() {}
  };
}

describe("L1 (found on fcf75d0, now rule X1): only a frame with its own result key is the call's answer", () => {
  const sessionEntryKeys = () => {
    const k = keysOf(OWNER, DEV1);
    return new Set([hexOf(k.sessions.key), hexOf(k.sessionNonces.key), hexOf(k.circuitBreakers.key)]);
  };

  it("HOLDS the control: through nodeTransport and honest frames, A6's session, nonce and breaker are known and stored", async () => {
    fakeSocket(rerunScript(A6.block_hash), []);
    const r = await readSessionState(nodeTransport("ws://scripted.invalid", 2000), OWNER, DEV1);
    expect(r.kind).toBe("known");
    for (const e of ["session", "sessionNonce", "circuitBreaker"]) expect([e, (r as any).value[e].kind, (r as any).value[e].stored]).toEqual([e, "known", true]);
  });

  for (const [what, frame] of [
    ["an empty object {}", (_req: any) => "{}"],
    ["a notification (method and params, no id, no result)", (_req: any) => JSON.stringify({ jsonrpc: "2.0", method: "state_storage", params: { subscription: "x", result: null } })],
    ["an answer to another id with a null result", (req: any) => JSON.stringify({ jsonrpc: "2.0", id: req.id + 1, result: null })],
    ["a frame whose error is 0 and that has no result", (req: any) => JSON.stringify({ jsonrpc: "2.0", id: req.id, error: 0 })],
  ] as const) {
    it(`RULE X1 a session entry answered with ${what} is unknown, not absent and not the default 0`, async () => {
      const keys = sessionEntryKeys();
      fakeSocket(rerunScript(A6.block_hash), [], (req, honest) => (req.method === "state_getStorage" && keys.has(req.params[0]) ? frame(req) : honest));
      const r = await readSessionState(nodeTransport("ws://scripted.invalid", 2000), OWNER, DEV1);
      expect(r.kind).toBe("known");
      // On fcf75d0: session is { kind: "absent" } and sessionNonce is { kind: "known", value: 0n, stored: false }.
      expect.soft((r as any).value.session).toMatchObject({ kind: "unknown" });
      expect.soft((r as any).value.sessionNonce).toMatchObject({ kind: "unknown" });
      expect.soft((r as any).value.circuitBreaker).toMatchObject({ kind: "unknown" });
    });
  }

  it("RULE X1 a frame answering another id is not taken as this call's answer", async () => {
    // The head is answered under id 2 with the recorded A6 hash: rpcCall takes it as the answer to its id 1.
    const sent: any[] = [];
    fakeSocket(rerunScript(A6.block_hash), sent, (req, honest) => JSON.stringify({ ...JSON.parse(honest), id: req.id + 1 }));
    const r = await readSessionState(nodeTransport("ws://scripted.invalid", 2000), OWNER, DEV1);
    expect(sent.length).toBeGreaterThan(0);
    expect(r.kind).toBe("unknown");
  });

  it("RULE X1 a frame with no jsonrpc field is not taken as an answer", async () => {
    fakeSocket(rerunScript(A6.block_hash), [], (_req, honest) => {
      const f = JSON.parse(honest);
      delete f.jsonrpc;
      return JSON.stringify(f);
    });
    const r = await readSessionState(nodeTransport("ws://scripted.invalid", 2000), OWNER, DEV1);
    expect(r.kind).toBe("unknown");
  });
});

describe("L2 (found on fcf75d0, now rule X2): nodeTransport sends only the five read methods", () => {
  it("RULE X2 a cast cannot make chain-read's transport put author_submitExtrinsic on the wire", async () => {
    const sent: any[] = [];
    fakeSocket(rerunScript(A6.block_hash), sent, (req) => JSON.stringify({ jsonrpc: "2.0", id: req.id, result: `0x${"00".repeat(32)}` }));
    const t = nodeTransport("ws://scripted.invalid", 2000);
    try {
      await t("author_submitExtrinsic" as any, ["0x00"]);
    } catch {
      /* a refusal by throw would also keep the wire clean */
    }
    expect(sent.map((f) => f.method).filter((m) => !(READ_METHODS as readonly string[]).includes(m))).toEqual([]);
  });

  it("HOLDS the five read methods go on the wire as asked", async () => {
    const sent: any[] = [];
    fakeSocket(rerunScript(A6.block_hash), sent);
    await readSessionState(nodeTransport("ws://scripted.invalid", 2000), OWNER, DEV1);
    for (const f of sent) expect(READ_METHODS as readonly string[]).toContain(f.method);
  });
});

describe("L3 (found on fcf75d0, now rule X3): the stored record's owner and delegate must be the ones asked", () => {
  /**
   * At B10 (dev2's successful session call) a node answers the three keys of (OWNER, DEV1) with the recorded bytes of
   * (OWNER, DEV2) at that block. The door builds the key from the asked parts, so the key check passes; the bytes are
   * a whole session record of another delegate.
   */
  const swapped = (): Script => {
    const s = rerunScript(B10.block_hash);
    const mine = keysOf(OWNER, DEV1);
    const theirs = keysOf(OWNER, DEV2);
    for (const e of ["sessions", "sessionNonces", "circuitBreakers"]) {
      const v = s.storage.get(`${B10.block_hash} ${hexOf(theirs[e].key)}`);
      if (v !== undefined) s.storage.set(`${B10.block_hash} ${hexOf(mine[e].key)}`, v);
    }
    return s;
  };

  it("HOLDS the control: the recording holds dev2's session at B10, and it reads known for (OWNER, DEV2)", async () => {
    const r = await readSessionState(transportOf(rerunScript(B10.block_hash)), OWNER, DEV2);
    expect((r as any).value.session.kind).toBe("known");
    expect((r as any).value.session.value.delegate).toBe(DEV2);
  });

  it("RULE X3 a read of (OWNER, DEV1) never answers known a session record whose delegate is DEV2", async () => {
    const r = await readSessionState(transportOf(swapped()), OWNER, DEV1);
    expect(r.kind).toBe("known");
    const session = (r as any).value.session;
    // On fcf75d0: { kind: "known", stored: true, value: { owner: OWNER, delegate: DEV2, ... } }.
    if (session.kind === "known") expect([session.value.owner, session.value.delegate]).toEqual([OWNER, DEV1]);
    expect(session.kind).toBe("unknown");
  });

  it("RULE X3 crossCheck of the (OWNER, DEV1) read against B10's events, which hold only dev2's SessionCallExecuted, does not agree", async () => {
    const t = transportOf(swapped());
    const state = await readSessionState(t, OWNER, DEV1);
    const events = await readBlockEvents(t, { number: B10.finalized_in_block, hash: B10.block_hash });
    expect([state.kind, events.kind]).toEqual(["known", "known"]);
    const c = crossCheck((state as any).value, (events as any).value);
    // On fcf75d0: known, with dev2's totals, for a state whose delegate field says DEV1.
    expect(c.kind).toBe("unknown");
  });
});
