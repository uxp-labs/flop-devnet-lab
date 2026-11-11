/**
 * Thin fetch client for the gateway calls @flop-labs/client does not cover
 * (estimate, ephemeral child keys, devnet enrollment), plus public reads
 * (genesis, Ethereum chain id, seat ownerOf, imd job check). Every request
 * carries our User-Agent: the gateway 403s default library UAs. Nothing here retries.
 * A paid run fails closed when the chain id or the pinned genesis cannot be confirmed.
 */
import { IMD_API, SEAT_CHAIN_ID, SEAT_COLLECTION, USER_AGENT, type NetworkInfo } from "./networks.js";
import { outsideText, type Mark } from "./secrets.js";

export type Fetch = typeof globalThis.fetch;

/** Failed before any inference was sent (for example the child-key mint), so no paid work can have started. */
export class PreSendError extends Error {
  override name = "PreSendError";
}

/**
 * The paid-run gate refused: a wrong chain, a reset, or a source it could not read. The gate runs
 * before any quote, mint or send, so its refusal is a PreSendError wherever it is raised, and a rule
 * refusal (exit 5) at the pre-mint recheck exactly as at the first check.
 */
export class PaidGateError extends PreSendError {
  override name = "PaidGateError";
}

export function uaFetch(base: Fetch = globalThis.fetch): Fetch {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    return base(input, { ...init, headers });
  };
}

export interface Estimate {
  model?: string;
  estimated_input_tokens?: number;
  estimated_output_tokens?: number;
  estimated_cost_flop?: number;
}

export async function postEstimate(net: NetworkInfo, body: { model: string; prompt: string; max_tokens: number }, f: Fetch, timeoutMs = 15000): Promise<Estimate> {
  const res = await uaFetch(f)(`${net.gateway}/models/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`estimate HTTP ${res.status}`);
  return (await res.json()) as Estimate;
}

/** POST /keys/ephemeral: single-use child key capped at maxSpend. The token is returned to memory only. */
export async function mintChildKey(net: NetworkInfo, parentBearer: string, opts: { model: string; maxSpend: number }, f: Fetch, signal?: AbortSignal): Promise<{ token: string; expires_at: number }> {
  // No inference is sent until a child key exists, so every failure here (transport, timeout,
  // unparsable body) is pre-send: it must not be booked as a paid attempt with unknown spend.
  let res: Response;
  try {
    res = await uaFetch(f)(`${net.gateway}/keys/ephemeral`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${parentBearer}` },
      body: JSON.stringify({ scope: { models: [opts.model], max_spend: opts.maxSpend }, uses: 1, new_session_expire_time: 60, expire_time: 300 }),
      // Its own 15 s budget, and the caller's signal (run's timer) so an abort stops the mint too.
      signal: signal ? AbortSignal.any([AbortSignal.timeout(15000), signal]) : AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new PreSendError(`child key mint failed (${serverText((e as Error).name)}: ${serverText((e as Error).message)})`);
  }
  if (res.status !== 201) throw new PreSendError(`child key mint HTTP ${res.status}`);
  let j: { token: string; expires_at: number };
  try {
    j = (await res.json()) as { token: string; expires_at: number };
  } catch {
    throw new PreSendError("child key mint returned an unparsable body");
  }
  if (typeof j?.token !== "string" || !/^flop_ek_/.test(j.token)) throw new PreSendError("child key mint returned an unexpected token shape");
  return j;
}

export function enrollChallengeUrl(net: NetworkInfo, ss58: string): string {
  return `${net.gateway}/enroll/wallet/challenge?address=${encodeURIComponent(ss58)}`;
}

export async function getEnrollChallenge(net: NetworkInfo, ss58: string, f: Fetch): Promise<{ message: string; nonce: string; expires_at: number }> {
  const res = await uaFetch(f)(enrollChallengeUrl(net, ss58), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`enroll challenge HTTP ${res.status}`);
  // The parse error of a body that is not JSON quotes the body: never repeat it (review defect 5).
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    throw new Error("the enroll challenge was not JSON");
  }
  const c = j as { message?: unknown; nonce?: unknown; expires_at?: unknown } | null;
  if (!c || typeof c !== "object" || typeof c.message !== "string") throw new Error("the enroll challenge has no message");
  return c as { message: string; nonce: string; expires_at: number };
}

