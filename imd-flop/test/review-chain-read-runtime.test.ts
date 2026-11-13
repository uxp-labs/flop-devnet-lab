/**
 * Review of P2 (reviewer, not the builder): attack C, the runtime (R3).
 *
 * All "HOLDS": these pass on fcf75d0 and pin what held. The blocks are the upgrade recording's
 * (observatory/fixtures/recording-20261112080132-05842a6db1e9c890/requests-inputs.json blocks, from
 * research/2026-11-12-runtime-upgrade/results.json boundary.*); the metadata blobs are the ones that recording
 * answered at the last block of the old runtime (old) and at the block that carried the upgrade (new).
 */
import { describe, expect, it } from "vitest";
import type { Transport } from "../src/chain-read/node.js";
import { readBlockEvents, readSessionState } from "../src/chain-read/read.js";
import { repoJson, transportOf, UPGRADE_RECORDING, upgradeBlocks, upgradeScript } from "./lib/recorded-node.js";

const B = upgradeBlocks();
const LAST_OLD = B["runtime-upgrade/last-of-old-runtime"] as { hash: string; height: number };
const CARRIES = B["runtime-upgrade/carries-upgrade"] as { hash: string; height: number };
const FIRST_NEW = B["runtime-upgrade/first-of-new-runtime"] as { hash: string; height: number };
const LATER = B["runtime-upgrade/later-of-new-runtime"] as { hash: string; height: number };
const UP = repoJson(`${UPGRADE_RECORDING}/requests-inputs.json`).accounts;

const script = () => upgradeScript(LATER.hash, CARRIES.hash, [LATER.hash]);
const OLD_MD = () => script().metadata.get(LAST_OLD.hash) as string;
const NEW_MD = () => script().metadata.get(CARRIES.hash) as string;

/** A node from the upgrade recording whose metadata answer, at any block, is the one given. */
const withMetadata = (md: string): Transport => {
  const base = transportOf(script());
  return (m, p) => (m === "state_getMetadata" ? Promise.resolve(md) : base(m, p));
};
/** A node from the upgrade recording whose metadata answer is the one recorded at the block asked about itself. */
const ownMetadata = (block: string): Transport => {
  const s = script();
  const base = transportOf(s);
  return (m, p) => (m === "state_getMetadata" ? Promise.resolve(s.metadata.get(block) ?? NEW_MD()) : base(m, p));
};

describe("C: the upgrade block and the first block of the new runtime", () => {
  it("HOLDS the recording holds two different metadata blobs at the last old block and the upgrade block", () => {
    expect(OLD_MD()).toBeDefined();
    expect(NEW_MD()).toBeDefined();
    expect(OLD_MD()).not.toBe(NEW_MD());
  });

  it("HOLDS 3528528 (LastRuntimeUpgrade names the old spec): its parent's (old) metadata is known; its own and the new metadata are unknown", async () => {
    const at = { number: CARRIES.height, hash: CARRIES.hash };
    const parent = await readBlockEvents(withMetadata(OLD_MD()), at);
    expect(parent.kind).toBe("known");
    expect((await readBlockEvents(ownMetadata(CARRIES.hash), at)).kind).toBe("unknown");
    expect((await readBlockEvents(withMetadata(NEW_MD()), at)).kind).toBe("unknown");
  });

  it("HOLDS 3528529 (the first of the new runtime): the new metadata, whether at its parent or at itself, is known; the old is unknown", async () => {
    const at = { number: FIRST_NEW.height, hash: FIRST_NEW.hash };
    const r = await readBlockEvents(withMetadata(NEW_MD()), at);
    expect(r.kind).toBe("known");
    expect((await readBlockEvents(ownMetadata(FIRST_NEW.hash), at)).kind).toBe("known");
    expect((await readBlockEvents(withMetadata(OLD_MD()), at)).kind).toBe("unknown");
    const old = await readBlockEvents(withMetadata(OLD_MD()), { number: CARRIES.height, hash: CARRIES.hash });
    expect((r as any).value.runtime.specVersion).not.toBe((old as any).value.runtime.specVersion);
  });

  it("HOLDS a session read at a block of the new runtime with the old runtime's metadata answers no entry known", async () => {
    const r = await readSessionState(withMetadata(OLD_MD()), UP.owner.value, UP.device_1.value);
    if (r.kind === "known") for (const f of ["session", "sessionNonce", "circuitBreaker"]) expect([f, (r.value as any)[f].kind]).toEqual([f, "unknown"]);
    else expect(r.kind).toBe("unknown");
  });

  it("HOLDS the same session read with the new metadata is known (the control)", async () => {
    const r = await readSessionState(withMetadata(NEW_MD()), UP.owner.value, UP.device_1.value);
    expect(r.kind).toBe("known");
    expect((r as any).value.session.kind).toBe("known");
  });
});
