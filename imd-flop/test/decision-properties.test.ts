/**
 * Properties of the two booking decisions, checked over a small grid of previous rows, receipt reads,
 * failure reports and reported costs (booking step, review of the audit 8ddc5d2 fixes): decideBooking for
 * a receipt read, and decideFailure for what run reports when its paid call fails (settlement.ts).
 * Pure: no file, no provider, no network. The whole grid is walked on every run, and each test also
 * asserts how many cases it walked, so the grid cannot shrink unnoticed.
 *
 * The grid:
 *  - Previous rows. Every row imd-flop can write for a request: a hold in each state that does not settle,
 *    a sent row a trusted read with no state reached (receipt_seen), a settling row with no amount, a
 *    settling row with a known spend, and a released reservation (refused_local, charge 0) with a padded
 *    quote that is known or not. Its cap charge is what the rules give for the cost the row records: the
 *    hold floor, max(hold, spend, cost). A released reservation records no cost: its call brought back no
 *    completion. Then the rows an older version booked below their hold: a settling row with a known spend
 *    charged max(spend, cost). They are not migrated. Then the rows imd-flop writes with a cap charge that
 *    is not a known amount (null), which only a damaged file can hold.
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

type Row = Booking<number | null> & { quote_padded: number | null };
/** The rows imd-flop writes for a request whose recorded cost is rowCost. */
const writtenRows = (rowCost: number | null): Row[] => [
  ...PENDING_STATES.map((state) => ({ state, spend: null, cap_charge: max(HOLD, rowCost), quote_padded: HOLD })),
  { state: "sent", spend: null, cap_charge: max(HOLD, rowCost), quote_padded: HOLD, receipt_seen: true },
  ...SETTLING_STATES.flatMap((state) => [null, 0, BOOKED].map((spend) => ({ state, spend, cap_charge: max(Math.max(HOLD, spend ?? 0), rowCost), quote_padded: HOLD }))),
  ...(rowCost === null ? [HOLD, null].map((quote_padded) => ({ state: "refused_local", spend: null, cap_charge: 0, quote_padded })) : []),
];
/** The rows an older version booked below their hold: a known settlement charged max(spend, cost). Not migrated. */
const OLDER = new Set<Row>();
const olderRows = (rowCost: number | null): Row[] => SETTLING_STATES.flatMap((state) => [0, BOOKED].map((spend) => ({ state, spend, cap_charge: max(spend, rowCost), quote_padded: HOLD })));
interface Case {
  prev: Row;
  /** The cost the decision is given: the row's own recorded cost, or a first report on a row that has none. */
  cost: number | null;
}

