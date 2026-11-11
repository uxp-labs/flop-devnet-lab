/** What IMD publishes at GET /requests/capabilities and in its API reference, read 2026-11-11. */
import type { Address } from "viem";

export const DEFAULT_API = "https://api.imd.fun";
export const IMD_DECIMALS = 18;

/** The IMD token, by chain id. The signer pays in no other asset. */
export const IMD_TOKEN: Readonly<Record<number, Address>> = {
  1: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7", // Ethereum mainnet
  4663: "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127", // Robinhood Chain
};

/**
 * The wallet IMD is paid to (`payTo` in GET /requests/capabilities), by chain id. A challenge that
 * names any other recipient is refused: it is the one field of a payment that only the server supplies.
 */
export const IMD_PAY_TO: Readonly<Record<number, Address>> = {
  1: "0x4e0fa57bde726079356537e2f34d671e9f41adbc", // Ethereum mainnet
};

/** The recipient pinned for a chain, or null where none is known and the owner must name one. */
export const imdPayTo = (chainId: number): Address | null => IMD_PAY_TO[chainId] ?? null;

/**
 * Ceilings that catch a slip of units (atomic units typed where IMD was meant), not spending limits:
 * a request costs 0.5 IMD. The owner's own limit is --max-imd, and it must sit under this.
 */
export const LARGEST_PRICE = 100n * 10n ** BigInt(IMD_DECIMALS);
export const LARGEST_ALLOWANCE = 1000n * 10n ** BigInt(IMD_DECIMALS);

export function imdToken(chainId: number): Address {
  const token = IMD_TOKEN[chainId];
  if (!token) throw new Error(`no IMD token known on chain ${chainId}`);
  return token;
}
