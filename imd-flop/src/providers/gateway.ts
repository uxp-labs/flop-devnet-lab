/**
 * The gateway provider: the real devnet gateway via @flop-labs/client, gated behind --live. complete() re-checks
 * the Ethereum chain id and the pinned genesis before it mints a child key. The gateway's HTTP client is
 * ../gateway.ts.
 */
import { statSync } from "node:fs";
import { FlopClient, FlopHTTPError } from "@flop-labs/client";
import { readSecretFile } from "../store.js";
import { CliError, EXIT } from "../errors.js";
import { assertPaidNetwork, mintChildKey, postEstimate, PreSendError, uaFetch, type Estimate, type Fetch } from "../gateway.js";
import { NON_FINITE_NUMBER, NonFiniteNumber, markNonFinite, nonFiniteSeam, notJsonBecause } from "../outside-json.js";
import type { NetworkInfo } from "../networks.js";
import type { GatewayReceipt } from "../receipts.js";
import { registerSecret } from "../secrets.js";
import type { CompleteReq, CompleteRes, Provider, ReceiptRead } from "./interface.js";

/** Real devnet gateway. Requires a gateway bearer in seats/<seat>/gateway.key (0600) from `enroll --live`. */
export class FlopProvider implements Provider {
  readonly name = "flop" as const;
  calls = 0;
  private parent: string;
  constructor(
    private net: NetworkInfo,
    gatewayKeyPath: string,
    private f: Fetch = globalThis.fetch,
    private ethRpc?: string,
  ) {
    let raw: string;
    try {
      const mode = statSync(gatewayKeyPath).mode & 0o777;
      if (mode & 0o077) throw new CliError(`gateway key file is mode ${mode.toString(8)}; expected 600`, EXIT.REFUSED_RULE);
      raw = readSecretFile(gatewayKeyPath).trim();
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError("no gateway key for this seat (run `imd-flop enroll --live` on the holder's machine first)", EXIT.USAGE);
    }
    this.parent = raw;
    registerSecret(raw);
  }

  estimate(body: { model: string; prompt: string; max_tokens: number }): Promise<Estimate> {
    return postEstimate(this.net, body, this.f);
  }

  async complete(req: CompleteReq): Promise<CompleteRes> {
    // run's timer may fire during the pre-flight. Until the completion request starts nothing is sent,
    // so an abort before then is a pre-send refusal (refused_local, reservation released), not a timeout.
    const notAborted = (stage: string) => {
      if (req.signal.aborted) throw new PreSendError(`aborted before send (${stage}): ${(req.signal.reason as Error | undefined)?.message ?? "aborted"}`);
    };
    notAborted("before the network check");
    // Throws PaidGateError, a PreSendError: the gate runs before the mint, so nothing was sent.
    await assertPaidNetwork(this.net, this.ethRpc, this.f);
    notAborted("after the network check");
    this.calls++;
    // Spend-guard rule 3: the broad key only mints a single-use child capped at this call's quote.
    const child = await mintChildKey(this.net, this.parent, { model: req.model, maxSpend: req.maxCostFlop }, this.f, req.signal);
    registerSecret(child.token);
    notAborted("after the child-key mint");
    // The client parses the answer: its fetch checks the body for a number that is not finite (outside-json.ts).
    const seam = nonFiniteSeam(uaFetch(this.f));
    const client = new FlopClient({ baseURL: this.net.gateway, apiKey: child.token, fetch: seam.fetch });
    let res: Awaited<ReturnType<FlopClient["createChatCompletion"]>>;
    try {
      res = await client.createChatCompletion(
        { model: req.model, messages: req.messages, max_tokens: req.max_tokens, max_cost_flop: req.maxCostFlop } as Parameters<FlopClient["createChatCompletion"]>[0],
        { signal: req.signal, idempotencyKey: req.requestId, correlationId: req.correlationId },
      );
    } catch (e) {
      // The same error, so the same path; run.ts names the reason when the seam replaced the body.
      throw seam.met() ? markNonFinite(e) : e;
    }
    const u = res.usage as CompleteRes["usage"];
    return { request_id: req.requestId, text: res.choices[0]?.message?.content ?? "", usage: u };
  }

  async readReceipt(requestId: string): Promise<ReceiptRead> {
    const seam = nonFiniteSeam(uaFetch(this.f));
    const client = new FlopClient({ baseURL: this.net.gateway, apiKey: this.parent, fetch: seam.fetch });
    try {
      const r = (await client.getCredentialReceipt(requestId)) as unknown as GatewayReceipt;
      return { http: 200, receipt: r, error: null };
    } catch (e) {
      // A body the seam replaced takes the path of a body that is not JSON, and the error says why.
      if (e instanceof FlopHTTPError) {
        const err = seam.met() ? NON_FINITE_NUMBER : ((e.body as { error?: string } | undefined)?.error ?? null);
        return { http: e.status, receipt: null, error: err };
      }
      return { http: 0, receipt: null, error: seam.met() ? notJsonBecause((e as Error).message, new NonFiniteNumber()) : (e as Error).message };
    }
  }
}

/**
 * The gateway for `quote` only: the estimate is free, so it needs no key and no --live. The network, and the
 * fetch when the caller gave none (globalThis.fetch), are read when the estimate is asked for, as before. It
 * completes nothing and reads no receipt.
 */
export function gatewayQuoteProvider(net: () => NetworkInfo, f: Fetch | undefined): Provider {
  return {
    name: "flop",
    calls: 0,
    estimate: (b) => postEstimate(net(), b, f ?? globalThis.fetch),
    complete: () => Promise.reject(new Error("quote only")),
    readReceipt: () => Promise.reject(new Error("quote only")),
  };
}
