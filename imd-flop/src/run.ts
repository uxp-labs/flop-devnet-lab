import { readFileSync } from "node:fs";
import { randomBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CliError, EXIT } from "./errors.js";
import { loadConfig } from "./config.js";
import { linkFile } from "./paths.js";
import { redactFlagged, scanForSecrets } from "./secrets.js";
import { readJson, writeJsonSafe } from "./store.js";
import { loadSigner, readIdentity, revokedDids } from "./keys.js";
import { verifyLink, type LinkFile } from "./link.js";
import { DEFAULT_MODEL, network, SEAT_COLLECTION } from "./networks.js";
import { checkBudget, noRoom, padQuote, requireCap, validateJob, validatePayer, validateRunMaxTokens, type BudgetState } from "./policy.js";
import { appendLedger, jobSpent, LedgerLockError, spentToday, UnusableLedgerRow, utcDay, withLedgerLock, type LedgerEntry } from "./ledger.js";
import { classifyReceipt, type Classified } from "./receipts.js";
import { bookFailure, bookRead } from "./booking.js";
import { DISAGREE, PAST_ADMITTED, reportedCost, SETTLES } from "./settlement.js";
import { receiptVerdicts, storeRead } from "./receipt-store.js";
import { responsePath } from "./response-store.js";
import type { Provider } from "./providers.js";
import { assertPaidNetwork, checkImdJob, PaidGateError, PreSendError, readVerifiedSeatOwner, type Fetch } from "./gateway.js";
import { FlopHTTPError } from "@flop-labs/client";
import type { MatchResult } from "./receipts.js";

export { padQuote, TEMPLATE_PAD } from "./policy.js";

export interface RunOpts {
  job?: string;
  prompt?: string;
  promptFile?: string;
  system?: string;
  maxTokens: number;
  seat?: string;
  noLink?: boolean;
  jobBudget?: number;
  timeoutMs: number;
  checkJob?: boolean;
  model?: string;
}

export interface RunResult {
  request_id: string;
  job: string;
  provider: string;
  payer: string;
  quote_padded: number;
  cap_charge: number;
  /** The receipt as read, with its two verdicts. `status` is set only when it disagrees with the ledger (receipt-store.ts receiptVerdicts). */
  receipt: Classified & { seat: string; did: string; match: MatchResult; status?: string };
  response_file: string;
  /** Completion text that was stored. Null when the response-file secret scan withheld it. */
  text: string | null;
  /** Present only when a field of the response record was withheld by the secret scan. Same string as the response file. */
  withheld?: string;
  link_bypassed: boolean;
}

/** Rule 5 (a broken link means no route) and rule 2 (one DID per seat, not revoked). */
export async function checkLinkForRun(h: string, seat: string, requireWallet: boolean, deps: { fetch?: Fetch; ethRpc?: string } = {}): Promise<{ ok: boolean; why: string[] }> {
  const why: string[] = [];
  const lf = readJson<LinkFile>(linkFile(h, seat));
  const id = readIdentity(h, seat);
  if (!lf) return { ok: false, why: [`no link for seat ${seat}; run \`imd-flop link --token ${seat}\``] };
  // Live runs must prove the signer still owns the seat (a sale kills the link). Fail closed without an RPC.
  let currentOwner: string | null | undefined;
  if (requireWallet) {
    if (!deps.ethRpc) why.push("owner check needs ETH_RPC_URL (an Ethereum mainnet JSON-RPC URL) for --provider flop");
    else {
      try {
        currentOwner = await readVerifiedSeatOwner(deps.ethRpc, SEAT_COLLECTION, lf.statement.tokenId, deps.fetch);
      } catch (e) {
        why.push(`owner check failed: ${(e as Error).message}`);
      }
    }
  }
  const v = await verifyLink(lf, currentOwner === undefined ? {} : { currentOwner });
  if (!v.ok) why.push(...v.errors);
  if (!id || lf.statement.flopDid !== id.did) why.push("link names a different DID than this seat's key");
  if (lf.statement.tokenId !== seat) why.push(`link is for token ${lf.statement.tokenId}, not seat ${seat}`);
  if (revokedDids(h).has(lf.statement.flopDid)) why.push("link names a revoked DID");
  if (requireWallet && !(v.wallet.checked && v.wallet.ok)) why.push("seat-wallet EIP-712 signature missing or invalid (required for --provider flop)");
  return { ok: why.length === 0, why };
}

