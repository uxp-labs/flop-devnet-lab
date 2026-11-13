// Review of piece F (round 32), attack 1: the final record decoded a third way. The node's answers
// are read straight from the fixture's tape.jsonl (no helper of the fill, no src/scale), every key is
// built and every value decoded with the reference library, polkadot-api, from the reviewed 1014020
// metadata, and each value is compared with results.final.json. Also attack 2: the balances walked
// step by step from the start with only the fees and the movements the events name. Offline.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { AccountId, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encoderMetadata } from "./helpers/recorded-encoder.js";

type Rec = Record<string, any>;
const REPO = new URL("../../", import.meta.url);
const repoText = (p: string) => readFileSync(new URL(p, REPO), "utf8");
const DIR = "research/2026-11-12-encoder-devnet-test";
const FIX = "observatory/fixtures/recording-20261113182100-8769e8d2841bf49a";
const FINAL = JSON.parse(repoText(`${DIR}/results.final.json`)) as Rec;
const RUN = JSON.parse(repoText(`${DIR}/results.json`)) as Rec;
const TAPE = repoText(`${FIX}/tape.jsonl`)
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => JSON.parse(l) as Rec);
const B = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(encoderMetadata()))));
const ACC = AccountId();
const OWNER = RUN.accounts.owner.public_key as string;
const DEVICE = RUN.accounts.device.public_key as string;
const ss58 = (h: string) => ACC.dec(h);
const toHex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const CHANNEL = (FINAL.steps as Rec[]).find((s) => s.step === "T3").events.find((e: Rec) => e.name === "ForceOpenRequested").fields.channel_id as string;

/** The block of each id by the run time record (height), its hash by the tape's chain_getBlockHash. */
function blockHash(height: number): string {
  const c = TAPE.find((t) => t.request.method === "chain_getBlockHash" && t.request.params[0] === height);
  return c?.answer.result as string;
}
function storageAt(hash: string): Map<string, string | null> {
  const c = TAPE.find((t) => t.request.method === "state_queryStorageAt" && t.request.params[1] === hash);
  const m = new Map<string, string | null>();
  for (const [k, v] of (c?.answer.result[0].changes ?? []) as [string, string | null][]) m.set(k, v);
  return m;
}
function extrinsicsAt(hash: string): string[] {
  const c = TAPE.find((t) => t.request.method === "chain_getBlock" && t.request.params[0] === hash);
  return c?.answer.result.block.extrinsics as string[];
}

/** A papi value in a plain form: bigint and number as text, accounts as hex, binaries as hex, undefined as null. */
function plain(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint" || typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    if (/^[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(v)) return toHex(ACC.enc(v));
    return v;
  }
  if (typeof v.asHex === "function") return v.asHex();
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
}
/** The record's value in the same plain form; an Option written { type: Some|None } is unwrapped. */
function plainRecord(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(plainRecord);
  if (typeof v === "object") {
    if (v.type === "None" && Object.keys(v).length === 2) return null;
    if (v.type === "Some" && Object.keys(v).length === 2) return plainRecord(v.value);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainRecord(x)]));
  }
  return v;
}

const ID_OF = (id: string) => (id === "start" ? { height: RUN.start.finalized.number } : { height: (RUN.steps as Rec[]).find((s) => s.step === id).run_time.sent.block_number });

/** Every read of a block, decoded by the reference. Nothing stored is the word "absent". */
function refReads(id: string) {
  const hash = blockHash(ID_OF(id).height);
  const st = storageAt(hash);
  const read = (pallet: string, entry: string, ...k: unknown[]) => {
    const s = B.buildStorage(pallet, entry);
    const key = s.keys.enc(...k);
    if (!st.has(key)) throw new Error(`${id}: ${pallet}.${entry} not asked`);
    const raw = st.get(key) ?? null;
    return { key, raw, stored: raw !== null, value: raw === null ? null : s.value.dec(raw) };
  };
  return {
    hash,
    owner: read("System", "Account", ss58(OWNER)),
    device: read("System", "Account", ss58(DEVICE)),
    session: read("FlopSessionKeys", "Sessions", ss58(OWNER), ss58(DEVICE)),
    nonce: read("FlopSessionKeys", "SessionNonces", ss58(OWNER), ss58(DEVICE)),
    breaker: read("FlopSessionKeys", "CircuitBreakers", ss58(DEVICE)),
    channel: read("ComputeChannel", "Channels", CHANNEL),
    events: read("System", "Events"),
  };
}

const IDS = ["start", "T1", "T2", "T3", "T4", "T5", "T6", "T8", "T9"];
const afterOf = (id: string): Rec => (id === "start" ? FINAL.before : (FINAL.steps as Rec[]).find((s) => s.step === id).after);
const stepOf = (id: string): Rec => (FINAL.steps as Rec[]).find((s) => s.step === id);

const accountWord = (r: Rec) => (!r.stored ? { absent: true } : { free: String(r.value.data.free), reserved: String(r.value.data.reserved), nonce: String(r.value.nonce) });

