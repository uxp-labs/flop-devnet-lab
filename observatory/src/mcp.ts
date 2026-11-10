// Read-only MCP over JSON-RPC 2.0. Pure: request in, response out. No tool writes.
import { censusFeed, driftFeed, escrowsFeed, feedText, snapshotMeta, statusFeed } from "./feed.js";
import type { EscrowState, Snapshot } from "./types.js";

export interface McpContext {
  snapshot: Snapshot;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ESCROW_ID = /^0x[0-9a-fA-F]{64}$/;

const noArgs = { type: "object", properties: {}, additionalProperties: false };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  { name: "get_status", description: "Network status: genesis, reset_detected (null means unknown), finality, service health. Carries observed_at and trust.", inputSchema: noArgs, annotations: READ },
  {
    name: "get_escrow_state",
    description: "One escrow state from finalized chain events. Settlement only; says nothing about output quality.",
    inputSchema: { type: "object", properties: { escrow_id: { type: "string", description: "0x plus 64 hex" } }, required: ["escrow_id"], additionalProperties: false },
    annotations: READ,
  },
  { name: "list_escrows", description: "All escrow states in the snapshot. Settlement only.", inputSchema: noArgs, annotations: READ },
  { name: "get_census", description: "Event census. null when not computed. Partial totals are labeled partial.", inputSchema: noArgs, annotations: READ },
  { name: "get_drift", description: "Spec drift report. null when not computed.", inputSchema: noArgs, annotations: READ },
  { name: "get_snapshot_meta", description: "Snapshot hash, seq, previous hash, observed_at, trust and run pin.", inputSchema: noArgs, annotations: READ },
] as const;

function ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function content(obj: unknown) {
  return { content: [{ type: "text", text: feedText(obj) }] };
}

/** Escrow ids are matched case-insensitively. An id not in the snapshot is unverified, with a note. */
function escrowFor(s: Snapshot, id: string): EscrowState {
  const hit = s.escrows.find((e) => e.escrow_id.toLowerCase() === id.toLowerCase());
  if (hit) return hit;
  return {
    schema: "flop-observatory/escrow-state@0",
    escrow_id: id,
    state: "unverified",
    evidence: [],
    notes: ["escrow id not present in this snapshot; no finalized evidence seen"],
    finalized_height: s.status.finalized_height,
    observed_at: s.observed_at,
    trust: s.trust,
    scope: "settlement only; says nothing about output quality",
  };
}

/** Returns null for notifications (no response). */
export function handleMcp(request: unknown, ctx: McpContext): JsonRpcResponse | null {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return err(null, -32600, "invalid request");
  const r = request as Record<string, unknown>;
  const hasId = "id" in r && (typeof r.id === "string" || typeof r.id === "number");
  const id = hasId ? (r.id as string | number) : null;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return err(id, -32600, "invalid request");
  const method = r.method;
  if (!hasId) return null; // notifications never get a response
  const params = r.params && typeof r.params === "object" && !Array.isArray(r.params) ? (r.params as Record<string, unknown>) : {};

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "flop-observatory", version: "0.0.1" },
        instructions: "Read-only observatory for FLOP devnet. Escrow state is settlement only and says nothing about output quality. null means unknown.",
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return err(id, -32602, "params.name must be a string");
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const s = ctx.snapshot;
      switch (name) {
        case "get_status":
          return ok(id, content(statusFeed(s)));
        case "get_escrow_state": {
          const eid = args.escrow_id;
          if (typeof eid !== "string" || !ESCROW_ID.test(eid)) return err(id, -32602, "escrow_id must be 0x plus 64 hex");
          return ok(id, content(escrowFor(s, eid)));
        }
        case "list_escrows":
          return ok(id, content(escrowsFeed(s)));
        case "get_census":
          return ok(id, content(censusFeed(s)));
        case "get_drift":
          return ok(id, content(driftFeed(s)));
        case "get_snapshot_meta":
          return ok(id, content(snapshotMeta(s)));
        default:
          return err(id, -32602, `unknown tool: ${name}`);
      }
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}

/** One line of the stdio protocol: JSON text in, one JSON line out (or null for no output). */
export function handleLine(line: string, ctx: McpContext): string | null {
  if (line.trim() === "") return null;
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    return JSON.stringify(err(null, -32700, "parse error"));
  }
  const res = handleMcp(req, ctx);
  return res === null ? null : JSON.stringify(res);
}
