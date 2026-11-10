# Observatory rules

These rules are the spec. Code and tests follow them, and the independent recount in
`tools/recount.py` is written from this file alone, not from the TypeScript.

## 1. Unknown is never good news

- A value we could not read is `null`, shown blank. It is never `ok`, never `0`, never "complete".
- `reset_detected` is `false` only when both the faucet and the RPC report the pinned genesis.
  If either disagrees it is `true`. If neither can be read it is `null`, and callers treat `null`
  like `true` before spending.

## 2. Evidence boundaries for escrows

- Only finalized events count. An event in a block that is not finalized is pending, never proof.
- Only events on the pinned genesis count. Events from another genesis are excluded and noted.
- Events are identified by `(genesis, block_hash, index)`. The same event seen twice counts once.
- `funded` needs a finalized `hasStation.EscrowOpened` for the escrow id and no finalized terminal event.
- `claimed` needs a finalized `hasStation.EscrowReleased` for the escrow id.
- `refunded` needs a finalized `hasStation.EscrowRefunded` for the escrow id.
- Missing evidence leaves the escrow `unverified`.
- Conflicting evidence leaves it `unverified` with a note: for example both a finalized release
  and a finalized refund for one id, or an event whose escrow id does not parse.
- A malformed event (escrow id not `0x` plus 64 hex, missing fields, wrong types) is ignored with a
  note. It can never make an escrow look funded, claimed or refunded.
- Gateway receipts, gateway "settled" fields and any other non-chain report are not chain proof.
  They cannot move an escrow to any state.
- Every escrow result carries `scope: "settlement only; says nothing about output quality"`.

## 3. Census

- Input is the retained raw event pages for one requested block range. Raw pages are kept so
  any count can be recomputed.
- A page chain for a range starts at page 0 and follows `next_page` until it is `null`. A range
  whose chain is broken (a missing page) is not covered.
- Covered ranges are the union of ranges with complete page chains. Gaps are the requested
  range minus covered. `complete` is true only with no gaps; otherwise `status` is `"partial"`
  and every total is labeled partial. Partial counts are never presented as complete.
- Deduplicate events by `(genesis, block_hash, index)` across and within pages, and report
  `duplicates_dropped`.
- Count only finalized events. Unfinalized events go to `pending_unfinalized`.
- Count only pages on the pinned genesis. Pages on any other genesis go to
  `excluded_other_genesis` (counted in events) and set the census `reset_detected` note. Counts
  never mix geneses.
- Malformed events (missing section, method, block hash or index) go to `malformed_dropped`.
- Event names counted:

| Kind | Event | Confirmed |
|---|---|---|
| escrows_opened | hasStation.EscrowOpened | yes, tclk/flop/src/chain.ts |
| escrows_released | hasStation.EscrowReleased | yes, tclk/flop/VERIFICATION.md |
| escrows_refunded | hasStation.EscrowRefunded | yes, tclk/flop/VERIFICATION.md |
| channels_opened | computeChannel.ChannelOpened | no, assumed until M1 reads metadata |
| channels_settled | computeChannel.ChannelSettled | no, assumed until M1 reads metadata |

- `by_account` counts by the first account field in the event data (`who`, `owner`, `agent`,
  `payer`, in that order). Events with none of these count in totals only.

### 3.1 Clarifications (binding; both implementations follow them)

1. Only events on pages of complete chains, inside the requested range, are counted anywhere
   (totals, pending, duplicates, malformed). Events on a broken chain count nowhere.
2. A chain is keyed by `(genesis, from_block, to_block)`. It is complete when it starts at page 0,
   every `next_page` exists, there is no cycle, and it ends at `null`. Pages not reachable from page 0
   are ignored. Two copies of one page number that disagree on `next_page` break the chain;
   identical copies are kept and their events dedupe.
3. Each complete chain's range is clipped to the request, and overlapping or adjacent ranges merge
   (1 to 5 and 6 to 10 become 1 to 10). With no pages at all, the whole request is one gap.
4. An event whose integer `block_number` is outside the request or outside its page's range is
   skipped, not malformed. A `null` block_number is kept.
5. Genesis values are compared exactly as written. Fixtures use lower case.
6. `excluded_other_genesis` is the number of events on all pages of any other genesis, whatever
   their chain or finality. Those pages never add coverage.
7. An event is malformed when it is not an object; when `section`, `method` or `block_hash` is
   missing, not a string or empty; when `index` is missing, not an integer (a boolean is not an
   integer) or negative; or when `block_number` is neither null nor an integer. A non-object `data`
   is not malformed; the event simply has no account.
8. A missing or non-boolean `finalized` means not finalized: the event is pending.
9. All copies of one key form a group; `duplicates_dropped` adds copies minus one per group. If any
   copy is not finalized, the group is one pending event. If copies disagree on section, method
   or account, the group counts once in `malformed_dropped` and nowhere else. Malformed events have
   no key and are never deduplicated.
10. Order: block range filter, then malformed, then dedupe, then pending or finalized, then kind.
    Finalized events of kinds not in the table count nowhere.
11. The account is the first of `who`, `owner`, `agent`, `payer` whose value is a non-empty string.
    `by_account` lists only non-zero kinds; accounts sort ascending.
12. A structurally invalid page (not an object, `genesis` not a string, `from_block`, `to_block`,
    `page` or `next_page` missing or of the wrong type, `events` not a list, or an inverted range)
    makes the whole census refuse with an error. It is never turned into a partial count.
13. A request with a negative `from_block` or `from_block` greater than `to_block` is refused.

## 4. Read only

The observatory never signs, spends or writes. RPC calls outside the allowlist in `src/guard.ts`,
any HTTP method other than GET or HEAD, and any signing or spending call are refused and recorded.
Tests fail if any attempt is left in the log.

## 5. Outputs agree

The page, the JSON feeds and the MCP tools are rendered from the same snapshot. For every
escrow and for the network status they show the same state, the same `observed_at` and the same
trust label. Unknown values are blank on the page and `null` in JSON and MCP.
