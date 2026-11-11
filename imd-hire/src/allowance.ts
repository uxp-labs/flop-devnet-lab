/**
 * The one transaction this wallet ever sends: an ERC-20 approval that lets Permit2 move a capped
 * amount of IMD. Payments themselves are signatures, and IMD's server pays their gas. The spender is
 * fixed to the canonical Permit2 contract, so this module cannot approve anyone else. It signs and
 * returns the raw transaction; it does not send it.
 */
import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { refused } from "./errors.js";
import { PERMIT2 } from "./payment.js";

export interface ApproveParams {
  chainId: number;
  token: Address;
  amount: bigint; // the allowance, atomic units; 0 revokes
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint; // wei
  maxPriorityFeePerGas: bigint; // wei
  maxCost: bigint; // refuse when gas times maxFeePerGas is above this, wei
}

export interface SignedApprove {
  raw: Hex;
  hash: Hex;
  from: Address;
  to: Address; // the token
  spender: Address; // Permit2
  amount: string;
  chainId: number;
  nonce: number;
  maxCostWei: string;
}

export async function signApprove(account: PrivateKeyAccount, p: ApproveParams): Promise<SignedApprove> {
  const reasons: string[] = [];
  if (p.amount < 0n) reasons.push("the allowance is negative");
  if (!Number.isSafeInteger(p.nonce) || p.nonce < 0) reasons.push("the nonce is not a whole number from 0");
  if (p.gas <= 0n || p.maxFeePerGas <= 0n || p.maxPriorityFeePerGas < 0n) reasons.push("gas and fees must be positive");
  if (p.maxPriorityFeePerGas > p.maxFeePerGas) reasons.push("the priority fee is above the fee cap");
  const cost = p.gas * p.maxFeePerGas;
  if (cost > p.maxCost) reasons.push(`the most this could cost, ${cost} wei, is above the limit of ${p.maxCost} wei`);
  if (reasons.length > 0) throw refused(reasons);

  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: p.chainId,
    to: p.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, p.amount] }),
    value: 0n,
    nonce: p.nonce,
    gas: p.gas,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
  });
  return { raw, hash: keccak256(raw), from: account.address, to: p.token, spender: PERMIT2, amount: p.amount.toString(), chainId: p.chainId, nonce: p.nonce, maxCostWei: cost.toString() };
}
