import { configFile } from "./paths.js";
import { readJson, writeJsonSafe } from "./store.js";

export type Payer = "holder" | "requester";
export interface SeatCap {
  daily: number; // FLOP per UTC day, holder-paid spend
  perCall: number; // FLOP per call (padded quote)
}
export interface Config {
  network: string;
  seat?: string; // active seat (tokenId, or "unassigned" before link)
  payer: Payer;
  caps: Record<string, SeatCap>;
}

export const DEFAULT_CONFIG: Config = { network: "devnet", payer: "holder", caps: {} };

export function loadConfig(h: string): Config {
  const c = readJson<Partial<Config>>(configFile(h));
  return { ...DEFAULT_CONFIG, ...(c ?? {}), caps: { ...(c?.caps ?? {}) } };
}

export function saveConfig(h: string, c: Config): void {
  writeJsonSafe(configFile(h), c, "config.json");
}