/** Every previous row with every reported cost it can meet. */
function cases(): Case[] {
  const out: Case[] = [];
  for (const rowCost of COSTS) {
    const older = olderRows(rowCost);
    for (const row of older) OLDER.add(row);
    for (const prev of [...writtenRows(rowCost), ...older]) {
      for (const cost of rowCost === null ? COSTS : [rowCost]) out.push({ prev, cost });
    }
    // A damaged row holds no charge whatever cost it records, so it is listed once, with every cost.
    if (rowCost === null) for (const prev of writtenRows(rowCost)) for (const cost of COSTS) out.push({ prev: { ...prev, cap_charge: null }, cost });
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
/** Any trusted read on a released reservation, a receipt with no state included: the gateway holds the request after all. */
const reopens = (prev: Row, read: ReadOutcome) => prev.state === "refused_local" && TRUSTED_READS.includes(read);
/**
 * The hold floor, the least the charge can be after the read: the booked charge; on a row the read reopens,
 * the padded quote (or the booked charge if higher); on a damaged row, the padded quote, and only for a read
 * that proves a settlement. Null is unknown, and then the read is not booked.
 */
const floorOf = (prev: Row, read: ReadOutcome): number | null => {
  if (!known(prev.cap_charge)) return proves(read) !== null && known(prev.quote_padded) ? prev.quote_padded : null;
  if (reopens(prev, read)) return known(prev.quote_padded) ? Math.max(prev.cap_charge!, prev.quote_padded!) : null;
  return prev.cap_charge;
};
/** The read is not booked: it lowers a booked settlement, or its hold floor is unknown. */
const notBooked = (prev: Row, read: ReadOutcome) => below(prev, read) || floorOf(prev, read) === null;
/** The charge the cap admitted for the row: nothing for a released reservation, else its padded quote. Null is unknown. */
const admittedOf = (prev: Row): number | null => (prev.state === "refused_local" ? 0 : known(prev.quote_padded) ? prev.quote_padded : null);
const show = (c: Case, ...reads: ReadOutcome[]) => JSON.stringify({ ...c, reads });
/** The row after a read, as the booking step appends it: the row with the decided booking in it. */
const afterRead = (prev: Row, read: ReadOutcome, cost: number | null): Row => ({ ...prev, ...decideBooking(prev, read, cost).booking }) as Row;

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
  it("the grid: 224 previous rows with a cost (118 written by imd-flop, 36 booked by an older version, 32 of them below their hold, 70 damaged, 20 of all of them released reservations), 100 reads, 25 of them trusted", () => {
    // Moved (hold floor): 174 rows, 109 written and 65 damaged. Settling rows with a known spend are now
    // charged the hold floor, the older rows charged below it are kept apart, and a sent row a trusted read
    // with no state reached (receipt_seen) is new.
    // An older row is below its hold unless a reported cost of 0.3 raised it above.
    const older = CASES.filter((c) => OLDER.has(c.prev));
    const belowHold = CASES.filter((c) => known(c.prev.cap_charge) && c.prev.state !== "refused_local" && c.prev.cap_charge! < HOLD);
    expect({ cases: CASES.length, damaged: CASES.filter((c) => !known(c.prev.cap_charge)).length, older: older.length, belowHold: belowHold.length, released: CASES.filter((c) => c.prev.state === "refused_local").length, reads: READS.length, trusted: TRUSTED_READS.length, untrusted: UNTRUSTED_READS.length })
      .toEqual({ cases: 224, damaged: 70, older: 36, belowHold: 32, released: 20, reads: 100, trusted: 25, untrusted: 75 });
  });

  it("an untrusted read never changes state or spend and never lowers the charge", () => {
    const r = walk(UNTRUSTED_READS, (c, _read, next) => {
      if (next.state !== c.prev.state || next.spend !== c.prev.spend) return true;
      // An unknown charge stays exactly as it is. A known one may only go up, to the reported cost.
      return known(c.prev.cap_charge) ? !(known(next.cap_charge) && next.cap_charge! >= c.prev.cap_charge!) : next.cap_charge !== c.prev.cap_charge;
    });
    expect(r).toEqual({ walked: 224 * 75, failures: [], failed: 0 });
  });

  it("a booked known settlement is never lowered, and a read that would lower it is reported", () => {
    const r = walk(READS, (c, read, next, disagree) => {
      if (!settles(c.prev.state) || !known(c.prev.spend)) return false;
      if (!settles(next.state) || !known(next.spend) || next.spend! < c.prev.spend!) return true;
      return below(c.prev, read) && !disagree;
    });
    expect(r).toEqual({ walked: 224 * 100, failures: [], failed: 0 });
  });

  it("no read moves a row out of a settling state", () => {
    const r = walk(READS, (c, _read, next) => settles(c.prev.state) && !settles(next.state));
    expect(r).toEqual({ walked: 224 * 100, failures: [], failed: 0 });
  });

  it("when the spend is known and the charge is a known amount, the charge is at least max(spend, reported cost)", () => {
    const r = walk(READS, (c, _read, next) => known(next.spend) && known(next.cap_charge) && next.cap_charge! < max(next.spend!, c.cost));
    expect(r).toEqual({ walked: 224 * 100, failures: [], failed: 0 });
  });

  it("a charge that is not a known amount: a proven settlement that may be booked replaces it with the hold floor, and any other read changes nothing and is reported", () => {
    // This is the one case where "the charge is at least max(spend, reported cost)" cannot be asked: the
    // charge of such a row is unknown, and the rule for it is that nothing is put in its place, never 0.
    // Moved (hold floor): a proven settlement was booked at max(settled, reported cost). It is booked at
    // max(padded quote, settled, reported cost), and only when the padded quote is a known amount.
    let walked = 0;
    const failures: string[] = [];
    for (const c of CASES.filter((x) => !known(x.prev.cap_charge))) {
      for (const read of READS) {
        walked += 1;
        const { booking, disagree } = decideBooking(c.prev, read, c.cost);
        const settled = proves(read);
        const booked = settled !== null && !below(c.prev, read) && known(c.prev.quote_padded);
        const ok = booked
          ? !disagree && booking.spend === settled && booking.cap_charge === max(Math.max(c.prev.quote_padded!, settled), c.cost)
          : disagree && booking.state === c.prev.state && booking.spend === c.prev.spend && booking.cap_charge === c.prev.cap_charge;
        if (!ok) failures.push(show(c, read));
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 70 * 100, failures: [], failed: 0 });
  });

  it("a read that disagrees changes nothing: the booking is the previous row's, except that a reported cost may raise a known charge", () => {
    // Review of the booking step: a decision that let a lowering read still move the state (settled to
    // released) passed every other property here. Moved (hold floor): 6152 of 17400. The grid is larger, and
    // a proven settlement on a damaged row or a released one now needs a known padded quote.
    let disagreed = 0;
    const r = walk(READS, (c, _read, next, disagree) => {
      if (!disagree) return false;
      disagreed += 1;
      const charge = next.cap_charge === c.prev.cap_charge || (known(c.prev.cap_charge) && next.cap_charge === max(c.prev.cap_charge!, c.cost));
      return next.state !== c.prev.state || next.spend !== c.prev.spend || !charge;
    });
    expect({ ...r, disagreed }).toEqual({ walked: 224 * 100, failures: [], failed: 0, disagreed: 6789 });
  });

  it("a read is reported as disagreeing exactly when it is not booked: it lowers a booked settlement, or its hold floor is unknown", () => {
    // Moved (hold floor): "or the charge it would hold is unknown and no settlement replaces it". A proven
    // settlement no longer books its own amount as the charge, so it needs a known floor too.
    const r = walk(READS, (c, read, _next, disagree) => disagree !== notBooked(c.prev, read));
    expect(r).toEqual({ walked: 224 * 100, failures: [], failed: 0 });
  });

  it("any trusted read that reopens a released reservation holds its padded quote again, raised by a settlement or a reported cost, and says it passed what the cap admitted", () => {
    // Moved (hold floor): walked the trusted reads with a state only, and booked a proven settlement at its
    // own amount. A trusted receipt with no state reopens the row too (R2): the row is sent again and marked
    // receipt_seen. A proven settlement books its spend and the hold comes back.
    const released = CASES.filter((c) => c.prev.state === "refused_local" && known(c.prev.cap_charge));
    let walked = 0;
    const failures: string[] = [];
    for (const c of released) {
      for (const read of TRUSTED_READS) {
        walked += 1;
        const { booking, disagree, pastAdmitted } = decideBooking(c.prev, read, c.cost);
        const settled = proves(read);
        const got = { state: booking.state, spend: booking.spend, cap_charge: booking.cap_charge, receipt_seen: booking.receipt_seen ?? false, disagree, pastAdmitted };
        const state = read.state ?? "sent";
        const expected = known(c.prev.quote_padded)
          ? { state, spend: settled, cap_charge: max(Math.max(c.prev.quote_padded!, settled ?? 0), c.cost), receipt_seen: state === "sent", disagree: false, pastAdmitted: true }
          : { state: c.prev.state, spend: c.prev.spend, cap_charge: c.prev.cap_charge, receipt_seen: false, disagree: true, pastAdmitted: false };
        if (JSON.stringify(got) !== JSON.stringify(expected)) failures.push(show(c, read));
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 10 * 25, failures: [], failed: 0 });
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
          const ab = afterRead(afterRead(c.prev, a, c.cost), b, c.cost);
          const ba = afterRead(afterRead(c.prev, b, c.cost), a, c.cost);
          const same = ab.spend === ba.spend && ab.cap_charge === ba.cap_charge && settles(ab.state) === settles(ba.state);
          if (!same) failures.push(show(c, a, b));
        }
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 224 * 25 * 25, failures: [], failed: 0 });
  });

  it("booking the same read again changes nothing", () => {
    const r = walk(READS, (c, read, next) => {
      const again = decideBooking({ ...c.prev, ...next } as Row, read, c.cost).booking;
      return again.state !== next.state || again.spend !== next.spend || again.cap_charge !== next.cap_charge;
    });
    expect(r).toEqual({ walked: 224 * 100, failures: [], failed: 0 });
  });
});

