/**
 * P2, rules T2 and T3, and B2: each way a chain read is unknown, each with its own test, and an entry with no stored
 * value, which is absent and not unknown. Every answer comes from a committed recording (test/lib/recorded-node.ts),
 * or is one recorded answer changed in a way the test says.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { eventsOf, runtimeOf, valueOf } from "../src/chain-read/door.js";
import { accountOf, eventsKey, lastRuntimeUpgradeKey, sessionKeys } from "../src/chain-read/keys.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { CAPS, nodeTransport, READ_METHODS } from "../src/chain-read/node.js";
import { readBlockEvents, readSessionState } from "../src/chain-read/read.js";
import { shapeFileText } from "../src/chain-read/shape-file.js";
import {
  copyScript,
  type Log,
  RERUN_RESULTS,
  repoJson,
  rerunScript,
  type Script,
  transportOf,
  UPGRADE_RECORDING,
  upgradeBlocks,
  upgradeScript,
} from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const DEV2: string = RESULTS.accounts.dev2.public_key;
/** The rerun's step A6, its first successful session call: its block holds every session entry the read asks. */
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const at = (s: any) => ({ number: s.finalized_in_block as number, hash: s.block_hash as string });
const LINE = KEY_TABLE.runtimes[0] as (typeof KEY_TABLE.runtimes)[number];
const keysOf = (owner: string, delegate: string) => (sessionKeys(LINE, (accountOf(owner) as any).value, (accountOf(delegate) as any).value) as any).value;

const B = upgradeBlocks();
const CARRIES = B["runtime-upgrade/carries-upgrade"] as { hash: string; height: number };
const FIRST_NEW = B["runtime-upgrade/first-of-new-runtime"] as { hash: string; height: number };
const LATER = B["runtime-upgrade/later-of-new-runtime"] as { hash: string; height: number };
/** The upgrade recording as a node whose finalized head is its latest block. */
const upgrade = (): Script => upgradeScript(LATER.hash, CARRIES.hash, [LATER.hash]);
/** The upgrade recording's accounts. */
const UP = repoJson(`${UPGRADE_RECORDING}/requests-inputs.json`).accounts;
const S: string = UP.owner.value;
const D1: string = UP.device_1.value;

const reasonOf = (g: { kind: string }) => (g as { reason?: string }).reason ?? "";
const lruAt = (s: Script, hash: string) => s.storage.get(`${hash} ${hexOf(lastRuntimeUpgradeKey())}`) as string;
const eventsAt = (s: Script, hash: string) => s.storage.get(`${hash} ${hexOf(eventsKey())}`) as string;

describe("T2: a runtime that is not reviewed is unknown", () => {
  it("a LastRuntimeUpgrade naming the next spec version (the recorded bytes, the version raised by one) is unknown by the door's words", async () => {
    const s = rerunScript(A6.block_hash);
    const lru = bytesOf(lruAt(s, A6.block_hash));
    // A four byte Compact<u32>: the version is the value shifted left by two, so adding 4 raises it by one.
    expect((lru[0] as number) & 3).toBe(2);
    const raised = Uint8Array.from(lru);
    raised[0] = (raised[0] as number) + 4;
    expect(runtimeOf(raised).kind).toBe("unknown");
    expect(reasonOf(runtimeOf(raised))).toMatch(/no reviewed runtime/);
    const changed = copyScript(s);
    changed.storage.set(`${A6.block_hash} ${hexOf(lastRuntimeUpgradeKey())}`, hexOf(raised));
    for (const r of [await readBlockEvents(transportOf(changed), at(A6)), await readSessionState(transportOf(changed), OWNER, DEV1)]) {
      expect(r.kind).toBe("unknown");
      expect(reasonOf(r)).toMatch(/^the runtime of the block: the decoder: no reviewed runtime/);
    }
  });

  it("a reviewed runtime the key table holds no line for is unknown for a session read (block 3528528, executed by the old runtime)", async () => {
    const r = await readSessionState(transportOf({ ...upgrade(), head: CARRIES.hash }), S, D1);
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toMatch(/key table holds no line for spec/);
  });
});

