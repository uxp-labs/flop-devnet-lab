/**
 * Validation and spend policy. Pure: no file, network or ledger access. Each check either returns the
 * accepted value or throws a CliError with the exit code the CLI has always used, so callers keep their
 * order of checks and their exit codes. Behavior is pinned by contract/vectors (quote, cap-compare,
 * cap-payer, amount-text, max-tokens) and the older run/cap tests.
 */
import { knownAmount } from "./amount.js";
import { CliError, EXIT } from "./errors.js";
import type { Payer, SeatCap } from "./config.js";
import { ceil6, floor6 } from "./rounding.js";
import { scanForSecrets } from "./secrets.js";

export const TEMPLATE_PAD = 20; // measured: Qwen chat wrap 23 tokens vs 3 raw for "Be brief.\nHi"

/** A finite, positive number. */
export const posFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** A usable token count is a known amount (amount.ts): a finite number that is not negative. A negative count would shrink the divisor and inflate the pad. */
function usableTokenCount(value: unknown): number | null {
  return knownAmount(value);
}

export function padQuote(est: { estimated_cost_flop?: number; estimated_input_tokens?: number; estimated_output_tokens?: number }): { raw: number; padded: number } | null {
  const raw = est.estimated_cost_flop;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !(raw > 0)) return null;
  const tinIn = (est as { estimated_input_tokens?: unknown }).estimated_input_tokens;
  const toutIn = (est as { estimated_output_tokens?: unknown }).estimated_output_tokens;
  const tin = tinIn === undefined ? 0 : usableTokenCount(tinIn);
  const tout = toutIn === undefined ? 0 : usableTokenCount(toutIn);
  if (tin === null || tout === null || tin + tout <= 0) return null;
  const perTok = raw / (tin + tout);
  const unrounded = raw + TEMPLATE_PAD * perTok;
  if (!Number.isFinite(unrounded) || !(unrounded > 0)) return null;
  const padded = ceil6(Math.max(unrounded, raw));
  if (!Number.isFinite(padded) || !(padded > 0) || padded < raw) return null;
  return { raw, padded };
}

/** A CLI amount (`cap set`, --per-call, --job-budget): JS Number() of the text, finite and > 0. Undefined passes through. */
export function parseAmount(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`${name} must be a positive number`, EXIT.USAGE);
  return n;
}

/** Rule 4 (real work only): a non-empty, printable, non-key-shaped IMD job id. Returns the trimmed id. */
export function validateJob(raw: string | undefined): string {
  const job = (raw ?? "").trim();
  if (!job) throw new CliError("--job <imd job id> is required: FLOP calls only serve real IMD jobs (rule 4)", EXIT.REFUSED_RULE);
  if (!/^[\x21-\x7e]{1,120}$/.test(job)) throw new CliError("--job must be 1-120 printable characters", EXIT.USAGE);
  // Every ledger row carries the job id, so a key-shaped id could never be recorded. Refuse it up front.
  if (scanForSecrets({ job }).length > 0) throw new CliError("--job looks key-shaped (for example 64+ hex characters) and cannot be written to the ledger; use a different job id", EXIT.USAGE);
  return job;
}

/** `run --max-tokens`: an integer 1..8192. (`quote` does not check; see contract quirk Q-MAXTOK-RANGE.) */
export function validateRunMaxTokens(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 8192) throw new CliError("--max-tokens must be 1..8192", EXIT.USAGE);
  return n;
}

/** The seat's cap. Missing, or without finite positive numbers with perCall <= daily, is no cap: fail closed. */
export function requireCap(caps: Record<string, SeatCap>, seat: string): SeatCap {
  const cap = caps[seat];
  if (!cap) throw new CliError(`no daily cap for seat ${seat}: FLOP stays off. Set one with \`imd-flop cap set <FLOP/day>\``, EXIT.REFUSED_CAP);
  if (!posFinite(cap.daily) || !posFinite(cap.perCall) || cap.perCall > cap.daily) {
    throw new CliError(`cap for seat ${seat} is malformed (daily and perCall must be positive numbers, perCall <= daily): FLOP stays off. Set it again with \`imd-flop cap set <FLOP/day>\``, EXIT.REFUSED_CAP);
  }
  return cap;
}

/**
 * Only "holder" and "requester" have spend limits (limitsFor). Anything else in config.json (a hand edit,
 * another writer) would skip every check: fail closed, nothing sent. A requester call also needs a job
 * budget, its second limit.
 */
export function validatePayer(payer: unknown, jobBudget: number | undefined): Payer {
  if (payer !== "holder" && payer !== "requester") {
    throw new CliError(`payer ${JSON.stringify(payer)} in config.json is not "holder" or "requester": no cap or budget applies, FLOP stays off. Set it with \`imd-flop config set payer holder|requester\``, EXIT.REFUSED_CAP);
  }
  if (payer === "requester" && !(typeof jobBudget === "number" && jobBudget > 0)) {
    throw new CliError("payer is requester: pass --job-budget <FLOP> (the requester's budget for this job)", EXIT.REFUSED_CAP);
  }
  return payer;
}

