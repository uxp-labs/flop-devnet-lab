// Our storage records on the third recording: the twelve keys of part B read across the runtime
// upgrade, and the deny list test's reads of part C, each decoded through the door
// (decodeStorageValue in src/scale/block.ts) under the runtime runtimeOfBlock chooses for its block,
// with that runtime's metadata found on the tape by its sha256. Every field has a source that is not
// this decoder: a results file of the lab's devnet tests, an earlier recording whose values rounds 19
// and 20 held to those files, or the reference decoder's decode of the same bytes (polkadot-api,
// tests only), marked READ. An assert that rests on a chain rule is marked RULE. Then the new
// runtime's values damaged: never anything but a refusal, never a value the reference reads another way.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type StorageValue, decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "../src/scale/block.js";
import { type Decoded, decodeValue } from "../src/scale/decode.js";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { ScaleError, fromHex, toHex } from "../src/scale/reader.js";
import { REVIEWED, type ReviewedShape } from "../src/scale/shape.js";
import { storageKey } from "../src/scale/storage-key.js";
import { plain } from "./helpers/plain.js";
import { recordedStorage } from "./helpers/recorded-storage.js";
import { type UpgradeRead, recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { keyBytes } from "./helpers/requests/core.js";
import { ACROSS, type Block, DENY, DENY_READS, RECORDS, NEVER_A_SESSION, type Read } from "./helpers/requests/list-3.js";

const U = recordedUpgrade();
const S = recordedStorage();
const record = (name: string) => JSON.parse(readFileSync(new URL(`../../research/${name}/results.json`, import.meta.url), "utf8"));
const DENY_RECORD = record("2026-11-11-session-deny-list");
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const shapeOf = (r: ReviewedShape) => readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8");
const [CONTROL, AFTER] = ACROSS;

/** One runtime's metadata, parsed by ours and by the reference, found on the tape by the sha256 of its REVIEWED line. */
const RUNTIMES = new Map<string, { md: Metadata; builder: ReturnType<typeof getDynamicBuilder> }>();
function runtime(r: ReviewedShape) {
  const known = RUNTIMES.get(r.metadataSha256);
  if (known) return known;
  const bytes = U.metadataBySha(r.metadataSha256);
  const made = { md: parseMetadata(bytes), builder: getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(bytes)))) };
  RUNTIMES.set(r.metadataSha256, made);
  return made;
}
function runtimeAt(b: Block): ReviewedShape {
  const r = runtimeOfBlock(U.upgradeOf(b));
  if (!r.found) throw new Error(r.refused);
  return r.reviewed;
}
/** A read through the door under the runtime chosen for its block. */
function door(r: UpgradeRead): StorageValue {
  const rt = runtimeAt(r.block);
  return decodeStorageValue({ specName: rt.specName, specVersion: rt.specVersion, metadata: U.metadataBySha(rt.metadataSha256), lastRuntimeUpgrade: U.upgradeOf(r.block), shapeText: shapeOf(rt), pallet: r.read.pallet, entry: r.read.entry, keys: keyBytes(U.inputs, r.read), key: fromHex(r.key), answer: r.answer });
}
const valueOf = (r: UpgradeRead): { stored: boolean; value: Decoded } => {
  const v = door(r);
  if (!v.decoded) throw new Error(`${r.read.entry} at ${r.height}: ${v.refused}`);
  return { stored: v.stored, value: v.value };
};
const entryOf = (md: Metadata, r: Read) => md.pallets.find((p) => p.name === r.pallet)?.storage?.entries.find((e) => e.name === r.entry);
const sameRead = (a: Read, b: Read) => JSON.stringify(a) === JSON.stringify(b);
const readAt = (b: Block, r: Read): UpgradeRead => {
  const x = U.reads.find((y) => y.block === b && sameRead(y.read, r));
  if (x === undefined) throw new Error(`no read of ${r.entry} at ${b}`);
  return x;
};
/** READ: the reference decoder's decode of the same bytes with the same runtime's metadata, in the plain form. */
function referenceOf(r: UpgradeRead, value: Decoded) {
  const rt = runtimeAt(r.block);
  const { md, builder } = runtime(rt);
  const e = md.pallets.find((p) => p.name === r.read.pallet)?.storage?.entries.find((x) => x.name === r.read.entry);
  const type = e?.value ?? -1;
  const bytes = r.answer ?? e?.fallback ?? new Uint8Array();
  return { ours: plain(md, "ours", type, value), reference: plain(md, "reference", type, builder.buildStorage(r.read.pallet, r.read.entry).value.dec(toHex(bytes))) };
}
const label = (r: Read) => `${r.entry}(${r.keys.map((k) => ("account" in k ? k.account : k.channel)).join(",")})`;
const ss58: Record<string, string> = {
  owner: record("2026-11-11-session-escrow").owner.ss58,
  device_1: record("2026-11-11-session-probe").device.ss58,
  device_2: record("2026-11-11-session-escrow").device.ss58,
  device_3: DENY_RECORD.device.ss58,
};