describe("T2: the upgrade block 3528528 read with its own metadata is unknown", () => {
  it("read with the metadata at its parent, as chain-read reads it, its events are known, at the old runtime", async () => {
    const r = await readBlockEvents(transportOf(upgrade()), { number: CARRIES.height, hash: CARRIES.hash });
    expect(r.kind).toBe("known");
    const lru = runtimeOf(bytesOf(lruAt(upgrade(), CARRIES.hash)));
    expect((r as any).value.runtime).toEqual((lru as any).value);
    expect((r as any).value.events.length).toBeGreaterThan(0);
  });

  it("a node whose header names the block itself as its parent hands the reader the metadata at the block: unknown by the door's words", async () => {
    const s = upgrade();
    s.headers.set(CARRIES.hash, { number: CARRIES.height, parentHash: CARRIES.hash });
    const r = await readBlockEvents(transportOf(s), { number: CARRIES.height, hash: CARRIES.hash });
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toMatch(/^System.Events: the decoder: not decoded: the metadata for spec \d+ is \d+ bytes/);
  });

  it("the door itself, given the metadata at the block, refuses", () => {
    const s = upgrade();
    const lru = bytesOf(lruAt(s, CARRIES.hash));
    const runtime = (runtimeOf(lru) as any).value;
    const shape = (shapeFileText(runtime.shapeFile) as any).value;
    const own = eventsOf({ runtime, metadata: bytesOf(s.metadata.get(CARRIES.hash) as string), lastRuntimeUpgrade: lru, shapeText: shape }, bytesOf(eventsAt(s, CARRIES.hash)));
    expect(own.kind).toBe("unknown");
    const parent = eventsOf({ runtime, metadata: bytesOf(s.metadata.get(s.hashes.get(CARRIES.height - 1) as string) as string), lastRuntimeUpgrade: lru, shapeText: shape }, bytesOf(eventsAt(s, CARRIES.hash)));
    expect(parent.kind).toBe("known");
  });

  it("the first block of the new runtime, read with the metadata at 3528528, its parent, is known at the new runtime", async () => {
    const r = await readBlockEvents(transportOf(upgrade()), { number: FIRST_NEW.height, hash: FIRST_NEW.hash });
    expect(r.kind).toBe("known");
    expect((r as any).value.runtime).toEqual((runtimeOf(bytesOf(lruAt(upgrade(), FIRST_NEW.hash))) as any).value);
  });
});

describe("T2: a wrong key is unknown", () => {
  it("the door refuses a value asked under another delegate's key", () => {
    const s = rerunScript(A6.block_hash);
    const lru = bytesOf(lruAt(s, A6.block_hash));
    const runtime = (runtimeOf(lru) as any).value;
    const pin = { runtime, metadata: bytesOf(s.metadata.values().next().value as string), lastRuntimeUpgrade: lru, shapeText: (shapeFileText(runtime.shapeFile) as any).value };
    const mine = keysOf(OWNER, DEV1).sessions;
    const other = keysOf(OWNER, DEV2).sessions;
    const answer = bytesOf(s.storage.get(`${A6.block_hash} ${hexOf(mine.key)}`) as string);
    expect(valueOf(pin, { pallet: "FlopSessionKeys", entry: "Sessions", keys: mine.parts, key: mine.key, answer }).kind).toBe("known");
    const wrong = valueOf(pin, { pallet: "FlopSessionKeys", entry: "Sessions", keys: mine.parts, key: other.key, answer });
    expect(wrong.kind).toBe("unknown");
    expect(reasonOf(wrong)).toMatch(/the key asked is not the key of this entry and these key parts/);
  });

  it("a key table line with a changed fixed part builds a key the door refuses", async () => {
    const s = rerunScript(A6.block_hash);
    const line = JSON.parse(JSON.stringify(LINE));
    line.entries.sessions.entryPart = line.entries.session_nonces.entryPart;
    const k = (sessionKeys(line, (accountOf(OWNER) as any).value, (accountOf(DEV1) as any).value) as any).value.sessions;
    const lru = bytesOf(lruAt(s, A6.block_hash));
    const runtime = (runtimeOf(lru) as any).value;
    const pin = { runtime, metadata: bytesOf(s.metadata.values().next().value as string), lastRuntimeUpgrade: lru, shapeText: (shapeFileText(runtime.shapeFile) as any).value };
    const v = valueOf(pin, { pallet: "FlopSessionKeys", entry: "Sessions", keys: k.parts, key: k.key, answer: null });
    expect(v.kind).toBe("unknown");
  });
});

