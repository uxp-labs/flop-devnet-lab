import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, keccak256, parseGwei, parseTransaction, recoverTransactionAddress, type TransactionSerializedEIP1559 } from "viem";
import { signApprove, type ApproveParams } from "../src/allowance.js";
import { EXIT, HireError } from "../src/errors.js";
import { account, IMD } from "./helpers.js";

const FIVE_IMD = 5_000000000000000000n;
const params = (over: Partial<ApproveParams> = {}): ApproveParams => ({ chainId: 1, token: IMD, amount: FIVE_IMD, nonce: 0, gas: 60000n, maxFeePerGas: parseGwei("0.2"), maxPriorityFeePerGas: parseGwei("0.01"), maxCost: 10n ** 15n, ...over });

describe("the Permit2 allowance transaction", () => {
  it("approves the canonical Permit2 contract, on the IMD token, for the capped amount and nothing else", async () => {
    const signed = await signApprove(account, params());
    const tx = parseTransaction(signed.raw as TransactionSerializedEIP1559);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(1);
    expect(tx.to?.toLowerCase()).toBe(IMD);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.nonce ?? 0).toBe(0);
    expect(tx.gas).toBe(60000n);
    expect(tx.maxFeePerGas).toBe(parseGwei("0.2"));
    expect(tx.maxPriorityFeePerGas).toBe(parseGwei("0.01"));
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.functionName).toBe("approve");
    expect(call.args).toEqual(["0x000000000022D473030F116dDEE9F6B43aC78BA3", FIVE_IMD]);
    expect(await recoverTransactionAddress({ serializedTransaction: signed.raw as TransactionSerializedEIP1559 })).toBe(account.address);
    expect(signed).toMatchObject({ hash: keccak256(signed.raw), from: account.address, to: IMD, spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: FIVE_IMD.toString(), chainId: 1, nonce: 0, maxCostWei: (60000n * parseGwei("0.2")).toString() });
  });

  it("an allowance of 0 revokes", async () => {
    const tx = parseTransaction((await signApprove(account, params({ amount: 0n, nonce: 3 }))).raw as TransactionSerializedEIP1559);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args).toEqual(["0x000000000022D473030F116dDEE9F6B43aC78BA3", 0n]);
    expect(tx.nonce).toBe(3);
  });

  const refusedFor: [string, Partial<ApproveParams>, RegExp][] = [
    ["a cost above the limit", { gas: 60000n, maxFeePerGas: parseGwei("100"), maxCost: 10n ** 15n }, /above the limit/],
    ["a priority fee above the fee cap", { maxPriorityFeePerGas: parseGwei("1") }, /priority fee is above/],
    ["a negative allowance", { amount: -1n }, /negative/],
    ["a negative nonce", { nonce: -1 }, /nonce/],
    ["a fractional nonce", { nonce: 1.5 }, /nonce/],
    ["no gas", { gas: 0n }, /positive/],
    ["no fee", { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, /positive/],
  ];
  for (const [name, over, why] of refusedFor) {
    it(`refuses ${name} and signs nothing`, async () => {
      const e = await signApprove(account, params(over)).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(HireError);
      expect((e as HireError).code).toBe(EXIT.REFUSED);
      expect((e as HireError).message).toMatch(why);
    });
  }
});