describe("decideFailure properties", () => {
  const REPORTS: Failure[] = ["timeout_unknown", "error", "refused_local"];
  /** The row after a failure report: the row with the next booking in it, or the row itself when the report is not booked. */
  const afterFailure = (prev: Row, report: Failure): Row => ({ ...prev, ...decideFailure(prev, report) }) as Row;
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
    expect(r).toEqual({ walked: 224 * 3, failures: [], failed: 0 });
    // Moved (hold floor): 84. 54 of the 118 written rows settle, all 36 older rows, and 30 of the 70 damaged ones.
    expect(CASES.filter((c) => settles(c.prev.state)).length).toBe(120);
  });

  it("a failure report never changes the spend, and never lowers a known charge except the pre send release from a row still in state sent that no trusted read reached", () => {
    // Moved (review of the booking step): the release was allowed from any row that does not settle. A
    // reserved or estimated row comes from a trusted gateway read, and that read beats "nothing was sent".
    // Moved (hold floor, R2): a sent row a trusted read with no state reached is not released either.
    const r = walkReports((c, report, next) => {
      if (next.spend !== c.prev.spend) return true;
      if (!known(c.prev.cap_charge)) return next.cap_charge !== c.prev.cap_charge;
      const release = report === "refused_local" && c.prev.state === "sent" && c.prev.receipt_seen !== true;
      return release ? next.cap_charge !== 0 : next.cap_charge !== c.prev.cap_charge;
    });
    expect(r).toEqual({ walked: 224 * 3, failures: [], failed: 0 });
  });

  it("a failure report is booked exactly on a row that does not settle and has a known charge, \"nothing was sent\" only on a row still in state sent, and then the state is the report", () => {
    // Moved (review of the booking step): "nothing was sent" was booked on any row that does not settle.
    const r = walkReports((c, report, next, booked) => {
      const expected = !settles(c.prev.state) && known(c.prev.cap_charge) && (report !== "refused_local" || (c.prev.state === "sent" && c.prev.receipt_seen !== true));
      return booked !== expected || (booked ? next.state !== report : !same(next, c.prev));
    });
    expect(r).toEqual({ walked: 224 * 3, failures: [], failed: 0 });
  });

  it("a charge that is not a known amount is never replaced by a guess: no report changes such a row", () => {
    const damaged = CASES.filter((c) => !known(c.prev.cap_charge));
    const changed = damaged.flatMap((c) => REPORTS.filter((report) => decideFailure(c.prev, report) !== null).map((report) => JSON.stringify({ ...c, report })));
    expect({ walked: damaged.length * 3, changed }).toEqual({ walked: 70 * 3, changed: [] });
  });

  it("booking the same report again changes nothing", () => {
    const r = walkReports((_c, report, next) => !same(afterFailure(next, report), next));
    expect(r).toEqual({ walked: 224 * 3, failures: [], failed: 0 });
  });

  it("a failure report before or after a trusted settling read: the same booked spend, and a charge not lower than the settlement's", () => {
    // A report can reach the booking step before or after another process books a settling read of the same
    // request. Either way the spend is the same. When the read's settlement is booked, the charge is at
    // least max(settled, reported cost) either way, and in fact equal. When no settlement is booked from
    // the read, the charge is equal either way too.
    // Moved (review of the booking step): this counted 90 cases where "nothing was sent" released a hold and
    // a settling read with no amount left the row holding nothing. A trusted read now beats that report in
    // both orders, so those cases agree. One shape is counted here, not hidden: a timeout or a gateway error
    // reported on a released reservation (refused_local) and then a settling read with no amount. That row
    // is never reached: refused_local for a request id is written only by run's own "nothing was sent"
    // report, and run makes one report per request.
    // Moved (hold floor): that shape is counted for every settling read now, a proven settlement included. On
    // such a row a reported timeout or error keeps the charge at 0 and does not reopen it, while a trusted
    // read reopens it to the hold, so the two orders charge differently whatever the read settles.
    const settlingReads = TRUSTED_READS.filter((read) => settles(read.state));
    let walked = 0;
    let reportOnReleasedRow = 0;
    const failures: string[] = [];
    for (const c of CASES) {
      for (const report of REPORTS) {
        for (const read of settlingReads) {
          walked += 1;
          const reportFirst = afterRead(afterFailure(c.prev, report), read, c.cost);
          const readFirst = afterFailure(afterRead(c.prev, read, c.cost), report);
          if (report !== "refused_local" && c.prev.state === "refused_local" && known(c.prev.cap_charge)) {
            reportOnReleasedRow += 1;
            continue;
          }
          const settled = proves(read);
          const bookedSettlement = settled !== null && !notBooked(c.prev, read);
          let ok = reportFirst.spend === readFirst.spend && settles(reportFirst.state) === settles(readFirst.state);
          if (bookedSettlement) {
            const floor = max(settled, c.cost);
            ok &&= known(reportFirst.cap_charge) && known(readFirst.cap_charge) && reportFirst.cap_charge! >= floor && readFirst.cap_charge! >= floor && reportFirst.cap_charge === readFirst.cap_charge;
          } else {
            ok &&= reportFirst.cap_charge === readFirst.cap_charge;
          }
          if (!ok) failures.push(show(c, read) + " " + report);
        }
      }
    }
    expect({ walked, reportOnReleasedRow, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 224 * 3 * 10, reportOnReleasedRow: 200, failures: [], failed: 0 });
  });

  it("\"nothing was sent\" before or after any trusted read: the same booked spend and the same charge", () => {
    // A trusted read shows the gateway holds the request. Read first, the report does not release the row;
    // report first, the read takes the released row back to the hold. Either way the outcome is the same.
    // Walked with the cases whose reported cost is none: "nothing was sent" means the call brought back no
    // completion, so no cost can be reported for the request. Moved (hold floor, R2): this held before only
    // because both orders released the hold for a trusted receipt with no state. Now neither does.
    const reachable = CASES.filter((c) => c.cost === null);
    let walked = 0;
    const failures: string[] = [];
    for (const c of reachable) {
      for (const read of TRUSTED_READS) {
        walked += 1;
        const reportFirst = afterRead(afterFailure(c.prev, "refused_local"), read, c.cost);
        const readFirst = afterFailure(afterRead(c.prev, read, c.cost), "refused_local");
        if (reportFirst.spend !== readFirst.spend || reportFirst.cap_charge !== readFirst.cap_charge) failures.push(show(c, read));
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 32 * 25, failures: [], failed: 0 });
  });
});