describe("T2: a missing value where one must be is unknown", () => {
  it("no System.LastRuntimeUpgrade at the block", async () => {
    const s = rerunScript(A6.block_hash);
    s.storage.set(`${A6.block_hash} ${hexOf(lastRuntimeUpgradeKey())}`, null);
    const r = await readSessionState(transportOf(s), OWNER, DEV1);
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toMatch(/^System.LastRuntimeUpgrade: the node holds no value at .*, where one must be$/);
  });

  it("no System.Events at the block", async () => {
    const s = rerunScript(A6.block_hash);
    s.storage.set(`${A6.block_hash} ${hexOf(eventsKey())}`, null);
    const r = await readBlockEvents(transportOf(s), at(A6));
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toMatch(/^System.Events: the node holds no value at .*, where one must be$/);
  });

  it("no metadata at the block's parent", async () => {
    const s = rerunScript(A6.block_hash);
    s.metadata.clear();
    const r = await readBlockEvents(transportOf(s), at(A6));
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toMatch(/^the metadata at the block's parent: state_getMetadata: rpc error/);
  });
});

describe("T2: answers that are not hex, over their cap, node errors and timeouts are unknown", () => {
  const nonceKey = () => `${A6.block_hash} ${hexOf(keysOf(OWNER, DEV1).sessionNonces.key)}`;

  for (const [what, text] of [
    ["upper case hex (its last byte written AB)", (h: string) => `${h.slice(0, -2)}AB`],
    ["an odd number of hex digits", (h: string) => h.slice(0, -1)],
    ["no 0x", (h: string) => h.slice(2)],
    ["a number", () => 7],
  ] as const) {
    it(`a stored value written as ${what}`, async () => {
      const s = rerunScript(A6.block_hash);
      s.storage.set(nonceKey(), (text as (h: string) => any)(s.storage.get(nonceKey()) as string));
      const r = await readSessionState(transportOf(s), OWNER, DEV1);
      expect(r.kind).toBe("known");
      expect((r as any).value.sessionNonce.kind).toBe("unknown");
      expect((r as any).value.sessionNonce.reason).toMatch(/^FlopSessionKeys.SessionNonces: state_getStorage: the answer for sessionNonce is not/);
      expect((r as any).value.session.kind).toBe("known");
    });
  }

  it("a stored nonce one byte over its cap of a u64", async () => {
    const s = rerunScript(A6.block_hash);
    s.storage.set(nonceKey(), `${s.storage.get(nonceKey())}00`);
    const r = await readSessionState(transportOf(s), OWNER, DEV1);
    expect((r as any).value.sessionNonce.reason).toMatch(new RegExp(`more than its cap of ${CAPS.sessionNonce} bytes`));
  });

  it("each cap is a positive whole number of bytes, and the events and metadata caps are the decoder's 16 MiB", () => {
    for (const v of Object.values(CAPS)) expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    expect(CAPS.events).toBe(16 * 1024 * 1024);
    expect(CAPS.metadata).toBe(16 * 1024 * 1024);
  });

  it("System.Events over its cap is unknown and never decoded", async () => {
    const s = rerunScript(A6.block_hash);
    s.storage.set(`${A6.block_hash} ${hexOf(eventsKey())}`, `0x${"00".repeat(CAPS.events + 1)}`);
    const r = await readBlockEvents(transportOf(s), at(A6));
    expect(reasonOf(r)).toMatch(/^System.Events: state_getStorage: the answer for events is more than its cap/);
  });

  it("a header over its cap is unknown", async () => {
    const s = rerunScript(A6.block_hash);
    const t = transportOf(s);
    const big = async (m: any, p: readonly unknown[]) => {
      const a = await t(m, p);
      return m === "chain_getHeader" && a !== null ? { ...(a as object), digest: { logs: ["0x" + "00".repeat(CAPS.header)] } } : a;
    };
    const r = await readBlockEvents(big, at(A6));
    expect(reasonOf(r)).toMatch(/chain_getHeader: the answer is more than its cap/);
  });

  it("a finalized head that is not a 32 byte hash is unknown", async () => {
    const s = rerunScript(A6.block_hash);
    s.head = A6.block_hash.slice(0, -2);
    expect(reasonOf(await readSessionState(transportOf(s), OWNER, DEV1))).toBe("the finalized head: chain_getFinalizedHead: the answer is not a 32 byte hash");
  });

  it("a node error is unknown, with the method's name and the node's words", async () => {
    const t = async (m: any) => {
      if (m === "chain_getFinalizedHead") throw new Error("rpc error: the node is busy");
      return null;
    };
    expect(reasonOf(await readSessionState(t, OWNER, DEV1))).toBe("the finalized head: chain_getFinalizedHead: rpc error: the node is busy");
  });

  it("a node error's words are quoted through server-text.ts: cut, and never a frame", async () => {
    const t = async () => {
      throw new Error(`rpc error: ${"x".repeat(1000)}`);
    };
    expect(reasonOf(await readSessionState(t, OWNER, DEV1)).length).toBeLessThan(300);
  });

  describe("a timeout", () => {
    const real = globalThis.WebSocket;
    afterEach(() => {
      (globalThis as { WebSocket: unknown }).WebSocket = real;
    });

    it("is unknown: nodeTransport goes through node-rpc.ts rpcCall, whose timer ends a call no frame answers (a fake socket that never opens)", async () => {
      (globalThis as { WebSocket: unknown }).WebSocket = class {
        onopen: unknown;
        onmessage: unknown;
        onerror: unknown;
        close() {}
      };
      const r = await readSessionState(nodeTransport("ws://scripted.invalid", 20), OWNER, DEV1);
      expect(reasonOf(r)).toBe("the finalized head: chain_getFinalizedHead: rpc timeout");
    });
  });
});

describe("T2: events of a block that is not canonical, or above the finalized head, are unknown", () => {
  it("a block whose hash is not the node's at its height", async () => {
    const other = RESULTS.steps.find((s: any) => s.step === "A9");
    const r = await readBlockEvents(transportOf(rerunScript(other.block_hash)), { number: A6.finalized_in_block, hash: other.block_hash });
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toMatch(/is not canonical/);
  });

  it("a block whose header names another number", async () => {
    const s = rerunScript(A6.block_hash);
    s.headers.set(A6.block_hash, { ...(s.headers.get(A6.block_hash) as any), number: A6.finalized_in_block - 1 });
    s.headers.set(s.head, s.headers.get(A6.block_hash) as any);
    const head = RESULTS.steps.find((x: any) => x.step === "A9");
    const r = await readBlockEvents(transportOf({ ...s, head: head.block_hash }), at(A6));
    expect(reasonOf(r)).toMatch(/names block/);
  });

  it("a block above the finalized head", async () => {
    const later = RESULTS.steps.find((s: any) => s.step === "A9");
    const r = await readBlockEvents(transportOf(rerunScript(A6.block_hash)), at(later));
    expect(r.kind).toBe("unknown");
    expect(reasonOf(r)).toBe(`block ${later.finalized_in_block} is not at or below the finalized head ${A6.finalized_in_block}`);
  });

  it("a block number that is not a whole number at or above 0 is unknown", async () => {
    for (const n of [-1, 1.5, Number.NaN]) expect((await readBlockEvents(transportOf(rerunScript(A6.block_hash)), { number: n, hash: A6.block_hash })).kind).toBe("unknown");
  });

  it("a block at or below the finalized head is read", async () => {
    const later = RESULTS.steps.find((s: any) => s.step === "A9");
    expect((await readBlockEvents(transportOf(rerunScript(later.block_hash)), at(A6))).kind).toBe("known");
  });
});

describe("B2: a header of the wrong shape is unknown", () => {
  const withHeader = (h: unknown) => {
    const base = transportOf(rerunScript(A6.block_hash));
    return (m: any, p: readonly unknown[]) => (m === "chain_getHeader" ? Promise.resolve(h) : base(m, p));
  };
  const good = () => ({ number: `0x${A6.finalized_in_block.toString(16)}`, parentHash: (rerunScript(A6.block_hash).headers.get(A6.block_hash) as any).parentHash });

  it("the control: the recorded header's number and stand in parent are read", async () => {
    expect((await readSessionState(withHeader(good()), OWNER, DEV1)).kind).toBe("known");
  });

  for (const [what, h, reason] of [
    ["no block", null, /holds no block/],
    ["a list", [], /is not a header/],
    ["a number in decimal", { ...{}, number: "3552838" }, /number is not a hex quantity/],
    ["a number past a u32", { number: "0x100000000" }, /number is not a hex quantity/],
    ["a number with a leading zero", { number: "0x0a" }, /number is not a hex quantity/],
    ["a parent hash of 31 bytes", { parentHash: `0x${"ab".repeat(31)}` }, /parentHash is not a 32 byte hash/],
  ] as const) {
    it(`a header with ${what}`, async () => {
      const header = h === null || Array.isArray(h) ? h : { ...good(), ...h };
      const r = await readSessionState(withHeader(header), OWNER, DEV1);
      expect(r.kind).toBe("unknown");
      expect(reasonOf(r)).toMatch(reason);
    });
  }
});

describe("B2: one finalized head, and every call at it", () => {
  it("the head is asked once; every storage read is at that hash and the metadata at its parent, whatever the head says later", async () => {
    const s = rerunScript(A6.block_hash);
    const later = RESULTS.steps.find((x: any) => x.step === "A9").block_hash;
    const log: Log = [];
    const base = transportOf(s, log);
    let asked = 0;
    const moving = (m: any, p: readonly unknown[]) => {
      if (m === "chain_getFinalizedHead") asked += 1;
      return asked > 1 && m === "chain_getFinalizedHead" ? Promise.resolve(later) : base(m, p);
    };
    const r = await readSessionState(moving, OWNER, DEV1);
    expect(r.kind).toBe("known");
    expect(asked).toBe(1);
    const storage = log.filter((c) => c.method === "state_getStorage");
    expect(storage.length).toBe(4);
    for (const c of storage) expect(c.params[1]).toBe(A6.block_hash);
    expect(log.filter((c) => c.method === "state_getMetadata").map((c) => c.params[0])).toEqual([(s.headers.get(A6.block_hash) as any).parentHash]);
    expect(log.filter((c) => c.method === "chain_getHeader").map((c) => c.params[0])).toEqual([A6.block_hash]);
  });

  it("a read asks only the five read methods", async () => {
    const log: Log = [];
    await readSessionState(transportOf(rerunScript(A6.block_hash), log), OWNER, DEV1);
    await readBlockEvents(transportOf(rerunScript(A6.block_hash), log), at(A6));
    for (const c of log) expect(READ_METHODS).toContain(c.method);
    expect(new Set(log.map((c) => c.method))).toEqual(new Set(READ_METHODS));
  });

  it("an owner or delegate that is not a 32 byte account is unknown before any call", async () => {
    const log: Log = [];
    expect(reasonOf(await readSessionState(transportOf(rerunScript(A6.block_hash), log), OWNER.slice(0, -2), DEV1))).toMatch(/^the owner:/);
    expect(reasonOf(await readSessionState(transportOf(rerunScript(A6.block_hash), log), OWNER, DEV1.toUpperCase()))).toMatch(/^the delegate:/);
    expect(log).toEqual([]);
  });
});

describe("T3: an entry with no stored value is absent, not unknown", () => {
  it("SessionNonces of device D1 as owner and S as delegate, answered null at block 3530299 of the upgrade recording, is absent", async () => {
    const r = await readSessionState(transportOf(upgrade()), D1, S);
    expect(r.kind).toBe("known");
    expect((r as any).value.number).toBe(LATER.height);
    expect((r as any).value.sessionNonce).toEqual({ kind: "absent" });
  });

  it("the same read's entries the recording did not ask are unknown, not absent", async () => {
    const r = await readSessionState(transportOf(upgrade()), D1, S);
    expect((r as any).value.session.kind).toBe("unknown");
    expect((r as any).value.circuitBreaker.kind).toBe("unknown");
  });

  it("an Optional entry (Sessions) answered null is absent too", async () => {
    const s = rerunScript(A6.block_hash);
    s.storage.set(`${A6.block_hash} ${hexOf(keysOf(OWNER, DEV1).sessions.key)}`, null);
    const r = await readSessionState(transportOf(s), OWNER, DEV1);
    expect((r as any).value.session).toEqual({ kind: "absent" });
    expect((r as any).value.sessionNonce.kind).toBe("known");
  });

  it("S and D1's session at block 3530299, recorded whole, is known at the new runtime", async () => {
    const r = await readSessionState(transportOf(upgrade()), S, D1);
    expect(r.kind).toBe("known");
    for (const e of ["session", "sessionNonce", "circuitBreaker"]) expect((r as any).value[e].kind).toBe("known");
    expect((r as any).value.runtime).toEqual((runtimeOf(bytesOf(lruAt(upgrade(), LATER.hash))) as any).value);
  });
});
