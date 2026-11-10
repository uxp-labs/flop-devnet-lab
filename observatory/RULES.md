# Observatory rules

These rules are the spec. Code and tests follow them, and the independent recount in
`tools/recount.py` is written from this file alone, not from the TypeScript.

## 1. Unknown is never good news

- A value we could not read is `null`, shown blank. It is never `ok`, never `0`, never "complete".
- `reset_detected` is `false` only when both a usable faucet `/chain` reading and a usable RPC
  head report the pinned genesis (1.1 says what usable means). If a usable reading reports
  another genesis it is `true`. Otherwise it is `null`, and callers treat `null` like `true`
  before spending. An unusable reading counts for neither: it never makes the value `false`, and
  never `true` either, though its genesis still shows in `genesis` and a disagreement with the
  other source is still a conflict.

### 1.1 Health

Each service has one health value: `ok`, `degraded`, `down` or `unknown`. `ok` needs every
check below to run and pass.

- Times are ISO 8601 with an explicit zone: `Z` or an offset such as `+00:00`. A time without a
  zone does not parse, because its meaning would depend on the machine's time zone. A time must
  also be a real instant: a date such as 2026-11-31, an hour of 24, a minute or second of 60, or
  an offset beyond 23:59 does not parse (it is never rolled over). The snapshot time must parse,
  or the status refuses.
- The faucet genesis comes from `GET /chain` only when that reading is HTTP 200 with no error and
  a reading time that parses, is at most the stale limit old, and is not later than the snapshot
  time. Otherwise the faucet genesis is `null`, so `reset_detected` cannot be `false`. A `/chain`
  reading time later than the snapshot time is also a conflict.
- The RPC genesis counts toward `reset_detected` only from a usable head: no read error, and an
  `observed_at` that parses, is at most the stale limit old and is not later than the snapshot
  time. `genesis.rpc` still shows what the head said. The same usable head is the only one whose
  finalized height may bound escrow evidence (section 2).
- Heights and the runtime version are safe integers (census clause 14). A finalized or best
  height past 2^53 - 1 was already rounded by the JSON parser, so it is not a valid one.
- A reading time later than the snapshot time is a conflict, noted in `conflicts`, whatever that
  reading's health.

- Faucet: `ok` needs HTTP 200 and a body with `status` "ok" and `ready` true. A body that says ok
  with any other HTTP status is `degraded`. A body with `status` "degraded", or `ready` false, is
  `degraded`; `status` "down" is `down`. No response, or a body we cannot read on a non 5xx status,
  is `unknown`; an unreadable body on a 5xx status is `down`.
- Gateway: `ok` needs HTTP 200. 429 and 503 are `degraded`, any other 5xx is `down`, any other
  status is `degraded`, and no response is `unknown`.
- Faucet and gateway freshness: `ok` also needs a reading time (`fetched_at`) that parses, is not
  later than the snapshot time, and is at most the stale limit old. A reading older than that is
  `degraded`. A reading time later than the snapshot time is a conflict and `degraded`. A reading
  with no parsable time is `unknown`. Only HTTP 200 counts: 204 or any other 2xx is not `ok`.
- RPC: when nothing was read it is `unknown`, or `down` when the read was tried and failed.
  Otherwise these checks apply:
  - the read had no error
  - the genesis hash is present and valid
  - the finalized head (height and hash) is present and valid
  - the best height is present, valid, not below the finalized height, and at most the lag limit
    ahead of it (30 blocks by default)
  - `observed_at` parses, is not later than the snapshot time, and is at most the stale limit old
    (120 seconds by default)
  - when earlier snapshots recorded a finalized head on the same genesis: no rollback below the
    highest finalized height any of them saw, no changed hash at this height in any of them, and
    no finalized height stuck for longer than the stale limit, counted from the oldest of the
    latest run of snapshots at this same height. If a head time in that run does not parse, the
    stuck check cannot run. The snapshot command reads the earlier snapshots from its log, after
    verifying the log's hash chain (a broken log refuses), and passes every one that recorded a
    finalized head, oldest first, so a snapshot in between with no RPC reading, or one on another
    genesis, hides nothing.
