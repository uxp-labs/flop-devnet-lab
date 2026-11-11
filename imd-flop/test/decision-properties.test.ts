/**
 * Properties of the one booking decision (settlement.ts decideBooking), checked over a small grid of
 * previous rows, receipt reads and reported costs (booking step, review of the audit 8ddc5d2 fixes).
 * Pure: no file, no provider, no network. The whole grid is walked on every run, and each test also
 * asserts how many cases it walked, so the grid cannot shrink unnoticed.
 *
 * The grid:
 *  - Previous rows. Every row imd-flop can write for a request: a hold in each state that does not settle,
 *    a settling row with no amount (the hold stays), and a settling row with a known spend. Its cap charge
 *    is what the rules give for the cost the row records: max(hold, cost) or max(spend, cost). Then the same
 *    rows with a cap charge that is not a known amount (null), which only a damaged file can hold.
 *  - Reads. Trusted, and untrusted in each of the three ways (not fresh, wrong identity, redacted), in every
 *    receipt state and with no state, with settled amounts null, 0, below, equal to and above the booked 0.05.
 *  - Reported costs. None, 0, below every amount, between the amounts and the hold, above the hold. A
 *    request has one completion, so one reported cost: a row has either not recorded it yet or records the
 *    same cost the decision is given.
 */
import { describe, expect, it } from "vitest";
import { decideBooking, type Booking, type ReadOutcome } from "../src/settlement.js";

const HOLD = 0.186;
const BOOKED = 0.05;
const COSTS: (number | null)[] = [null, 0, 0.01, 0.1, 0.3];
const PENDING_STATES = ["sent", "reserved", "estimated", "timeout_unknown", "error"];
const SETTLING_STATES = ["settled", "released"];
const max = (a: number, c: number | null) => (c === null ? a : Math.max(a, c));

type Row = Booking<number | null>;
interface Case {
  prev: Row;
  /** The cost the decision is given: the row's own recorded cost, or a first report on a row that has none. */
  cost: number | null;
}

/** Every previous row with every reported cost it can meet. */
function cases(): Case[] {
  const out: Case[] = [];
  for (const rowCost of COSTS) {
    const rows: Row[] = [
      ...PENDING_STATES.map((state) => ({ state, spend: null, cap_charge: max(HOLD, rowCost) })),
      ...SETTLING_STATES.flatMap((state) => [
        { state, spend: null, cap_charge: max(HOLD, rowCost) },
        { state, spend: 0, cap_charge: max(0, rowCost) },
        { state, spend: BOOKED, cap_charge: max(BOOKED, rowCost) },
      ]),
    ];
    for (const prev of rows) {
      for (const cost of rowCost === null ? COSTS : [rowCost]) out.push({ prev, cost });
    }
    // A damaged row holds no charge whatever cost it records, so it is listed once, with every cost.
    if (rowCost === null) for (const prev of rows) for (const cost of COSTS) out.push({ prev: { ...prev, cap_charge: null }, cost });
  }
  return out;
}

const TRUSTED = { fresh: true, identityOk: true, redacted: false };
const UNTRUSTED = [
  { fresh: false, identityOk: true, redacted: false },
  { fresh: true, identityOk: false, redacted: false },
  { fresh: true, identityOk: true, redacted: true },
];
const READ_STATES = [null, "reserved", "estimated", "settled", "released"];
const AMOUNTS = [null, 0, 0.01, BOOKED, 0.07];
const readsWith = (trust: typeof TRUSTED): ReadOutcome[] => READ_STATES.flatMap((state) => AMOUNTS.map((settled) => ({ ...trust, state, settled })));
const TRUSTED_READS = readsWith(TRUSTED);
const UNTRUSTED_READS = UNTRUSTED.flatMap(readsWith);
const READS = [...TRUSTED_READS, ...UNTRUSTED_READS];

const CASES = cases();
// The test's own reading of the rules, written out here so that no expectation comes from the code under test.
const settles = (state: string | null) => state !== null && SETTLING_STATES.includes(state);
const known = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** The settlement a read proves: trusted, in a settling state, with a known amount. Else null. */
const proves = (read: ReadOutcome): number | null => (TRUSTED_READS.includes(read) && settles(read.state) && known(read.settled) ? (read.settled as number) : null);
/** The read proves a settlement below the one the row has booked. */
const below = (prev: Row, read: ReadOutcome) => settles(prev.state) && known(prev.spend) && proves(read) !== null && proves(read)! < prev.spend!;
const show = (c: Case, ...reads: ReadOutcome[]) => JSON.stringify({ ...c, reads });

/** Walk every case with every read, collect what breaks the property, and say how many were walked. */
function walk(reads: ReadOutcome[], broken: (c: Case, read: ReadOutcome, next: Booking<number | null>, disagree: boolean) => boolean) {
  const failures: string[] = [];
  let walked = 0;
  for (const c of CASES) {
    for (const read of reads) {
      walked += 1;
      const { booking, disagree } = decideBooking(c.prev, read, c.cost);
      if (broken(c, read, booking, disagree)) failures.push(show(c, read));
    }
  }
  return { walked, failures: failures.slice(0, 5), failed: failures.length };
}

