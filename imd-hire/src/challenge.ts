/**
 * The 402 challenge IMD answers to `POST /requests/:id/submit` with no body: the x402 v2 payment
 * requirements, plus the quote they belong to. Parsed strictly. A challenge with a shape this module
 * does not know is refused, never signed in part.
 */
import { isAddress, type Address } from "viem";
import { usage } from "./errors.js";

/** A CAIP-2 network name. Only eip155 ones pass the parser, e.g. "eip155:1". */
export type Network = `${string}:${string}`;

export interface Accepted {
  scheme: "exact";
  network: Network;
  asset: Address;
  amount: string; // atomic units, decimal
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { assetTransferMethod: "permit2" };
}

export interface Quote {
  id: string;
  action: string;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
  payment: { network: Network; asset: Address; amount: string; payTo: Address };
  quoteHash: string; // 64 hex, no 0x
}

export interface Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface Challenge {
  x402Version: 2;
  resource: Resource;
  accepted: Accepted; // accepts[0]: the one requirement this signer will pay
  quote: Quote;
  requesterScopeHash: string; // 64 hex, no 0x
  resourceUrl: string;
  input: unknown; // the request as the server normalized it
}

const HEX64 = /^[0-9a-f]{64}$/;
const ATOMIC = /^[1-9][0-9]{0,77}$/;
const NETWORK = /^eip155:[1-9][0-9]{0,15}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** The chain id of a CAIP-2 EVM network name. */
export const chainIdOf = (network: Network): number => Number(network.slice("eip155:".length));

/** Reads a challenge body. Throws a usage error that lists every problem found. */
export function parseChallenge(body: unknown): Challenge {
  const problems: string[] = [];
  const need = (ok: boolean, what: string): boolean => {
    if (!ok) problems.push(what);
    return ok;
  };
  const fail = (): never => {
    throw usage(`not a challenge this signer knows: ${problems.join("; ")}`);
  };

  if (!need(isObject(body), "the body is not an object")) fail();
  const b = body as Json;
  need(b.x402Version === 2, "x402Version is not 2");

  const accepts = b.accepts;
  if (!need(Array.isArray(accepts) && accepts.length === 1 && isObject(accepts[0]), "accepts is not a list of exactly one requirement")) fail();
  const a = (accepts as Json[])[0];
  need(a.scheme === "exact", "accepts[0].scheme is not exact");
  need(typeof a.network === "string" && NETWORK.test(a.network), "accepts[0].network is not an eip155 network");
  need(typeof a.asset === "string" && isAddress(a.asset), "accepts[0].asset is not an address");
  need(typeof a.amount === "string" && ATOMIC.test(a.amount), "accepts[0].amount is not a positive whole number of atomic units");
  need(typeof a.payTo === "string" && isAddress(a.payTo), "accepts[0].payTo is not an address");
  need(isSeconds(a.maxTimeoutSeconds), "accepts[0].maxTimeoutSeconds is not a positive whole number");
  need(isObject(a.extra) && Object.keys(a.extra).length === 1 && a.extra.assetTransferMethod === "permit2", "accepts[0].extra is not exactly {assetTransferMethod: permit2}");
  need(Object.keys(a).sort().join() === "amount,asset,extra,maxTimeoutSeconds,network,payTo,scheme", "accepts[0] holds a field this signer does not know");

  const r = b.resource;
  if (need(isObject(r) && typeof r.url === "string", "resource.url is missing")) {
    const res = r as Json;
    need(Object.keys(res).every((k) => k === "url" || k === "description" || k === "mimeType"), "resource holds a field this signer does not know");
    need(res.description === undefined || typeof res.description === "string", "resource.description is not text");
    need(res.mimeType === undefined || typeof res.mimeType === "string", "resource.mimeType is not text");
  }

  const q = b.quote;
  if (need(isObject(q), "quote is missing")) {
    const quote = q as Json;
    need(typeof quote.id === "string" && quote.id.length > 0, "quote.id is missing");
    need(typeof quote.action === "string" && quote.action.length > 0, "quote.action is missing");
    need(isSeconds(quote.issuedAt), "quote.issuedAt is not a unix time");
    need(isSeconds(quote.expiresAt), "quote.expiresAt is not a unix time");
    need(typeof quote.quoteHash === "string" && HEX64.test(quote.quoteHash), "quote.quoteHash is not 64 hex");
    const p = quote.payment;
    if (need(isObject(p), "quote.payment is missing")) {
      const pay = p as Json;
      need(typeof pay.network === "string" && NETWORK.test(pay.network), "quote.payment.network is not an eip155 network");
      need(typeof pay.asset === "string" && isAddress(pay.asset), "quote.payment.asset is not an address");
      need(typeof pay.amount === "string" && ATOMIC.test(pay.amount), "quote.payment.amount is not a positive whole number of atomic units");
      need(typeof pay.payTo === "string" && isAddress(pay.payTo), "quote.payment.payTo is not an address");
    }
  }
  need(typeof b.requesterScopeHash === "string" && HEX64.test(b.requesterScopeHash), "requesterScopeHash is not 64 hex");
  need(typeof b.resourceUrl === "string" && b.resourceUrl.length > 0, "resourceUrl is missing");
  need("input" in b, "input is missing");
  if (problems.length > 0) fail();

  const quote = q as Json;
  const pay = quote.payment as Json;
  const res = r as Json;
  return {
    x402Version: 2,
    resource: {
      url: res.url as string,
      ...(res.description !== undefined ? { description: res.description as string } : {}),
      ...(res.mimeType !== undefined ? { mimeType: res.mimeType as string } : {}),
    },
    accepted: {
      scheme: "exact",
      network: a.network as Network,
      asset: a.asset as Address,
      amount: a.amount as string,
      payTo: a.payTo as Address,
      maxTimeoutSeconds: a.maxTimeoutSeconds as number,
      extra: { assetTransferMethod: "permit2" },
    },
    quote: {
      id: quote.id as string,
      action: quote.action as string,
      issuedAt: quote.issuedAt as number,
      expiresAt: quote.expiresAt as number,
      payment: { network: pay.network as Network, asset: pay.asset as Address, amount: pay.amount as string, payTo: pay.payTo as Address },
      quoteHash: quote.quoteHash as string,
    },
    requesterScopeHash: b.requesterScopeHash as string,
    resourceUrl: b.resourceUrl as string,
    input: b.input,
  };
}