describe("our twelve records across the upgrade, at the last block of the old runtime and at a block of the new one", () => {
  it("reads 3528527 under the old runtime and 3530299 under the new one, chosen by their own LastRuntimeUpgrade", () => {
    expect([runtimeAt(CONTROL), runtimeAt(AFTER)]).toEqual([REVIEWED.at(0), REVIEWED.at(1)]);
  });

  it("asked at 3530299 the key the new runtime's metadata builds, by our key builder and by the reference: no prefix or hasher changed", () => {
    const { md, builder } = runtime(REVIEWED.at(1) as ReviewedShape);
    for (const r of RECORDS) {
      const asked = readAt(AFTER, r).key;
      expect(toHex(storageKey(md, r.pallet, r.entry, keyBytes(U.inputs, r))), label(r)).toBe(asked);
      expect(builder.buildStorage(r.pallet, r.entry).keys.enc(...r.keys.map((k) => ("account" in k ? ss58[k.account] : U.inputs.channels[k.channel].value))), label(r)).toBe(asked);
      expect(readAt(CONTROL, r).key, label(r)).toBe(asked);
    }
    expect(RECORDS).toHaveLength(12);
  });

  it("holds the same bytes at both blocks for every key: 11 stored, and the pair that never had a session absent at both", () => {
    for (const r of RECORDS) expect(readAt(AFTER, r).answer, label(r)).toEqual(readAt(CONTROL, r).answer);
    expect(RECORDS.filter((r) => readAt(CONTROL, r).answer === null)).toEqual([NEVER_A_SESSION]);
  });

  it("decodes each side under its own runtime to equal values, each the value the reference reads (READ)", () => {
    for (const r of RECORDS) {
      const before = valueOf(readAt(CONTROL, r));
      const after = valueOf(readAt(AFTER, r));
      expect(after, label(r)).toEqual(before);
      for (const x of [readAt(CONTROL, r), readAt(AFTER, r)]) {
        const v = valueOf(x);
        const both = referenceOf(x, v.value);
        expect(both.ours, `${label(r)} at ${x.height}`).toEqual(both.reference);
      }
    }
  });

  it("reads the pair that never had a session as the Default both sides: not stored, the default bytes the shapes state, decoded", () => {
    for (const b of ACROSS) {
      const x = readAt(b, NEVER_A_SESSION);
      const v = valueOf(x);
      const rt = runtimeAt(b);
      const shape = JSON.parse(shapeOf(rt));
      const { md } = runtime(rt);
      expect(shape.flop_session_keys.session_nonces.modifier, b).toBe("Default");
      expect(v, b).toEqual({ stored: false, value: decodeValue(md, entryOf(md, NEVER_A_SESSION)?.value ?? -1, fromHex(shape.flop_session_keys.session_nonces.default)) });
      const both = referenceOf(x, v.value);
      expect(both.ours, b).toEqual(both.reference);
    }
  });

  it("holds the bytes the second recording read at the end of the lab's first two tests, whose fields rounds 19 and 20 held to their results files", () => {
    // The last read of each key on the second recording, by height, where it read the key at all.
    const earlier = new Map<string, number>();
    for (const r of RECORDS) {
      const key = readAt(CONTROL, r).key;
      const last = S.reads.filter((x) => x.key === key).sort((a, b) => a.height - b.height).at(-1);
      if (last === undefined) continue;
      expect(last.answer, label(r)).toEqual(readAt(CONTROL, r).answer);
      earlier.set(label(r), last.height);
    }
    expect([...earlier.keys()]).toEqual(["Sessions(owner,device_1)", "Sessions(owner,device_2)", "SessionNonces(owner,device_2)", "CircuitBreakers(device_2)", "Channels(ours)", "Channels(gateway)"]);
  });

  it("holds device D3's records to the deny list test's own last reads on this recording: the session at the revoke block, the nonce and the breaker after the one call that succeeded", () => {
    for (const d of DENY_READS.filter((x) => x.block !== "session-deny-list/2-create-session")) {
      const from = readAt(d.block, d.read);
      expect(readAt(CONTROL, d.read).answer, `${label(d.read)} at ${from.height}`).toEqual(from.answer);
    }
  });
});

