import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CliError, EXIT } from "./errors.js";
import { loadConfig } from "./config.js";
import { linkFile, receiptsDir, responsesDir } from "./paths.js";
import { redactFlagged, scanForSecrets } from "./secrets.js";
import { readJson, writeJsonSafe } from "./store.js";
import { loadSigner, readIdentity, revokedDids } from "./keys.js";
import { verifyLink, type LinkFile } from "./link.js";
import { DEFAULT_MODEL, network, SEAT_COLLECTION } from "./networks.js";
import { appendLedger, jobSpent, LedgerLockError, spentToday, UnusableLedgerCharge, utcDay, withLedgerLock, type LedgerEntry } from "./ledger.js";
import { classifyReceipt, knownSettledSpend, type Classified } from "./receipts.js";
import type { Provider } from "./providers.js";
import { assertPaidNetwork, checkImdJob, PreSendError, readVerifiedSeatOwner, type Fetch } from "./gateway.js";
import { FlopHTTPError } from "@flop-labs/client";
import { matchReceipt } from "./match.js";
import { latestAttempts } from "./ledger.js";
import type { MatchResult } from "./receipts.js";

export const TEMPLATE_PAD = 20; // measured: Qwen chat wrap 23 tokens vs 3 raw for "Be brief.\nHi"

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

  // Rule 4: real work only.
  const job = (o.job ?? "").trim();
  if (!job) throw new CliError("--job <imd job id> is required: FLOP calls only serve real IMD jobs (rule 4)", EXIT.REFUSED_RULE);
  if (!/^[\x21-\x7e]{1,120}$/.test(job)) throw new CliError("--job must be 1-120 printable characters", EXIT.USAGE);
  // Every ledger row carries the job id, so a key-shaped id could never be recorded. Refuse it up front.
  if (scanForSecrets({ job }).length > 0) throw new CliError("--job looks key-shaped (for example 64+ hex characters) and cannot be written to the ledger; use a different job id", EXIT.USAGE);

  const prompt = o.promptFile ? readFileSync(o.promptFile, "utf8") : o.prompt;
  if (!prompt || prompt.trim().length === 0) throw new CliError("--prompt or --prompt-file is required", EXIT.USAGE);
  if (!Number.isInteger(o.maxTokens) || o.maxTokens < 1 || o.maxTokens > 8192) throw new CliError("--max-tokens must be 1..8192", EXIT.USAGE);

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

  // Required cap. A cap object without finite positive numbers (perCall <= daily) is no cap: fail closed.
  const cap = cfg.caps[seat];
  if (!cap) throw new CliError(`no daily cap for seat ${seat}: FLOP stays off. Set one with \`imd-flop cap set <FLOP/day>\``, EXIT.REFUSED_CAP);
  const posFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!posFinite(cap.daily) || !posFinite(cap.perCall) || cap.perCall > cap.daily) {
    throw new CliError(`cap for seat ${seat} is malformed (daily and perCall must be positive numbers, perCall <= daily): FLOP stays off. Set it again with \`imd-flop cap set <FLOP/day>\``, EXIT.REFUSED_CAP);
  }

  // Only "holder" (daily cap) and "requester" (job budget) have a spend limit. Anything else in
  // config.json (a hand edit, another writer) would skip both checks: fail closed, nothing sent.
  if (cfg.payer !== "holder" && cfg.payer !== "requester") {
    throw new CliError(`payer ${JSON.stringify(cfg.payer)} in config.json is not "holder" or "requester": no cap or budget applies, FLOP stays off. Set it with \`imd-flop config set payer holder|requester\``, EXIT.REFUSED_CAP);
  }
  if (cfg.payer === "requester" && !(typeof o.jobBudget === "number" && o.jobBudget > 0)) {
    throw new CliError("payer is requester: pass --job-budget <FLOP> (the requester's budget for this job)", EXIT.REFUSED_CAP);
  }

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
    payer: cfg.payer,
    model,
    max_tokens: o.maxTokens,
    prompt_sha256: bytesToHex(sha256(utf8ToBytes(estPrompt))),
    per_call_cap: cap.perCall,
    daily_cap: cap.daily,
    job_budget: cfg.payer === "requester" ? o.jobBudget! : null,
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
      spentBefore = cfg.payer === "holder" ? spentToday(h, seat, provider.name, day) : jobSpent(h, job, provider.name);
    } catch (e) {
      if (e instanceof UnusableLedgerCharge) refuse(e.message, EXIT.REFUSED_CAP, q, null);
      throw e;
    }
    if (q.padded > cap.perCall) refuse(`padded quote ${q.padded} FLOP is over the per-call cap ${cap.perCall}`, EXIT.REFUSED_CAP, q, spentBefore);
    if (cfg.payer === "holder") {
      const left = Math.round((cap.daily - spentBefore) * 1e6) / 1e6;
      if (left <= 0) refuse(`daily cap reached (${spentBefore}/${cap.daily} FLOP today, UTC)`, EXIT.REFUSED_CAP, q, spentBefore);
      if (q.padded > left) refuse(`padded quote ${q.padded} FLOP is over the remaining daily cap ${left}`, EXIT.REFUSED_CAP, q, spentBefore);
    } else {
      // Only "requester" reaches here (checked above). A non-finite budget left would skip the cap, so refuse it.
      const left = Math.round((o.jobBudget! - spentBefore) * 1e6) / 1e6;
      if (cfg.payer !== "requester" || !Number.isFinite(left)) refuse(`no usable requester budget for payer ${JSON.stringify(cfg.payer)}`, EXIT.REFUSED_CAP, q, spentBefore);
      if (q.padded > left) refuse(`padded quote ${q.padded} FLOP is over this job's remaining requester budget ${left}`, EXIT.REFUSED_CAP, q, spentBefore);
    }
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
    const reason = timedOut ? `${err.name}: no answer; spend unknown, not retried` : preSend ? `nothing sent: ${err.message.replace(/0x[0-9a-fA-F]{64}/g, "[hash]")}` : `HTTP ${http}`;
    appendLedger(h, { ...sent, ts: new Date().toISOString(), state: timedOut ? "timeout_unknown" : preSend ? "refused_local" : "error", reason, spend: null, cap_charge: preSend ? 0 : sent.cap_charge, http });
    if (timedOut) {
      throw new CliError(`no answer within ${o.timeoutMs} ms. Spend is UNKNOWN (recorded as null). Not retried. Check later with \`imd-flop receipt ${requestId}\`.`, EXIT.TIMEOUT_UNKNOWN);
    }
    if (preSend) throw new CliError(`nothing sent: ${err.message}`, EXIT.ERROR);
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
  const rawId = rr.receipt ? (rr.receipt as { request_id?: unknown }).request_id : undefined;
  const identityOk = typeof rawId === "string" && rawId.length > 0 && rawId === requestId;
  if (!identityOk) {
    classified.settled = null;
    classified.chain_final = false;
    classified.request_id = typeof rawId === "string" ? rawId : "";
  }
  const receipt0 = { ...classified, seat, did: signer.identity.did };
  let receiptBody: unknown = { ...classified, seat, did: signer.identity.did, ss58: signer.identity.ss58, network: net.name, ...(provider.name === "mock" ? { mock_scenario: (provider as { scenario?: string }).scenario ?? "ok" } : {}) };
  let receiptRedacted = false;
  try {
    writeJsonSafe(join(receiptsDir(h), `${requestId}.json`), receiptBody, "receipt");
  } catch {
    receiptRedacted = true;
    const redacted = redactFlagged(receiptBody);
    receiptBody = redacted.copy;
    writeJsonSafe(join(receiptsDir(h), `${requestId}.json`), receiptBody, "receipt");
    // stdout shows what was stored: every redacted field, not only error and settled_raw.
    const cleaned = receiptBody as Record<string, unknown>;
    const r0 = receipt0 as unknown as Record<string, unknown>;
    for (const k of Object.keys(r0)) if (k in cleaned) r0[k] = cleaned[k] ?? null;
  }

  const usage = res.usage;
  const costReported = typeof usage?.cost_flop === "number" && Number.isFinite(usage.cost_flop) ? usage.cost_flop : null;
  // A known settlement is a finite amount >= 0, including explicit 0, and only
  // once the receipt state is settled or released. Otherwise the pre-call
  // reservation stays. Reported usage may raise that reservation, not lower it.
  const unresolvedCharge = costReported !== null ? Math.max(q.padded, costReported) : q.padded;
  const stateSettles = classified.state === "settled" || classified.state === "released";
  const settledKnown = !receiptRedacted && identityOk && stateSettles ? knownSettledSpend(classified.settled) : null;
  const chosen = settledKnown ?? unresolvedCharge;
  const capCharge = Number.isFinite(chosen) ? chosen : q.padded;
  appendLedger(h, { ...sent, ts: new Date().toISOString(), state: classified.state ?? "sent", reason: classified.flag, spend: settledKnown, cost_reported: costReported, cap_charge: capCharge, http: rr.http });

  const match = await matchReceipt(h, receipt0, latestAttempts(h).find((e) => e.request_id === requestId) ?? null);
  const receipt = { ...receipt0, match };
  return { request_id: requestId, job, provider: provider.name, payer: cfg.payer, quote_padded: q.padded, cap_charge: capCharge, receipt, response_file: responseFile, text, ...(withheld !== undefined ? { withheld } : {}), link_bypassed: linkBypassed };
}