- Any failed check makes RPC health `degraded`. A missing or invalid genesis hash, finalized head
  or best height is a failed check. A missing or unparsable `observed_at` means the age check
  cannot run: health is `unknown` when nothing else failed.
- An `observed_at` later than the snapshot time is a conflict, noted in `conflicts`, and makes RPC
  health `degraded`.
- `rpc.stale` is `true` when the head is older than the stale limit or the finalized height is
  stuck, `false` only when the age was computed and is within the limit and nothing is stuck, and
  `null` otherwise, including for a head time later than the snapshot time.

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
- Copies of one event (same genesis, block_hash and index) must agree on section, method, escrow
  id and block_number. When copies disagree, every escrow that any copy names is `unverified` with a
  note. One chain event is never evidence for two escrows.
- A finalized `hasStation.EscrowReleased` or `hasStation.EscrowRefunded` on the pinned genesis
  whose escrow id does not parse cannot be tied to one escrow, so it could contradict any of them:
  every escrow in the result that it could contradict is `unverified` with a note. A release
  could be a second distinct release, so it contradicts a claimed escrow as surely as a refund
  does, and the same holds for a refund against a refunded escrow. This holds for
  every such copy, whether the other copies of that event agree with it, disagree with it, or are
  well formed. More conflicting evidence never gives a more confident answer.
- An event whose integer `block_number` is outside its page's block range is never evidence, and
  it is suspect. Copies are grouped before the range check, so an out-of-range copy still counts
  for the copy agreement rule and the unparsable id rule, and an out-of-range finalized release or
  refund that names an escrow leaves that escrow `unverified` with a note. The census skips such
  an event (clause 4), so neither reads it as a release or refund.
- Genesis values and block hashes are compared exactly as written, as in census clause 5.
- Integers in event and page fields follow census clause 14: an unsafe integer (beyond 2^53 - 1)
  makes an event malformed and a page invalid. A negative integer `block_number` is an integer:
  it is outside its page's range (the rule above), not malformed.
- Two distinct finalized opens for one escrow are conflicting evidence whether or not a release or
  refund exists: the escrow is `unverified` with a note.
- A finalized release or refund that names an escrow but lies above the finalized height leaves
  the escrow `unverified` with a note: the page calls it final, but our finalized head does not
  reach it yet.
- A finalized height bounds the evidence only when it comes from a usable RPC head on the pinned
  genesis: no read error, and a head time that parses, is not later than the snapshot time and is
  at most the stale limit old. Otherwise (the RPC was not read, the reading is not usable, or it
  reports another genesis) `finalized_height` is `null`, and a result with evidence notes that its
  evidence is not bounded by a finalized height.
- An event with no `block_number` key is malformed (census clause 7). One whose `block_number`
  is `null` is kept, but no finalized height can bound it, and a result whose evidence includes
  one says so.
- Escrow evidence follows census clause 2 on the pinned genesis. If any chain there is broken (no
  page 0, a `next_page` that names a page that does not exist, a cycle, or copies of one page
  number that disagree on `next_page`), every escrow is `unverified` with a note: the missing
  page could hold a conflicting event. An event on a page that is not reachable from page 0 is
  never evidence, and a finalized release or refund there that names an escrow leaves it
  `unverified`, as for an event outside its page's range.
- If any copy of an event is not finalized, the event is pending, never proof. This is the same
  rule as census clause 9.
- If any event page in the input could not be read or parsed, or is structurally invalid (census
  clause 12), every escrow in the result is `unverified` with a note naming the file. The missing
  page could hold a conflicting event.
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
- Malformed events (missing section, method, block hash or index; clause 7 has the full list) go
  to `malformed_dropped`.
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