/**
 * The hold floor (independent review of the review fixes, findings R9, R2 and R3). From the moment a call is
 * sent, its cap charge is never below the padded quote it was admitted with: a gateway read (settled or
 * released, with any amount or none) and a reported cost can only raise it. The one release is "nothing was
 * sent", from a row still in state sent that no trusted read has reached. Any trusted read, a receipt with no
 * state included, beats that report in both orders: read first, the report does not release the hold;
 * report first, the read brings the hold back. A booking that puts the day in a state the cap did not admit
 * says so (Decision.pastAdmitted). Checked over the grid one step at a time, over every sequence of two steps,
 * and over sequences of three steps from a shorter list, with this file's own reading of the rules.
 */
describe("the hold floor", () => {
  type Step = { read: ReadOutcome } | { report: Failure };
  const REPORTS: Failure[] = ["timeout_unknown", "error", "refused_local"];
  const STEPS: Step[] = [...READS.map((read) => ({ read })), ...REPORTS.map((report) => ({ report }))];
  /** For three steps: every trusted read, one untrusted read of each kind (settled at the booked amount), and every report. */
  const untrustedSettled = UNTRUSTED.map((u) => UNTRUSTED_READS.find((x) => x.fresh === u.fresh && x.identityOk === u.identityOk && x.redacted === u.redacted && x.state === "settled" && x.settled === BOOKED)!);
  const SHORT: Step[] = [...TRUSTED_READS.map((read) => ({ read })), ...untrustedSettled.map((read) => ({ read })), ...REPORTS.map((report) => ({ report }))];
  const apply = (row: Row, step: Step, cost: number | null): Row => ("read" in step ? afterRead(row, step.read, cost) : ({ ...row, ...decideFailure(row, step.report) }) as Row);

  /**
   * One sequence, by this file's reading of the floor: what broke, or null. `lower` is the least the charge
   * may be. A release is allowed only for "nothing was sent" on a row in state sent with a known charge,
   * before any trusted read was booked for the request (a row marked receipt_seen counts as one), and then
   * the charge is 0. Every other step leaves the charge at least `lower`. A trusted read that is booked on a
   * released row brings the hold back: the charge is at least the padded quote.
   */
  function broken(c: Case, steps: Step[]): string | null {
    let row = c.prev;
    let lower = known(row.cap_charge) ? row.cap_charge! : null;
    let seen = row.receipt_seen === true;
    for (const [i, step] of steps.entries()) {
      const next = apply(row, step, c.cost);
      const release = "report" in step && step.report === "refused_local" && row.state === "sent" && !seen && known(row.cap_charge);
      if (release) {
        if (next.state !== "refused_local" || next.cap_charge !== 0) return `step ${i}: the release did not happen`;
        lower = 0;
      } else if (lower !== null && !(known(next.cap_charge) && next.cap_charge! >= lower)) {
        return `step ${i}: the charge went down`;
      }
      if ("read" in step && TRUSTED_READS.includes(step.read) && !notBooked(row, step.read)) {
        seen = true;
        if (row.state === "refused_local" && known(row.quote_padded) && !(next.cap_charge! >= row.quote_padded!)) return `step ${i}: the released hold did not come back`;
      }
      if (known(next.cap_charge)) lower = Math.max(lower ?? 0, next.cap_charge!);
      row = next;
    }
    return null;
  }

  function walkSequences(steps: Step[], length: number) {
    const failures: string[] = [];
    let walked = 0;
    const go = (c: Case, seq: Step[]) => {
      if (seq.length === length) {
        walked += 1;
        const why = broken(c, seq);
        if (why) failures.push(`${why}: ${JSON.stringify({ ...c, seq })}`);
        return;
      }
      for (const step of steps) go(c, [...seq, step]);
    };
    for (const c of CASES) go(c, []);
    return { walked, failures: failures.slice(0, 3), failed: failures.length };
  }

  it("one step: the charge never goes down, except the release from a sent row that no trusted read reached; a booked trusted read brings a released hold back", () => {
    expect(walkSequences(STEPS, 1)).toEqual({ walked: 224 * 103, failures: [], failed: 0 });
  });

  it("every sequence of two steps, reads and reports in any order: the same", () => {
    expect(walkSequences(STEPS, 2)).toEqual({ walked: 224 * 103 * 103, failures: [], failed: 0 });
  });

  it("sequences of three steps over every trusted read, one untrusted read of each kind and every report: the same", () => {
    expect(SHORT.length).toBe(31);
    expect(walkSequences(SHORT, 3)).toEqual({ walked: 224 * 31 * 31 * 31, failures: [], failed: 0 });
  });

  it("on every row imd-flop writes for a sent call, no read takes the charge below the padded quote", () => {
    // The floor itself, read directly: the rows charged at least their hold (not the older rows, not a
    // released reservation, not a damaged row) stay there after any read.
    const held = CASES.filter((c) => c.prev.state !== "refused_local" && known(c.prev.cap_charge) && c.prev.cap_charge! >= HOLD);
    let walked = 0;
    const failures: string[] = [];
    for (const c of held) {
      for (const read of READS) {
        walked += 1;
        const next = afterRead(c.prev, read, c.cost);
        if (!(known(next.cap_charge) && next.cap_charge! >= HOLD)) failures.push(show(c, read));
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 112 * 100, failures: [], failed: 0 });
  });

  it("a booking says it passed what the cap admitted exactly when its charge rises above what the cap admitted for the row and above what the row had booked", () => {
    // What the cap admitted: the padded quote for a call it let through, nothing for a released
    // reservation. So this is a released hold that comes back, or a charge raised above the padded quote by
    // a settled amount or a reported cost. Nothing else passes it.
    let passed = 0;
    const r = walk(READS, (c, read, next) => {
      const admitted = admittedOf(c.prev);
      const want = known(next.cap_charge) && admitted !== null && next.cap_charge! > admitted && (!known(c.prev.cap_charge) || next.cap_charge! > c.prev.cap_charge!);
      if (want) passed += 1;
      return decideBooking(c.prev, read, c.cost).pastAdmitted !== want;
    });
    expect({ ...r, passed }).toEqual({ walked: 224 * 100, failures: [], failed: 0, passed: 2303 });
  });
});

