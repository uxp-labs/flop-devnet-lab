// The MCP exchanges scripts/mcp-transcript.mjs makes with the real binary, in order. The output
// check (scripts/consistency.mjs) holds a transcript to exactly this list, so an exchange added,
// dropped, reordered or edited fails it (round 7 review M2).
//
// Every tool, every escrow id in the snapshot, one well formed id the snapshot does not hold, one
// unknown tool and one malformed id. Each entry is { req, expectError }.

/** An escrow id the snapshot does not hold, so the unseen escrow rule is asked of the real binary. */
export function unseenEscrowId(snapshot) {
  const held = new Set((snapshot.escrows ?? []).map((e) => String(e.escrow_id).toLowerCase()));
  for (const b of ["ee", "ed", "ec"]) {
    const id = "0x" + b.repeat(32);
    if (!held.has(id)) return id;
  }
  throw new Error("no unseen escrow id left");
}

export function exchangesFor(snapshot) {
  let id = 0;
  const out = [];
  const add = (method, params, expectError = false) => {
    out.push({ req: { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }, expectError });
  };
  add("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "observatory-check", version: "0" } });
  add("tools/list");
  for (const name of ["get_status", "list_escrows", "get_census", "get_drift", "get_snapshot_meta"]) add("tools/call", { name, arguments: {} });
  for (const e of snapshot.escrows ?? []) add("tools/call", { name: "get_escrow_state", arguments: { escrow_id: e.escrow_id } });
  add("tools/call", { name: "get_escrow_state", arguments: { escrow_id: unseenEscrowId(snapshot) } });
  add("tools/call", { name: "sign_transaction", arguments: {} }, true);
  add("tools/call", { name: "get_escrow_state", arguments: { escrow_id: "not-an-id" } }, true);
  return out;
}