1. Only events on pages of complete chains whose range intersects the requested range are counted
   anywhere (totals, pending, duplicates, malformed). Events on a broken chain, or on a chain whose
   range does not intersect the request, count nowhere, whatever their block_number.
2. A chain is keyed by `(genesis, from_block, to_block)`. It is complete when it starts at page 0,
   every `next_page` on the walk from page 0 exists, there is no cycle, and it ends at `null`. Pages
   not reachable from page 0 are otherwise ignored. Two copies of one page number that disagree on `next_page` break the chain, whether
   or not the walk from page 0 reaches that page number; identical copies are kept and their events
   dedupe. A `next_page` that names a page that does not exist, including a negative number, breaks
   the chain.
3. Each complete chain's range is clipped to the request, and overlapping or adjacent ranges merge
   (1 to 5 and 6 to 10 become 1 to 10). With no pages at all, the whole request is one gap.
4. An event whose integer `block_number` is outside the request or outside its page's range is
   skipped, not malformed. A `null` block_number is kept, on a chain that intersects the request
   (clause 1). Copies of one event (one key, clause 9) that lie partly inside and partly outside
   (their own page's range or the request) are inconsistent: the group counts once in
   `malformed_dropped`, its copies beyond the first count in `duplicates_dropped` as for any group
   (clause 9), and it counts nowhere else. A group whose copies all lie outside is skipped and
   counts nowhere, not even in `duplicates_dropped`.
5. Genesis values are compared exactly as written. Fixtures use lower case.
6. `excluded_other_genesis` is the number of events on all pages of any other genesis, whatever
   their chain or finality. Those pages never add coverage.
7. An event is malformed when it is not an object; when `section` or `method` is missing, not a
   string or empty; when `block_hash` is not `0x` followed by 64 lower case hex digits; when
   `index` is missing, not an integer (a boolean is not an integer) or negative; or when
   `block_number` is missing, or present but neither null nor an integer. A non-object `data` is
   not malformed; the event simply has no account. The escrow rules read events the same way.
8. A missing or non-boolean `finalized` means not finalized: the event is pending.
9. All copies of one key form a group; `duplicates_dropped` adds copies minus one per group. If any
   copy is not finalized, the group is one pending event. If copies disagree on section, method
   or account, the group counts once in `malformed_dropped` and nowhere else. Malformed events have
   no key and are never deduplicated.
10. Order: malformed, then group by key, then the block range rule of clause 4 (a group all
    outside is skipped, a mixed group is malformed), then dedupe, then pending or finalized, then
    kind. An event that is malformed and also has an integer `block_number` outside the request or
    its page's range is skipped, not malformed. Finalized events of kinds not in the table count
    nowhere.
11. The account is the first of `who`, `owner`, `agent`, `payer` whose value is a non-empty string.
    `by_account` lists only non-zero kinds; accounts sort ascending.
12. A structurally invalid page (not an object, `genesis` not a string, `from_block`, `to_block`,
    `page` or `next_page` missing or of the wrong type, a negative `page`, a negative `from_block`
    (block numbers start at 0), `events` not a list, or an inverted range) makes the whole census refuse with an error. So does an event page file that
    cannot be read, decoded as strict UTF-8, or parsed as standard JSON (RFC 8259: the text is
    UTF-8 with no byte order mark, and `NaN` and `Infinity` are not JSON). A byte that is not
    valid UTF-8 refuses; it is never replaced and read around. So does a key that appears twice
    in one object, after its escapes are read: parsers differ on which copy wins, so the file has
    no one meaning. So does a file whose arrays and objects nest deeper than 64 levels, checked
    before parsing, so no parser's own stack limit decides. An integer literal too long to be a
    safe integer is just that, an unsafe integer (clause 14), however many digits it has.
    Neither is ever turned into a partial count.
13. A request with a negative `from_block` or `from_block` greater than `to_block` is refused.
14. An integer is a JSON number with no fractional part, judged by value: `1.0` is the integer 1,
    `1.5` is not an integer, and a boolean is never an integer. It must also be safe: from
    -(2^53 - 1) to 2^53 - 1. A larger value is not an integer, so a page field holding one refuses
    the census and an event field holding one makes the event malformed. This holds for every
    integer field in these rules (`index`, `block_number`, `page`, `next_page`, `from_block`,
    `to_block`) and for the request.
15. Every entry in `event-pages/` must be a page file: a regular file whose name ends in `.json` and
    does not start with a dot. Any other entry (a dotfile, another extension, a folder) refuses the
    census and leaves every escrow `unverified`, because it may be a page that was meant to count.
    A symbolic link is not a regular file, even when it points to one. `event-pages` itself must
    be a folder, not a file or a link; otherwise the census refuses and every escrow is
    `unverified`.
16. A refusal names its reason, and the Python recount names the same one:
    - `request`: the request is invalid (clause 13);
    - `page-file`: an event page file cannot be read, decoded or parsed, an entry in
      `event-pages/` is not a page file, or `event-pages` is not a real folder (clauses 12 and
      15). The refusal names the first such entry in name order, or `event-pages` itself;
    - `page-structure`: a page file parses, but the page is structurally invalid (clause 12);
    - `input`: anything else the census cannot start from, such as no pinned genesis.
    A request problem is named before any page problem, and a page file problem before any page
    structure problem, so both implementations name the same reason for the same input.

## 4. Read only

The observatory never signs, spends or writes. RPC calls outside the allowlist in `src/guard.ts`,
any HTTP method other than GET or HEAD, and any signing or spending call are refused and recorded.
Tests fail if any attempt is left in the log.

- In tests every network and process path is blocked at runtime and recorded, not only fetch and
  WebSocket: `node:http`, `node:https` and `node:http2` requests, `node:net` and `node:tls`
  connections and listeners, `node:dgram` sockets, `node:dns` lookups, worker threads, and every
  `node:child_process` call (spawn, exec, execFile, fork and their sync forms). Named imports see
  the block too. So do the lower layers: `dgram.Socket` send, bind and connect, `dns.Resolver`
  queries, `ChildProcess.prototype.spawn`, `process.binding`, `process.dlopen` and
  `inspector.open`.
- A source scan fails any `src` module, other than `guard.ts`, that imports one of those modules or
  calls fetch, WebSocket, a signing API or a key API. It also fails the indirect forms:
  `process.getBuiltinModule`, `createRequire`, an `import()` or `require()` whose argument is not
  a plain string, `process.binding`, `eval` and `Function`, called or not.
- The source scan fails any use of the bare names `fetch`, `WebSocket`, `EventSource`,
  `XMLHttpRequest` and `globalThis` in `src`, and any member or computed access on `global`,
  `self` or `window`, so an aliased, `.call` or computed form cannot slip past it.
- Every attempt, every reset of the log and every test file's final check is written to a
  journal the moment it happens. Once every test file has ended, and again after the test run
  exits, the journal is checked:
  - an attempt still in a file's log at its final check fails;
  - anything after a file's final check fails, an attempt or a reset made from a timer, say,
    which no test hook can see;
  - a reset or a final check whose count disagrees with the attempts journaled before it fails,
    because it means the journal lost an attempt;
  - every test file must reach its final check.
- The harness canary proves that a test leaving any of these in the log fails: a fetch, an
  `node:https` request, a `node:net` connection, a child process, a refused RPC write, a refused
  signature and a refused spend. It proves the same for a blocked call fired from a timer after
  the file's final check, with and without a reset there, and that the timer case passes once
  the journal check is taken out, so that check is what catches it.

## 5. Outputs agree

The page, the JSON feeds and the MCP tools are rendered from the same snapshot. Unknown values are
blank on the page and `null` in JSON and MCP.

- Each feed's payload (`status`, `escrows`, `census`, `drift`) equals the matching part of the
  snapshot exactly, every field included. MCP tool text equals the feed file byte for byte.
  `snapshot.json` equals the last line of the snapshot log, and its hash verifies.
- Nothing on the page is hidden, so nothing the check compares can be invisible to a reader:
  - no HTML comment and no other `<!` markup but the doctype;
  - only the elements and attributes the renderer writes, so no `hidden` or `style` attribute
    and no `script`, `details` or `template` element;
  - only the renderer's own stylesheet, which sets no property that can hide a value, shrink it
    to nothing or paint it invisible (`test/page.test.ts` reviews each property it sets).
- Every table carries `data-section` (`status`, `escrow`, `census` or `drift`), holds only keys
  of that section, and sits under that section's heading. The headings are Network status,
  Escrows, Census and Spec drift, in that order. Only the intro line's snapshot values and the
  census banner sit outside a section table.
- The drift item table's header cells carry `data-col` with the field each column shows and read
  that field's name, with underscores as spaces. Each field of a drift item is a column, named
  once, and every drift row's cells follow the header's order. A `data-col` header exists only
  there.
- No text states a value the check does not compare: every `th` is a row label (`data-for`) or a
  drift column (`data-col`); every row but the drift header holds a `td`; the title is
  "FLOP Observatory"; and every piece of text outside a marked cell and a `th` is one of the
  page's fixed words, in order, with the intro's `seq` equal to the snapshot's. `aria-label`
  appears only as `unknown` on a blank unknown cell, and each cell's `class` is the one its value
  calls for (`unk` for unknown, `h-<health>`, `s-<state>`, none otherwise).
- Every `td` on the page carries `data-k`; a cell without one fails the check. The visible text of
  every marked element, nested tags included, must match its value as rendered below.
- Every value sits where a person reads it:
  - A table row with a label is one `th` and one `td`. The `th` carries `data-for`, equal to the
    `td`'s `data-k`, and its text is the label for that key.
  - The label for a key is the rest of the key after its prefix (`status.`, `census.`, `drift.`,
    or `escrow.<id>.`), with dots and underscores read as spaces: `status.rpc.stale` reads
    `rpc stale`, `status.genesis.faucet` reads `genesis faucet` and
    `escrow.<id>.finalized_height` reads `finalized height`. Census totals read
    `partial ` first when the census is partial. A bare `census` or `drift` cell reads its key.
  - Each escrow card carries `data-escrow` with its id and holds only that escrow's cells.
  - Each drift item row carries `data-row` with its `drift.<index>` path and holds only that
    item's cells.
- An escrow id asked for over MCP that is not in the snapshot is `unverified`, with
  `finalized_height` null.
- Every value cell on the page carries `data-k`, the path of the value in the snapshot:
  `status.<field>` with nested fields joined by dots (`status.rpc.stale`, `status.genesis.faucet`),
  `escrow.<escrow_id>.<field>`, `census.<field>` and `census.totals.<kind>`, and
  `drift.<item index>.<field>`. Every marked cell is compared with the snapshot, and a marked
  cell the checker does not know fails the check.
- Page rendering, the same for every cell:
  - `null` is a blank grey cell with no `data-v`.
  - Health `unknown` and drift status `unknown` are blank grey cells with `data-v="unknown"`.
  - `true` and `false` render as those words; numbers in decimal; strings as written, escaped.
  - A list carries `data-n`, its length. An empty list renders `none`: known empty, never blank.
    Lists of text join with `; `. Block ranges render `from-to` and join with `, `. Evidence
    renders `event @ block_number block_hash #event_index`, with `?` for a null block number.
  - An empty string renders `(empty)`.
  - The census request renders `from to to`.
- These must agree everywhere, for the status: every health value, `reset_detected`,
  `rpc.stale`, `conflicts`, the genesis values, the finalized height and hash, `observed_at` and
  the trust label; for every escrow: state, evidence, notes, `observed_at`, trust and scope; for
  the census: status, coverage, gaps and every total.
- The check runs on real rendered snapshots of several scenarios, not only the healthy one: a
  reset, nothing read, a degraded faucet, a partial census, and conflicting escrow evidence.
