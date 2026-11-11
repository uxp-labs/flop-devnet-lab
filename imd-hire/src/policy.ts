/**
 * What the wallet's owner approved, and the check that a challenge asks for exactly that. Pure: no
 * file, clock or network access. Every reason a challenge is refused is returned, so the caller can
 * show them all; an empty list means the challenge may be signed.
 */
import { isAddressEqual, type Address } from "viem";
import { canon } from "./canon.js";
import { chainIdOf, type Challenge } from "./challenge.js";

export interface Policy {
  api: string; // origin of the IMD API, e.g. https://api.imd.fun
  chainId: number; // the one chain this wallet pays on
  token: Address; // the one asset it pays in
  maxAmount: bigint; // the most it pays for one request, atomic units
  action: string; // the action that was quoted, e.g. job.open
  input: unknown; // the request body that was quoted
}

/** Seconds a quote's issue time may sit ahead of this machine's clock. */
export const CLOCK_SKEW_SECONDS = 120;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * True when `got` holds everything `sent` holds, with the same values. The server normalizes a
 * request (it sorts keys and fills defaults), so it may hold more, never less and never different.
 */
export function holds(got: unknown, sent: unknown): boolean {
  if (isObject(sent)) return isObject(got) && Object.keys(sent).every((key) => key in got && holds(got[key], sent[key]));
  try {
    return canon(got) === canon(sent);
  } catch {
    return false;
  }
}

export function checkChallenge(ch: Challenge, policy: Policy, nowSeconds: number): string[] {
  const reasons: string[] = [];
  const { accepted, quote } = ch;
  const network = `eip155:${policy.chainId}`;

  if (accepted.network !== network) reasons.push(`the payment is on ${accepted.network}, not ${network}`);
  if (quote.payment.network !== accepted.network) reasons.push("the quote and the payment requirement name different networks");
  if (chainIdOf(accepted.network) !== policy.chainId) reasons.push("the payment network is not this wallet's chain");

  if (!isAddressEqual(accepted.asset, policy.token)) reasons.push(`the payment asset ${accepted.asset} is not the IMD token ${policy.token}`);
  if (!isAddressEqual(quote.payment.asset, accepted.asset)) reasons.push("the quote and the payment requirement name different assets");

  if (quote.payment.amount !== accepted.amount) reasons.push("the quote and the payment requirement name different amounts");
  if (BigInt(accepted.amount) > policy.maxAmount) reasons.push(`the price ${accepted.amount} is above the approved maximum ${policy.maxAmount}`);

  if (!isAddressEqual(quote.payment.payTo, accepted.payTo)) reasons.push("the quote and the payment requirement name different recipients");

  const resourceUrl = `${policy.api}/requests/${quote.id}`;
  if (ch.resourceUrl !== resourceUrl) reasons.push(`resourceUrl is not ${resourceUrl}`);
  if (ch.resource.url !== ch.resourceUrl) reasons.push("resource.url is not the order's resourceUrl");

  if (quote.action !== policy.action) reasons.push(`the quote is for ${quote.action}, not ${policy.action}`);
  if (!holds(ch.input, policy.input)) reasons.push("the quoted input is not the request that was approved");

  if (quote.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) reasons.push("the quote is dated in the future; check this machine's clock");
  if (quote.expiresAt <= nowSeconds) reasons.push("the quote has expired; quote again");
  // The permit's deadline is now plus maxTimeoutSeconds and must fall before the quote expires.
  else if (nowSeconds + accepted.maxTimeoutSeconds >= quote.expiresAt) reasons.push("the quote is too close to its expiry for the payment window; quote again");

  return reasons;
}
