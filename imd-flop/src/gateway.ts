/**
 * Thin fetch client for the gateway calls @flop-labs/client does not cover
 * (estimate, ephemeral child keys, devnet enrollment), plus public reads
 * (genesis, Ethereum chain id, seat ownerOf, imd job check). Every request
 * carries our User-Agent: the gateway 403s default library UAs. Nothing here retries.
 * A paid run fails closed when the chain id or the pinned genesis cannot be confirmed.
 */
import { IMD_API, SEAT_CHAIN_ID, SEAT_COLLECTION, USER_AGENT, type NetworkInfo } from "./networks.js";

export type Fetch = typeof globalThis.fetch;

/** Failed before any inference was sent (for example the child-key mint), so no paid work can have started. */
export class PreSendError extends Error {
  override name = "PreSendError";
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
export async function mintChildKey(net: NetworkInfo, parentBearer: string, opts: { model: string; maxSpend: number }, f: Fetch): Promise<{ token: string; expires_at: number }> {
  // No inference is sent until a child key exists, so every failure here (transport, timeout,
  // unparsable body) is pre-send: it must not be booked as a paid attempt with unknown spend.
  let res: Response;
  try {
    res = await uaFetch(f)(`${net.gateway}/keys/ephemeral`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${parentBearer}` },
      body: JSON.stringify({ scope: { models: [opts.model], max_spend: opts.maxSpend }, uses: 1, new_session_expire_time: 60, expire_time: 300 }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new PreSendError(`child key mint failed (${(e as Error).name}: ${(e as Error).message})`);
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
  return (await res.json()) as { message: string; nonce: string; expires_at: number };
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
    errors.push(`faucet unavailable: ${(e as Error).message}`);
  }

  try {
    const raw = await rpcCall(net.rpc, "chain_getBlockHash", [0]);
    rpcGenesis = normalizeGenesis(raw);
    if (!rpcGenesis) errors.push("rpc genesis malformed");
  } catch (e) {
    errors.push(`rpc unavailable: ${(e as Error).message}`);
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
          finish(new Error(`rpc error: ${msg.error.message ?? "rpc error"}`));
          return;
        }
        finish(null, msg.result ?? null);
      } catch (e) {
        finish(e as Error);
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

const CHAIN_ID_RE = /^0x[0-9a-f]+$/i;

/**
 * eth_chainId on a caller-supplied Ethereum JSON-RPC URL (read only).
 * Throws when the endpoint is down or the payload is not a hex quantity.
 */
export async function readEthereumChainId(rpcUrl: string, f: Fetch = globalThis.fetch, timeoutMs = 15000): Promise<bigint> {
  let res: Response;
  try {
    res = await uaFetch(f)(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
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
  if (j.error) throw new Error(`eth_chainId error: ${j.error.message ?? "rpc error"}`);
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
 * Throws on a wrong chain, a reset, or any unavailable or malformed response.
 */
export async function assertPaidNetwork(net: NetworkInfo, ethRpc: string | undefined, f: Fetch = globalThis.fetch): Promise<void> {
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
  const data = "0x6352211e" + BigInt(tokenId).toString(16).padStart(64, "0");
  const res = await uaFetch(f)(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: collection, data }, "latest"] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error) return null;
  const r = j.result ?? "0x";
  if (r.length < 66) return null;
  const addr = "0x" + r.slice(-40);
  return /^0x0{40}$/.test(addr) ? null : addr;
}
