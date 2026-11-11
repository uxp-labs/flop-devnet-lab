// Shared types for FLOP Observatory. Every module imports from here.
//
// House rules (see RULES.md):
// - Unknown is null. Never "ok", never 0, never an empty string standing in for a value.
// - Only finalized chain events on the pinned genesis count as evidence.
// - Gateway reports are not chain proof, and settlement says nothing about output quality.
// - Every output carries observed_at and a trust label.
//
// Section owners: the lead owns everything outside the marked sections. The escrow
// module owns ESCROW TYPES, the census and drift module owns CENSUS TYPES and
// DRIFT TYPES. Change another section only through a handoff note.

/** Where a value came from. Live reads in M1 are "trusted RPC": we trust one node and say so. */
export type Trust = "trusted RPC" | "fixture";

export type Health = "ok" | "degraded" | "down" | "unknown";

/** One HTTP read, kept as returned. */
export interface HttpResult<T> {
  /** HTTP status, or null when there was no response. */
  http: number | null;
  /** Parsed body, or null when absent or unparsable. */
  body: T | null;
  /** Transport or parse error, or null. */
  error: string | null;
  /** When the response was taken (ISO 8601), or null when unknown. */
  fetched_at: string | null;
}

/** Shape of faucet.flop.network GET /health, as far as we read it. Extra fields pass through. */
export interface FaucetHealthBody {
  status?: string;
  ready?: boolean;
  live?: boolean;
  signer?: string;
  limits?: Record<string, number | boolean>;
  [key: string]: unknown;
}

/** Shape of faucet.flop.network GET /chain. */
export interface FaucetChainBody {
  network?: string;
  chain?: string;
  genesisHash?: string;
  caip2?: string;
  ss58Format?: number;
  decimals?: number;
  tokenSymbol?: string;
  rpc?: string;
  [key: string]: unknown;
}

/** What the RPC said about the chain head, read in one pass. */
export interface RpcHead {
  /** Hash of block 0. */
  genesis_hash: string | null;
  finalized: { number: number; hash: string } | null;
  best_number: number | null;
  runtime_spec_version: number | null;
  /** When this head was read (ISO 8601). */
  observed_at: string | null;
  /** Transport error, if the read failed. */
  error: string | null;
  /**
   * Set only when a saved reading exists but cannot be read (a fixture file that is not strict
   * UTF-8 JSON with one value per key): the file and why. Nothing else is set, so the head counts
   * as nothing read, and the reason shows as the RPC detail.
   */
  unreadable?: string;
}

/**
 * The anchor read back (RULES.md 1.1): what chain_getBlockHash(height) answered for the latest
 * finalized height an earlier snapshot logged on the pinned genesis. Only a live run reads one.
 */
export interface AnchorReading {
  height: number;
  /** The answer as given: a block hash, or null when the node has no block there. Null too when the read failed. */
  hash: unknown;
  /** Why the read failed on the way, or null when an answer came back. */
  error: string | null;
}

/** One chain event, kept verbatim as a raw input. */
export interface RawEvent {
  block_number: number | null;
  /** 0x + 64 hex. */
  block_hash: string;
  finalized: boolean;
  /** Event index within its block. (genesis, block_hash, index) identifies an event. */
  index: number;
  /** Pallet, e.g. "hasStation". */
  section: string;
  /** Event name, e.g. "EscrowReleased". */
  method: string;
  data: Record<string, unknown>;
}

/** One page of events for a block range, kept verbatim so counts can be recomputed. */
export interface EventPage {
  /** Genesis hash of the chain these blocks belong to. */
  genesis: string;
  /** Inclusive block range this page chain covers. */
  from_block: number;
  to_block: number;
  /** 0-based page index within that range's page chain. */
  page: number;
  /** Index of the next page, or null when this is the last page. */
  next_page: number | null;
  events: RawEvent[];
}

/** Runtime constants as read from chain metadata (api.consts), keyed "pallet.constant". */
export interface RuntimeConstants {
  observed_at: string | null;
  runtime_spec_version: number | null;
  values: Record<string, unknown>;
}

export interface ServiceStatus {
  health: Health;
  http: number | null;
  /** Short human-readable reason, or null. */
  detail: string | null;
  observed_at: string | null;
}

/** networkStatus(): one of the two interfaces the Grok team imports. */
export interface NetworkStatus {
  schema: "flop-observatory/network-status@0";
  observed_at: string;
  trust: Trust;
  genesis: { pinned: string; faucet: string | null; rpc: string | null };
  /**
   * true: some source reports a genesis other than the pinned one.
   * false: both faucet and RPC report the pinned genesis.
   * null: not enough evidence to say. Callers must treat null like true before spending.
   */
  reset_detected: boolean | null;
  /** Disagreements between sources, in plain words. Empty when none were seen. */
  conflicts: string[];
  finalized_height: number | null;
  finalized_hash: string | null;
  best_height: number | null;
  finality_lag: number | null;
  runtime_version: number | null;
  rpc: ServiceStatus & { stale: boolean | null };
  gateway: ServiceStatus;
  faucet: ServiceStatus & { ready: boolean | null; limits: Record<string, number | boolean> | null };
}

// ===== ESCROW TYPES (owner: escrow module) =====

export type EscrowStateName = "unverified" | "funded" | "claimed" | "refunded";

