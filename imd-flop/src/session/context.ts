/** What the CLI hands each session command (P5b, rule C1): the seat found as the other commands find it, and its inputs. */
import type { Transport } from "../chain-read/node.js";
import type { SeatCap } from "../config.js";
import type { NetworkInfo } from "../networks.js";

export interface SessionContext {
  readonly home: string;
  readonly seat: string;
  readonly net: NetworkInfo;
  readonly caps: Record<string, SeatCap>;
  /** `--owner`, as typed. */
  readonly owner: string | undefined;
  /** `--days`, as typed: grant only. */
  readonly days: string | undefined;
  /** The caller's transport (rule C5), else the network's node. */
  readonly transport: Transport | undefined;
}