describe("the deny list test at the old runtime, held to research/2026-11-11-session-deny-list/results.json", () => {
  const steps = DENY_RECORD.steps as { step: string; finalized_in_block: number; extrinsic_index: number; result: string; events_value_sha256: string }[];
  const stepOf = (b: Block) => {
    const s = steps.find((x) => `session-deny-list/${x.step}` === b);
    if (s === undefined) throw new Error(`no step ${b}`);
    return s;
  };

  it("decodes each of the five blocks' events under the old runtime, of the sha256 the record gives of their hex", () => {
    for (const s of DENY) {
      expect(runtimeAt(s.block), s.block).toEqual(REVIEWED.at(0));
      expect(sha256(toHex(U.eventsOf(s.block))), s.block).toBe(stepOf(s.block).events_value_sha256);
    }
  });

  it("finds each step's outcome at its extrinsic index: the three successes, and the two refusals by the pallet and error index and names the record gives", () => {
    const md = runtime(REVIEWED.at(0) as ReviewedShape).md;
    let refusals = 0;
    for (const s of DENY) {
      const rt = runtimeAt(s.block);
      const e = decodeBlockEvents({ specName: rt.specName, specVersion: rt.specVersion, metadata: U.metadataBySha(rt.metadataSha256), lastRuntimeUpgrade: U.upgradeOf(s.block), shapeText: shapeOf(rt), events: U.eventsOf(s.block) });
      if (!e.decoded) throw new Error(e.refused);
      const step = stepOf(s.block);
      const outcome = e.events.filter((x) => x.pallet === "System" && (x.event === "ExtrinsicSuccess" || x.event === "ExtrinsicFailed") && JSON.stringify(x.phase) === JSON.stringify({ variant: "ApplyExtrinsic", fields: step.extrinsic_index }));
      expect(outcome, s.block).toHaveLength(1);
      const o = outcome[0];
      if (step.result === "success") {
        expect([o?.event, s.error], s.block).toEqual(["ExtrinsicSuccess", null]);
        continue;
      }
      refusals++;
      const m = /^failed: (\w+)\.(\w+) \(pallet (\d+), error (\d+)\)$/.exec(step.result);
      expect(m, step.result).not.toBeNull();
      const err = (o?.fields as { dispatch_error: { variant: string; fields: { index: number; error: string } } }).dispatch_error;
      expect([o?.event, err.variant, err.fields.index, fromHex(err.fields.error).at(0)], s.block).toEqual(["ExtrinsicFailed", "Module", Number(m?.[3]), Number(m?.[4])]);
      const pallet = md.pallets.find((p) => p.index === err.fields.index);
      const errors = md.types.at(pallet?.error ?? -1)?.def;
      const name = errors?.kind === "variant" ? errors.variants.find((v) => v.index === fromHex(err.fields.error).at(0))?.name : undefined;
      expect([pallet?.name, name], s.block).toEqual([m?.[1], m?.[2]]);
      expect(name, s.block).toBe(s.error);
    }
    expect(refusals).toBe(2);
  });

  const SESSION = DENY_RECORD.session;
  const STATE = DENY_RECORD.session_state;
  const create = () => valueOf(readAt("session-deny-list/2-create-session", DENY_READS[0]?.read as Read));
  const revoke = () => valueOf(readAt("session-deny-list/12-revoke-session", DENY_READS[1]?.read as Read));
  const utf8 = (hex: Decoded) => Buffer.from(fromHex(String(hex))).toString("utf8");

  it("reads the session of D3 at the create block with the terms the record gives and the nine allow list names exactly as given", () => {
    const s = create();
    const v = s.value as Record<string, Decoded>;
    expect(s.stored).toBe(true);
    expect([v.owner, v.delegate]).toEqual([DENY_RECORD.owner.public_key, DENY_RECORD.device.public_key]);
    expect([v.spending_cap, v.per_tx_limit, v.daily_cap]).toEqual([SESSION.spending_cap_raw, SESSION.per_tx_limit_raw, SESSION.daily_cap_raw]);
    expect((v.allowed_pallets as Decoded[]).map(utf8)).toEqual(SESSION.allowed_pallets);
    expect(v.active).toBe(STATE.after_step_2.active);
    // RULE: the epoch starts at the block that created the session, and it lasts the blocks it was given.
    expect([v.epoch_start, v.expires_at]).toEqual([SESSION.created_in_block, SESSION.created_in_block + SESSION.duration_blocks]);
    // READ: nothing spent yet, as the reference reads the same bytes.
    const both = referenceOf(readAt("session-deny-list/2-create-session", DENY_READS[0]?.read as Read), s.value);
    expect(both.ours).toEqual(both.reference);
    expect(Object.keys(v)).toEqual(["owner", "delegate", "spending_cap", "per_tx_limit", "daily_cap", "epoch_spent", "epoch_start", "spent", "expires_at", "allowed_pallets", "active"]);
  });

  it("reads the same session at the revoke block inactive, with what was spent as the record gives it after step 11, and every other field as at its creation", () => {
    const v = revoke().value as Record<string, Decoded>;
    const c = create().value as Record<string, Decoded>;
    expect(v.active).toBe(STATE.after_step_12.active);
    expect([v.spent, v.epoch_spent]).toEqual([STATE.after_step_11.spent_raw, STATE.after_step_11.epoch_spent_raw]);
    expect({ ...v, active: c.active, spent: c.spent, epoch_spent: c.epoch_spent }).toEqual(c);
  });

  it("reads the nonce and the breaker after the one call that succeeded as the record gives them, the other breaker fields as the reference reads them", () => {
    const [, , nonceRead, breakerRead] = DENY_READS;
    const n = valueOf(readAt(nonceRead?.block as Block, nonceRead?.read as Read));
    expect(n).toEqual({ stored: true, value: String(STATE.after_step_11.session_nonce) });
    const b = readAt(breakerRead?.block as Block, breakerRead?.read as Read);
    const br = valueOf(b);
    expect((br.value as Record<string, Decoded>).tx_count).toBe(STATE.after_step_11.circuit_breaker_tx_count);
    const both = referenceOf(b, br.value);
    expect(both.ours).toEqual(both.reference);
  });
});