/** One finalized event that supports an escrow state. */
export interface EscrowEvidence {
  /** "section.method", e.g. "hasStation.EscrowReleased". */
  event: string;
  block_hash: string;
  block_number: number | null;
  event_index: number;
  genesis: string;
}

/** escrowState(): the other interface the Grok team imports. */
export interface EscrowState {
  schema: "flop-observatory/escrow-state@0";
  escrow_id: string;
  state: EscrowStateName;
  /** Finalized events behind the state. Empty when unverified. */
  evidence: EscrowEvidence[];
  /** Why the state is what it is: ignored events, conflicts, missing evidence. */
  notes: string[];
  finalized_height: number | null;
  observed_at: string;
  trust: Trust;
  scope: "settlement only; says nothing about output quality";
}

/**
 * Inputs to escrowState() besides the id and the raw event pages. There is no field for
 * gateway receipts or any other non-chain report: they are not evidence (RULES.md section 2).
 */
export interface EscrowStateOptions {
  /** The only genesis whose events count. 0x + 64 hex. */
  pinnedGenesis: string;
  /** Finalized height the pages were read at, or null when unknown. */
  finalizedHeight: number | null;
  /** When the pages were read (ISO 8601). */
  observedAt: string;
  trust: Trust;
  /**
   * Event page files that could not be read or parsed, as "file: reason". When not empty,
   * every escrow is unverified: the missing page could hold a conflicting event.
   */
  unreadablePages?: string[];
}

// ===== END ESCROW TYPES =====

// ===== CENSUS TYPES (owner: census and drift module) =====

export interface CensusCounts {
  escrows_opened: number;
  escrows_released: number;
  escrows_refunded: number;
  channels_opened: number;
  channels_settled: number;
}

export interface BlockRange {
  from_block: number;
  to_block: number;
}

export interface CensusReport {
  schema: "flop-observatory/census@0";
  observed_at: string;
  trust: Trust;
  genesis: string;
  requested: BlockRange;
  covered: BlockRange[];
  gaps: BlockRange[];
  /** True only when the whole requested range is covered by complete page chains. */
  complete: boolean;
  status: "complete" | "partial";
  /** Finalized, deduplicated events on the pinned genesis only. Partial when status is "partial". */
  totals: CensusCounts;
  by_account: Record<string, Partial<CensusCounts>>;
  pending_unfinalized: number;
  duplicates_dropped: number;
  excluded_other_genesis: number;
  malformed_dropped: number;
  /** "section.method" counted for each kind, with whether the name is confirmed from metadata. */
  event_names: Record<keyof CensusCounts, { event: string; confirmed: boolean }>;
  /**
   * The label every total carries, for totals and by_account alike. Always equal to status:
   * "partial" whenever any part of the request is a gap. Partial counts are never presented as complete.
   */
  totals_label: "complete" | "partial";
  /** Blocks in the request, and how many of them complete page chains cover. */
  requested_blocks: number;
  covered_blocks: number;
  /**
   * true: some page is on a genesis other than the pinned one (a possible chain reset).
   * false: every page is on the pinned genesis. null: there were no pages, so nothing to say.
   */
  reset_detected: boolean | null;
  /** Why the census looks as it does: broken chains, ignored pages, skipped events, other geneses, gaps. */
  notes: string[];
}

// ===== END CENSUS TYPES =====

// ===== DRIFT TYPES (owner: census and drift module) =====

export interface DriftItem {
  /** Parameter name as in flop-protocol-params.yaml. */
  param: string;
  /** Where the runtime value is read, e.g. "api.consts.balances.existentialDeposit". */
  runtime_path: string | null;
  /** The canonical value as written in the spec, JSON safe (an integer past 2^53 is a decimal string). */
  spec: unknown;
  /** The runtime value as read, or null when it was not read. */
  runtime: unknown;
  status: "match" | "mismatch" | "unknown";
  note: string | null;
  /** The kind of check site: an api.consts constant, api.query storage, source only, or no mapping. */
  mapping: "constant" | "storage" | "source_only" | "none";
  /** unit as written in the spec, or null. */
  unit: string | null;
  /**
   * The value the runtime should hold, in base units after meta.decimals, multiplier and divisor,
   * as a decimal string. null when it cannot be worked out exactly.
   */
  expected: string | null;
}

export interface DriftReport {
  schema: "flop-observatory/drift@0";
  observed_at: string;
  trust: Trust;
  genesis: string | null;
  finalized_height: number | null;
  runtime_version: number | null;
  spec_source: string;
  /** When the runtime constants were read, or null when unknown. */
  runtime_observed_at: string | null;
  items: DriftItem[];
  matches: number;
  mismatches: number;
  unknown: number;
}

// ===== END DRIFT TYPES =====

/** One line of the snapshot log: everything observed in one pass, hash-chained to the line before. */
export interface Snapshot {
  schema: "flop-observatory/snapshot@0";
  seq: number;
  prev_hash: string | null;
  /** sha256 over the canonical JSON of this snapshot without the hash field. */
  hash: string;
  observed_at: string;
  trust: Trust;
  /** Source revision and inputs that produced this snapshot. */
  pin: RunPin;
  status: NetworkStatus;
  escrows: EscrowState[];
  census: CensusReport | null;
  drift: DriftReport | null;
}

/** Enough to rerun a snapshot exactly: code revision, tools, and the chain point it describes. */
export interface RunPin {
  source_sha: string | null;
  source: string;
  genesis: string | null;
  finalized_height: number | null;
  finalized_hash: string | null;
  node: string;
}
