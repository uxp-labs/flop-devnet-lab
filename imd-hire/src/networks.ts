/** What IMD publishes at GET /requests/capabilities and in its API reference, read 2026-11-11. */
import type { Address } from "viem";

export const DEFAULT_API = "https://api.imd.fun";
export const IMD_DECIMALS = 18;

/** The IMD token, by chain id. The signer pays in no other asset. */
export const IMD_TOKEN: Readonly<Record<number, Address>> = {
  1: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7", // Ethereum mainnet
  4663: "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127", // Robinhood Chain
};

export function imdToken(chainId: number): Address {
  const token = IMD_TOKEN[chainId];
  if (!token) throw new Error(`no IMD token known on chain ${chainId}`);
  return token;
}
