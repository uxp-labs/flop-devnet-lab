/**
 * The first signature: the x402 "exact" payment, a Permit2 transfer authorization. It is built by the
 * x402 client libraries exactly as IMD's API reference shows, then checked field by field against the
 * challenge before it leaves this module, so nothing is sent that the signer did not mean to sign.
 */
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { PERMIT2_ADDRESS, permit2WitnessTypes, x402ExactPermit2ProxyAddress } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { isAddressEqual, isHex, verifyTypedData, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { canon, canonHash } from "./canon.js";
import { chainIdOf, type Accepted, type Challenge, type Resource } from "./challenge.js";
import { refused } from "./errors.js";

export interface Permit2Authorization {
  from: Address;
  permitted: { token: Address; amount: string };
  spender: Address;
  nonce: string;
  deadline: string;
  witness: { to: Address; validAfter: string };
}

/** The payment exactly as it is sent: IMD parses it strictly and refuses any other key. */
export interface Payment {
  x402Version: 2;
  resource: Resource;
  accepted: Accepted;
  payload: { signature: Hex; permit2Authorization: Permit2Authorization };
}

/** The contract the token allowance is given to, and the one a payment names as its spender. */
export const PERMIT2: Address = PERMIT2_ADDRESS;
export const PERMIT2_PROXY: Address = x402ExactPermit2ProxyAddress;

const keysOf = (v: object): string => Object.keys(v).sort().join();

/** Every way `payment` differs from what `ch` asked `from` to sign. Empty when it is exact. */
export async function checkPayment(payment: Payment, ch: Challenge, from: Address, nowSeconds: number): Promise<string[]> {
  const reasons: string[] = [];
  const auth = payment.payload?.permit2Authorization;
  if (payment.x402Version !== 2 || keysOf(payment) !== "accepted,payload,resource,x402Version" || !auth || keysOf(payment.payload) !== "permit2Authorization,signature") {
    return ["the payment does not have the documented shape"];
  }
  if (keysOf(auth) !== "deadline,from,nonce,permitted,spender,witness" || keysOf(auth.permitted) !== "amount,token" || keysOf(auth.witness) !== "to,validAfter") {
    return ["the Permit2 authorization does not have the documented shape"];
  }
  if (canon(payment.accepted) !== canon(ch.accepted)) reasons.push("accepted is not the challenge's requirement");
  if (canon(payment.resource) !== canon(ch.resource)) reasons.push("resource is not the challenge's resource");
  if (!isAddressEqual(auth.from, from)) reasons.push("the payer is not this wallet");
  if (!isAddressEqual(auth.permitted.token, ch.accepted.asset)) reasons.push("the permitted token is not the quoted asset");
  if (auth.permitted.amount !== ch.accepted.amount) reasons.push("the permitted amount is not the quoted amount");
  if (!isAddressEqual(auth.spender, PERMIT2_PROXY)) reasons.push("the spender is not the x402 exact Permit2 proxy");
  if (!isAddressEqual(auth.witness.to, ch.accepted.payTo)) reasons.push("the witness recipient is not the quoted recipient");
  if (auth.witness.validAfter !== "0") reasons.push("the payment is not valid from now");
  const deadline = Number(auth.deadline);
  if (!Number.isSafeInteger(deadline) || deadline <= nowSeconds) reasons.push("the payment window has already closed");
  else if (deadline >= ch.quote.expiresAt) reasons.push("the payment window does not end before the quote expires");
  if (!/^[0-9]+$/.test(auth.nonce)) reasons.push("the Permit2 nonce is not a number");
  if (reasons.length > 0) return reasons;

  const signed = isHex(payment.payload.signature)
    ? await verifyTypedData({
        address: from,
        domain: { name: "Permit2", chainId: chainIdOf(ch.accepted.network), verifyingContract: PERMIT2 },
        types: permit2WitnessTypes,
        primaryType: "PermitWitnessTransferFrom",
        message: {
          permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
          spender: auth.spender,
          nonce: BigInt(auth.nonce),
          deadline: BigInt(auth.deadline),
          witness: { to: auth.witness.to, validAfter: BigInt(auth.witness.validAfter) },
        },
        signature: payment.payload.signature,
      }).catch(() => false)
    : false;
  return signed ? [] : ["the payment signature is not this wallet's signature over the authorization"];
}

/** The asset and the most of it the wallet's owner approved for one payment. */
export interface SpendLimit {
  token: Address;
  maxAmount: bigint; // atomic units
}

/**
 * Builds and signs the payment for a challenge that has passed the policy check. The limit is also
 * handed to the x402 client as its spend control, so the library refuses any other asset or a larger
 * amount on its own, whatever was checked before.
 */
export async function signPayment(ch: Challenge, account: PrivateKeyAccount, limit: SpendLimit): Promise<Payment> {
  const client = x402Client.fromConfig({
    schemes: [{ network: ch.accepted.network, client: new ExactEvmScheme(account) }],
    spendControls: { allowedAssets: [{ network: ch.accepted.network, asset: limit.token, maxAmountPerPayment: limit.maxAmount.toString() }] },
  });
  let created: Awaited<ReturnType<typeof client.createPaymentPayload>>;
  try {
    created = await client.createPaymentPayload({ x402Version: 2, resource: ch.resource, accepts: [ch.accepted] });
  } catch (e) {
    throw refused([`the x402 client would not build the payment: ${(e as Error).message}`]);
  }
  // As in IMD's reference: an SDK may attach extensions, and IMD refuses a payment that carries any.
  const { extensions: _dropped, ...generated } = created;
  const payment = JSON.parse(JSON.stringify({ ...generated, accepted: ch.accepted })) as Payment;
  const reasons = await checkPayment(payment, ch, account.address, Math.floor(Date.now() / 1000));
  if (reasons.length > 0) throw refused(reasons);
  return payment;
}

/** The PAYMENT-SIGNATURE header value: base64 of the payment's JSON. */
export const paymentHeader = (payment: Payment): string => encodePaymentSignatureHeader(payment as unknown as Parameters<typeof encodePaymentSignatureHeader>[0]);

/** SHA-256 of the payment's canonical JSON: the payment the quote approval commits to. */
export const paymentHash = (payment: Payment): Hex => canonHash(payment);
