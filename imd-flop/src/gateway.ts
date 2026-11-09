/**
 * Thin fetch client for the gateway calls @flop-labs/client does not cover
 * (estimate, ephemeral child keys, devnet enrollment), plus the public reads
 * behind opt-in flags (genesis check, imd job check). Every request carries our
 * User-Agent: the gateway 403s default library UAs. Nothing here retries.
 */
import { IMD_API, USER_AGENT, type NetworkInfo } from "./networks.js";

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
  const res = await uaFetch(f)(`${net.gateway}/keys/ephemeral`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${parentBearer}` },
    body: JSON.stringify({ scope: { models: [opts.model], max_spend: opts.maxSpend }, uses: 1, new_session_expire_time: 60, expire_time: 300 }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 201) throw new PreSendError(`child key mint HTTP ${res.status}`);
  const j = (await res.json()) as { token: string; expires_at: number };
  if (!/^flop_ek_/.test(j.token)) throw new PreSendError("child key mint returned an unexpected token shape");
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

/** Docs: "compare live RPC and faucet genesis before use" (devnet can reset). */
export async function checkGenesis(net: NetworkInfo, f: Fetch = globalThis.fetch): Promise<{ ok: boolean; faucetGenesis: string | null; rpcGenesis: string | null; error?: string }> {
  let faucetGenesis: string | null = null;
  let rpcGenesis: string | null = null;
  try {
    const res = await uaFetch(f)(`${net.faucet}/chain`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    faucetGenesis = ((await res.json()) as { genesisHash?: string }).genesisHash?.toLowerCase() ?? null;
    rpcGenesis = (await rpcCall(net.rpc, "chain_getBlockHash", [0]))?.toLowerCase() ?? null;
  } catch (e) {
    return { ok: false, faucetGenesis, rpcGenesis, error: (e as Error).message };
  }
  return { ok: !!faucetGenesis && faucetGenesis === rpcGenesis, faucetGenesis, rpcGenesis };
}

function rpcCall(url: string, method: string, params: unknown[], timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("rpc timeout"));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }));
    ws.onmessage = (ev) => {
      clearTimeout(t);
      ws.close();
      try {
        resolve((JSON.parse(String(ev.data)) as { result?: string }).result ?? null);
      } catch (e) {
        reject(e as Error);
      }
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("rpc websocket error"));
    };
  });
}

/** Rule 4 (real work only), optional live check: the job must exist on imd's public API. */
export async function checkImdJob(jobId: string, f: Fetch = globalThis.fetch): Promise<{ ok: boolean; status: number }> {
  const res = await uaFetch(f)(`${IMD_API}/jobs/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  return { ok: res.ok, status: res.status };
}
