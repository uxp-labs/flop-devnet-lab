/**
 * Validation and spend policy. Pure: no file, network or ledger access. Each check either returns the
 * accepted value or throws a CliError with the exit code the CLI has always used, so callers keep their
 * order of checks and their exit codes. Behavior is pinned by contract/vectors (quote, cap-compare,
 * amount-text, max-tokens) and the older run/cap tests.
 */
import { CliError, EXIT } from "./errors.js";
import type { Payer, SeatCap } from "./config.js";
import { scanForSecrets } from "./secrets.js";

export const TEMPLATE_PAD = 20; // measured: Qwen chat wrap 23 tokens vs 3 raw for "Be brief.\nHi"

/** A finite, positive number. */
export const posFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function finiteTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** Round up to 6 decimals. A value already on a 1e-6 boundary stays put. */
function ceil6(n: number): number {
  const scaled = n * 1e6;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) <= 1e-6) return nearest / 1e6;
  return Math.ceil(scaled) / 1e6;
}

export function padQuote(est: { estimated_cost_flop?: number; estimated_input_tokens?: number; estimated_output_tokens?: number }): { raw: number; padded: number } | null {
  const raw = est.estimated_cost_flop;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !(raw > 0)) return null;
  const tinIn = (est as { estimated_input_tokens?: unknown }).estimated_input_tokens;
  const toutIn = (est as { estimated_output_tokens?: unknown }).estimated_output_tokens;
  const tin = tinIn === undefined ? 0 : finiteTokenCount(tinIn);
  const tout = toutIn === undefined ? 0 : finiteTokenCount(toutIn);
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
 * Only "holder" (daily cap) and "requester" (job budget) have a spend limit. Anything else in config.json
 * (a hand edit, another writer) would skip both checks: fail closed, nothing sent.
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
 * The cap check made under the ledger lock. Holder: per-call cap, then the remaining daily cap.
 * Requester: per-call cap, then the remaining job budget. Null means the padded quote fits.
 */
export function checkBudget(a: { padded: number; cap: SeatCap; payer: Payer; spentBefore: number; jobBudget?: number }): BudgetRefusal | null {
  const { padded, cap, payer, spentBefore } = a;
  if (padded > cap.perCall) return { reason: `padded quote ${padded} FLOP is over the per-call cap ${cap.perCall}`, code: EXIT.REFUSED_CAP };
  if (payer === "holder") {
    const left = Math.round((cap.daily - spentBefore) * 1e6) / 1e6;
    if (left <= 0) return { reason: `daily cap reached (${spentBefore}/${cap.daily} FLOP today, UTC)`, code: EXIT.REFUSED_CAP };
    if (padded > left) return { reason: `padded quote ${padded} FLOP is over the remaining daily cap ${left}`, code: EXIT.REFUSED_CAP };
    return null;
  }
  // A non-finite budget left would skip the cap, so refuse it (and any payer other than requester).
  const left = Math.round((a.jobBudget! - spentBefore) * 1e6) / 1e6;
  if (payer !== "requester" || !Number.isFinite(left)) return { reason: `no usable requester budget for payer ${JSON.stringify(payer)}`, code: EXIT.REFUSED_CAP };
  if (padded > left) return { reason: `padded quote ${padded} FLOP is over this job's remaining requester budget ${left}`, code: EXIT.REFUSED_CAP };
  return null;
}
