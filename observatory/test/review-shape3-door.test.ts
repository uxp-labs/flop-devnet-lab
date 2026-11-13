// Review of decoder-shape@3 (round 29), attack 3: the door (src/scale/block.ts decodeStorageValue)
// on the new entries, one change at a time. The keys and values are built by polkadot-api (the
// reference, tests only); the accounts and hashes are the third recording's inputs.
import { readFileSync } from "node:fs";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { decodeStorageValue } from "../src/scale/block.js";
import { fromHex } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";

const U = recordedUpgrade();
const [BEFORE, , , LATER] = UPGRADE_BLOCKS;
const OWNER = fromHex(U.inputs.accounts.owner.value);
const OURS = fromHex(U.inputs.channels.ours.value);
const GATEWAY = fromHex(U.inputs.channels.gateway.value);
const cat = (...p: Uint8Array[]) => new Uint8Array(p.flatMap((x) => [...x]));

const RT = REVIEWED.map((r) => {
  const metadata = U.metadataBySha(r.metadataSha256);
  return {
    spec: r.specVersion,
    ref: getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(metadata)))),
    pin: { specName: r.specName, specVersion: r.specVersion, metadata, lastRuntimeUpgrade: U.upgradeOf(r.specVersion === 1014014 ? BEFORE : LATER), shapeText: readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8") },
  };
});
type Rt = (typeof RT)[number];
const key = (rt: Rt, pallet: string, entry: string, parts: Uint8Array[]) => {
  const s = rt.ref.buildStorage(pallet, entry);
  return fromHex(s.keys.enc(...s.args.dec(cat(...parts))));
};
const door = (rt: Rt, pallet: string, entry: string, keys: Uint8Array[], k: Uint8Array, answer: Uint8Array | null) => decodeStorageValue({ ...rt.pin, pallet, entry, keys, key: k, answer });
const out = (v: ReturnType<typeof decodeStorageValue>) => (v.decoded ? { stored: v.stored, value: v.value } : v.refused);

describe.each(RT.map((rt) => [rt.spec, rt] as const))("review shape 3: the door on the new entries, spec %i", (_s, rt) => {
  const acct = (v: unknown) => rt.ref.buildStorage("System", "Account").value.enc(v);
  const ACCOUNT = { nonce: 1, consumers: 0, providers: 1, sufficients: 0, data: { free: 5n, reserved: 0n, frozen: 0n, flags: 0n } };
  const kAcct = key(rt, "System", "Account", [OWNER]);

  it("HOLDS: Balances.Account, the same entry name in another pallet, is refused by name; its key under System.Account is refused", () => {
    const bk = key(rt, "Balances", "Account", [OWNER]);
    expect(out(door(rt, "Balances", "Account", [OWNER], bk, new Uint8Array(64)))).toMatch(/is not a storage entry the reviewed shape states$/);
    expect(out(door(rt, "System", "Account", [OWNER], bk, acct(ACCOUNT)))).toBe("System.Account: the key asked is not the key of this entry and these key parts");
  });

  it("HOLDS: MeasuredRoots refuses its two parts swapped, one part missing, another precision, a key one byte longer", () => {
    const INT8 = new Uint8Array([3]);
    const FP16 = new Uint8Array([1]);
    const k = key(rt, "ModelRegistry", "MeasuredRoots", [OURS, INT8]);
    const v = GATEWAY;
    expect(out(door(rt, "ModelRegistry", "MeasuredRoots", [OURS, INT8], k, v))).toMatchObject({ stored: true });
    expect(out(door(rt, "ModelRegistry", "MeasuredRoots", [INT8, OURS], k, v))).toMatch(/^ModelRegistry\.MeasuredRoots: storage ModelRegistry\.MeasuredRoots, map key 0: /);
    expect(out(door(rt, "ModelRegistry", "MeasuredRoots", [OURS], k, v))).toBe("ModelRegistry.MeasuredRoots: storage ModelRegistry.MeasuredRoots takes 2 map keys, not 1");
    expect(out(door(rt, "ModelRegistry", "MeasuredRoots", [OURS, FP16], k, v))).toBe("ModelRegistry.MeasuredRoots: the key asked is not the key of this entry and these key parts");
    expect(out(door(rt, "ModelRegistry", "MeasuredRoots", [OURS, new Uint8Array([6])], k, v))).toMatch(/map key 1: /);
    expect(out(door(rt, "ModelRegistry", "MeasuredRoots", [OURS, INT8], cat(k, new Uint8Array([0])), v))).toMatch(/the key asked is \d+ bytes, more than/);
  });

  it("HOLDS: an answer with one more byte, an answer cut short, and empty bytes are refused for an Optional and a Default entry", () => {
    const k = key(rt, "MinerStaking", "Miners", [OWNER]);
    const miner = rt.ref.buildStorage("MinerStaking", "Miners").value.enc({ self_stake: 1n, delegated_stake: 0n, commission_rate: 0, is_active: true, total_rewards_earned: 0n, registered_at: 1 });
    expect(out(door(rt, "MinerStaking", "Miners", [OWNER], k, cat(miner, new Uint8Array([0]))))).toMatch(/^MinerStaking\.Miners: /);
    expect(out(door(rt, "MinerStaking", "Miners", [OWNER], k, miner.slice(0, -1)))).toMatch(/^MinerStaking\.Miners: /);
    expect(out(door(rt, "MinerStaking", "Miners", [OWNER], k, new Uint8Array(0)))).toMatch(/^MinerStaking\.Miners: /);
    const kf = key(rt, "ComputeChannel", "FailedAcks", [OWNER]);
    expect(out(door(rt, "ComputeChannel", "FailedAcks", [OWNER], kf, new Uint8Array(0)))).toMatch(/^ComputeChannel\.FailedAcks: /);
    expect(out(door(rt, "ComputeChannel", "FailedAcks", [OWNER], kf, new Uint8Array([1, 0, 0, 0, 0])))).toMatch(/^ComputeChannel\.FailedAcks: /);
    expect(out(door(rt, "System", "Account", [OWNER], kAcct, acct(ACCOUNT).slice(0, -1)))).toMatch(/^System\.Account: /);
  });

  it("HOLDS: System.Account: a u32 at its largest and an amount of 2^128 - 1 are exact; the default's flags against a stored 0", () => {
    const max = 2n ** 128n - 1n;
    const v = door(rt, "System", "Account", [OWNER], kAcct, acct({ nonce: 0xffffffff, consumers: 0xffffffff, providers: 0, sufficients: 0, data: { free: max, reserved: max, frozen: max, flags: max } }));
    expect(out(v)).toEqual({ stored: true, value: { nonce: 4294967295, consumers: 4294967295, providers: 0, sufficients: 0, data: { free: max.toString(), reserved: max.toString(), frozen: max.toString(), flags: max.toString() } } });
    const stored0 = door(rt, "System", "Account", [OWNER], kAcct, acct({ ...ACCOUNT, data: { ...ACCOUNT.data, free: 0n } }));
    expect(out(stored0)).toMatchObject({ stored: true, value: { data: { free: "0", flags: "0" } } });
    const absent = door(rt, "System", "Account", [OWNER], kAcct, null);
    expect(out(absent)).toMatchObject({ stored: false, value: { nonce: 0, data: { free: "0", flags: (1n << 127n).toString() } } });
  });
});