/**
 * The sentence `run` adds to its failure message when the booking step only recorded its report
 * (booking.ts, outcome recorded): what the ledger kept for the request instead.
 */
function keptByLedger(row: LedgerEntry): string {
  return SETTLES.has(row.state) ? `The ledger already holds a settlement for this request (${row.state}); it was kept.` : `The ledger kept its ${row.state} row for this request.`;
}

/**
 * What run needs from its caller. `warn` receives the DISAGREE line when run's own receipt read is not
 * booked, and the PAST_ADMITTED line when its booking puts the day in a state the cap did not admit.
 */
export interface RunDeps {
  fetch?: Fetch;
  ethRpc?: string;
  warn: (s: string) => void;
}

export async function runJob(h: string, provider: Provider, o: RunOpts, deps: RunDeps): Promise<RunResult> {
  const cfg = loadConfig(h);
  const net = network(cfg.network);
  const seat = o.seat ?? cfg.seat;
  if (!seat) throw new CliError("no seat: run `imd-flop init --seat <tokenId>` or pass --seat", EXIT.USAGE);

  const job = validateJob(o.job);

  const prompt = o.promptFile ? readFileSync(o.promptFile, "utf8") : o.prompt;
  if (!prompt || prompt.trim().length === 0) throw new CliError("--prompt or --prompt-file is required", EXIT.USAGE);
  validateRunMaxTokens(o.maxTokens);

  // Rule 5: link must verify. Only the mock may bypass it, and the output says so.
  let linkBypassed = false;
  if (o.noLink) {
    if (provider.name !== "mock") throw new CliError("--no-link is only allowed with --provider mock", EXIT.REFUSED_LINK);
    linkBypassed = true;
  }

  // Paid calls only. The mock provider never reaches this, so offline demo runs stay local.
  // Wrong chain, reset genesis (including faucet and RPC agreeing on another hash), and
  // unavailable or malformed responses throw here, before estimate and before complete.
  if (provider.name === "flop") {
    try {
      await assertPaidNetwork(net, deps.ethRpc, deps.fetch);
    } catch (e) {
      throw new CliError(`refused locally, nothing sent: ${(e as Error).message}`, EXIT.REFUSED_RULE);
    }
  }

  if (!linkBypassed) {
    const lc = await checkLinkForRun(h, seat, provider.name === "flop", { fetch: deps.fetch, ethRpc: deps.ethRpc });
    if (!lc.ok) throw new CliError(`link does not verify, refusing: ${lc.why.join("; ")}`, EXIT.REFUSED_LINK);
  }
  const signer = loadSigner(h, seat); // also proves the key file is 0600 and matches identity.json

  const cap = requireCap(cfg.caps, seat);
  const payer = validatePayer(cfg.payer, o.jobBudget);

  if (o.checkJob) {
    const r = await checkImdJob(job, deps.fetch);
    if (!r.ok) throw new CliError(`imd job ${job} not found on api.imd.fun (HTTP ${r.status}); refusing`, EXIT.REFUSED_RULE);
  }

  const model = o.model ?? DEFAULT_MODEL;
  const messages = [...(o.system ? [{ role: "system" as const, content: o.system }] : []), { role: "user" as const, content: prompt }];
  const estPrompt = (o.system ? o.system + "\n" : "") + prompt;
  const base: Omit<LedgerEntry, "state" | "reason" | "request_id" | "spend" | "cost_reported" | "cap_charge" | "http" | "quote_raw" | "quote_padded" | "spent_before" | "job_spent_before"> = {
    ts: new Date().toISOString(),
    day: utcDay(),
    seat,
    did: signer.identity.did,
    job,
    provider: provider.name,
    network: net.name,
    payer,
    model,
    max_tokens: o.maxTokens,
    prompt_sha256: bytesToHex(sha256(utf8ToBytes(estPrompt))),
    per_call_cap: cap.perCall,
    daily_cap: cap.daily,
    job_budget: payer === "requester" ? o.jobBudget! : null,
    mock: provider.name === "mock",
  };
  /** What is already charged against this call's limits: the seat's spend today, and for a requester the job's spend. */
  type Spent = Pick<BudgetState, "spentBefore" | "jobSpentBefore">;
  // Every row records both totals. Null is unknown. job_spent_before is also null on a holder row.
  const recorded = (spent: Spent | null): Required<Pick<LedgerEntry, "spent_before" | "job_spent_before">> => ({ spent_before: spent?.spentBefore ?? null, job_spent_before: spent?.jobSpentBefore ?? null });
  const refuse = (reason: string, code: number, q: { raw: number | null; padded: number | null }, spent: Spent | null): never => {
    appendLedger(h, { ...base, request_id: null, quote_raw: q.raw, quote_padded: q.padded, ...recorded(spent), state: "refused_local", reason, spend: null, spend_raw: null, cost_reported: null, cap_charge: 0, http: null });
    throw new CliError(`refused locally, nothing sent: ${reason}`, code);
  };

  const NO_QUOTE = { raw: null, padded: null };
  // What the limits are checked against. The seat's spend today, for every payer: the seat's key pays for
  // the call, so the daily cap bounds it. For a requester also this job's spend, for the job budget.
  // A ledger row a total cannot use (an unusable charge, or a row that cannot be placed) refuses the run.
  const spentSoFar = (day: string, quote: { raw: number | null; padded: number | null }): Spent => {
    try {
      const spentBefore = spentToday(h, seat, provider.name, day);
      return payer === "requester" ? { spentBefore, jobSpentBefore: jobSpent(h, job, provider.name) } : { spentBefore };
    } catch (e) {
      if (e instanceof UnusableLedgerRow) refuse(e.message, EXIT.REFUSED_CAP, quote, null);
      throw e;
    }
  };

  // A refusal that needs no quote comes before the estimate, so the prompt does not leave the machine
  // for nothing. The check under the ledger lock below stays the authority.
  const spentEarly = spentSoFar(base.day, NO_QUOTE);
  const early = noRoom({ cap, payer, jobBudget: o.jobBudget, ...spentEarly });
  if (early) refuse(early.reason, early.code, NO_QUOTE, spentEarly);

  // Then the quote; fail closed.
  let q: { raw: number; padded: number } | null = null;
  try {
    q = padQuote(await provider.estimate({ model, prompt: estPrompt, max_tokens: o.maxTokens }));
  } catch (e) {
    refuse(`estimate failed (${(e as Error).message})`, EXIT.ESTIMATE_FAILED, NO_QUOTE, null);
  }
  if (!q) return refuse("estimate returned no usable cost", EXIT.ESTIMATE_FAILED, NO_QUOTE, null);

  const requestId = `${provider.name === "mock" ? "mock" : "imdflop"}-${seat}-${bytesToHex(randomBytes(8))}`;
  const lockedCheck = (): LedgerEntry => {
    // The UTC day is read once, inside the lock, and used for both the cap check and the rows.
    const day = utcDay();
    const spent = spentSoFar(day, q);
    const refusal = checkBudget({ padded: q.padded, cap, payer, jobBudget: o.jobBudget, ...spent });
    if (refusal) refuse(refusal.reason, refusal.code, q, spent);
    const row: LedgerEntry = { ...base, day, request_id: requestId, quote_raw: q.raw, quote_padded: q.padded, ...recorded(spent), state: "sent", reason: null, spend: null, spend_raw: null, cost_reported: null, cap_charge: q.padded, http: null };
    appendLedger(h, row); // written before the call so a crash still leaves the attempt on the books. A later refused_local line wins if the provider refuses before mint.
    return row;
  };
  let sent: LedgerEntry;
  try {
    sent = withLedgerLock(h, lockedCheck);
  } catch (e) {
    // The lock was never taken, so no cap check ran and nothing was sent.
    if (e instanceof LedgerLockError) throw new CliError(`refused locally, nothing sent: ${e.message}`, EXIT.REFUSED_LOCK);
    throw e;
  }

  // Every row written for this request from here on goes through the booking step (booking.ts), against
  // the request's latest ledger row and not against `sent`: another process may have refreshed this
  // request and booked its own read while the call ran. `sent` goes with it as the seed row, which the
  // step writes again only when the ledger no longer holds the request's row, so the call stays on the
  // books. If the lock cannot be taken or the append fails, the step throws (exit 1), and the latest row
  // stays and keeps its reservation.

  // A ref'd timer (AbortSignal.timeout is unref'd and would let the process exit mid-call).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`no answer within ${o.timeoutMs} ms`, "TimeoutError")), o.timeoutMs);
  let res;
  try {
    res = await provider.complete({ model, messages, max_tokens: o.maxTokens, requestId, correlationId: `imd-job-${job}`.slice(0, 128), maxCostFlop: q.padded, signal: ac.signal });
  } catch (e) {
    const err = e as Error;
    const http = e instanceof FlopHTTPError ? e.status : null;
    const preSend = e instanceof PreSendError;
    const timedOut = http === null && !preSend; // abort, timeout or dropped connection: the gateway may have done paid work
    // Pre-mint failure minted nothing. `error` would show in status as a pending paid attempt.
    // `refused_local` with cap charge 0 is the line to write. Hashes are stripped so the secret scan
    // can store that line; otherwise the pre-call `sent` charge would stay in effect.
    let reason = timedOut ? `${err.name}: no answer; spend unknown, not retried` : preSend ? `nothing sent: ${err.message.replace(/0x[0-9a-fA-F]{64}/g, "[hash]")}` : `HTTP ${http}`;
    // A key-shaped provider message would make the secret scan refuse the release row and strand
    // the reservation. Withhold the message instead, so the refused_local (cap charge 0) line is written.
    const preSendWithheld = preSend && scanForSecrets({ reason }).length > 0;
    if (preSendWithheld) reason = "nothing sent: provider error withheld by the secret scan";
    // What run saw is a report, not a receipt read (settlement.ts decideFailure). It never replaces a
    // settlement another process booked meanwhile, and "nothing was sent" never releases a row a trusted
    // read produced: then the report is only recorded, and the exit code below still says what this call
    // saw. The message also says what the ledger kept.
    const { outcome, row } = bookFailure(h, requestId, timedOut ? "timeout_unknown" : preSend ? "refused_local" : "error", { reason, http }, sent);
    const kept = outcome === "recorded" ? keptByLedger(row) : null;
    const settled = kept !== null && SETTLES.has(row.state);
    const also = kept ? ` ${kept}` : "";
    if (timedOut) {
      throw new CliError(`no answer within ${o.timeoutMs} ms. ${settled ? "" : "Spend is UNKNOWN (recorded as null). "}Not retried.${also} Check later with \`imd-flop receipt ${requestId}\`.`, EXIT.TIMEOUT_UNKNOWN);
    }
    // The gate refusing at its pre-mint recheck is the same rule refusal as at the first check above.
    // Any other pre-send failure exits NOT_SENT, so it is told apart from a gateway error on the paid call below.
    if (preSend) throw new CliError(`${preSendWithheld ? reason : `nothing sent: ${err.message}`}${kept ? "." + also : ""}`, e instanceof PaidGateError ? EXIT.REFUSED_RULE : EXIT.NOT_SENT);
    throw new CliError(`gateway refused the call (HTTP ${http})${settled ? "" : "; spend recorded as unknown"}${kept ? "." + also : ""}`, EXIT.ERROR);
  } finally {
    clearTimeout(timer);
  }

  const responseFile = responsePath(h, requestId);
  const responseRecord = { request_id: requestId, job, seat, provider: provider.name, model, usage: res.usage ?? null, output_sha256: bytesToHex(sha256(utf8ToBytes(res.text))), text: res.text, mock: provider.name === "mock", note: "not submitted to IMD; the holder decides what to use" };
  // `run --json` prints this return value, so it has to be the text that was stored.
  let text: string | null = res.text;
  let withheld: string | undefined;
  let storedResponse: unknown = responseRecord;
  try {
    writeJsonSafe(responseFile, storedResponse, "response");
  } catch (e) {
    // Null only the flagged fields. The text is withheld only when the text itself was flagged.
    withheld = (e as Error).message;
    const redacted = redactFlagged(responseRecord);
    const copy = redacted.copy as typeof responseRecord & { text: string | null };
    if (copy.text === null) text = null;
    storedResponse = { ...copy, withheld };
    try {
      if (redacted.residual.length > 0) throw new Error("redaction left a finding");
      writeJsonSafe(responseFile, storedResponse, "response");
    } catch {
      // Fail safe: never lose the attempt. Keep the record, drop the gateway-supplied parts.
      text = null;
      withheld = "secret scan blocked writing response; text and usage withheld";
      storedResponse = { ...responseRecord, usage: null, text: null, withheld };
      writeJsonSafe(responseFile, storedResponse, "response");
    }
  }

  const rr = await provider.readReceipt(requestId);
  const classified = classifyReceipt(rr.receipt, { job, provider: provider.name, http: rr.http, error: rr.error, requestId, mock: provider.name === "mock" });
  // The receipt file goes through the same owner as receipt --refresh (receipt-store.ts storeRead): another
  // process may have refreshed this request and stored its read while the call ran, and a failed read here
  // keeps every gateway field that file holds.
  const ident = { seat, did: signer.identity.did, ss58: signer.identity.ss58, network: net.name, ...(provider.name === "mock" ? { mock_scenario: (provider as { scenario?: string }).scenario ?? "ok" } : {}) };
  const { saved, read } = storeRead(h, requestId, rr, classified, () => ident);
  // stdout shows what was stored: every field of the receipt as the file holds it, redacted fields included.
  const stored = saved as unknown as Record<string, unknown>;
  const receipt0 = { ...(Object.fromEntries(Object.keys(classified).map((k) => [k, stored[k] ?? null])) as unknown as Classified), seat, did: signer.identity.did };

  // The same booking step as receipt --refresh, with the rules held in settlement.ts: a failed read (not
  // HTTP 200 with a receipt object) or a receipt body that had to be redacted proves nothing and never
  // releases the reservation. If the step throws, the answer is in the response file written above.
  const own = { flag: classified.flag, cost_reported: reportedCost(res.usage?.cost_flop), http: rr.http };
  const { outcome, row, pastAdmitted } = bookRead(h, requestId, read, own, sent);
  if (outcome === "disagree") deps.warn(DISAGREE);
  if (pastAdmitted) deps.warn(PAST_ADMITTED);

  const receipt = { ...receipt0, ...(await receiptVerdicts(h, receipt0, row)) };
  return { request_id: requestId, job, provider: provider.name, payer, quote_padded: q.padded, cap_charge: row.cap_charge, receipt, response_file: responseFile, text, ...(withheld !== undefined ? { withheld } : {}), link_bypassed: linkBypassed };
}