export interface BudgetRefusal { reason: string; code: number }

/**
 * What a budget check needs besides the quote. `spentBefore` is the seat's spend today, for every payer
 * (ledger.ts spentToday). A requester state also carries the job budget and `jobSpentBefore`, the job's
 * requester spend (ledger.ts jobSpent). Both totals are already rounded up.
 */
export interface BudgetState { cap: SeatCap; payer: Payer; spentBefore: number; jobBudget?: number; jobSpentBefore?: number }

const refusedCap = (reason: string): BudgetRefusal => ({ reason, code: EXIT.REFUSED_CAP });
const noUsableBudget = (payer: unknown): string => `no usable requester budget for payer ${JSON.stringify(payer)}`;

/** One spend limit: what it allows, what is already charged against it, and the wording of its refusals. */
interface SpendLimit {
  allowed: number | undefined;
  spent: number | undefined;
  /** Its room left is not a finite number, so it cannot be checked. */
  unusable: string;
  /** Nothing is left of it. */
  reached: string;
  /** The padded quote is more than what is left of it. */
  over: (padded: number, left: number) => string;
}

const dailyCap = (a: BudgetState): SpendLimit => ({
  allowed: a.cap.daily,
  spent: a.spentBefore,
  unusable: `no usable daily cap (${a.spentBefore}/${a.cap.daily} FLOP today, UTC)`,
  reached: `daily cap reached (${a.spentBefore}/${a.cap.daily} FLOP today, UTC)`,
  over: (padded, left) => `padded quote ${padded} FLOP is over the remaining daily cap ${left}`,
});

const jobBudget = (a: BudgetState): SpendLimit => ({
  allowed: a.jobBudget,
  spent: a.jobSpentBefore,
  unusable: noUsableBudget(a.payer),
  reached: `requester budget reached (${a.jobSpentBefore}/${a.jobBudget} FLOP on this job)`,
  over: (padded, left) => `padded quote ${padded} FLOP is over this job's remaining requester budget ${left}`,
});

/**
 * The limits that apply to this payer, in the order they are checked.
 * The seat's daily cap bounds every call the seat's key pays for, whoever the call is for. Today the gateway
 * has no third party payment, so the seat's key pays for every call, and every call counts. "Requester" is an
 * attribution label plus a second, narrower limit: the job budget. So a holder call must fit the daily cap,
 * and a requester call must fit the daily cap and then the job budget.
 * When FLOP ships proxies or escrow pools and a call is funded by another account, that account's limit will
 * bound the call and the seat's daily cap will not. That change belongs here.
 * Null for a payer that is neither: no limit is known for it.
 */
function limitsFor(a: BudgetState): SpendLimit[] | null {
  if (a.payer === "holder") return [dailyCap(a)];
  if (a.payer === "requester") return [dailyCap(a), jobBudget(a)];
  return null;
}

/**
 * Room left under a limit: what it allows, less what is already charged. Rounded down to 6 decimals, so
 * rounding never adds room. A figure that is missing is unknown, never 0: the room is then not a number.
 */
export function roomLeft(limit: { allowed: number | undefined; spent: number | undefined }): number {
  if (typeof limit.allowed !== "number" || typeof limit.spent !== "number") return Number.NaN;
  return floor6(limit.allowed - limit.spent);
}

/**
 * A refusal that needs no quote: nothing can fit, whatever the estimate says. It is the first limit of this
 * payer with nothing left: the daily cap, then for a requester the job budget. A limit whose room is not a
 * finite number is refused too, and so is a payer with no limits. Null means a quote may still fit.
 * `run` asks this before the estimate, so the prompt does not leave the machine for nothing, and
 * checkBudget asks it again under the ledger lock.
 */
export function noRoom(a: BudgetState): BudgetRefusal | null {
  const limits = limitsFor(a);
  // A payer with no limits would skip every check, so refuse it.
  if (!limits) return refusedCap(noUsableBudget(a.payer));
  for (const limit of limits) {
    const left = roomLeft(limit);
    // Room that is not a finite number would skip the limit, so refuse it.
    if (!Number.isFinite(left)) return refusedCap(limit.unusable);
    if (left <= 0) return refusedCap(limit.reached);
  }
  return null;
}

/**
 * The cap check made under the ledger lock. First the refusal that needs no quote (noRoom), then the
 * per-call cap, then the first limit of this payer that the padded quote does not fit: the daily cap, then
 * for a requester the job budget. Null means the padded quote fits.
 */
export function checkBudget(a: BudgetState & { padded: number }): BudgetRefusal | null {
  const { padded, cap } = a;
  const none = noRoom(a);
  if (none) return none;
  if (padded > cap.perCall) return refusedCap(`padded quote ${padded} FLOP is over the per-call cap ${cap.perCall}`);
  // noRoom has already refused a payer with no limits.
  for (const limit of limitsFor(a) ?? []) {
    const left = roomLeft(limit);
    if (padded > left) return refusedCap(limit.over(padded, left));
  }
  return null;
}