export async function postEnroll(net: NetworkInfo, body: { address: string; message: string; signature: string }, f: Fetch): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await uaFetch(f)(`${net.gateway}/enroll/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

const GENESIS_RE = /^0x[0-9a-f]{64}$/;

/** Full 32-byte 0x-hash. A shorter prefix is not a genesis. */
export function normalizeGenesis(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return GENESIS_RE.test(s) ? s : null;
}

/**
 * Docs: "compare live RPC and faucet genesis before use" (devnet can reset).
 * ok is true only when the pinned hash, the faucet's /chain hash, and RPC block 0
 * are the same full hash. Faucet and RPC agreeing on a different hash is a reset
 * and is not ok. HTTP errors, malformed JSON, and missing hashes are not ok.
 * There is no single-source fallback.
 */
export async function checkGenesis(net: NetworkInfo, f: Fetch = globalThis.fetch): Promise<{ ok: boolean; pinnedGenesis: string; faucetGenesis: string | null; rpcGenesis: string | null; error?: string }> {
  const pinnedGenesis = net.genesisHash.trim().toLowerCase();
  let faucetGenesis: string | null = null;
  let rpcGenesis: string | null = null;
  const errors: string[] = [];
  if (!GENESIS_RE.test(pinnedGenesis)) errors.push("pinned genesis is malformed");

  try {
    const res = await uaFetch(f)(`${net.faucet}/chain`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      errors.push(`faucet HTTP ${res.status}`);
    } else {
      try {
        const body = (await res.json()) as { genesisHash?: unknown };
        faucetGenesis = body && typeof body === "object" ? normalizeGenesis(body.genesisHash) : null;
        if (!faucetGenesis) errors.push("faucet genesis malformed");
      } catch {
        errors.push("faucet returned malformed JSON");
      }
    }
  } catch (e) {
    errors.push(`faucet unavailable: ${serverText((e as Error).message)}`);
  }

  try {
    const raw = await rpcCall(net.rpc, "chain_getBlockHash", [0]);
    rpcGenesis = normalizeGenesis(raw);
    if (!rpcGenesis) errors.push("rpc genesis malformed");
  } catch (e) {
    errors.push(`rpc unavailable: ${serverText((e as Error).message)}`);
  }

  const ok = errors.length === 0 && faucetGenesis === pinnedGenesis && rpcGenesis === pinnedGenesis;
  let error: string | undefined;
  if (!ok) {
    if (errors.length > 0) error = errors.join("; ");
    else if (faucetGenesis && faucetGenesis === rpcGenesis) error = "faucet and rpc agree on a different genesis than the pinned hash";
    else error = "genesis mismatch";
  }
  return { ok, pinnedGenesis, faucetGenesis, rpcGenesis, ...(error ? { error } : {}) };
}

function rpcCall(url: string, method: string, params: unknown[], timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(result);
    };
    timer = setTimeout(() => finish(new Error("rpc timeout")), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { result?: unknown; error?: { message?: string } };
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
          finish(new Error("rpc returned malformed JSON"));
          return;
        }
        // An error field is a failed read even when a result is also present.
        if (msg.error) {
          finish(new Error(`rpc error: ${serverText(msg.error.message ?? "rpc error")}`));
          return;
        }
        finish(null, msg.result ?? null);
      } catch {
        // JSON.parse's own message quotes the frame: never repeat it.
        finish(new Error("rpc returned malformed JSON"));
      }
    };
    ws.onerror = () => {
      finish(new Error("rpc websocket error"));
    };
  });
}

/** Rule 4 (real work only), optional live check: the job must exist on imd's public API. */
export async function checkImdJob(jobId: string, f: Fetch = globalThis.fetch): Promise<{ ok: boolean; status: number }> {
  const res = await uaFetch(f)(`${IMD_API}/jobs/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  return { ok: res.ok, status: res.status };
}

/** The most characters of one server text a message quotes. */
const SERVER_TEXT_MAX = 200;

/**
 * Server text (an error message a server or the transport wrote) for a message: through secrets.ts
 * outsideText, cut to SERVER_TEXT_MAX, with every form of the given marks replaced. Every message here that
 * quotes server text quotes it through this (swarm audit 33f3b9f, finding 3).
 */
function serverText(text: unknown, marks: Mark[] = []): string {
  return outsideText(text, { marks, max: SERVER_TEXT_MAX });
}

