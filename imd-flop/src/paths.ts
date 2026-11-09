import { homedir } from "node:os";
import { join } from "node:path";

/** Data root: $IMD_FLOP_HOME, else ~/.imd-flop */
export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.IMD_FLOP_HOME && env.IMD_FLOP_HOME.length > 0 ? env.IMD_FLOP_HOME : join(homedir(), ".imd-flop");
}
export const seatsDir = (h: string) => join(h, "seats");
export const seatDir = (h: string, seat: string) => join(h, "seats", seat);
export const keyFile = (h: string, seat: string) => join(seatDir(h, seat), "flop.key");
export const gatewayKeyFile = (h: string, seat: string) => join(seatDir(h, seat), "gateway.key");
export const identityFile = (h: string, seat: string) => join(seatDir(h, seat), "identity.json");
export const linkFile = (h: string, seat: string) => join(seatDir(h, seat), "link.json");
export const configFile = (h: string) => join(h, "config.json");
export const ledgerFile = (h: string) => join(h, "ledger.jsonl");
export const revocationsFile = (h: string) => join(h, "revocations.jsonl");
export const receiptsDir = (h: string) => join(h, "receipts");
export const responsesDir = (h: string) => join(h, "responses");
