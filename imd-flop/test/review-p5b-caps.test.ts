/**
 * Review of P5b, attacks 1 and 2 (promises P1, P2, P3). The reviewer's own arithmetic: each cap is set through
 * `cap set` from its decimal text, the four values of the grant are computed here from that text with integers
 * alone, and the printed hex is read back by the reference decoder (@polkadot-api, test/lib/chain-fixtures.ts).
 * The node is the rerun's recording at step A10 (research/2026-11-12-session-rerun-1014020/results.json
 * `steps[A10].block_hash`), the epoch length from that folder's facts-1014020.json
 * (`constants.FlopSessionKeys.SessionEpochLength.value`). No socket is opened.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { describeOwnerCall } from "../src/chain/describe.js";
import { rawOf } from "../src/session/caps.js";
import { CliError } from "../src/errors.js";
import { cli } from "./helpers.js";
import { hex, readJson, ref, refCall, RERUN, RUNTIME_ID, unhex } from "./lib/chain-fixtures.js";
import { DEV1, OWNER, scriptAt, seatHome, session, transportOf } from "./lib/session-fixtures.js";
import type { Log } from "./lib/recorded-node.js";
import { referenceBlake2b256, referenceReady } from "./lib/sr25519-reference.js";

const EPOCH = Number(readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys.SessionEpochLength.value);
const account = ref.buildDefinition(0);

beforeAll(async () => {
  await referenceReady();
});

/** The exact raw amount (10^18 per FLOP) of a decimal text, with an optional exponent, by integers alone; null when it is not a whole number of raw units. */
function rawOfText(t: string): bigint | null {
  const m = /^([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(t);
  if (m === null) throw new Error(`not a decimal text: ${t}`);
  const digits = m[1] + (m[2] ?? "");
  const shift = 18 - (m[2] ?? "").length + Number(m[3] ?? "0");
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift);
  const d = 10n ** BigInt(-shift);
  const n = BigInt(digits);
  return n % d === 0n ? n / d : null;
}

/** A raw amount as FLOP text, by the reviewer's own arithmetic. */
function flopText(raw: bigint): string {
  const w = raw / 10n ** 18n;
  const f = (raw % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
}

const grantJson = (home: string, days: number, log?: Log) => session(home, ["grant", "--owner", OWNER.ss58, "--days", String(days), "--json"], transportOf(scriptAt("A10"), log));

async function seatWithCaps(daily: string, perCall: string): Promise<string> {
  const home = seatHome(DEV1, null);
  const r = await cli(home, ["cap", "set", daily, "--per-call", perCall]);
  expect([r.code, r.err]).toEqual([0, ""]);
  return home;
}

/** The decoded allow list's names as text. */
const names = (list: unknown[]): string[] => list.map((x: any) => Buffer.from(typeof x?.asBytes === "function" ? x.asBytes() : x).toString("utf8"));

const SENTENCE =
  /^This grant lets the device spend at most (\d+) raw \(([0-9.]+) FLOP\) over the whole session, at most (\d+) raw \(([0-9.]+) FLOP\) per epoch, and at most (\d+) raw \(([0-9.]+) FLOP\) per call, through (\w+) calls only, for (\d+) blocks, which is (\d+) epochs? of the runtime's epoch length of (\d+) blocks\.$/;

// [per call text, daily text]: the smallest cap, 1 to 6 decimals, exponents, trailing zeros, doubles that are not
// their decimal text (0.1, 0.3, 0.7), per call equal to daily, and the largest the tool allows (AMOUNT_MAX 1e9).
const GRID: [string, string][] = [
  ["0.000001", "0.000001"],
  ["1e-6", "1e-6"],
  ["0.1", "0.3"],
  ["0.1", "0.1"],
  ["0.3", "0.7"],
  ["1.5e-3", "2.500000"],
  ["0.123456", "0.654321"],
  ["12.34", "56.7"],
  ["0.000007", "999999999.999993"],
  ["123456789.123456", "987654321.987654"],
  ["999999999.999999", "999999999.999999"],
  ["1000000000", "1000000000"],
  ["1e9", "1e9"],
  ["0.29", "4.35"],
  ["1.1", "1.15"],
];

describe("review P5b, attack 1 and 2: the grant's caps and bytes by the reviewer's own arithmetic", () => {
  for (const [perCall, daily] of GRID) {
    it(`HOLDS: cap set ${daily} --per-call ${perCall}, days 1 to 10: the four values, the delegate, the allow list, the hash, the words and the sentence are exact`, async () => {
      const home = await seatWithCaps(daily, perCall);
      const per = rawOfText(perCall)!;
      const day = rawOfText(daily)!;
      for (let days = 1; days <= 10; days++) {
        const r = await grantJson(home, days);
        expect([days, r.code, r.err]).toEqual([days, 0, ""]);
        const j = r.json();
        const back = refCall.dec(unhex(j.call_hex));
        expect([back.type, back.value.type]).toEqual(["FlopSessionKeys", "create_session"]);
        const v = back.value.value;
        expect({ delegate: hex(account.enc(v.delegate)), spending_cap: v.spending_cap, per_tx_limit: v.per_tx_limit, daily_cap: v.daily_cap, duration_blocks: v.duration_blocks, allowed: names(v.allowed_pallets) }).toEqual({
          delegate: DEV1.public_key,
          spending_cap: day * BigInt(days),
          per_tx_limit: per,
          daily_cap: day,
          duration_blocks: EPOCH * days,
          allowed: ["ComputeChannel"],
        });
        // The reference encodes the same value to the same bytes: nothing printed beyond the call.
        expect(hex(refCall.enc(back))).toBe(j.call_hex);
        expect(j.call_blake2b_256).toBe(hex(referenceBlake2b256(unhex(j.call_hex))));
        expect(j.words).toBe(describeOwnerCall(RUNTIME_ID, unhex(j.call_hex)));
        const s = SENTENCE.exec(j.allows);
        expect(s, j.allows).not.toBeNull();
        expect(s!.slice(1)).toEqual([
          String(day * BigInt(days)), flopText(day * BigInt(days)),
          String(day), flopText(day),
          String(per), flopText(per),
          "ComputeChannel", String(EPOCH * days), String(days), String(EPOCH),
        ]);
      }
    });
  }

  it("HOLDS: rawOf is exact for 20000 grid amounts from 1 millionth to AMOUNT_MAX, as decimal text through Number, and refuses each with a 7th decimal", () => {
    let seed = 0x9e3779b9n;
    const next = (): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed;
    };
    for (let i = 0; i < 20000; i++) {
      const micro = (next() % 1_000_000_000_000_000n) + 1n;
      const text = `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
      expect(rawOf(Number(text), "cap", "42")).toBe(micro * 10n ** 12n);
      if (micro < 100_000_000_000_000n) {
        const off = `${text}${(next() % 9n) + 1n}`;
        expect(() => rawOf(Number(off), "cap", "42"), off).toThrow(CliError);
      }
    }
  });

  for (const [daily, perCall] of [["0.0000015", "0.000001"], ["1", "0.1234567"], ["1.0000001", "1"], ["99999999.9999991", "1"]]) {
    it(`HOLDS: cap set ${daily} --per-call ${perCall}, a cap with a 7th decimal: grant exits 3, prints nothing, asks the node nothing`, async () => {
      const home = await seatWithCaps(daily, perCall);
      const log: Log = [];
      const r = await grantJson(home, 1, log);
      expect([r.code, r.out, log.length]).toEqual([3, "", 0]);
      expect(r.err).toMatch(/not on the 6 decimal grid/);
    });
  }

  it("HOLDS: a cap text with more than 6 decimals whose double is a grid value grants that grid value, as run enforces it (the text is lost at cap set, before the grant)", async () => {
    // 0.30000000000000001 parses to the same double as 0.3. The grant is the cap the seat holds, 0.3, below the text.
    const home = await seatWithCaps("0.30000000000000001", "0.30000000000000001");
    const j = (await grantJson(home, 1)).json();
    expect(j.caps.daily_cap).toBe(String(rawOfText("0.3")));
    expect(BigInt(j.caps.daily_cap) < rawOfText("0.30000000000000001")!).toBe(true);
  });

  for (const text of ["0.99999999999999999", "999999999.99999899", "999999999.9999991"]) {
    it(`HOLDS RP5B-1 (open question Q-AMOUNT-TEXT, contract/rules.json): cap set ${text} stores the nearest number, and the grant follows the stored cap exactly and prints it in raw and in FLOP, not the text's own amount`, async () => {
      const home = seatHome(DEV1, null);
      const set = await cli(home, ["cap", "set", text]);
      // Today's behaviour: the text is read as a number, so a text with more digits than a number holds is stored as its nearest number.
      expect([set.code, set.err]).toEqual([0, ""]);
      const stored = rawOf(Number(text), "daily cap", "42");
      expect(stored).not.toBe(rawOfText(text)); // the text's own amount is lost at cap set, before the grant
      const r = await grantJson(home, 1);
      expect(r.code).toBe(0);
      const j = r.json();
      expect(j.caps.daily_cap).toBe(String(stored));
      expect(j.caps.spending_cap).toBe(String(stored));
      const m = SENTENCE.exec(j.allows);
      expect(m).not.toBeNull();
      // The owner reads what is granted: the raw amount and its FLOP text, both the stored cap's.
      expect([m![1], m![2], m![3], m![4]]).toEqual([String(stored), flopText(stored), String(stored), flopText(stored)]);
    });
  }
});
