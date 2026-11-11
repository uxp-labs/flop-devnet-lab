/**
 * ledger.jsonl: one line per state change of an attempt (spend-guard rule 6). The latest line for a
 * request_id wins. Tokens, keys and prompts are never written; only a prompt hash.
 * States: refused_local, sent, timeout_unknown, error, reserved, estimated, settled, released.
 * A pre-mint refusal appends refused_local (cap charge 0). That latest line supersedes the pre-call sent line.
 */
import { existsSync, readFileSync } from "node:fs";
import { AMOUNT_MAX, knownAmount } from "./amount.js";
import { isSeatId } from "./keys.js";
import { groupKey, isRequestId, readLedgerText } from "./ledger-text.js";
import { assertLockHeld, LedgerUnlockable, lockDepth, withLock } from "./lock.js";
import { ledgerFile } from "./paths.js";
import { isJobId } from "./policy.js";
import { ceilMicro } from "./rounding.js";
import { outsideValue } from "./secrets.js";
import { appendJsonlSafe } from "./store.js";
import type { Payer } from "./config.js";

export interface LedgerEntry {
  ts: string;
  day: string; // UTC date; the daily cap resets at 00:00 UTC
  request_id: string | null;
  seat: string; // NFT tokenId
  did: string | null; // the seat's FLOP did:key at call time
  job: string;
  provider: "mock" | "flop";
  network: string;
  payer: Payer;
  model: string;
  max_tokens: number;
  prompt_sha256: string;
  quote_raw: number | null;
  quote_padded: number | null;
  per_call_cap: number | null;
  daily_cap: number | null;
  job_budget: number | null;
  spent_before: number | null; // the seat's spend today before this call, for every payer: the daily cap's running total. Null is unknown
  // Requester row: this job's requester spend before this call, the job budget's running total. Null on a holder row.
  // Rows written before the daily cap bounded requester calls (audit 8ddc5d2, finding 13) lack the field, and on
  // those requester rows spent_before held the job's spend. A missing value is unknown, never 0.
  job_spent_before?: number | null;
  state: string;
  reason: string | null;
  spend: number | null; // finite settled spend >= 0; null = unknown (negative, non-finite, and missing are unknown, never coerced to 0)
  cost_reported: number | null; // usage.cost_flop from the completion, if any. Recorded as reported; not a settlement.
  // The exact spend in base units (10^18 per FLOP) as a canonical digit string, or null for unknown (money
  // stage 1; settlement.ts decideBooking decides it). Recorded only: policy.ts, the sums here and the cap never
  // read it, and the cap is computed from cap_charge alone. Rows written before money stage 1 lack the field:
  // a missing value is unknown, never 0.
  spend_raw?: string | null;
  // The hold floor: from the moment the call is sent, the padded quote it was admitted with, raised by a
  // settled spend or a reported cost above it, never lowered by a gateway read (settlement.ts decideBooking).
  // 0 on a refused_local row: nothing was sent. So the cap counts what each call was allowed to spend.
  // Rows an older version booked below their hold are not migrated.
  cap_charge: number;
  // True when a trusted receipt read was booked and left the row in state sent (a receipt with no state):
  // the gateway knows the request, so a "nothing was sent" report does not release the hold (settlement.ts
  // decideFailure). Absent otherwise.
  receipt_seen?: boolean;
  http: number | null;
  mock: boolean;
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function appendLedger(h: string, e: LedgerEntry): void {
  withLedgerLock(h, () => {
    assertLockHeld(ledgerFile(h)); // the lock file still carries our token (lock.ts): it was not removed by hand
    appendJsonlSafe(ledgerFile(h), e, "ledger.jsonl");
  });
}

/** One ledger row with its line number in ledger.jsonl, counted from 1 (blank lines count), so a refusal can name it. */
interface Line {
  n: number;
  row: LedgerEntry;
}

/**
 * Every row of ledger.jsonl with its line number. A line that is not valid JSON, or is JSON but not an object,
 * is damaged: it throws UnreadableLedgerLine naming the line, and nothing that reads the ledger goes on as
 * if it were not there. This is the one owner of that read, for every reader: a reader outside the ledger
 * lock that meets such a line first takes the lock and reads again, and names the line only when it is
 * still unreadable there (review fixes 3, item 2). If the lock cannot be taken, LedgerLockError: busy. `run` refuses (exit 10, nothing sent), and every other command exits 1 with the same
 * message. A damaged ledger is not a disagreement between a receipt and the ledger.
 */
function ledgerLines(h: string): Line[] {
  try {
    return parsedLines(h);
  } catch (e) {
    // Read outside the lock: the line may be one another process is still appending under it. Take the lock
    // and read again before naming any line. Under the lock every append is whole, so a line still
    // unreadable there is damaged. A lock that cannot be taken throws LedgerLockError: the ledger is busy.
    if (!(e instanceof UnreadableLedgerLine) || (lockDepth.get(ledgerFile(h)) ?? 0) > 0) throw e;
    try {
      return withLedgerLock(h, () => parsedLines(h));
    } catch (again) {
      if (!(again instanceof LedgerUnlockable)) throw again;
      // The lock cannot be created here (a home this reader may read but not write): read without it, and say
      // so beside a line that does not parse.
      try {
        return parsedLines(h);
      } catch (still) {
        if (still instanceof UnreadableLedgerLine) throw new UnreadableLedgerLine(`${still.message} ${NOT_LOCKED}`);
        throw still;
      }
    }
  }
}

function parsedLines(h: string): Line[] {
  const path = ledgerFile(h);
  if (!existsSync(path)) return [];
  const lines: Line[] = [];
  // The ledger text contract (ledger-text.ts): the one reading of the file's text, shared with the viewer.
  for (const line of readLedgerText(readFileSync(path, "utf8"))) {
    if (line.kind === "unreadable") throw new UnreadableLedgerLine(`ledger line ${line.n} cannot be read: ${line.why}; next call refused. Repair or remove that line.`);
    if (line.kind === "row") lines.push({ n: line.n, row: line.row as unknown as LedgerEntry });
  }
  return lines;
}

export { isRequestId } from "./ledger-text.js";

/** Latest line per usable request_id, with its line number. Lines with no usable request_id are left out. */
function latestLines(h: string): Line[] {
  return latestOfGroups(ledgerLines(h)).filter((line) => isRequestId(line.row.request_id));
}

/**
 * The latest line of every group, by the ledger text contract's one grouping rule (ledger-text.ts groupKey):
 * a usable request id groups the rows of a request, and a row without one is a group of its own.
 */
function latestOfGroups(lines: Line[]): Line[] {
  const m = new Map<string, Line>();
  for (const line of lines) m.set(groupKey(line.row as unknown as Record<string, unknown>, line.n), line);
  return [...m.values()];
}

/**
 * A line with no usable request_id that is not a refusal written before a request id exists (refused_local,
 * charge 0). No later line can supersede it, so it is its own entry for the totals, and it cannot be placed.
 */
function withoutRequestId(row: LedgerEntry): boolean {
  return !isRequestId(row.request_id) && !(row.state === "refused_local" && row.cap_charge === 0);
}

/**
 * Latest line per request_id. Lines with no request_id are omitted.
 * A locally proven pre-dispatch refusal may still have a request_id; that line is kept and its cap_charge is 0, so it adds nothing to spend.
 * A generic refusal label or unknown spend does not imply a zero charge, and those lines stay in this list.
 */
export function latestAttempts(h: string): LedgerEntry[] {
  return latestLines(h).map((line) => line.row);
}

/** The line number of the latest row of a request, or null when the ledger holds none. */
export function latestLineOf(h: string, requestId: string): number | null {
  return latestLines(h).find((line) => line.row.request_id === requestId)?.n ?? null;
}

/**
 * A ledger line that cannot be used: it cannot be read (ledgerLines), it cannot be placed in a total
 * (placed), or its charge is not a known amount (sumCharges). The message names the ledger line so the
 * holder can repair it. run.ts refuses on any of these (exit 3, nothing sent).
 */
export class UnusableLedgerRow extends Error {}
/** The row's cap_charge is not a known amount. */
export class UnusableLedgerCharge extends UnusableLedgerRow {}
/** Added to a damaged line's message when the ledger could not be locked to read it again (LedgerUnlockable). */
export const NOT_LOCKED = "The ledger could not be locked, so this line may be one still being written.";
/** The line is not valid JSON, or not a JSON object, even when read under the ledger lock (ledgerLines). */
export class UnreadableLedgerLine extends UnusableLedgerRow {}

/** A cap charge counts only when it is a known amount (amount.ts): a finite number and not negative. Null is not 0. */
export function usableCapCharge(value: unknown): boolean {
  return knownAmount(value) !== null;
}

/**
 * A total is above AMOUNT_MAX, the largest amount this tool compares: it is not a known amount, so nothing is
 * decided on it. run.ts refuses (exit 3, nothing sent), and the read commands exit 1 with the same message.
 */
export class UnusableLedgerTotal extends UnusableLedgerRow {}

/** AMOUNT_MAX in micro units: the largest total this tool compares. */
const TOTAL_MAX_MICRO = BigInt(AMOUNT_MAX) * 1_000_000n;

/**
 * An exact total from the integer numerators of known amounts (rounding.ts ceilMicro: each rounded up to 6
 * decimals, so the total never understates what was spent). They are added as BigInt, never as floats, and
 * the total is that integer over 1e6 (swarm audit 33f3b9f, finding 5). A total above AMOUNT_MAX throws, and
 * its message names how many rows make it up, their lines, and the way back (review defect 7).
 */
function exactTotal(items: { n: number; amount: number }[], total: string, wayBack: string): number {
  let micro = 0n;
  for (const { amount } of items) micro += BigInt(ceilMicro(amount));
  if (micro > TOTAL_MAX_MICRO) {
    const lines = items.map(({ n }) => n);
    const named = lines.length <= 5 ? `ledger ${lines.length === 1 ? "line" : "lines"} ${listed(lines)}` : `ledger lines ${lines[0]} (the first) to ${lines[lines.length - 1]} (the last)`;
    throw new UnusableLedgerTotal(`${total} is above ${AMOUNT_MAX} FLOP, the largest amount this tool compares, so it is not a known amount; next call refused. It is made of ${lines.length} ${lines.length === 1 ? "row" : "rows"}, ${named}. ${wayBack}`);
  }
  return Number(micro) / 1e6;
}

/** 1, 2 and 3. */
const listed = (ns: number[]): string => (ns.length === 1 ? String(ns[0]) : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

/** The total of these rows' cap charges, exact (exactTotal). A charge that is not a known amount throws, naming its line. */
function sumCharges(lines: Line[], total: string, wayBack: string): number {
  for (const { n, row } of lines) {
    if (!usableCapCharge(row.cap_charge)) throw new UnusableLedgerCharge(`ledger cap_charge unusable; next call refused (ledger line ${n}). Repair or remove that line.`);
  }
  return exactTotal(lines.map(({ n, row }) => ({ n, amount: row.cap_charge })), total, wayBack);
}

const REPAIR = "Repair those lines.";

/** A UTC day as utcDay writes it: YYYY-MM-DD, and a real calendar date from year 0001 on (the viewer's Python dates start there). */
function isUtcDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !v.startsWith("0000") && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && utcDay(new Date(`${v}T00:00:00Z`)) === v;
}

/** The provider names a ledger row can hold. contract/rules.json LEDGER_PROVIDERS. */
export const LEDGER_PROVIDERS: ReadonlySet<string> = new Set(["mock", "flop"]);
const PAYERS: ReadonlySet<string> = new Set(["holder", "requester"]);

/** A field a total filters rows on, the value the total wants there, and what a usable value is. */
interface Filter {
  field: "day" | "seat" | "provider" | "job" | "payer";
  want: string;
  usable: (v: unknown) => boolean;
}
const onDay = (day: string): Filter => ({ field: "day", want: day, usable: isUtcDay });
const onSeat = (seat: string): Filter => ({ field: "seat", want: seat, usable: isSeatId });
const onProvider = (provider: string): Filter => ({ field: "provider", want: provider, usable: (v) => typeof v === "string" && LEDGER_PROVIDERS.has(v) });
const onJob = (job: string): Filter => ({ field: "job", want: job, usable: isJobId });
const onPayer = (payer: string): Filter => ({ field: "payer", want: payer, usable: (v) => typeof v === "string" && PAYERS.has(v) });

/**
 * The one owner of "this row cannot be placed", for the daily total and the job total alike. The latest row
 * of each request is placed in a total when every filter matches. A row with a usable value that differs
 * from what a filter wants is not this total's. A row that would count if its unusable values were readable
 * (every usable value matches, and at least one value is not usable) cannot be placed: it throws
 * UnusableLedgerRow naming the line, so the next call is refused rather than its charge lost. Only the latest
 * row of a request is placed: an older row of the same request is superseded, so damage there loses nothing.
 * A line with no usable request_id cannot be superseded, so it is its own entry, and its request_id counts
 * as an unusable value (withoutRequestId): it cannot be placed, unless it is a refusal charged 0.
 */
function placed(h: string, filters: Filter[], total: string): Line[] {
  const all = ledgerLines(h);
  const lines: Line[] = [];
  for (const line of latestOfGroups(all).filter((l) => isRequestId(l.row.request_id) || withoutRequestId(l.row))) {
    const row = line.row as unknown as Record<string, unknown>;
    const values = filters.map((f) => ({ f, v: row[f.field] }));
    if (values.some(({ f, v }) => f.usable(v) && v !== f.want)) continue;
    const unusable = [...(isRequestId(row.request_id) ? [] : [{ field: "request_id", v: row.request_id }]), ...values.filter(({ f, v }) => !f.usable(v)).map(({ f, v }) => ({ field: f.field, v }))];
    if (unusable.length > 0) {
      // Never the raw value: a key shaped one would stop the refusal row (swarm audit 33f3b9f, finding 6).
      const what = unusable.map(({ field, v }) => `${field} ${outsideValue(v)}`).join(", ");
      throw new UnusableLedgerRow(`ledger line ${line.n} cannot be placed in ${total}: ${what} is not a usable value; next call refused. Repair or remove that line.`);
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The seat's spend on one UTC day: the daily cap's running total.
 * The seat's daily cap bounds every call the seat's key pays for, whoever the call is for. Today the gateway
 * has no third party payment, so the seat's key pays for every call, and every row of the seat counts: there
 * is no payer filter. When FLOP ships proxies or escrow pools and a call is funded by another account, that
 * account's limit will bound the call and it will not count here.
 */
export function spentToday(h: string, seat: string, provider: string, day = utcDay()): number {
  return sumCharges(seatDay(h, seat, provider, day), dailyTotal(seat, provider, day), REPAIR);
}

const dailyTotal = (seat: string, provider: string, day: string) => `the daily total of seat ${seat} (${provider}, ${day})`;

/** The latest row of every request of the seat for that provider and UTC day (placed). */
function seatDay(h: string, seat: string, provider: string, day: string): Line[] {
  return placed(h, [onDay(day), onSeat(seat), onProvider(provider)], dailyTotal(seat, provider, day));
}

/**
 * What the gateway reported as spent on one UTC day, over the same rows spentToday counts. `spent` is the sum
 * of their known settled spends (`spend`), exact as that total is (exactTotal). `unknownRows` counts the
 * rows for a call that was sent (any state but refused_local) whose spend is not a known amount: the gateway
 * reported no amount for them, so they add nothing to the sum and are never shown as 0. `spent` is null when
 * no row has a known spend and at least one is unknown (swarm audit 33f3b9f, finding 13). A refused_local row
 * is not an unknown spend: nothing was sent. `status` shows both beside spentToday, which is what counts
 * against the cap. No cap or booking decision reads them.
 */
export function reportedSpendToday(h: string, seat: string, provider: string, day = utcDay()): { spent: number | null; unknownRows: number } {
  const spends: { n: number; amount: number }[] = [];
  let unknownRows = 0;
  for (const { n, row } of seatDay(h, seat, provider, day)) {
    const spend = knownAmount(row.spend);
    if (spend !== null) spends.push({ n, amount: spend });
    else if (row.state !== "refused_local") unknownRows += 1;
  }
  if (spends.length === 0 && unknownRows > 0) return { spent: null, unknownRows };
  return { spent: exactTotal(spends, `the reported spend of seat ${seat} (${provider}, ${day})`, REPAIR), unknownRows };
}

/** The requester spend on one job, on any day: the job budget's running total. */
export function jobSpent(h: string, job: string, provider: string): number {
  const total = `the requester total of job ${job} (${provider})`;
  return sumCharges(placed(h, [onJob(job), onProvider(provider), onPayer("requester")], total), total, "The way back: use a new job id, or repair those lines.");
}

export { LedgerLockError, LedgerLockLost, LedgerUnlockable } from "./lock.js";

/**
 * Exclusive lock over a read of the ledger and the append that follows from it: the cap check with its
 * `sent` row (run.ts), and the booking step for everything written after the call (booking.ts). Re-enters
 * in this process. The lock itself is lock.ts.
 * Synchronous bodies only.
 */
export function withLedgerLock<T>(h: string, fn: () => T): T {
  return withLock(ledgerFile(h), fn);
}
