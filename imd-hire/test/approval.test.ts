import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { quoteApproval, signQuoteApproval } from "../src/approval.js";
import { paymentHash, signPayment } from "../src/payment.js";
import { account, challenge, EXPIRES, ISSUED, LIMIT } from "./helpers.js";

beforeEach(() => vi.useFakeTimers({ now: (ISSUED + 30) * 1000, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("the quote approval", () => {
  it("is the typed data IMD's API reference lists, field for field", async () => {
    const ch = challenge();
    const payment = await signPayment(ch, account, LIMIT);
    const typed = quoteApproval(ch, payment);
    expect(typed.domain).toEqual({ name: "IdentityMD Paid Action", version: "1", chainId: 1 });
    expect(typed.primaryType).toBe("QuoteApproval");
    expect(typed.types.QuoteApproval.map((f) => `${f.name}:${f.type}`)).toEqual([
      "resource:string",
      "requesterScopeHash:bytes32",
      "quoteId:string",
      "quoteHash:bytes32",
      "paymentHash:bytes32",
      "action:string",
      "asset:address",
      "amount:uint256",
      "payTo:address",
      "expiresAt:uint256",
    ]);
    expect(typed.message).toEqual({
      resource: "https://api.imd.fun/requests/06423b07-dddf-41af-8bdf-f8d03dd925d8",
      requesterScopeHash: "0xf0dd59fe85f63e3917dd8c5092670ae76ca3e291856aa81c26450a3c618f4010",
      quoteId: "06423b07-dddf-41af-8bdf-f8d03dd925d8",
      quoteHash: "0xad8a1cdd3e3154fd7b5574c042b38aee306b842a500b79f20dd73d2f89ed01cb",
      paymentHash: paymentHash(payment),
      action: "job.open",
      asset: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
      amount: 500000000000000000n,
      payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
      expiresAt: BigInt(EXPIRES),
    });
  });

  it("is a 65 byte signature that recovers to the paying wallet", async () => {
    const ch = challenge();
    const payment = await signPayment(ch, account, LIMIT);
    const signature = await signQuoteApproval(ch, payment, account);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverTypedDataAddress({ ...quoteApproval(ch, payment), signature })).toBe(account.address);
  });

  it("commits to one payment: another payment gives another hash and another signature", async () => {
    const ch = challenge();
    const first = await signPayment(ch, account, LIMIT);
    const second = await signPayment(ch, account, LIMIT);
    expect(paymentHash(first)).not.toBe(paymentHash(second));
    const signature = await signQuoteApproval(ch, first, account);
    expect(signature).not.toBe(await signQuoteApproval(ch, second, account));
    // The first approval does not approve the second payment.
    expect(await recoverTypedDataAddress({ ...quoteApproval(ch, second), signature })).not.toBe(account.address);
  });
});
