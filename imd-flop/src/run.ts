import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CliError, EXIT } from "./errors.js";
import { loadConfig } from "./config.js";
import { linkFile, responsesDir } from "./paths.js";
import { redactFlagged, scanForSecrets } from "./secrets.js";
import { readJson, writeJsonSafe } from "./store.js";
import { loadSigner, readIdentity, revokedDids } from "./keys.js";
import { verifyLink, type LinkFile } from "./link.js";
import { DEFAULT_MODEL, network, SEAT_COLLECTION } from "./networks.js";
import { checkBudget, padQuote, requireCap, validateJob, validatePayer, validateRunMaxTokens } from "./policy.js";
import { appendLedger, jobSpent, LedgerLockError, spentToday, UnusableLedgerCharge, utcDay, withLedgerLock, type LedgerEntry } from "./ledger.js";
import { classifyReceipt, type Classified } from "./receipts.js";
import { holdCharge, isFreshRead, nextBooking, receiptIdentity } from "./settlement.js";
import { receiptPath, writeReceipt } from "./receipt-store.js";
import type { Provider } from "./providers.js";
import { assertPaidNetwork, checkImdJob, PaidGateError, PreSendError, readVerifiedSeatOwner, type Fetch } from "./gateway.js";
import { FlopHTTPError } from "@flop-labs/client";
import { matchReceipt } from "./match.js";
import { latestAttempts } from "./ledger.js";
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
  receipt: Classified & { seat: string; did: string; match: MatchResult };
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

