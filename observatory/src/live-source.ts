// LiveSource: the Source the status reads, over a Transport (src/transport.ts). Its trust is the
// transport's: "trusted RPC" over the network, "fixture" over a tape.
//
// It reads once, in a fixed order, one request at a time, so a tape of the reading has one order
// and replays exactly: the faucet's /health and /chain, the gateway's model list, the clock (the
// head's observed_at), then the head (src/rpc-head.ts says which calls). Every Source method
// answers from that one reading.
//
// This step reads network status only. It reads no event pages and no runtime constants: event
// pages are none and their errors none, as for a scenario with no event-pages folder, so a census
// over them is partial over its whole range and every escrow unverified, never "no events"
// (RULES.md sections 2 and 3). Runtime constants are null, as for a scenario without them.
import { type Answer, finalizedHashOf, headFrom } from "./rpc-head.js";
import type { Source } from "./source.js";
import { type Transport, TransportError } from "./transport.js";
import type { AnchorReading, EventPage, FaucetChainBody, FaucetHealthBody, HttpResult, RpcHead, RuntimeConstants, Trust } from "./types.js";

/** What a live reading GETs. Each host is on the allow list in src/net.ts. */
export const LIVE_URLS = {
  faucetHealth: "https://faucet.flop.network/health",
  faucetChain: "https://faucet.flop.network/chain",
  gatewayModels: "https://api.flop.network/v1/models",
} as const;

export interface LiveReading {
  faucetHealth: HttpResult<unknown>;
  faucetChain: HttpResult<unknown>;
  gatewayModels: HttpResult<unknown>;
  rpcHead: RpcHead;
}

export class LiveSource implements Source {
  readonly kind = "rpc" as const;
  readonly trust: Trust;
  readonly label: string;
  private readonly transport: Transport;
  private reading: Promise<LiveReading> | null = null;

  constructor(transport: Transport) {
    this.transport = transport;
    this.trust = transport.trust;
    this.label = `live:${transport.label}`;
  }

  /** The one reading, made on the first call and shared by every later one. */
  read(): Promise<LiveReading> {
    this.reading ??= this.readAll();
    return this.reading;
  }

  private async readAll(): Promise<LiveReading> {
    const faucetHealth = await this.transport.httpGet(LIVE_URLS.faucetHealth);
    const faucetChain = await this.transport.httpGet(LIVE_URLS.faucetChain);
    const gatewayModels = await this.transport.httpGet(LIVE_URLS.gatewayModels);
    const rpcHead = await this.readHead();
    return { faucetHealth, faucetChain, gatewayModels, rpcHead };
  }

  /** One call. A failure on the way is an answer; anything else (a refusal, a bad tape) stops the run. */
  private async call(method: string, params: readonly unknown[]): Promise<Answer> {
    try {
      return { result: await this.transport.rpc(method, params) };
    } catch (e) {
      if (e instanceof TransportError) return { error: e.message };
      throw e;
    }
  }

  private async readHead(): Promise<RpcHead> {
    // Taken before the first call, so the head is never shown as fresher than it is.
    const observedAt = this.transport.now();
    // Read for the record only: RpcHead has no field for the chain's name, and no rule reads it.
    // The tape keeps the answer.
    await this.call("system_chain", []);
    const genesis = await this.call("chain_getBlockHash", [0]);
    const finalizedHead = await this.call("chain_getFinalizedHead", []);
    const at = finalizedHashOf(finalizedHead);
    const finalizedHeader = at === null ? null : await this.call("chain_getHeader", [at]);
    const bestHeader = await this.call("chain_getHeader", []);
    const runtimeVersion = at === null ? null : await this.call("state_getRuntimeVersion", [at]);
    return headFrom({ observedAt, genesis, finalizedHead, finalizedHeader, bestHeader, runtimeVersion });
  }

  async faucetHealth(): Promise<HttpResult<FaucetHealthBody>> {
    return (await this.read()).faucetHealth as HttpResult<FaucetHealthBody>;
  }

  async faucetChain(): Promise<HttpResult<FaucetChainBody>> {
    return (await this.read()).faucetChain as HttpResult<FaucetChainBody>;
  }

  async gatewayModels(): Promise<HttpResult<unknown>> {
    return (await this.read()).gatewayModels;
  }

  async rpcHead(): Promise<RpcHead> {
    return (await this.read()).rpcHead;
  }

  async anchorBlock(): Promise<AnchorReading | null> {
    return null;
  }

  async runtimeConstants(): Promise<RuntimeConstants | null> {
    return null;
  }

  async eventPages(): Promise<EventPage[]> {
    return [];
  }

  async eventPageErrors(): Promise<string[]> {
    return [];
  }
}