describe("HOLDS: every read of the nine blocks, decoded by polkadot-api from the tape, is the final record's", () => {
  for (const id of IDS) {
    it(`HOLDS: ${id}: accounts, session, session nonce, breaker and channel`, () => {
      const r = refReads(id);
      const a = afterOf(id);
      if (id === "start") expect([FINAL.before.block_number, FINAL.before.block_hash]).toEqual([ID_OF(id).height, r.hash]);
      else expect([stepOf(id).finalized_in_block, stepOf(id).block_hash]).toEqual([ID_OF(id).height, r.hash]);
      expect(a.accounts.owner).toEqual(accountWord(r.owner));
      expect(a.accounts.device).toEqual(accountWord(r.device));
      expect(a.session).toEqual(r.session.stored ? { active: String(r.session.value.active), spent_raw: String(r.session.value.spent), epoch_spent_raw: String(r.session.value.epoch_spent) } : { absent: true });
      expect(a.session_nonce).toBe(r.nonce.stored ? String(r.nonce.value) : "absent");
      expect(a.breaker_tx_count).toBe(r.breaker.stored ? String(r.breaker.value.tx_count) : "absent");
      expect(plainRecord(a.channel)).toEqual(r.channel.stored ? plain(r.channel.value) : { absent: "true" });
      const raw = id === "start" ? FINAL.before.raw_reads : stepOf(id).raw_reads;
      for (const x of [r.owner, r.device, r.session, r.nonce, r.breaker, r.channel, r.events]) expect(raw[x.key]).toBe(x.raw);
    });
  }

  it("HOLDS: no balance the record's form leaves out moved: frozen is 0 and flags, providers, consumers are what the table says at every block", () => {
    const rows = IDS.map((id) => {
      const r = refReads(id);
      const f = (x: Rec) => (x.stored ? { frozen: String(x.value.data.frozen), flags: String(x.value.data.flags), providers: x.value.providers, consumers: x.value.consumers, sufficients: x.value.sufficients } : "absent");
      return { id, owner: f(r.owner), device: f(r.device) };
    });
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      for (const who of ["owner", "device"] as const) {
        const x = row[who];
        if (x !== "absent") expect([row.id, who, x.frozen]).toEqual([row.id, who, "0"]);
      }
    }
  });

  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6", "T8", "T9"]) {
    it(`HOLDS: ${id}: the events of the extrinsic, their order and fields, the fee and the result`, () => {
      const r = refReads(id);
      const s = stepOf(id);
      const evs = (B.buildStorage("System", "Events").value.dec(r.events.raw as string) as Rec[]).filter((e) => e.phase.type === "ApplyExtrinsic" && e.phase.value === s.extrinsic_index);
      expect(createHash("sha256").update(Buffer.from((r.events.raw as string).slice(2), "hex")).digest("hex")).toBe(s.events_value_sha256);
      expect(s.events.map((e: Rec) => `${e.pallet}.${e.name}`)).toEqual(evs.map((e) => `${e.event.type}.${e.event.value.type}`));
      // dispatch_error: the record keeps the module index and error bytes, the reference names them; held by the result below.
      const noErr = (x: Rec) => { const { dispatch_error: _, ...rest } = x ?? {}; return rest; };
      expect(plainRecord(s.events.map((e: Rec) => noErr(e.fields)))).toEqual(evs.map((e) => noErr(plain(e.event.value.value))));
      const fee = evs.filter((e) => e.event.type === "TransactionPayment" && e.event.value.type === "TransactionFeePaid");
      expect(fee).toHaveLength(1);
      expect(s.fee_raw).toBe(String(fee[0]?.event.value.value.actual_fee));
      expect(String(fee[0]?.event.value.value.tip)).toBe("0");
      expect(plain(fee[0]?.event.value.value.who)).toBe(s.signer);
      const last = evs[evs.length - 1];
      if (last.event.value.type === "ExtrinsicSuccess") expect(s.result).toBe("success");
      else {
        const err = last.event.value.value.dispatch_error;
        expect(err.type).toBe("Module");
        expect(s.result).toMatch(new RegExp(`^failed: ${err.value.type}\\.${err.value.value.type} \\(pallet `));
      }
      // The extrinsic is at that index and nowhere else.
      const signed = JSON.parse(repoText(`${DIR}/run-2026-11-13/signed/${id}.json`)) as Rec;
      const exts = extrinsicsAt(r.hash);
      expect(exts.flatMap((x, i) => (x === signed.extrinsic ? [i] : []))).toEqual([s.extrinsic_index]);
    });
  }
});

describe("attack 2: the balances walked from the start by fees and named movements", () => {
  it("HOLDS: the owner's and the device's free after each step is the start less each fee and each movement the events name", () => {
    let owner = BigInt(FINAL.before.accounts.owner.free);
    let device: bigint | "absent" = FINAL.before.accounts.device.absent ? "absent" : BigInt(FINAL.before.accounts.device.free);
    const rows: string[] = [];
    for (const id of ["T1", "T2", "T3", "T4", "T5", "T6", "T8", "T9"]) {
      const s = stepOf(id);
      let killed = false;
      for (const e of s.events as Rec[]) {
        const f = e.fields;
        const add = (who: string, d: bigint) => {
          if (who === OWNER) owner += d;
          if (who === DEVICE) device = (device === "absent" ? 0n : device) + d;
        };
        if (e.pallet === "Balances" && e.name === "Withdraw") add(f.who, -BigInt(f.amount));
        if (e.pallet === "Balances" && e.name === "Transfer") {
          add(f.from, -BigInt(f.amount));
          add(f.to, BigInt(f.amount));
        }
        if (e.pallet === "Balances" && e.name === "Deposit") add(f.who, BigInt(f.amount));
        if (e.pallet === "System" && e.name === "KilledAccount" && f.account === DEVICE) killed = true;
      }
      if (killed) {
        expect(device, `${id}: the device was killed holding`).toBe(0n);
        device = "absent";
      }
      rows.push(`${id} owner ${owner} record ${s.after.accounts.owner.free} | device ${device} record ${s.after.accounts.device.free ?? "absent"}`);
      expect(String(owner), id).toBe(s.after.accounts.owner.free);
      if (device === "absent") expect(s.after.accounts.device, id).toEqual({ absent: true });
      else expect(String(device), id).toBe(s.after.accounts.device.free);
    }
    console.log(rows.join("\n"));
  });
});
