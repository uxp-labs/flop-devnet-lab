/**
 * The second signature: the EIP-712 approval that ties one payment to one quote. A stock x402 client
 * does not make it. Every field comes from the challenge or from the payment that is sent, as IMD's
 * API reference lists them.
 */
import { recoverTypedDataAddress, isAddressEqual, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { chainIdOf, type Challenge } from "./challenge.js";
import { refused } from "./errors.js";
import { paymentHash, type Payment } from "./payment.js";

const QUOTE_APPROVAL_TYPES = {
  QuoteApproval: [
    { name: "resource", type: "string" },
    { name: "requesterScopeHash", type: "bytes32" },
    { name: "quoteId", type: "string" },
    { name: "quoteHash", type: "bytes32" },
    { name: "paymentHash", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/** The typed data the wallet signs. Exported so a test, or a person, can read exactly what it is. */
export function quoteApproval(ch: Challenge, payment: Payment) {
  const { quote } = ch;
  return {
    domain: { name: "IdentityMD Paid Action", version: "1", chainId: chainIdOf(quote.payment.network) },
    types: QUOTE_APPROVAL_TYPES,
    primaryType: "QuoteApproval",
    message: {
      resource: ch.resourceUrl,
      requesterScopeHash: `0x${ch.requesterScopeHash}`,
      quoteId: quote.id,
      quoteHash: `0x${quote.quoteHash}`,
      paymentHash: paymentHash(payment),
      action: quote.action,
      asset: quote.payment.asset,
      amount: BigInt(quote.payment.amount),
      payTo: quote.payment.payTo,
      expiresAt: BigInt(quote.expiresAt),
    },
  } as const;
}

/** Signs the approval and proves the signature recovers to the wallet before returning it. */
export async function signQuoteApproval(ch: Challenge, payment: Payment, account: PrivateKeyAccount): Promise<Hex> {
  const typed = quoteApproval(ch, payment);
  const signature = await account.signTypedData(typed);
  const signer = await recoverTypedDataAddress({ ...typed, signature });
  if (!isAddressEqual(signer, account.address) || !/^0x[0-9a-f]{130}$/.test(signature)) throw refused(["the quote approval did not come out as this wallet's 65 byte signature"]);
  return signature;
}