export async function runJob(h: string, provider: Provider, o: RunOpts, deps: { fetch?: Fetch; ethRpc?: string } = {}): Promise<RunResult> {
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
  const base: Omit<LedgerEntry, "state" | "reason" | "request_id" | "spend" | "cost_reported" | "cap_charge" | "http" | "quote_raw" | "quote_padded" | "spent_before"> = {
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
  const refuse = (reason: string, code: number, q: { raw: number | null; padded: number | null }, spentBefore: number | null): never => {
    appendLedger(h, { ...base, request_id: null, quote_raw: q.raw, quote_padded: q.padded, spent_before: spentBefore, state: "refused_local", reason, spend: null, cost_reported: null, cap_charge: 0, http: null });
    throw new CliError(`refused locally, nothing sent: ${reason}`, code);
  };

  // Quote first; fail closed.
  let q: { raw: number; padded: number } | null = null;
  try {
    q = padQuote(await provider.estimate({ model, prompt: estPrompt, max_tokens: o.maxTokens }));
  } catch (e) {
    refuse(`estimate failed (${(e as Error).message})`, EXIT.ESTIMATE_FAILED, { raw: null, padded: null }, null);
  }
  if (!q) return refuse("estimate returned no usable cost", EXIT.ESTIMATE_FAILED, { raw: null, padded: null }, null);

  const requestId = `${provider.name === "mock" ? "mock" : "imdflop"}-${seat}-${bytesToHex(randomBytes(8))}`;
  const lockedCheck = (): LedgerEntry => {
    // The UTC day is read once, inside the lock, and used for both the cap check and the rows.
    const day = utcDay();
    let spentBefore: number;
    try {
      spentBefore = payer === "holder" ? spentToday(h, seat, provider.name, day) : jobSpent(h, job, provider.name);
    } catch (e) {
      if (e instanceof UnusableLedgerCharge) refuse(e.message, EXIT.REFUSED_CAP, q, null);
      throw e;
    }
    const refusal = checkBudget({ padded: q.padded, cap, payer, spentBefore, jobBudget: o.jobBudget });
    if (refusal) refuse(refusal.reason, refusal.code, q, spentBefore);
    const row: LedgerEntry = { ...base, day, request_id: requestId, quote_raw: q.raw, quote_padded: q.padded, spent_before: spentBefore, state: "sent", reason: null, spend: null, cost_reported: null, cap_charge: q.padded, http: null };
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
    // `refused_local` with cap charge 0 is the latest line. Hashes are stripped so the secret scan
    // can store that line; otherwise the pre-call `sent` charge would stay in effect.
    let reason = timedOut ? `${err.name}: no answer; spend unknown, not retried` : preSend ? `nothing sent: ${err.message.replace(/0x[0-9a-fA-F]{64}/g, "[hash]")}` : `HTTP ${http}`;
    // A key-shaped provider message would make the secret scan refuse the release row and strand
    // the reservation. Withhold the message instead, so the refused_local (cap charge 0) line is written.
    const preSendWithheld = preSend && scanForSecrets({ reason }).length > 0;
    if (preSendWithheld) reason = "nothing sent: provider error withheld by the secret scan";
    appendLedger(h, { ...sent, ts: new Date().toISOString(), state: timedOut ? "timeout_unknown" : preSend ? "refused_local" : "error", reason, spend: null, cap_charge: preSend ? 0 : sent.cap_charge, http });
    if (timedOut) {
      throw new CliError(`no answer within ${o.timeoutMs} ms. Spend is UNKNOWN (recorded as null). Not retried. Check later with \`imd-flop receipt ${requestId}\`.`, EXIT.TIMEOUT_UNKNOWN);
    }
    // The gate refusing at its pre-mint recheck is the same rule refusal as at the first check above.
    if (preSend) throw new CliError(preSendWithheld ? reason : `nothing sent: ${err.message}`, e instanceof PaidGateError ? EXIT.REFUSED_RULE : EXIT.ERROR);
    throw new CliError(`gateway refused the call (HTTP ${http}); spend recorded as unknown`, EXIT.ERROR);
  } finally {
    clearTimeout(timer);
  }

  const responseFile = join(responsesDir(h), `${requestId}.json`);
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
  const { rawId, identityOk } = receiptIdentity(rr.receipt, requestId);
  if (!identityOk) {
    classified.settled = null;
    classified.chain_final = false;
    classified.request_id = typeof rawId === "string" ? rawId : "";
  }
  const receipt0 = { ...classified, seat, did: signer.identity.did };
  const stored = writeReceipt(receiptPath(h, requestId), { ...classified, seat, did: signer.identity.did, ss58: signer.identity.ss58, network: net.name, ...(provider.name === "mock" ? { mock_scenario: (provider as { scenario?: string }).scenario ?? "ok" } : {}) });
  const receiptRedacted = stored.redacted;
  if (receiptRedacted) {
    // stdout shows what was stored: every redacted field, not only error and settled_raw.
    const cleaned = stored.body as Record<string, unknown>;
    const r0 = receipt0 as unknown as Record<string, unknown>;
    for (const k of Object.keys(r0)) if (k in cleaned) r0[k] = cleaned[k] ?? null;
  }

  const usage = res.usage;
  const costReported = typeof usage?.cost_flop === "number" && Number.isFinite(usage.cost_flop) ? usage.cost_flop : null;
  // Same freshness rule as receipt --refresh: a failed read (not HTTP 200 with a receipt object) proves nothing
  // and never releases the reservation. A receipt body that had to be redacted never proves a settlement.
  const outcome = { fresh: isFreshRead(rr), identityOk: identityOk && !receiptRedacted, state: classified.state, settled: classified.settled };
  const booking = nextBooking({ state: sent.state, spend: sent.spend }, outcome, holdCharge(q.padded, costReported));
  appendLedger(h, { ...sent, ts: new Date().toISOString(), ...booking, reason: classified.flag, cost_reported: costReported, http: rr.http });

  const match = await matchReceipt(h, receipt0, latestAttempts(h).find((e) => e.request_id === requestId) ?? null);
  const receipt = { ...receipt0, match };
  return { request_id: requestId, job, provider: provider.name, payer, quote_padded: q.padded, cap_charge: booking.cap_charge, receipt, response_file: responseFile, text, ...(withheld !== undefined ? { withheld } : {}), link_bypassed: linkBypassed };
}