const CHAIN_ID_RE = /^0x[0-9a-f]+$/i;
/** Stands in for the caller's Ethereum RPC URL wherever a message would have repeated it. */
const ETH_RPC_URL_MARK = "[ETH_RPC_URL]";

/**
 * Every form the Ethereum RPC URL can be echoed in, each replaced by ETH_RPC_URL_MARK in other text (defense in
 * depth: the RPC server's own text is never quoted, see rpcFailure): the string as given, the parsed href, the
 * origin with the path, the userinfo (and its user and password alone), the path alone, and the query, and
 * their decoded forms. secrets.ts outsideText drops a form shorter than 8 characters.
 */
function rpcUrlMark(rpcUrl: string, url: URL): Mark {
  const userinfo = url.password ? `${url.username}:${url.password}` : url.username;
  const forms = [rpcUrl, url.href, url.origin + url.pathname, userinfo, url.username, url.password, url.pathname, url.search];
  const decoded = forms.flatMap((f) => { try { const d = decodeURIComponent(f); return d === f ? [] : [d]; } catch { return []; } });
  return { forms: [...forms, ...decoded], mark: ETH_RPC_URL_MARK };
}

/** The mark for a caller's Ethereum RPC URL, for text that might repeat it. Null when it is not a URL. */
export function ethRpcUrlMark(rpcUrl: string | undefined): Mark | null {
  if (!rpcUrl) return null;
  try {
    return rpcUrlMark(rpcUrl, new URL(rpcUrl));
  } catch {
    return { forms: [rpcUrl], mark: ETH_RPC_URL_MARK };
  }
}

/** The transport error names a message may give, a closed list. Any other name is reported as "Error". */
const TRANSPORT_KINDS: ReadonlySet<string> = new Set(["TypeError", "AbortError", "TimeoutError", "SyntaxError", "RangeError"]);

/**
 * A failure of the Ethereum RPC, as a message: a kind and numbers only. The server's text, its body and the
 * transport's message are never quoted, in any sink (review of the audit 33f3b9f fixes, defects 2 and 3).
 */
const rpcFailure = {
  transport: (e: unknown): string => {
    const name = (e as { name?: unknown })?.name;
    return `transport error (${typeof name === "string" && TRANSPORT_KINDS.has(name) ? name : "Error"})`;
  },
  rpcError: (error: unknown): string => {
    const code = (error as { code?: unknown } | null)?.code;
    return Number.isSafeInteger(code) ? `JSON-RPC error code ${code}` : "JSON-RPC error with no code";
  },
};

/** The Ethereum RPC URL as parsed for a call: what to fetch, and the mark for every message about it. */
interface EthRpc { url: string }

/** Parsed before any fetch, because fetch's own parse error repeats the whole URL. */
function ethRpc(rpcUrl: string): EthRpc {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error("the Ethereum RPC URL is not a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the Ethereum RPC URL is not a valid http(s) URL");
  return { url: rpcUrl };
}

/**
 * One read-only POST to the caller's Ethereum JSON-RPC URL: the single place that URL is used.
 * The URL often carries a key (userinfo or a path token), so no message from here quotes it, and no message
 * quotes what the server or the transport said either (rpcFailure).
 */
