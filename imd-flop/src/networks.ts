import { CliError, EXIT } from "./errors.js";

export interface NetworkInfo {
  name: string;
  gateway: string; // OpenAI-compatible alias base
  faucet: string;
  rpc: string;
  explorer: string;
  ss58Prefix: number;
  /** Block 0 hash. A link binds to this, not to the name "devnet", so a reset or fork kills it. */
  genesisHash: string;
}

/** Only devnet is published. Sources: docs.flop.network official-links, network-devnet, and faucet /chain (ss58Format 42). */
export const NETWORKS: Record<string, NetworkInfo> = {
  devnet: {
    name: "devnet",
    gateway: "https://api.flop.network/v1",
    faucet: "https://faucet.flop.network",
    rpc: "wss://rpc.devnet.flop.network",
    explorer: "https://explorer.devnet.flop.network",
    ss58Prefix: 42,
    // faucet.flop.network/chain genesisHash, read 2026-11-09. Full hash, compared in full.
    // Paid runs require the live faucet and RPC block 0 to equal this pin. `init --check-genesis` is the optional form of that read.
    genesisHash: "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631",
  },
};

export function network(name: string): NetworkInfo {
  const n = NETWORKS[name];
  if (!n) {
    throw new CliError(
      `network "${name}" is not published yet (FLOP testnet status: "planned"). Only devnet works today.`,
      EXIT.USAGE,
    );
  }
  return n;
}

export const USER_AGENT = "uxp-labs-imd-flop/0 (+https://github.com/uxp-labs)";
export const DEFAULT_MODEL = "qwen/qwen2.5-0.5b-instruct";
export const IMD_API = "https://api.imd.fun";
/** imd seat collection on Ethereum mainnet (api.imd.fun/health -> identity.collection, 2026-11-09). */
export const SEAT_COLLECTION = "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d" as const;
/** Ethereum mainnet. Paid runs require eth_chainId to equal this before ownerOf is read. */
export const SEAT_CHAIN_ID = 1;