describe("decideBooking properties", () => {
  it("the grid: 154 previous rows with a cost (99 written by imd-flop, 55 damaged), 100 reads, 25 of them trusted", () => {
    expect({ cases: CASES.length, damaged: CASES.filter((c) => !known(c.prev.cap_charge)).length, reads: READS.length, trusted: TRUSTED_READS.length, untrusted: UNTRUSTED_READS.length })
      .toEqual({ cases: 154, damaged: 55, reads: 100, trusted: 25, untrusted: 75 });
  });

  it("an untrusted read never changes state or spend and never lowers the charge", () => {
    const r = walk(UNTRUSTED_READS, (c, _read, next) => {
      if (next.state !== c.prev.state || next.spend !== c.prev.spend) return true;
      // An unknown charge stays exactly as it is. A known one may only go up, to the reported cost.
      return known(c.prev.cap_charge) ? !(known(next.cap_charge) && next.cap_charge! >= c.prev.cap_charge!) : next.cap_charge !== c.prev.cap_charge;
    });
    expect(r).toEqual({ walked: 154 * 75, failures: [], failed: 0 });
  });

  it("a booked known settlement is never lowered, and a read that would lower it is reported", () => {
    const r = walk(READS, (c, read, next, disagree) => {
      if (!settles(c.prev.state) || !known(c.prev.spend)) return false;
      if (!settles(next.state) || !known(next.spend) || next.spend! < c.prev.spend!) return true;
      return below(c.prev, read) && !disagree;
    });
    expect(r).toEqual({ walked: 154 * 100, failures: [], failed: 0 });
  });

  it("no read moves a row out of a settling state", () => {
    const r = walk(READS, (c, _read, next) => settles(c.prev.state) && !settles(next.state));
    expect(r).toEqual({ walked: 154 * 100, failures: [], failed: 0 });
  });

  it("when the spend is known and the charge is a known amount, the charge is at least max(spend, reported cost)", () => {
    const r = walk(READS, (c, _read, next) => known(next.spend) && known(next.cap_charge) && next.cap_charge! < max(next.spend!, c.cost));
    expect(r).toEqual({ walked: 154 * 100, failures: [], failed: 0 });
  });

  it("a charge that is not a known amount: a proven settlement that may be booked replaces it, and any other read changes nothing and is reported", () => {
    // This is the one case where "the charge is at least max(spend, reported cost)" cannot be asked: the
    // charge of such a row is unknown, and the rule for it is that nothing is put in its place, never 0.
    let walked = 0;
    const failures: string[] = [];
    for (const c of CASES.filter((x) => !known(x.prev.cap_charge))) {
      for (const read of READS) {
        walked += 1;
        const { booking, disagree } = decideBooking(c.prev, read, c.cost);
        const settled = proves(read);
        const booked = settled !== null && !below(c.prev, read);
        const ok = booked
          ? !disagree && booking.spend === settled && booking.cap_charge === max(settled, c.cost)
          : disagree && booking.state === c.prev.state && booking.spend === c.prev.spend && booking.cap_charge === c.prev.cap_charge;
        if (!ok) failures.push(show(c, read));
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 55 * 100, failures: [], failed: 0 });
  });

  it("a read is reported as disagreeing exactly when it is not booked: it lowers a booked settlement, or the charge is unknown and no settlement replaces it", () => {
    const r = walk(READS, (c, read, _next, disagree) => {
      return disagree !== (below(c.prev, read) || (!known(c.prev.cap_charge) && proves(read) === null));
    });
    expect(r).toEqual({ walked: 154 * 100, failures: [], failed: 0 });
  });

  it("order independence: two trusted reads book the same spend and charge in either order", () => {
    // Two processes can book the same request, and the gateway may answer them differently. Whichever
    // books first, the spend and the cap charge end up equal. The state name may differ: between settled
    // and released when both reads settle, and between two pending states when neither does.
    let walked = 0;
    const failures: string[] = [];
    for (const c of CASES) {
      for (const a of TRUSTED_READS) {
        for (const b of TRUSTED_READS) {
          walked += 1;
          const ab = decideBooking(decideBooking(c.prev, a, c.cost).booking, b, c.cost).booking;
          const ba = decideBooking(decideBooking(c.prev, b, c.cost).booking, a, c.cost).booking;
          const same = ab.spend === ba.spend && ab.cap_charge === ba.cap_charge && settles(ab.state) === settles(ba.state);
          if (!same) failures.push(show(c, a, b));
        }
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 154 * 25 * 25, failures: [], failed: 0 });
  });

  it("booking the same read again changes nothing", () => {
    const r = walk(READS, (c, read, next) => {
      const again = decideBooking(next, read, c.cost).booking;
      return again.state !== next.state || again.spend !== next.spend || again.cap_charge !== next.cap_charge;
    });
    expect(r).toEqual({ walked: 154 * 100, failures: [], failed: 0 });
  });
});