async function postEthRpc(rpc: EthRpc, call: { method: string; params: unknown[] }, f: Fetch, timeoutMs: number): Promise<Response> {
  try {
    return await uaFetch(f)(rpc.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(rpcFailure.transport(e));
  }
}

/**
 * eth_chainId on a caller-supplied Ethereum JSON-RPC URL (read only).
 * Throws when the endpoint is down or the payload is not a hex quantity.
 */
export async function readEthereumChainId(rpcUrl: string, f: Fetch = globalThis.fetch, timeoutMs = 15000): Promise<bigint> {
  let res: Response;
  try {
    const rpc = ethRpc(rpcUrl);
    res = await postEthRpc(rpc, { method: "eth_chainId", params: [] }, f, timeoutMs);
  } catch (e) {
    throw new Error(`eth_chainId unavailable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`eth_chainId HTTP ${res.status}`);
  let j: { result?: unknown; error?: { message?: string } };
  try {
    j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new Error("eth_chainId returned malformed JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("eth_chainId returned malformed JSON");
  if (j.error) throw new Error(`eth_chainId error: ${rpcFailure.rpcError(j.error)}`);
  if (typeof j.result !== "string" || !CHAIN_ID_RE.test(j.result.trim())) throw new Error("eth_chainId returned a malformed result");
  try {
    return BigInt(j.result.trim());
  } catch {
    throw new Error("eth_chainId returned a malformed result");
  }
}

/**
 * Chain id, then ownerOf. ownerOf is not called unless eth_chainId is SEAT_CHAIN_ID.
 * Throws on the wrong chain and on unavailable or malformed chain-id responses.
 */
export async function readVerifiedSeatOwner(rpcUrl: string, collection: string, tokenId: string, f: Fetch = globalThis.fetch, timeoutMs = 15000): Promise<string | null> {
  const chainId = await readEthereumChainId(rpcUrl, f, timeoutMs);
  if (chainId !== BigInt(SEAT_CHAIN_ID)) {
    throw new Error(`Ethereum chain id ${chainId} is not ${SEAT_CHAIN_ID} (seat collection ${collection} is on chain ${SEAT_CHAIN_ID})`);
  }
  return readSeatOwner(rpcUrl, collection, tokenId, f, timeoutMs);
}

/**
 * Preconditions for a paid FLOP call: Ethereum chain id of the seat collection,
 * and live faucet + RPC genesis both equal to the pinned devnet hash.
 * Throws PaidGateError on a wrong chain, a reset, or any unavailable or malformed response.
 */
export async function assertPaidNetwork(net: NetworkInfo, ethRpc: string | undefined, f: Fetch = globalThis.fetch): Promise<void> {
  try {
    await checkPaidNetwork(net, ethRpc, f);
  } catch (e) {
    throw new PaidGateError((e as Error).message);
  }
}

async function checkPaidNetwork(net: NetworkInfo, ethRpc: string | undefined, f: Fetch): Promise<void> {
  if (!ethRpc || ethRpc.trim() === "") {
    throw new Error(`paid FLOP calls need ETH_RPC_URL (an Ethereum JSON-RPC URL whose eth_chainId is ${SEAT_CHAIN_ID})`);
  }
  const chainId = await readEthereumChainId(ethRpc, f);
  if (chainId !== BigInt(SEAT_CHAIN_ID)) {
    throw new Error(`Ethereum chain id ${chainId} is not ${SEAT_CHAIN_ID} (seat collection ${SEAT_COLLECTION} is on chain ${SEAT_CHAIN_ID})`);
  }
  const g = await checkGenesis(net, f);
  if (!g.ok) {
    throw new Error(
      `FLOP genesis check failed: pinned ${g.pinnedGenesis} vs faucet ${g.faucetGenesis ?? "?"} vs rpc ${g.rpcGenesis ?? "?"}${g.error ? ` (${g.error})` : ""}. Devnet may have reset.`,
    );
  }
}

/**
 * ownerOf(tokenId) on the imd seat collection via a caller-supplied Ethereum JSON-RPC URL (read only, eth_call).
 * Returns null when the call reverts (nonexistent or burned token). Throws on transport errors so the caller fails closed.
 * Callers that trust the result use readVerifiedSeatOwner, which requires eth_chainId first.
 */
export async function readSeatOwner(rpcUrl: string, collection: string, tokenId: string, f: Fetch = globalThis.fetch, timeoutMs = 15000): Promise<string | null> {
  const rpc = ethRpc(rpcUrl);
  const data = "0x6352211e" + BigInt(tokenId).toString(16).padStart(64, "0");
  let res: Response;
  try {
    res = await postEthRpc(rpc, { method: "eth_call", params: [{ to: collection, data }, "latest"] }, f, timeoutMs);
  } catch (e) {
    throw new Error(`eth_call unavailable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
  // The parse error of a body that is not JSON quotes the body: never repeat it.
  let j: { result?: string; error?: { message?: string } };
  try {
    j = (await res.json()) as { result?: string; error?: { message?: string } };
  } catch {
    throw new Error("eth_call returned malformed JSON");
  }
  // The eth_call error text is never quoted: an error is a revert, read as no owner.
  if (j.error) return null;
  const r = j.result ?? "0x";
  if (r.length < 66) return null;
  const addr = "0x" + r.slice(-40);
  return /^0x0{40}$/.test(addr) ? null : addr;
}
