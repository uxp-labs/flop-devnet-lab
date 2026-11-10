// Builds one snapshot: everything observed in one pass, plus the pin needed to rerun it.
// Census and drift reports are computed by their own modules and passed in, so a snapshot
// can be built with or without them. A missing part is null, never an empty report.
import { escrowStates } from "./escrow.js";
import type { Source } from "./source.js";
import { assessNetwork, type StatusOptions } from "./status.js";
import type { NewSnapshot } from "./store.js";
import type { CensusReport, DriftReport, EscrowState, RunPin, Trust } from "./types.js";

export interface SnapshotParts {
  status: Source;
  escrows?: { source: Source; ids: string[] } | null;
  census?: { report: CensusReport; label: string } | null;
  drift?: { report: DriftReport; label: string } | null;
}

export interface SnapshotOptions {
  pinnedGenesis: string;
  /** Snapshot time (ISO 8601). Fixtures carry their own, so reruns are byte-identical. */
  now: string;
  sourceSha: string | null;
  previous?: StatusOptions["previous"];
  /** Every earlier snapshot's own time, oldest first (RULES.md 1.1: a log that runs backwards). */
  earlierTimes?: StatusOptions["earlierTimes"];
  /** Every earlier snapshot's best height and RPC genesis, oldest first (RULES.md 1.1). */
  earlierBest?: StatusOptions["earlierBest"];
}

/** The weakest trust among the parts: one fixture input makes the whole snapshot "fixture". */
function weakest(trusts: Trust[]): Trust {
  return trusts.includes("fixture") ? "fixture" : "trusted RPC";
}

export async function buildSnapshot(parts: SnapshotParts, o: SnapshotOptions): Promise<NewSnapshot> {
  const { status, rpcUsable } = await assessNetwork(parts.status, {
    pinnedGenesis: o.pinnedGenesis,
    now: o.now,
    previous: o.previous ?? null,
    earlierTimes: o.earlierTimes ?? null,
    earlierBest: o.earlierBest ?? null,
  });
  // RULES.md section 2: a finalized height bounds escrow evidence only from a usable RPC head on
  // the pinned genesis (assessNetwork says what usable means). Another chain's height, or a
  // stale, failed or contradicted reading, never bounds these escrows.
  const bound = status.genesis.rpc !== null && status.genesis.rpc === status.genesis.pinned && rpcUsable ? status.finalized_height : null;
  let escrows: EscrowState[] = [];
  const labels = [parts.status.label];
  const trusts: Trust[] = [parts.status.trust];
  if (parts.escrows) {
    const pages = await parts.escrows.source.eventPages();
    escrows = escrowStates(parts.escrows.ids, pages, {
      pinnedGenesis: o.pinnedGenesis,
      finalizedHeight: bound,
      observedAt: o.now,
      trust: parts.escrows.source.trust,
      // An unreadable page could hold a conflicting event, so it is never dropped silently.
      unreadablePages: await parts.escrows.source.eventPageErrors(),
    });
    labels.push(parts.escrows.source.label);
    trusts.push(parts.escrows.source.trust);
  }
  if (parts.census) {
    labels.push(parts.census.label);
    trusts.push(parts.census.report.trust);
  }
  if (parts.drift) {
    labels.push(parts.drift.label);
    trusts.push(parts.drift.report.trust);
  }
  const pin: RunPin = {
    source_sha: o.sourceSha,
    source: labels.join(" + "),
    // The RPC's genesis, which the finalized head below belongs to. Never mixed with the faucet's.
    genesis: status.genesis.rpc,
    finalized_height: status.finalized_height,
    finalized_hash: status.finalized_hash,
    node: process.version,
  };
  return {
    schema: "flop-observatory/snapshot@0",
    observed_at: o.now,
    trust: weakest(trusts),
    pin,
    status,
    escrows,
    census: parts.census?.report ?? null,
    drift: parts.drift?.report ?? null,
  };
}
