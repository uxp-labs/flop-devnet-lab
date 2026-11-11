/**
 * Properties of the two booking decisions, checked over a small grid of previous rows, receipt reads,
 * failure reports and reported costs (booking step, review of the audit 8ddc5d2 fixes): decideBooking for
 * a receipt read, and decideFailure for what run reports when its paid call fails (settlement.ts).
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
 *  - Failure reports. A timeout, a gateway error, and "nothing was sent".
 */
import { describe, expect, it } from "vitest";
import { decideBooking, decideFailure, type Booking, type Failure, type ReadOutcome } from "../src/settlement.js";

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

describe("decideFailure properties", () => {
  const REPORTS: Failure[] = ["timeout_unknown", "error", "refused_local"];
  /** The row after a failure report: the next booking, or the row itself when the report is not booked. */
  const afterFailure = (prev: Row, report: Failure): Row => decideFailure(prev, report) ?? prev;
  const same = (a: Row, b: Row) => a.state === b.state && a.spend === b.spend && a.cap_charge === b.cap_charge;
  /** Walk every case with every report, collect what breaks the property, and say how many were walked. */
  function walkReports(broken: (c: Case, report: Failure, next: Row, booked: boolean) => boolean) {
    const failures: string[] = [];
    let walked = 0;
    for (const c of CASES) {
      for (const report of REPORTS) {
        walked += 1;
        const decided = decideFailure(c.prev, report);
        if (broken(c, report, decided ?? c.prev, decided !== null)) failures.push(JSON.stringify({ ...c, report }));
      }
    }
    return { walked, failures: failures.slice(0, 5), failed: failures.length };
  }

  it("a failure report never changes a settling row", () => {
    const r = walkReports((c, _report, next, booked) => settles(c.prev.state) && (booked || !same(next, c.prev)));
    expect(r).toEqual({ walked: 154 * 3, failures: [], failed: 0 });
    // 6 of the 11 row shapes settle: 54 of the 99 written rows and 30 of the 55 damaged ones.
    expect(CASES.filter((c) => settles(c.prev.state)).length).toBe(84);
  });

  it("a failure report never changes the spend, and never lowers a known charge except the pre send release from a row that does not settle", () => {
    const r = walkReports((c, report, next) => {
      if (next.spend !== c.prev.spend) return true;
      if (!known(c.prev.cap_charge)) return next.cap_charge !== c.prev.cap_charge;
      const release = report === "refused_local" && !settles(c.prev.state);
      return release ? next.cap_charge !== 0 : next.cap_charge !== c.prev.cap_charge;
    });
    expect(r).toEqual({ walked: 154 * 3, failures: [], failed: 0 });
  });

  it("a failure report is booked exactly on a row that does not settle and has a known charge, and then the state is the report", () => {
    const r = walkReports((c, report, next, booked) => {
      const expected = !settles(c.prev.state) && known(c.prev.cap_charge);
      return booked !== expected || (booked ? next.state !== report : !same(next, c.prev));
    });
    expect(r).toEqual({ walked: 154 * 3, failures: [], failed: 0 });
  });

  it("a charge that is not a known amount is never replaced by a guess: no report changes such a row", () => {
    const damaged = CASES.filter((c) => !known(c.prev.cap_charge));
    const changed = damaged.flatMap((c) => REPORTS.filter((report) => decideFailure(c.prev, report) !== null).map((report) => JSON.stringify({ ...c, report })));
    expect({ walked: damaged.length * 3, changed }).toEqual({ walked: 55 * 3, changed: [] });
  });

  it("booking the same report again changes nothing", () => {
    const r = walkReports((_c, report, next) => !same(afterFailure(next, report), next));
    expect(r).toEqual({ walked: 154 * 3, failures: [], failed: 0 });
  });

  it("a failure report before or after a trusted settling read: the same booked spend, and a charge not lower than the settlement's", () => {
    // A report can reach the booking step before or after another process books a settling read of the same
    // request. Either way the spend is the same. When the read's settlement is booked, the charge is at
    // least max(settled, reported cost) either way, and in fact equal. When no settlement is booked from
    // the read, the charge is equal either way too, with one exception that is counted here, not hidden:
    // "nothing was sent" released a hold, and then a trusted read says settled or released with no amount.
    // The released row holds nothing, so the row ends as settling with no spend and no hold, where the
    // other order keeps the hold. It needs the gateway to hold a receipt for a request that was never sent.
    const settlingReads = TRUSTED_READS.filter((read) => settles(read.state));
    let walked = 0;
    let releasedThenNoAmount = 0;
    const failures: string[] = [];
    for (const c of CASES) {
      for (const report of REPORTS) {
        for (const read of settlingReads) {
          walked += 1;
          const reportFirst = decideBooking(afterFailure(c.prev, report), read, c.cost).booking;
          const readFirst = afterFailure(decideBooking(c.prev, read, c.cost).booking, report);
          const settled = proves(read);
          const bookedSettlement = settled !== null && !below(c.prev, read);
          let ok = reportFirst.spend === readFirst.spend && settles(reportFirst.state) === settles(readFirst.state);
          if (bookedSettlement) {
            const floor = max(settled, c.cost);
            ok &&= known(reportFirst.cap_charge) && known(readFirst.cap_charge) && reportFirst.cap_charge! >= floor && readFirst.cap_charge! >= floor && reportFirst.cap_charge === readFirst.cap_charge;
          } else if (report === "refused_local" && !settles(c.prev.state) && known(c.prev.cap_charge)) {
            releasedThenNoAmount += 1;
            ok &&= reportFirst.cap_charge === max(0, c.cost) && readFirst.cap_charge === max(c.prev.cap_charge!, c.cost);
          } else {
            ok &&= reportFirst.cap_charge === readFirst.cap_charge;
          }
          if (!ok) failures.push(show(c, read) + " " + report);
        }
      }
    }
    expect({ walked, releasedThenNoAmount, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 154 * 3 * 10, releasedThenNoAmount: 90, failures: [], failed: 0 });
  });
});