/**
 * The exact spend (money stage 1). decideBooking also decides the row's spend_raw: the exact spend in base
 * units (10^18 per FLOP) as a canonical digit string, or null for unknown, taken from the read's
 * settled_spend_raw through the exact amount rule (amount.ts exactAmount). It is recorded beside the float
 * figures, and no cap, quote, charge or settlement decision reads it.
 * The grid: every previous row above with an exact spend that is absent (a row written before this
 * change), null, junk (a number, which only a damaged file holds), and on a settling row one consistent with
 * its spend, also with leading zeros as a hand edit could leave it (or, with no spend, an exact spend alone). Every read above with a raw value that is absent,
 * null, junk ("0x10"), the exact amount of its settled spend and the same with leading zeros (or, with no
 * settled spend, an exact amount alone). The raw values are consistent with the settled spends: a read
 * that settles lower carries a lower exact amount. Two reads that contradict each other are not in the
 * grid, because the gateway's float and exact figures are two views of one ledger observation.
 */
describe("decideBooking: the exact spend (money stage 1)", () => {
  const RAW_OF: Record<number, string> = { 0: "0", 0.01: "10000000000000000", 0.05: "50000000000000000", 0.07: "70000000000000000" };
  const RAW_ONLY = "60000000000000000";
  const ABSENT = Symbol("absent");
  type ExactRow = Row & { spend_raw?: unknown };
  type ExactRead = ReadOutcome & { settledRaw?: unknown };
  const withRaw = <T extends object>(o: T, key: string, raw: unknown): T => (raw === ABSENT ? { ...o } : { ...o, [key]: raw });
  const prevRaws = (prev: Row): unknown[] => [ABSENT, null, 5e16, ...(settles(prev.state) ? (known(prev.spend) ? [RAW_OF[prev.spend!], "00" + RAW_OF[prev.spend!]] : [RAW_ONLY]) : [])];
  const readRaws = (read: ReadOutcome): unknown[] => [ABSENT, null, "0x10", ...(known(read.settled) ? [RAW_OF[read.settled as number], "00" + RAW_OF[read.settled as number]] : [RAW_ONLY])];
  const EXACT_CASES: (Case & { prev: ExactRow })[] = CASES.flatMap((c) => prevRaws(c.prev).map((raw) => ({ ...c, prev: withRaw(c.prev, "spend_raw", raw) })));
  const exactReadsOf = (reads: ReadOutcome[]): { base: ReadOutcome; read: ExactRead }[] => reads.flatMap((base) => readRaws(base).map((raw) => ({ base, read: withRaw(base, "settledRaw", raw) })));
  const EXACT_READS = exactReadsOf(READS);
  const isTrusted = (base: ReadOutcome) => TRUSTED_READS.includes(base);

  // The test's own exact amount rule: ASCII digits only, below 2^128, canonical. Else null.
  const exactOf = (v: unknown): bigint | null => (typeof v === "string" && /^[0-9]+$/.test(v) && BigInt(v) < 2n ** 128n ? BigInt(v) : null);
  /**
   * The read books a float spend the row did not hold: the row's float spend was unknown, or a different
   * known amount. Moved (hold floor, R5): this was only "replaces a different known one" (money stage 1,
   * decision 1). A float spend that moves from unknown to known is booked as a pair too.
   */
  const booksNewSpend = (prev: Row, base: ReadOutcome) => proves(base) !== null && !notBooked(prev, base) && prev.spend !== proves(base);
  /**
   * The exact spend after a read, by the rules. A read that books a float spend the row did not hold brings
   * its own exact amount, or unknown: the pair. A read that books no float spend never changes the exact
   * spend beside a known float spend (R5). Any other trusted settling read that is booked sets a valid exact
   * amount above the booked one. Anything else changes nothing.
   */
  const expectedRaw = (prev: ExactRow, base: ReadOutcome, read: ExactRead): unknown => {
    const incoming = exactOf(read.settledRaw);
    if (booksNewSpend(prev, base)) return incoming === null ? null : incoming.toString();
    if (proves(base) === null && known(prev.spend)) return prev.spend_raw;
    const booked = exactOf(prev.spend_raw);
    if (!isTrusted(base) || !settles(base.state) || notBooked(prev, base) || incoming === null) return prev.spend_raw;
    return booked === null || incoming > booked ? incoming.toString() : prev.spend_raw;
  };
  const afterExact = (prev: ExactRow, read: ExactRead, cost: number | null): ExactRow => ({ ...prev, ...decideBooking(prev, read, cost).booking }) as ExactRow;

  function walkExact(reads: { base: ReadOutcome; read: ExactRead }[], broken: (c: Case & { prev: ExactRow }, base: ReadOutcome, read: ExactRead, next: ExactRow) => boolean) {
    const failures: string[] = [];
    let walked = 0;
    for (const c of EXACT_CASES) {
      for (const { base, read } of reads) {
        walked += 1;
        if (broken(c, base, read, afterExact(c.prev, read, c.cost))) failures.push(show(c, read));
      }
    }
    return { walked, failures: failures.slice(0, 5), failed: failures.length };
  }

  it("the grid: 884 previous rows with an exact spend, 480 reads with a raw value, 120 of them trusted", () => {
    // Moved (hold floor): 662 rows. The grid above is larger.
    expect({ cases: EXACT_CASES.length, reads: EXACT_READS.length, trusted: EXACT_READS.filter((r) => isTrusted(r.base)).length }).toEqual({ cases: 884, reads: 480, trusted: 120 });
  });

  it("an untrusted read never sets the exact spend", () => {
    const r = walkExact(EXACT_READS.filter((r) => !isTrusted(r.base)), (c, _base, _read, next) => next.spend_raw !== c.prev.spend_raw);
    expect(r).toEqual({ walked: 884 * 360, failures: [], failed: 0 });
  });

  it("a booked exact spend is never lowered, and is replaced only together with the float spend it describes", () => {
    // Moved (money stage 1, decision 1): this was "never lowered and never lost". An exact amount describes
    // the booked settlement, so when a read books a different known float spend, the exact amount is that
    // read's own, or unknown. Moved (hold floor, R5): also when the row's float spend was unknown.
    const r = walkExact(EXACT_READS, (c, _base, read, next) => {
      if (known(next.spend) && next.spend !== c.prev.spend) return next.spend_raw !== (exactOf(read.settledRaw)?.toString() ?? null);
      const before = exactOf(c.prev.spend_raw);
      if (before === null) return false;
      const after = exactOf(next.spend_raw);
      return after === null || after < before;
    });
    expect(r).toEqual({ walked: 884 * 480, failures: [], failed: 0 });
  });

  it("hold floor, R5: a read whose float amount is unknown never sets or changes the exact spend beside a known float spend", () => {
    // The reviewer's finding R5: a released read with no float amount and an exact amount set spend_raw on a
    // row whose float spend was known, so the row held an exact amount taken from another read.
    let beside = 0;
    const r = walkExact(EXACT_READS, (c, base, _read, next) => {
      if (!known(c.prev.spend) || proves(base) !== null) return false;
      beside += 1;
      return next.spend_raw !== c.prev.spend_raw || next.spend !== c.prev.spend;
    });
    expect({ ...r, beside }).toEqual({ walked: EXACT_CASES.length * EXACT_READS.length, failures: [], failed: 0, beside: 202400 });
  });

  it("the exact spend is set only by a trusted settling read that is not refused: with a new known float spend its own, otherwise only above the booked one, and in canonical form", () => {
    // This covers: carried on a first settlement, arriving on a later read, a lower or equal amount
    // changing nothing, a refused read (it would lower the booked float spend) setting nothing, junk and a
    // missing value read as unknown, and leading zeros dropped. Moved (money stage 1, decision 1): a read
    // that replaces a known float spend with a different one replaces the exact spend with its own. Moved
    // (hold floor, R5): so does a read that books a float spend the row did not know, and a read that books
    // no float spend leaves the exact spend beside a known one as it is. The count was 12144 on the smaller grid.
    let set = 0;
    const r = walkExact(EXACT_READS, (c, base, read, next) => {
      const want = expectedRaw(c.prev, base, read);
      if (want !== c.prev.spend_raw) set += 1;
      return next.spend_raw !== want;
    });
    expect({ ...r, set }).toEqual({ walked: 884 * 480, failures: [], failed: 0, set: 22494 });
  });

  it("the raw value never changes the float booking: state, spend, charge and disagree are what the same read without it decides", () => {
    // The cap is computed exactly as before money stage 1: nothing in it reads the exact spend.
    const failures: string[] = [];
    let walked = 0;
    for (const c of EXACT_CASES) {
      for (const { base, read } of EXACT_READS) {
        walked += 1;
        const withIt = decideBooking(c.prev, read, c.cost);
        const without = decideBooking(c.prev, base, c.cost);
        const same = withIt.disagree === without.disagree && withIt.booking.state === without.booking.state && withIt.booking.spend === without.booking.spend && withIt.booking.cap_charge === without.booking.cap_charge;
        if (!same) failures.push(show(c, read));
      }
    }
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 884 * 480, failures: [], failed: 0 });
  });

  it("order independence: two trusted reads book the same pair of float and exact spend in either order", () => {
    // Two processes can book the same request, and the gateway may answer them differently. Walked over
    // the rows with no exact spend or a consistent one, and the trusted reads with no raw value or the
    // exact amount of their settled spend. Moved (money stage 1, decision 1): this compared the exact spend
    // alone and counted 8576 pairs where the read that settled higher carried no exact amount, so one order
    // left the exact amount of the lower read beside the higher spend. That pair was false, and it is gone.
    // Moved (hold floor): this was "but for two shapes counted here", 5200 and 6624 pairs of 785000. Both
    // are gone, and any pair that differs now fails here.
    //  - A read refused only because the charge it would hold was unknown (a damaged row, or a released
    //    reservation with an unknown padded quote) was booked after a read that settled first gave the row
    //    a known charge. Now such a read is refused in both orders: on a damaged row only a proven
    //    settlement with a known padded quote is booked, and on a released row with an unknown padded quote
    //    no trusted read is booked (holdFloor).
    //  - An exact amount with no float amount beside it, on a read or on the row, survived in one order only.
    //    Now the read that books the float spend sets the pair, and a read with no float amount never
    //    changes the exact spend beside a known float spend (R5), so the order no longer decides it.
    const reads = exactReadsOf(TRUSTED_READS).filter(({ read }) => !("settledRaw" in read) || (typeof read.settledRaw === "string" && !read.settledRaw.startsWith("0x") && !read.settledRaw.startsWith("00")));
    const cases = EXACT_CASES.filter((c) => !("spend_raw" in c.prev) || typeof c.prev.spend_raw === "string");
    let walked = 0;
    const failures: string[] = [];
    for (const c of cases) {
      for (const a of reads) {
        for (const b of reads) {
          walked += 1;
          const ab = afterExact(afterExact(c.prev, a.read, c.cost), b.read, c.cost);
          const ba = afterExact(afterExact(c.prev, b.read, c.cost), a.read, c.cost);
          // Absent and null are both unknown: one order can write an explicit null where the other leaves the field absent.
          if (ab.spend !== ba.spend || exactOf(ab.spend_raw) !== exactOf(ba.spend_raw)) failures.push(show(c, a.read, b.read));
        }
      }
    }
    expect({ cases: cases.length, reads: reads.length }).toEqual({ cases: 436, reads: 50 });
    expect({ walked, failures: failures.slice(0, 5), failed: failures.length }).toEqual({ walked: 436 * 50 * 50, failures: [], failed: 0 });
  });

  it("booking the same read again leaves the exact spend as it is", () => {
    const r = walkExact(EXACT_READS, (c, _base, read, next) => afterExact(next, read, c.cost).spend_raw !== next.spend_raw);
    expect(r).toEqual({ walked: 884 * 480, failures: [], failed: 0 });
  });

  it("a failure report never changes the exact spend", () => {
    const failures = EXACT_CASES.flatMap((c) => (["timeout_unknown", "error", "refused_local"] as Failure[]).filter((report) => ({ ...c.prev, ...decideFailure(c.prev, report) }).spend_raw !== c.prev.spend_raw).map((report) => JSON.stringify({ ...c, report })));
    expect({ walked: EXACT_CASES.length * 3, failures }).toEqual({ walked: 884 * 3, failures: [] });
  });
});
