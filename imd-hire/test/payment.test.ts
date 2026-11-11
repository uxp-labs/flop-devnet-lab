import { decodePaymentSignatureHeader } from "@x402/core/http";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from "@x402/evm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { EXIT, HireError } from "../src/errors.js";
import { checkPayment, paymentHash, paymentHeader, PERMIT2, PERMIT2_PROXY, signPayment, type Payment } from "../src/payment.js";
import { canon } from "../src/canon.js";
import { account, challenge, EXPIRES, HALF_IMD, IMD, ISSUED, LIMIT, OTHER_KEY } from "./helpers.js";

const NOW = ISSUED + 30;
beforeEach(() => vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("the Permit2 payment", () => {
  it("names the canonical Permit2 contract and the x402 exact proxy, pinned here so a library change shows", () => {
    expect(PERMIT2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(PERMIT2_PROXY).toBe("0x402085c248EeA27D92E8b30b2C58ed07f9E20001");
    // The pinned library signs for the same two contracts. If an upgrade moves either, this fails
    // and every payment is refused until the addresses here are checked and changed by hand.
    expect(PERMIT2_ADDRESS).toBe(PERMIT2);
    expect(x402ExactPermit2ProxyAddress).toBe(PERMIT2_PROXY);
  });

  it("is exactly the documented shape, for exactly what the challenge asks", async () => {
    const ch = challenge();
    const payment = await signPayment(ch, account, LIMIT);
    expect(Object.keys(payment).sort()).toEqual(["accepted", "payload", "resource", "x402Version"]);
    expect(payment.x402Version).toBe(2);
    expect(payment.accepted).toEqual(ch.accepted);
    expect(payment.resource).toEqual(ch.resource);
    const auth = payment.payload.permit2Authorization;
    expect(Object.keys(payment.payload).sort()).toEqual(["permit2Authorization", "signature"]);
    expect(auth.from).toBe(account.address);
    expect({ token: auth.permitted.token.toLowerCase(), amount: auth.permitted.amount }).toEqual({ token: IMD, amount: "500000000000000000" });
    expect(auth.spender).toBe(PERMIT2_PROXY);
    expect({ to: auth.witness.to.toLowerCase(), validAfter: auth.witness.validAfter }).toEqual({ to: "0x4e0fa57bde726079356537e2f34d671e9f41adbc", validAfter: "0" });
    expect(Number(auth.deadline)).toBe(NOW + 300);
    expect(Number(auth.deadline)).toBeLessThan(EXPIRES);
    expect(auth.nonce).toMatch(/^[0-9]+$/);
    expect(payment.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await checkPayment(payment, ch, account.address, NOW)).toEqual([]);
  });

  it("uses a new Permit2 nonce every time", async () => {
    const a = await signPayment(challenge(), account, LIMIT);
    const b = await signPayment(challenge(), account, LIMIT);
    expect(a.payload.permit2Authorization.nonce).not.toBe(b.payload.permit2Authorization.nonce);
  });

  it("the header is base64 of the payment's JSON, and the hash is SHA-256 of its canonical JSON", async () => {
    const payment = await signPayment(challenge(), account, LIMIT);
    expect(decodePaymentSignatureHeader(paymentHeader(payment))).toEqual(payment);
    expect(JSON.parse(Buffer.from(paymentHeader(payment), "base64").toString("utf8"))).toEqual(payment);
    const { createHash } = await import("node:crypto");
    expect(paymentHash(payment)).toBe("0x" + createHash("sha256").update(canon(payment)).digest("hex"));
  });

  const tampers: [string, (p: any) => void, RegExp][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["a larger amount", (p) => (p.payload.permit2Authorization.permitted.amount = "900000000000000000"), /permitted amount/],
    ["another token", (p) => (p.payload.permit2Authorization.permitted.token = "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127"), /permitted token/],
    ["another spender", (p) => (p.payload.permit2Authorization.spender = "0x00000000000000000000000000000000000000aa"), /spender/],
    ["another recipient", (p) => (p.payload.permit2Authorization.witness.to = "0x00000000000000000000000000000000000000aa"), /witness recipient/],
    ["another payer", (p) => (p.payload.permit2Authorization.from = "0x00000000000000000000000000000000000000aa"), /payer is not this wallet/],
    ["a window that outlasts the quote", (p) => (p.payload.permit2Authorization.deadline = String(EXPIRES)), /does not end before the quote expires/],
    ["a window that has closed", (p) => (p.payload.permit2Authorization.deadline = String(NOW)), /already closed/],
    ["a later start", (p) => (p.payload.permit2Authorization.witness.validAfter = "5"), /valid from now/],
    ["another requirement", (p) => (p.accepted.amount = "1"), /accepted is not/],
    ["another resource", (p) => (p.resource.url = "https://api.imd.fun/requests/other"), /resource is not/],
    ["extensions attached", (p) => (p.extensions = {}), /documented shape/],
    ["an extra key in the authorization", (p) => (p.payload.permit2Authorization.extra = "0x"), /documented shape/],
    ["an extra key in the witness", (p) => (p.payload.permit2Authorization.witness.extra = "0x"), /documented shape/],
    ["a signature that is not hex", (p) => (p.payload.signature = "signed"), /signature is not this wallet/],
  ];
  for (const [name, edit, why] of tampers) {
    it(`the check catches ${name}`, async () => {
      const ch = challenge();
      const payment = structuredClone(await signPayment(ch, account, LIMIT)) as Payment;
      edit(payment);
      expect((await checkPayment(payment, ch, account.address, NOW)).join("; ")).toMatch(why);
    });
  }

  it("the check catches a valid signature by another wallet, and one over other fields", async () => {
    const ch = challenge();
    const other = privateKeyToAccount(OTHER_KEY);
    const theirs = await signPayment(ch, other, LIMIT);
    const forged = structuredClone(theirs);
    forged.payload.permit2Authorization.from = account.address;
    expect((await checkPayment(forged, ch, account.address, NOW)).join()).toMatch(/signature is not this wallet/);
    const mine = structuredClone(await signPayment(ch, account, LIMIT));
    mine.payload.permit2Authorization.nonce = "1";
    expect((await checkPayment(mine, ch, account.address, NOW)).join()).toMatch(/signature is not this wallet/);
  });

  it("the x402 client itself refuses another asset or a price above the limit", async () => {
    const overLimit = await signPayment(challenge(), account, { token: IMD, maxAmount: HALF_IMD - 1n }).then(() => null, (x: unknown) => x);
    expect((overLimit as HireError).code).toBe(EXIT.REFUSED);
    expect((overLimit as HireError).message).toMatch(/x402 client would not build the payment/);
    const otherAsset = await signPayment(challenge(), account, { token: "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127", maxAmount: HALF_IMD }).then(() => null, (x: unknown) => x);
    expect((otherAsset as HireError).code).toBe(EXIT.REFUSED);
    expect((otherAsset as HireError).message).toMatch(/x402 client would not build the payment/);
    // At exactly the limit it signs.
    expect((await signPayment(challenge(), account, { token: IMD, maxAmount: HALF_IMD })).payload.signature).toMatch(/^0x/);
  });

  it("refuses to sign when the payment window would not end before the quote expires", async () => {
    vi.setSystemTime((EXPIRES - 100) * 1000);
    const e = await signPayment(challenge(), account, LIMIT).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(HireError);
    expect((e as HireError).code).toBe(EXIT.REFUSED);
    expect((e as HireError).message).toMatch(/nothing signed.*does not end before the quote expires/);
  });
});