describe("the new runtime's values damaged: a refusal, never another throw, never a value the reference reads another way", () => {
  /** Ours on these bytes: the plain value, or "refused" for a ScaleError; anything else is thrown on. */
  const ours = (md: Metadata, type: number, b: Uint8Array): Decoded | "refused" => {
    try {
      return decodeValue(md, type, b);
    } catch (e) {
      if (e instanceof ScaleError) return "refused";
      throw e;
    }
  };
  const NEW = REVIEWED.at(1) as ReviewedShape;
  const values = () => {
    const { md, builder } = runtime(NEW);
    return U.reads
      .filter((r) => r.answer !== null && runtimeAt(r.block).specVersion === NEW.specVersion)
      .map((r) => ({ r, md, codec: builder.buildStorage(r.read.pallet, r.read.entry).value, type: entryOf(md, r.read)?.value ?? -1, bytes: r.answer as Uint8Array }));
  };

  it("refuses every prefix of every stored value of the new runtime: our eleven records and the two blocks' events", () => {
    const all = values();
    expect(all).toHaveLength(13);
    let n = 0;
    for (const { r, md, type, bytes } of all) {
      expect(ours(md, type, bytes), `${r.read.entry} at ${r.height}`).not.toBe("refused");
      for (let i = 0; i < bytes.length; i++) {
        expect(ours(md, type, bytes.subarray(0, i)), `${r.read.entry} at ${r.height}, ${i} bytes`).toBe("refused");
        n++;
      }
    }
    expect(n).toBe(all.reduce((a, x) => a + x.bytes.length, 0));
  });

  it("ends every bit flip in a refusal or in the value the reference reads from the same bytes: every bit of a value of at most 512 bytes, one bit a byte of a larger one", () => {
    let compared = 0;
    let refused = 0;
    for (const { r, md, codec, type, bytes } of values()) {
      for (let i = 0; i < bytes.length; i++) {
        const bits = bytes.length <= 512 ? [0, 1, 2, 3, 4, 5, 6, 7] : [i % 8];
        for (const bit of bits) {
          const m = bytes.slice();
          m.set([(m.at(i) as number) ^ (1 << bit)], i);
          const v = ours(md, type, m);
          if (v === "refused") {
            refused++;
            continue;
          }
          let ref: unknown;
          try {
            ref = codec.dec(toHex(m));
          } catch {
            continue;
          }
          try {
            expect(JSON.stringify(plain(md, "ours", type, v)), `${r.read.entry} at ${r.height}, byte ${i} bit ${bit}`).toBe(JSON.stringify(plain(md, "reference", type, ref)));
            compared++;
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("reference:")) continue;
            throw e;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(0);
  });
});
