# Observatory rules

These rules are the spec. Code and tests follow them, and the independent recount in
`tools/recount.py` is written from this file alone, not from the TypeScript.

## 1. Unknown is never good news

- A value we could not read is `null`, shown blank. It is never `ok`, never `0`, never "complete".
- `reset_detected` is `false` only when both a usable faucet `/chain` reading and a usable RPC
  head report the pinned genesis (1.1 says what usable means). If a usable reading reports
  another genesis it is `true`. It is `true` too when the anchor is lost (1.1): the node no longer
  holds, at a finalized height the log saw, the block the log saw there, which is a reset that kept
  the genesis. Otherwise it is `null`, and callers treat `null` like `true`
  before spending. An unusable reading counts for neither: it never makes the value `false`, and
  never `true` either, though its genesis still shows in `genesis` and a disagreement with the
  other source is still a conflict.
- A genesis is `0x` plus 64 lower case hex digits, compared exactly as written, as in census
  clause 5. Any other spelling, upper case hex included, is not a valid genesis: the status reads
  it as `null`, so it can never make `reset_detected` `false`.
- In M0 the pinned genesis is the devnet genesis in `src/status.ts`, unless a scenario's
  `meta.json` names another (the census and escrow fixtures that test other chains do); the
  snapshot command takes it from the status scenario. M1 takes it from the code alone.
- The check (`npm run check`) is a pass only when its `report.txt` says `finished: yes`. A run cut
  by a signal or ended before its last step says `finished: no (...)`, has an `overall_exit` that is
  never 0 and has no outputs digest (`none (the run did not finish)`); an outputs folder with no
  file has the digest `none`. A run that did not finish is unknown, never a pass.

### 1.1 Health

Each service has one health value: `ok`, `degraded`, `down` or `unknown`. `ok` needs every
check below to run and pass.

- Times are ISO 8601 with an explicit zone: `Z` or an offset such as `+00:00`. A time without a
  zone does not parse, because its meaning would depend on the machine's time zone. A time must
  also be a real instant: a date such as 2026-11-31, an hour of 24, a minute or second of 60, or
  an offset beyond 23:59 does not parse (it is never rolled over). A fraction of a second is cut
  to whole milliseconds, never rounded, so `23:47:53.9999999Z` stays in second 53. The snapshot
  time must parse, or the status refuses. Every command reads its time from `--now`, or else from
  the scenario's `meta.json` `now`, which must then parse too: `status`, `escrow`, `census`,
  `drift` and `snapshot` each refuse a scenario that gives no time or one that is no time, `census`
  as an input problem, so no output carries a reading time that is missing or is no time.
- The faucet genesis counts toward `reset_detected` only from a usable `GET /chain` reading: HTTP
  200 with no error and a reading time that parses, is at most the stale limit old, and is not
  later than the snapshot time. Otherwise it counts for neither, as section 1 says: `genesis.faucet`
  still shows what the reading said, as `genesis.rpc` does for the RPC; a reading that names a
  genesis other than the pinned one is a conflict; and the faucet's detail says why the reading
  does not count, the file and reason included when the saved reading cannot be read, and an HTTP
  status that is not a whole number said as such, never as the value it holds. A usable
  reading whose body names no `genesisHash`, or a malformed one, gives `reset_detected` nothing to
  go on, and the faucet's detail says that too. A `/chain` reading time later than the snapshot
  time is also a conflict.
- The RPC genesis counts toward `reset_detected` only from a usable head: no read error, an
  `observed_at` that parses, is at most the stale limit old and is not later than the snapshot time,
  a valid finalized head and a valid best height (so every check against them can run), and nothing
  below found the head contradicting itself or an earlier snapshot: no rollback, no changed
  finalized hash, a best height not below the finalized height nor below the highest finalized
  height an earlier snapshot saw on this genesis nor more than the lag limit below the highest best
  height an earlier snapshot saw on this genesis, a runtime version not below the highest one an
  earlier snapshot saw on this genesis, no lost anchor, and no earlier snapshot taken, or its head
  read, later than this snapshot time. A head that fails any of these is not usable, however fresh: a
  chain restarted from the same spec keeps its genesis, and its first heads report a low best height
  and no finalized head yet. `genesis.rpc` still shows what the head said. A usable head counts
  toward `reset_detected` false only once its finalized height is known not to be stuck: the stuck
  check below ran and found it held for no longer than the stale limit, or new to the log. A height
  stuck past the stale limit, or one whose stuck check cannot run, leaves `reset_detected` null
  unless a reading names another genesis, which counts either way. So does an anchor read back with
  no verdict: the head is still usable, but it never counts toward false. The same usable head is the only
  one whose finalized height may bound escrow evidence (section 2), stuck or not: a finalized height
  stays final however long it holds, and a bound below the chain's only keeps more evidence waiting.
- Heights and the runtime version are safe integers (census clause 14). A finalized or best
  height past 2^53 - 1 was already rounded by the JSON parser, so it is not a valid one.
- A reading time later than the snapshot time is a conflict, noted in `conflicts`, whatever that
  reading's health.
- An `error` holding any value but `null`, an empty string included, is a read error, and so is a
  reading with no `error` key at all, which does not say whether it failed. A faucet or gateway
  reading with a read error is never `ok`: with an HTTP status it is `degraded` and its detail
  names the error; with none it is `unknown`. The `/chain` reading and the RPC head follow the
  same reading of `error`.
- Each reading's fields reach the status only with the interface's types: `observed_at` a string,
  `http` a safe integer, the faucet `limits` an object whose every value is a finite number or a
  boolean. A field of any other type is `null`. A field the RPC head leaves out reads as `null`,
  as a head that read nothing writes it, so a missing key is never taken for a value that failed a
  check: a head of only `{"error": ...}` is a failed read, `down` with its error, and no genesis
  conflict. A head that is not a JSON object read nothing: the RPC is `unknown` and says so.
- A saved reading that cannot be read (not strict UTF-8, not JSON, nested deeper than 64 levels or
  holding one key twice, as census clause 12 reads a page file, or not a regular file: a named
  pipe, a device or a folder at its path, which is never opened to wait on) counts as nothing read:
  the faucet or gateway is `unknown`, and so is the RPC, each with the file and the reason as its
  detail. Its last copy of a repeated key never wins. A `meta.json` that cannot be read refuses
  the scenario.

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
    highest finalized height any of them saw (for the best height too, even when this head has no
    valid finalized head), no changed hash at this height in any of them, and no finalized height
    stuck for longer than the stale limit, counted from the oldest of the latest run of snapshots at
    this same height. If a head time in that run does not parse, the stuck check cannot run. The
    stuck check runs on a head found to roll back or change its hash too, so its `rpc.stale` still
    says how long its height has held. The snapshot command reads the earlier snapshots from its
    log, after verifying the log's hash chain (a broken log refuses), and passes every one that
    recorded a finalized head, oldest first, so a snapshot in between with no RPC reading, or one on
    another genesis, hides nothing. An earlier snapshot that recorded no head time still sets the
    floor; only the stuck check needs the time. So does one whose head came with a read error: the
    floor fails closed, and a reading that later proves wrong keeps every later snapshot on that log
    degraded until the operator starts a new log (README.md says how). The command also passes every
    earlier snapshot's own time, whatever it read: an earlier snapshot taken, or its head read,
    later than this snapshot time is a conflict, and this head is not usable. The floor is only as
    durable as the log: an absent log means no earlier snapshot, and a log cut short or removed
    cannot be detected from the log itself.
  - every earlier snapshot's best height on the same genesis is a floor too, less the lag limit,
    whether or not either head read a finalized head: a best height more than the lag limit below
    the highest of them is a conflict, and this head is not usable. A reorganisation undoes only
    blocks that are not final, and a healthy head has at most the lag limit of them, so a fall
    further than that is a restart, a node still syncing or a rollback. After a finality stall a
    reorganisation could drop a longer fork, but a restart after a stall looks the same, so the
    rule fails closed: the head stays unusable until its best height is back within the lag limit
    of the highest one seen, and then counts again. Like the finalized floor, this one counts a
    head that came with a read error: a reading that later proves wrong keeps the head unusable
    until the operator starts a new log.
  - the spec floor: every earlier snapshot's runtime version on the same genesis is a floor. A
    version below the highest of them is a conflict, and this head is not usable, as for a
    finalized height below the floor. The runtime is upgraded in place on one genesis (read by hand
    on 2026-11-11: devnet ran spec 1011000 at block 1, 1011003 at block 1,000,000 and 1014014 at the
    head, all on one genesis), so a
    higher version is no conflict and changes nothing. An unknown version (`null`) is no verdict,
    and does not keep `reset_detected` from `false` by itself: the head rules already judge a head
    that read nothing.
  - the anchor: a live run that builds on a log reads back one earlier finalized block, the anchor:
    the latest finalized head an earlier snapshot logged on the pinned genesis, by its height, with
    `chain_getBlockHash(height)`, after the head calls (section 7). It compares the answer with the
    logged hash. The same hash changes nothing. Another hash, or no block at that height (the node
    answers `null`), means the finalized chain is not the one the log saw: the anchor is lost. That
    is a conflict that names the height, the logged hash and what the node answered, and ends with
    the words "the finalized chain is not the one the log saw"; `reset_detected` is `true`; and the
    head is not usable, as for a changed finalized hash. A read that failed on the way, or an answer
    that is no block hash, gives no verdict: no conflict, `reset_detected` is never `false` on that
    reading (it is `null` unless another rule finds a reset), and the RPC detail says why. Like a
    stuck check that cannot run, it leaves RPC health `unknown` when nothing else failed. With no
    anchor (a first run, or a log with no finalized head on the pinned genesis) no call is made and
    nothing changes. The anchor catches a chain restored from a backup, or restarted from the same
    chain spec and grown past the log's heights, which keeps its genesis and can pass every height
    rule above. What it does not show: it is one block, read from the same single RPC endpoint the
    run already trusts. It catches a chain that changed under the log, not an endpoint that lies
    consistently. A block hash commits to every block before it, so the same hash at the anchor's
    height means the same history below it, as far as that endpoint tells it; no header is checked.
  - Three restarts the heads alone cannot see: one whose earlier heads read no valid genesis, which
    are on no genesis and set no floor and no anchor; one within the lag limit of where the chain
    was, which no reorganisation rule can tell from a reorganisation; and one whose new chain is
    already past every height the log holds by the next snapshot, which heads alone cannot tell from
    progress. A live run sees the last two through the anchor, once the new chain holds a block at
    the anchor's height: a restarted chain's block there is, in practice, another block. A new chain
    below that height is below the finalized floor already. The first stays unseen. The snapshot
    command reads no network, so it reads no anchor back: for it the second stays unseen, and the
    third is seen only when the new finalized head lands on a height the log recorded, as a changed
    hash there.
  - The `status` command reads no log, so none of the checks against earlier snapshots runs there:
    its `reset_detected` speaks for that one reading only. The snapshot command's does not, and
    neither does a live run's, which reads the published log (section 7). Only a live run reads the
    anchor back; every saved reading holds none.
- Any failed check makes RPC health `degraded`. A missing or invalid genesis hash, finalized head
  or best height is a failed check. A missing or unparsable `observed_at` means the age check
  cannot run: health is `unknown` when nothing else failed.
- An `observed_at` later than the snapshot time is a conflict, noted in `conflicts`, and makes RPC
  health `degraded`.
- `rpc.stale` is `true` when the head is older than the stale limit or the finalized height is
  stuck, `false` only when the age was computed and is within the limit and nothing is stuck, and
  `null` otherwise, including for a head time later than the snapshot time and for a fresh head
  whose stuck check cannot run.

## 2. Evidence boundaries for escrows

- Only finalized events count. An event in a block that is not finalized is pending, never proof.
- Only events on the pinned genesis count. Events from another genesis are excluded and noted.
- Events are identified by `(genesis, block_hash, index)`. The same event seen twice counts once.
- `funded` needs a finalized `hasStation.EscrowOpened` for the escrow id and no finalized terminal
  event.
- `claimed` needs a finalized `hasStation.EscrowReleased` for the escrow id.
- `refunded` needs a finalized `hasStation.EscrowRefunded` for the escrow id.
- Missing evidence leaves the escrow `unverified`.
- Conflicting evidence leaves it `unverified` with a note: for example both a finalized release
  and a finalized refund for one id, or an event whose escrow id does not parse.
- A malformed event (escrow id not `0x` plus 64 hex, missing fields, wrong types) is ignored with a
  note. It can never make an escrow look funded, claimed or refunded. A finalized event whose data
  names an escrow but whose section or method is missing, empty or not a string (census clause 7)
  could be any of the three kinds, so it leaves that escrow `unverified`, as a malformed release
  or refund does.
- Copies of one event (same genesis, block_hash and index) must agree on section, method, escrow
  id, block_number and account (the account census clause 11 reads, so the census and the escrow
  rules drop the same groups, clause 9). When copies disagree, every escrow that any copy names is
  `unverified` with a note. One chain event is never evidence for two escrows.
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
  genesis (section 1.1): no read error, a head time that parses, is not later than the snapshot
  time and is at most the stale limit old, and no check that found the head contradicting itself
  or an earlier snapshot. Otherwise (the RPC was not read, the reading is not usable, or it reports
  another genesis) `finalized_height` is `null`, and a result with evidence notes that its
  evidence is not bounded by a finalized height. A height handed to the escrow rules that is not a
  whole number from 0 (NaN, infinity, 1.5, -1) bounds nothing and reads the same way.
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
- Event data written as a list rather than an object (the positional form) holds no escrow id
  these rules can read: for an escrow it is malformed, with a note, while the census counts it
  with no account. The difference can only make an escrow less confident, never more.
- Copies of one event must agree on its block number. Two different events (another index) in
  one block are not checked against each other's block number.
- Block order is not checked: a release counts whatever block its open sits at, and a finalized
  release makes an escrow `claimed` even when its open is pending or absent. A caller that needs
  funded, then released, checks both itself.
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
- The census's own `reset_detected` speaks of its pages only: `true` when a page is on another
  genesis, `false` when pages were read and none is, `null` when no page was read. It is not the
  status `reset_detected`. Pages alone cannot show the chain was not reset, so a census `false`
  never stands for the status value, and a page may show the status `reset detected` as `true`
  while the census row of the same name reads `false`. Branch on the status value.
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
   not reachable from page 0 are otherwise ignored. Two copies of one page number that disagree on
   `next_page` break the chain, whether or not the walk from page 0 reaches that page number;
   identical copies are kept and their events dedupe. A `next_page` that names a page that does not
   exist, including a negative number, breaks the chain.
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
    `by_account` lists only non-zero kinds; accounts sort ascending by code point, as Python
    orders strings (U+FF41 before U+1D400, which UTF-16 units would put first). Any string is an
    account name, `__proto__` and `constructor` included, and every output keeps it. Key order is
    presentation only: the cross-check compares accounts and their counts, not their order, the
    feeds sort every key by UTF-16 unit for their fixed format, and a JavaScript object lists a
    name such as `7` first whatever the sort.
12. A structurally invalid page (not an object, `genesis` not a string, `from_block`, `to_block`,
    `page` or `next_page` missing or of the wrong type, a negative `page`, a negative `from_block`
    (block numbers start at 0), `events` not a list, or an inverted range) makes the whole census
    refuse with an error. So does an event page file that cannot be read, decoded as strict UTF-8,
    or parsed as standard JSON (RFC 8259: the text is UTF-8 with no byte order mark, and `NaN` and
    `Infinity` are not JSON). A byte that is not valid UTF-8 refuses; it is never replaced and read
    around. So does a key that appears twice in one object, after its escapes are read: parsers
    differ on which copy wins, so the file has no one meaning. So does a file whose arrays and
    objects nest deeper than 64 levels, checked before parsing, so no parser's own stack limit
    decides. An integer literal too long to be a safe integer is just that, an unsafe integer
    (clause 14), however many digits it has. Neither is ever turned into a partial count.
13. A request with a negative `from_block` or `from_block` greater than `to_block` is refused.
14. An integer is a JSON number with no fractional part, judged by value: `1.0` is the integer 1,
    `1.5` is not an integer, and a boolean is never an integer. It must also be safe: from
    -(2^53 - 1) to 2^53 - 1. A larger value is not an integer, so a page field holding one refuses
    the census and an event field holding one makes the event malformed. This holds for every
    integer field in these rules (`index`, `block_number`, `page`, `next_page`, `from_block`,
    `to_block`) and for the request. The value judged is the one the JSON text reads as, a binary
    double (IEEE 754), on both sides: `1.0000000000000000001` reads as the integer 1.
15. Every entry in `event-pages/` must be a page file: a regular file whose name ends in `.json` and
    does not start with a dot. Any other entry (a dotfile, another extension, a folder) refuses the
    census and leaves every escrow `unverified`, because it may be a page that was meant to count.
    A symbolic link is not a regular file, even when it points to one. `event-pages` itself must
    be a folder, not a file or a link, and one that is there but cannot be read or listed (no
    permission, or a path past the system's limit) holds pages no one can see; otherwise the census
    refuses and every escrow is `unverified`.
16. A refusal names its reason, and the Python recount names the same one:
    - `request`: the request is invalid (clause 13). On the command line both sides read
      `--from` and `--to` as ASCII digits only, so " 0", "+5", "1_0", "0x10" or digits of
      another script refuse here, never read as a number;
    - `page-file`: an event page file cannot be read, decoded or parsed, an entry in
      `event-pages/` is not a page file, or `event-pages` is not a real folder or cannot be read or
      listed (clauses 12 and 15). The refusal names the first such entry in name order, or
      `event-pages` itself, whole:
      the cross-check reads the name as the longest entry of the scenario the message names, so
      a name that holds a colon or a semicolon is compared in full;
    - `page-structure`: a page file parses, but the page is structurally invalid (clause 12);
    - `input`: anything else the census cannot start from, such as no pinned genesis.
    A request problem is named before any page problem, and a page file problem before any page
    structure problem, so both implementations name the same reason for the same input. On the
    command line both sides read the same arguments by the same rules: every flag is `--name`
    followed by its value as the next argument, so `--name=value`, a name the command does not read
    (an abbreviation such as `--gen` included), a flag given twice, a flag with no value (the next
    argument missing, empty, as an unset shell variable gives, or itself a flag), and an argument
    that is no flag's value are each a request problem, while a value that starts with one dash
    (`-5`, `-a`) is a value, judged as one. A request number that is not plain digits, or has more
    than 16 significant digits (so it is past 2^53 - 1), is a request problem, a range given there
    is checked before the folder is read, and a scenario folder that does not exist, or a pinned
    genesis in `meta.json` that is empty or not text, is an input problem; the recount reads its
    genesis only from its flag, where an empty value is a request problem, so the `meta.json` case
    is the command's alone and the cross-check compares it through no case. The folder flag left out
    is a request problem on both sides, and so is a scenario the command reads with no `--from` or
    `--to` and no `census_request` in its `meta.json`. The recount needs all four of its flags, and
    one left out is a request problem; the TypeScript command reads a missing `--genesis`, `--from`
    or `--to` from the scenario's `meta.json`, so a flag left out is compared only through
    `meta.json`, as every scenario is. The command's `--now` (a time with a zone, checked as one)
    has no counterpart in the recount, which reads no clock, so the cross-check never passes it. A
    file name a refusal names is shown as itself when it is UTF-8, but for `%`, the control
    characters (C0, DEL and C1) and the line and paragraph separators, each as the `%XX` of its
    UTF-8 bytes, and byte for byte with every other byte as `%XX` when it is not, so a name holds no
    line break of any kind and no two names are shown alike. Every refusal that names a file or a
    folder shows it so, page structure refusals and a scenario folder that does not exist included,
    but for one case: Node decodes the command's arguments before the command reads them, so a
    scenario folder name that is not UTF-8 reaches it with U+FFFD in place of each bad byte, and the
    command can neither name nor open such a folder as the recount can. Such a folder is outside
    what the two sides compare. Near the system's path limit the two agree: a scenario path whose
    `event-pages` is past the limit while its `meta.json` is not is a page file problem on both
    sides, naming `event-pages`, and the cross-check makes one at run time; one whose page files
    alone are past it is a page file problem on both, naming the first such file, and the
    cross-check makes one too; a folder path past the limit itself is an input problem on both. An
    `event-pages` folder they may not read or list is a page file problem on both sides too; the
    cross-check cannot make one when it runs as root, where every folder opens, so each side's own
    tests make the call fail instead. The TypeScript command also reads the folder's `meta.json` and
    refuses as an input problem when it cannot, a scenario folder it may not search and one whose
    `meta.json` path alone is past the limit included. The recount does not read `meta.json`, so
    that one input problem is the command's alone; the recount names `event-pages` as a page file
    problem there, since it cannot read that either. So is a `meta.json` whose `now` is missing or
    no time when no `--now` is given (section 1.1): the recount reads no clock. Last, Node takes `.`
    and `..` segments and doubled slashes out of a path before the system sees it, while the recount
    hands the path to the system as given. So the command counts the folder a padded path names
    whenever that folder can be read, while the recount refuses a padded path once any part of it is
    past the limit: as an input problem when the folder path is, and otherwise as a page file
    problem naming the first part past it, `event-pages` or a page file; and a `..` after a link
    names another folder on each side. Such a path is outside what the two sides compare.

## 4. Read only

The observatory never signs, spends or writes. RPC calls outside the allowlist in `src/guard.ts`,
any HTTP method other than GET or HEAD, and any signing or spending call are refused and recorded.
Tests fail if any attempt is left in the log.

- In tests every network and process path is blocked at runtime and recorded, not only fetch and
  WebSocket: `node:http`, `node:https` and `node:http2` requests, `node:net` and `node:tls`
  connections and listeners, `node:dgram` sockets, `node:dns` lookups, worker threads, module hooks
  (`module.register`, whose hooks run on a loader thread that holds unpatched modules of its own,
  and `module.registerHooks`), and every `node:child_process` call (spawn, exec, execFile, fork and
  their sync forms). Named imports see the block too. So do the lower layers: `net.Server`'s
  `_listen2`, which makes the handle under `listen`, the `dgram.Socket` constructor, which opens its
  native handle at once, by its name and by the real prototype's `constructor` property, and
  `dgram.Socket` send, bind and connect, `dns.Resolver` queries, `ChildProcess.prototype.spawn`,
  `process.binding`, `process.dlopen` and `inspector.open`. The block covers the ways out named
  here and is tried against each of them; it is no proof that Node has no other.
- One exemption: `runShell` in `test/setup.ts`, which holds the real `spawnSync` taken before the
  block and never exports it, so `test/publish-shell.test.ts` can run the shell of both publish
  jobs, the live workflow's and the record workflow's (they push to one branch, so the cases that
  show each leaves the other's files alone run both in that one file). It serves that one test
  file only, runs `bash` only, in an environment built from the caller's
  values and `PATH` alone, with git limited to `file://` remotes (`GIT_ALLOW_PROTOCOL=file`, no
  system or global git config) and a `GITHUB_SERVER_URL` that is not `file://` refused. A call from
  any other file is recorded as a process attempt and throws, as every other process call does.
- A source scan fails any `src` module, other than `guard.ts`, that imports one of those modules or
  calls fetch, WebSocket, a signing API or a key API (`src/net-root.ts` names fetch and WebSocket
  in the one form the exemption below allows, and calls neither). It also fails the indirect forms:
  `process.getBuiltinModule`, `createRequire`, an `import()` or `require()` whose argument is not
  a plain string, `process.binding`, `eval` and `Function`, called or not.
- The source scan fails any use of the bare names `fetch`, `WebSocket`, `EventSource`,
  `XMLHttpRequest` and `globalThis` in `src`, and any member or computed access on `global`,
  `self` or `window`, so an aliased, `.call` or computed form cannot slip past it.
- A second scan (`scripts/source-scan.mjs`) reads each `src` module as a syntax tree, with every
  escape in a module name or identifier decoded and comments skipped, so `"n\x65t"`, an escaped
  `fetch` and `from /* x */ "node:net"` are seen for what they are. Every import, dynamic import and
  re-export names one plain string, and the module must be relative or on an allow-list: `node:fs`,
  `node:path`, `node:readline`, `node:url`, `node:crypto` (`createHash` only) and `yaml`. A module
  nobody thought to ban, a legacy one such as `_http_client` or a third party client, fails. A
  relative module must land on a scanned `.ts` module inside `src`, so a path out of `src` or to a
  `.mjs` file fails, and an import-equals (`import x = require(...)`) fails. Every import names what
  it takes: no default or namespace import, no default export taken by its name (`import { default
  as m }`, `export { default as m } from`), no `export *`, and no dynamic `import()`, so `src` never
  holds a module object whose exports `Object.entries` could list by names the scan cannot read, and
  nothing but `createHash` can come from `node:crypto`. It also fails the banned names as
  identifiers, properties, string keys, template keys, regular expression patterns or any other
  string (transports, the global object, the Web Crypto global, `eval`, `Function`, `Reflect`,
  `constructor` but a class's own method, the APIs that define getters on a prototype, rewire one or
  list its names, `atob`, `Object.assign`, the stack trace hook `prepareStackTrace`, `WebAssembly`,
  the socket calls `connect`, `listen` and `bind`, the Web Crypto classes `Crypto`, `CryptoKey` and
  `SubtleCrypto`, module loading, signing, key and cipher APIs), any name that starts with an
  underscore (an internal such as a stream's `_handle` or `__proto__`), as an identifier or as a
  string (`x["__proto__"]`, `console["_stdout"]`), the reader's streams `.input` and `.output`, read
  or destructured, the reader itself other than as `rl.on(event, arrow function)` in a statement of
  its own, where `rl` is a `const` that is not exported and holds the whole value of
  `createInterface(...)`, the one place `createInterface` is named but its import from
  `node:readline` (so the reader, which holds stdin, is never listed, handed on, kept as the value
  `on` returns or given to a listener as `this`), `process` other than `process.version`,
  `process.argv`, `process.exit`, `process.stdout.write(...)`, `process.stderr.write(...)` and
  `createInterface({ input: process.stdin })` (so a stream `src` holds is never handed on, read
  back, listed or asked to connect: under a pipe `process.stdout` is a socket), and any string
  naming an RPC method that writes or signs. It also fails every computed key that is not a string
  or number literal, in a member access (`o[k]`, `o?.[k]`, `super[k]`), an object, a pattern or a
  class: every property `src` reads or writes by name is named in its code, where the rules above
  read it, so a name only known at run time (read back from a regular expression, decoded, trimmed,
  listed or parsed) can never be used to reach anything. What `Object.entries` and `Object.values`
  list without a name is what an object `src` holds holds itself: data, the functions of `src`'s own
  modules, an allowed module's functions only by the names `src` imports, and what those functions
  hand back (a hash object, a parsed yaml document, an error). The reader is the one such object
  known to hold a stream, so it is held to the form above. The scan does not read what the others
  hold; the runtime block in the tests covers the network and process paths. `src` holds no module
  object, no global object and no `process`. `src` reads a data record by a run time key through
  `own()` in `src/own.ts`, which walks the record's own entries, never reaches an inherited member
  and never hands back a function. A name list refuses some plain words too (`sign`, `self`,
  `window`, `binding`, `encrypt` and the others, as identifiers or whole strings); `src` uses none
  of them. `src` must hold nothing but regular `.ts` files, so every file tsc compiles is read; both
  scans check that. It proves itself on known bad and good samples, and its file list on a throwaway
  folder, before it scans. What it cannot see is what an allowed module does with the arguments
  `src` passes it; the runtime block in the tests covers that.
- One exemption, for the composition root of every network read. `src/net-root.ts` may name
  `WebSocket` and `fetch`, each once, and only as the values of the plain properties of the one
  object literal it hands to `new NetTransport(...)`. The live command (`src/live-bin.ts`) and the
  recorder (`src/record-bin.ts`) both take their one transport from it. The syntax tree scan holds it to that form: no shorthand,
  computed, method or getter property, no other callee, no second argument, no second use of either
  name, and every other rule still applies there. The text scan in `test/guard.test.ts` holds it to
  the exact text `new NetTransport({ socketClass: WebSocket, httpCall: fetch, answerLimits })`,
  once, and reads the rest of the file by every rule. No other module gets the exemption, the two
  commands included, nor a `net-root.ts` in a subfolder; both scans prove that on samples before they scan. Every other module reaches the
  network only through the transport it is handed, so a test hands it fakes.
- `tools/recount.py` is read the same two ways: its own tests walk its syntax tree (exactly five
  plain imports, none under an alias and none of a submodule, no from-import, every use of a
  module one of a fixed list of full dotted names, so no alias of a module or of part of one; every
  attribute one of the fixed list of those recount.py uses, so `sys.stderr.buffer` and its kin
  fail; no `match` statement, whose class
  patterns read attributes by keyword, and no `.mro`; every other name one the file binds or a
  builtin on a fixed list of the ones it uses, so `type`, `help`, `vars` and every other builtin
  fail wherever they appear, as a name of the file's own too; no attribute that starts with an
  underscore but `super().__init__`, and none that names a frame, code or traceback field
  (`gi_frame`, `f_globals`, `tb_frame` and the rest), so a generator's frame cannot hand over the
  module's globals; nothing that runs code from a string; and `open` only called directly for
  reading, with a file and a mode and no unpacked argument or opener), and the guard test reads
  every name on every import line and the same bans as text.
- Every attempt, every reset of the log and every test file's final check is written to a
  journal the moment it happens. Once every test file has ended, and again after the test run
  exits, the journal is checked:
  - an attempt still in a file's log at its final check fails;
  - anything after a file's final check fails, an attempt or a reset made from a timer, say,
    which no test hook can see;
  - a reset or a final check whose count disagrees with the attempts journaled before it fails,
    because it means the journal lost an attempt;
  - every test file must reach its final check, each file counted once: one run of the tests runs
    each file once, so a file that reached its final check in two runs is itself a failure.
- No test may load a second copy of `src/guard.ts` (by reloading or mocking modules, or by
  importing it under a query string): a copy's attempts would reach neither the log nor the
  journal. A test reads every test file for those forms.
- The harness canary proves that a test leaving any of these in the log fails: a fetch, an
  `node:https` request, a `node:net` connection, a child process, module hooks, a listening handle
  made under `listen`, a `dgram.Socket` made directly, a refused RPC write, a refused signature and
  a refused spend. It proves the same for a blocked call fired from a timer after the file's final
  check, with and without a reset there, and that the timer case passes once the journal check is
  taken out, so that check is what catches it.

## 5. Outputs agree

The page, the JSON feeds and the MCP tools are rendered from the same snapshot. Unknown values are
blank on the page and `null` in JSON and MCP.

- Each feed's payload (`status`, `escrows`, `census`, `drift`, `upgrade`) equals the matching part of the
  snapshot exactly, every field included. MCP tool text equals the feed file byte for byte.
  `snapshot.json` equals the last line of the snapshot log, and its hash verifies.
- Every output is read as strict UTF-8, and every JSON output strictly: it is parsed first, and one
  that is not JSON ends the check with that failure, never a hang, as does `snapshot.json` when it
  is not an observatory snapshot and any output of a shape the check cannot read; then no key twice
  in one object, and each is in its written format (keys sorted, two-space indent, one trailing
  newline; `pin.json` two-space indent). A feed holds exactly `schema`
  (`flop-observatory/feed-<part>@0`), `snapshot_hash`, `observed_at`, `trust` and its part. The
  log's last line is `snapshot.json` in canonical form, byte for byte.
- `get_escrow_state` and `get_snapshot_meta` have no feed file: their text is the escrow, and the
  snapshot's meta (`schema` `flop-observatory/feed-snapshot-meta@0`, hash, seq, previous hash,
  `observed_at`, trust and pin), in the feed format. A tool answer is exactly one text item: no
  `isError`, no `structuredContent`, no second item a client could read instead. `tools/list`
  names exactly the seven read-only tools (`get_upgrade` among them, whose text is `upgrade.json`), and is exactly the server's declared list (descriptions,
  input schemas and annotations); the initialize answer is exactly the server's name, version and
  read-only instructions; each refusal has its own code and words. The transcript holds exactly
  the exchanges `scripts/mcp-transcript.mjs` makes, in order, one of them a well formed escrow id
  the snapshot does not hold, so the unseen escrow rule is asked of the real binary. Each answer is
  checked as the server wrote its line, which is one compact JSON line. The transcript is in its
  written format: one line per exchange ended by a newline and nothing else in the file, each
  line its four keys in the script's order (`request`, `expect_error`, `response`,
  `response_line`), the request spelled as the script sends it and the response as the server's
  own line.
- The snapshot command takes an escrow id only as `0x` plus 64 hex, the one form
  `get_escrow_state` answers for, so the page, the feeds and the MCP server hold the same ids.
- The MCP binary serves only an observatory snapshot whose hash verifies, read as strict UTF-8 with
  a byte order mark refused, nesting checked before parsing, one value per key, and the text byte
  for byte in the feed format, so an integer past 2^53 - 1 that the parser would round is refused
  too. What it serves must also pass every check in `src/snapshot-check.ts`, where each check has a
  name: `<object>.fields` and `<object>.<field>` for a shape, and one name for each agreement. A
  refusal names the checks the file breaks (the first five, and how many more). Every object in it
  but the census and the drift report holds exactly its schema's fields with its schema's types: the
  snapshot (`seq` a safe integer from 0, `prev_hash` none on the first line and 64 lower case hex on
  every other, its hash 64 lower case hex, `observed_at` a time with a zone, the trust one of the
  two labels), its pin (`source_sha` text or none, as the command was given it), the status
  (`observed_at` a time with a zone, its genesis exactly its three fields, the pinned hash and the
  faucet's and the RPC's hash or none, each service's health one of the four words, its http status
  a safe integer or none and its other fields of their types, its conflicts text), every escrow (its
  id `0x` plus 64 lower case hex and listed once, `observed_at` a time with a zone, its notes text)
  and every evidence item (one of the three escrow events, its block hash and genesis hashes); the
  census and the drift report are checked for their schema only. The snapshot's fields are chosen by
  its schema: `snapshot@0`, a line written before the upgrade watch, holds no `upgrade` field and
  still reads; any other schema is held to `snapshot@1`'s fields, `upgrade` among them (null or an
  object), and refused unless it is `snapshot@1`. The upgrade watch (7.2) holds exactly its fields:
  its schema, `observed_at` a time with a zone, the trust, `at` (`hash` 0x plus 64 lower case hex,
  `number` a count or none), `executing` (`state` one of reviewed, not reviewed, absent and unknown,
  `spec_name` text or none, `spec_version` a count or none, `detail` text or none), `authorized`
  (`state` one of absent, present and unknown, `bytes` 0x and lower case hex of whole bytes or none,
  `length` a count from 0 to 1048576 or none, `sha256` 64 lower case hex or none, `detail` text or
  none), `compared_with` a count or none and the two changes flags or none. An object whose set of fields is
  wrong is named once, as `<object>.fields`, and its values and parts are not read.
  Once every shape holds, the values the settlement rules tie together agree: `reset_detected` false
  only with both genesis readings on the pinned genesis and both heights read, and true only with a
  reading on another genesis or with a conflict that ends with "the finalized chain is not the one
  the log saw", which only a lost anchor gives (1.1); the finality lag the best height less the finalized one, and none when
  either is missing or the finalized one is higher; an escrow unverified with no evidence, funded on
  one open and nothing else, claimed on one release and refunded on one refund, each with at most
  one open and no event of the other kind, every item on the pinned genesis; an escrow's finalized
  height none or the status's, and none unless the status's RPC genesis is the pinned one, with no
  evidence above it; no finalized event evidence twice, for two escrows or for one; the pin's
  genesis, finalized height and hash the status's RPC genesis, finalized height and hash; the
  snapshot a fixture when any part is, the upgrade watch included; and, for a watch: its block the
  status's finalized head, its hash and its height, whenever the status has a finalized hash; a spec name and version exactly when the state
  is reviewed or not reviewed; a detail for every executing state but reviewed and none for it; bytes
  a length and a sha256 exactly when the authorisation is present, bytes only then and exactly when
  the length is at most 256, their byte count the length and their sha256 the sha256; an
  authorisation detail exactly when it is unknown, or present with its bytes not kept; both changes none when nothing was compared;
  `compared_with` below `at.number`, which is then known; `executing_changed` none unless the runtime
  is named now; `authorization_appeared` none when the authorisation is unknown, and true only when it
  is present. Anything else is refused and nothing is served. A call it
  cannot answer gets a JSON-RPC error, never a dead server. These are all the binary checks: times
  are not compared with each other, nor the parts' trust labels beyond the fixture rule. The hash is
  no signature: whoever writes the file can write a hash that verifies, so these checks catch a file
  that is broken or contradicts itself in one of the ways above, not one written to deceive, which
  serves what it holds. The output check (`scripts/consistency.mjs`) does not apply these rules:
  outputs written from a snapshot the binary refuses can still agree with each other, and in the
  check the step that drives the binary fails first. The snapshot command and its log are where the
  rules are applied.
- The snapshot log is read the same way: every line strict UTF-8, ending in a newline, with no
  blank line and nothing after the last newline, and in canonical form byte for byte. A line that
  is padded, ends in a carriage return or spells a number another way breaks the chain, and the
  snapshot command neither extends nor trusts it.
- The outputs folder holds exactly the ten files the commands write, the whole log's hash chain
  verifies, and the last line's `seq` is its position.
- Nothing on the page is hidden, so nothing the check compares can be invisible to a reader:
  - the head is the renderer's fixed head (charset, viewport, colour scheme, title and
    stylesheet), so no `meta` or `title` can carry a value or change how the page is decoded;
  - tag and attribute names are lower case, as the renderer writes them (a browser reads `<TR>`
    as `<tr>`), every `<` opens a tag, and a closing tag holds only its name;
  - no HTML comment and no other `<!` markup but the doctype;
  - only the elements and attributes the renderer writes, so no `hidden` or `style` attribute
    and no `script`, `details` or `template` element, and each attribute once on its element: a
    browser keeps the first of two with one name and another reader may keep the last;
  - only the renderer's own stylesheet, which sets no property that can hide a value, shrink it
    to nothing or paint it invisible (`test/page.test.ts` reviews each property it sets).
- Every table carries `data-section` (`status`, `escrow`, `census` or `drift`), holds only keys
  of that section, and sits under that section's heading. The headings are Network status,
  Runtime upgrade, Escrows, Census and Spec drift, in that order. The upgrade watch's two states are
  words like a health: `unknown` is a blank grey cell with `data-v="unknown"`, and a null watch is one
  blank `upgrade` row. Only the intro line's snapshot values and the
  census banner sit outside a section table.
- The drift item table's header cells carry `data-col` with the field each column shows and read
  that field's name, with underscores as spaces. Each field of a drift item is a column, named
  once, and every drift row's cells follow the header's order. A `data-col` header exists only
  there.
- No text states a value the check does not compare: every `th` is a row label (`data-for`) or a
  drift column (`data-col`), and its words are read as one or the other, so a `th` outside a
  row, a second `th` in a row or a `th` in a drift item row fails; every row but the drift header
  holds a `td`; the title is "FLOP Observatory"; the census banner is one of its two fixed
  sentences, read whole; and every piece of text outside a marked cell and a `th` is one of the
  page's fixed words, in order, with the intro's `seq` equal to the snapshot's. `aria-label`
  appears only as `unknown` on a blank unknown cell, and each cell's `class` is the one its value
  calls for (`unk` for unknown, `h-<health>`, `s-<state>`, none otherwise).
- Every value sits in a labeled row or a drift item row: a marked `td` in a table outside both
  fails, so no value loses its label. A row with `data-row` is a drift item row, named
  `drift.<index>`, and no other row has one. A row label is plain text, with no element inside it
  and `scope="row"`, and a drift column header is plain text with no `scope`. A bare `<code>` is
  nested only in an escrow id's cell. `data-v` is compared as a value, so `data-v="null"` on a blank
  cell is not the same as no `data-v`.
- Every element's `class` is the one the renderer writes for it, so nothing paints a cell from
  outside it: a marked cell's by its value, as above; the fixed paragraphs `note` and `banner`,
  in their order; `card` on every `div`; and none on any other element, so a class on a row, a
  table or a card fails. The page holds exactly the renderer's paragraphs, cards and tables (one
  card each for the status, every escrow and the census, and one or two for the drift), so an
  empty one cannot add a mark of its own. Every value cell but the intro line's carries `data-v`
  with its value as rendered (none for `null` and an empty list), so a machine reading `data-v`
  reads what a person reads.
- Every `td` on the page carries `data-k`; a cell without one fails the check. The visible text of
  every marked element, nested tags included, must match its value as rendered below. A marked
  element holds no markup but the one the renderer nests, a bare `<code>` around an escrow id, so
  a span inside a cell cannot paint its value as something else. The page holds exactly the keys
  the renderer writes for the snapshot, in its order, so a row dropped or moved and escrow cards
  in another order fail without the byte comparison. Each sits in the element the renderer writes
  it in: the snapshot hash in a `code`, its time and trust in `span`s, the census status in a `p`
  and every other value in a `td`, so a row turned into a bare marked `span`, which a browser moves
  out of its table and away from its label, fails without it too.
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
  `finalized_height` null, and its id is shown in lower case, as every escrow id is, however it
  was asked for.
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
- Last, every file is compared byte for byte with what the code writes for the snapshot:
  `index.html` with `src/page.ts`, the feeds and `snapshot.json` with `src/feed.ts`, and the
  transcript with what `scripts/mcp-transcript.mjs` writes from `src/mcp.ts`'s answers. The rules
  above judge the outputs against the snapshot on their own; this closes what they do not model.
  The canary runs every tamper with and without this comparison, so each tamper is shown caught
  by the rules alone, and one tamper that changes nothing they model shows the comparison bites.
- The check runs on real rendered snapshots of several scenarios, not only the healthy one: a
  reset, nothing read, a degraded faucet, a partial census, conflicting escrow evidence, and
  accounts named after properties every JavaScript object inherits (`__proto__`, `constructor`,
  `hasOwnProperty`, `toString`, `valueOf`), which a writer that assigns keys one by one would drop.

## 6. Spec drift

- Drift compares the parameters in a spec file (`params/*.yaml`) with saved runtime constants.
  A missing, `null` or unreadable runtime value is `unknown`, never a match; the spec decides how
  a value is read (its unit and decimals), and `source_only` items are `unknown` with their reason.
- `runtime_version` is a safe, non-negative integer, or `null`. `runtime_observed_at` is the
  constants' own reading time when it parses as a zoned time (section 1.1), or `null`.
- In M0 the constants come from a saved file with no chain of its own: `drift.genesis` and
  `drift.finalized_height` are always `null`, and no freshness rule applies. A `match` says the
  saved constants agree with the spec, not which chain they came from or when. M1 reads them from
  a usable RPC head (section 1.1) and fills both fields.

## 7. Live network status

The first live step reads network status only. Everything above holds for it; these rules are what
it adds.

- A live snapshot's trust is `"trusted RPC"`: it trusts one RPC endpoint, and the faucet and the
  gateway as they answer. It is not proof. No light client runs and no header hash is checked. A
  replay of a live run's tape has trust `"fixture"`, as all saved data has.
- The pinned genesis is `DEVNET_GENESIS` in `src/status.ts`, never one a reading names.
- The head is read once, one call at a time, in a fixed order: `system_chain`,
  `chain_getBlockHash(0)` for the genesis, `chain_getFinalizedHead` for the finalized hash,
  `chain_getHeader` at that hash for the finalized height, `chain_getHeader` with no hash for the
  best height, `state_getRuntimeVersion` at the finalized hash, and then the two reads of the upgrade
  watch at that same hash (7.2). Then, when the published log
  holds a finalized head on the pinned genesis, one more call: `chain_getBlockHash` at the height of
  the latest one, the anchor (1.1). Its height comes from the log, never from a reading, and a first
  run makes no such call. `state_getRuntimeVersion` is called only at the finalized head: at an old
  block it takes seconds. Its `observed_at` is taken just
  before the first call, so the head is never shown as fresher than it is, and the snapshot time
  just after the last reading, so no reading is later than it.
- A call that failed on the way (no socket, a time limit, an answer over the size limit or not
  strict JSON, an RPC error) is a read error: the head's `error` names the call and why. An answer
  that came back but does not hold what it should is `null`, with no error of its own, and the
  status judges it as section 1.1 judges a saved head with that field left out. A header number is
  read only as `0x` and hex digits, and only as a safe integer. A finalized hash that is not `0x`
  plus 64 lower case hex is never read by: the finalized head and the runtime version stay unread.
  `system_chain` is read for the tape only; no rule reads it.
- Nothing is sent before the guard (section 4) allows it: every RPC method through `guardRpc`, every
  HTTP method through `guardHttp`. Only these are reached: `wss://rpc.devnet.flop.network`,
  `https://faucet.flop.network` and `https://api.flop.network`, with no port, user or password. A URL
  off that list is refused and recorded as a network attempt, a redirect is refused, every request
  has a 15 second limit, every answer a 1 MiB limit counted in bytes (the live run states no larger
  limit for any method; section 8 says who may), and the run uses one socket.
  An RPC answer that cannot be held to one call (too large, not text, not strict JSON, not an
  object) fails the
  socket, and every call after it.
- A live run's memory is the published log: the `log/` folder of the branch `observatory-data`
  (7.1), named by `--log`, which is always given. Its day files, `<UTC date>.jsonl`, are read in
  name order as one log. The log is read before anything else, in full, through the store's reader
  and chain check, and every snapshot in it must pass the checks of section 5. The snapshot is then
  built on every snapshot in the log, as the snapshot command builds on its own log, so every check
  against earlier snapshots in section 1.1 runs, with the same code. It follows the log's last line:
  its `seq` is one more and its `prev_hash` is that line's hash. Its `reset_detected` speaks for
  that history, not for one reading.
- Two cases give no earlier snapshot: a log folder that does not exist (a first run) and one that
  holds no day file. The new snapshot then starts the log at `seq` 0. Every other case refuses the
  log: a name in the folder that is no day file of a real date, a link or anything but a regular
  file, a day file that holds no line (the publish job never writes one), a line the store's reader
  refuses, a line that does not follow the one before it, and a line that
  breaks a check of section 5 (a snapshot this code cannot check). A refused log is never read as
  no log: the run reads nothing from the network, writes no snapshot, exits 1, and never starts a
  new log over it. `run.json` names the case: `absent`, `empty`, `read`, `unreadable`, `broken` or
  `unchecked`.
- One allowance, for the readings published before runs kept memory: the log may begin with lines
  that each hold `seq` 0 and no `prev_hash`, each a whole log of one line that passes its hash
  check. They count as earlier snapshots like any other, and the chain goes on from the last of
  them. Once a line follows another, a line with `seq` 0 breaks the chain.
- The lines from before memory (each `seq` 0, at the start of the log) are each checked alone, by
  their own hash and the checks of section 5. They are not chained to each other, so their order
  and their number are not protected by the chain: one can be moved, added or removed among them,
  and the log still reads. A log that runs backwards in time still shows, as a conflict, through
  section 1.1's rule that no earlier snapshot is later than the new one.
- What the chain is and is not: from the first chained line on, each line names the hash of the one
  before it, so a line changed after that point, or one removed or moved anywhere but at the end,
  breaks the chain and the log is refused. That catches damage and reordering. It is no defence against someone who can write to
  the branch, who can rebuild every hash.
- A live snapshot still trusts one RPC endpoint, and the history it is built on is what that
  endpoint said before. The log does not show its lines are true, and lines cut from its end, a
  line from before memory added to or removed from its start, or the whole log removed cannot be
  detected from the log itself, as section 1.1 says of any log. Section 1.1's three restarts the
  heads alone cannot see are seen as that section says. The anchor is one more read from that same endpoint: it shows the
  endpoint still gives the block the log saw, not that the block is true.
- Every run reads the whole log: the checks need the highest finalized and best heights ever logged
  on the genesis, every hash logged at the current height and the latest run of snapshots at that
  height, which can be any length, and any shorter read would need a second owner of those rules.
- It reads no event pages and no runtime constants. Its source reports no pages and no page errors,
  as a scenario with no `event-pages` folder does, so a census over it is partial over its whole
  range and every escrow is `unverified`. Neither is ever shown as "no events".
- The tape holds every request in the order it was made and the answer as the observatory read
  it, after parsing: a body that was not JSON is a reading with its error set, not the bytes. A
  replay answers each request with the next entry and refuses any other request, naming both. A
  tape recorded before runs read the anchor holds no anchor call: it replays as a first run exactly,
  and a replay of it on a log that names an anchor is refused at that call, which it never answered.
- The run exits 0 when a truthful snapshot was written, whatever it says of each service, 3 when
  that snapshot holds a reset signal (`reset_detected` true or any conflict), 4 when the guard or
  the transport refused a request, 1 when the run broke before a snapshot was written or the log
  was refused, and 2 for wrong flags or an output folder that is not empty. A run never writes over an earlier one.

### 7.1 Publishing to observatory-data

The second live step publishes each reading to the branch `observatory-data` of this repository.
It writes to that one branch and nothing else, and never to the chain. Section 4 still holds for
everything the observatory reads.

- Only the `publish` job in `.github/workflows/observatory-live.yml` may write, and only
  `contents`. The live job keeps `contents: read` and checkout keeps no credentials.
- The live job checks the branch out read only, without credentials, into the folder
  `observatory-data`, and passes its `log/` to the command. It first asks the server whether the
  branch exists: a branch that does not exist is a first run, and any other answer stops the job.
- The job runs only for `refs/heads/main`, for every event that runs the live job, and only when
  the live job uploaded its output folder. It runs when the live job failed, so a run that exited 3
  for a reset signal is published. It does not run when the run was cancelled. The run stays red
  when the live job failed: nothing continues on error.
- It runs no code from the repository: no checkout, no install, no build, no node and no script
  file. It downloads this run's artifact by the id the live job gave, then uses `sha256sum`, `jq`,
  `date` and plain git.
- File names come from one fixed list, the same as `PUBLISHED_FILES` in `src/published.ts`, never
  from the artifact. The artifact must hold only regular files from that list and `SHA256SUMS`, and
  `SHA256SUMS` must be exactly the sums of those files. That is checked before any file is read.
  A difference stops the job.
- Only a run that exited 0 or 3 is published, with all ten files. A run that broke or was refused
  is not published, and the branch stays as it was.
- `observed_at` and the snapshot hash are checked against fixed patterns before use, reach the
  publishing step only through environment variables, and are used only inside double quotes. No
  `${{ }}` value appears in a shell command.
- The layout: `latest/` is replaced whole by the output folder. The snapshot line from
  `snapshots.jsonl` is appended to `log/<UTC date of observed_at>.jsonl`. `README.md` at the root
  is written when it is missing. Nothing else is written: `recordings/`, which the record
  workflow's publish job writes (section 8), is left as it is. When that day file already holds the
  line (a run attempted again), nothing is written at all, so `latest/` never goes back to an older
  reading.
- The branch as fetched must hold only what the two publish jobs write: every entry of its tree, read with
  `git ls-tree -r` alone and before anything on it is read or written, is a regular file with mode
  `100644`. A link, an executable, a submodule or any other entry fails the job, and nothing is
  pushed, a reading attempted again included.
- The line follows the branch's last line, read from the files alone: the last line of the last day
  file in byte order. The job checks the line's `seq` and `prev_hash` against fixed patterns, then
  appends it only when its `prev_hash` is that last line's hash, or is null when the branch holds no
  day file, and when its day is not before the last day file's. Otherwise the job fails and pushes
  nothing: another reading was published after the live job read the branch, or the line would
  break the chain. The reading is not published. The next run checks out the branch as it is then
  and builds on its last line, so nothing has to be done by hand, but in one case: a log whose last
  line is dated after the real clock (a runner whose clock ran ahead). Every later reading is then
  held back by the day order check until the clock passes that line's day, and every one carries a
  conflict, since the log runs backwards (section 1.1). The way out by hand is the README's recipe:
  move `log/` aside on the branch, in a commit of its own, and the next run starts a new log.
- The commit is made by `github-actions[bot]`, and its message carries `observed_at` and the
  snapshot hash. A branch that does not exist starts as an orphan, with no parent.
- The push names `refs/heads/observatory-data:refs/heads/observatory-data` and nothing else, and is
  never forced. When it is refused, the job fetches the branch again, checks the line against its
  last line again, lays the reading on top and pushes once more. A second refusal fails the job.
- The sums show the files are the ones the live job wrote. They do not show the reading is true:
  its trust is still `"trusted RPC"`. A reader judges `latest/` with `judgeLatest` in
  `src/published.ts`: exactly the ten files (a `latest/` written before the upgrade watch, nine
  files with no `upgrade.json`, is refused until the next run replaces it), each matching `SHA256SUMS`, the snapshot passing
  every check of section 5 and its hash check with trust `"trusted RPC"`, every feed, the log line
  and `run.json` the ones the snapshot gives, `run.json` a `flop-observatory/live-run@1` that names
  the log line the snapshot follows (its `history.last_hash` is the snapshot's `prev_hash`, or the
  log was absent or empty and the snapshot has `seq` 0), and `observed_at` of the snapshot and of
  its status neither after the reader's now nor older than the limit the reader passes. A
  `run.json` from before runs kept memory (`live-run@0`) is refused: its reading spoke for itself
  only. `judgeLatest` does not read `log/`.

### 7.2 The upgrade watch

- Right after `state_getRuntimeVersion(F)`, at the same finalized hash F and only when F is 0x plus
  64 lower case hex, the run reads `state_getStorage` of `System.LastRuntimeUpgrade` then of
  `System.AuthorizedUpgrade`, each by its key (twox128 of the pallet then of the entry), through the
  same guard and transport. The guard's list does not change. When F is no such hash neither is read
  and the snapshot's `upgrade` is null. The snapshot command's `--upgrade` gives the same two answers
  from a file, counted as read at the status fixture's finalized head; without it `upgrade` is null.
- A storage answer is null (the node holds no value) or 0x and lower case hex of whole bytes. A call
  that failed on the way, and any other answer, is unknown. Absent is only the null the node sent.
  A failed or malformed read is never absent and never a zero.
- `executing` reads `System.LastRuntimeUpgrade` through `runtimeOfBlock` (section 9) and nothing
  else: `reviewed` when it answers a line, `not reviewed` when the bytes are a whole record no line
  names (its name and version as the record states them), `absent` for null, and `unknown` when the
  read failed, the answer is malformed, or the bytes are no record (its detail is the decoder's
  refusal). The version and metadata read at F are never used: they answer for the next block.
- `authorized` reads `System.AuthorizedUpgrade`: `present` for bytes, `absent` for null, `unknown`
  otherwise. A present authorisation always carries `length` in bytes and `sha256` of the raw bytes,
  lower case hex. `bytes` is the hex only when `length` is at most 256. Above that it is null, with a
  fixed detail. Nothing of it is decoded. The snapshot check holds them to each other: with `bytes`
  not null, its byte count equals `length`, is at most 256, and its sha256 equals `sha256`; with
  `bytes` null and the state present, `length` is above 256; `length` is never above 1048576.
  Anything else is refused. Every surface (the feed, the page, the MCP tool, the notice line) shows
  the length and the sha256, and the bytes when kept.
- `at` is the block both reads were made at: its hash, and its height when known. When the status
  has a finalized head, `at` equals it in both fields, hash and number; the check refuses any other.
  A status with no finalized head says nothing of `at`: the run reads at F once F is a hash, and a
  header of F that failed or holds no valid number leaves the status with none and the watch at F,
  its height not known.
- No answer's text is echoed: a detail is a fixed sentence or the decoder's refusal, and a failed
  call is named by its call.
- The watch is compared with the latest earlier watch in the log on the same RPC genesis the status
  read now, at a lower block; with none when there is none, when the height is not known or when the
  RPC genesis is not. `executing_changed` is none unless both sides name a runtime, and true when the
  name or the version differs. `authorization_appeared` is none unless both sides' authorised state is
  known, and true when it is present now and was absent in the watch compared with, or is present
  with another length or another sha256. The hex is never compared.
- The watch adds no conflict, never touches `reset_detected` and never changes an exit code. The spec
  floor of section 1.1 and `runtime_version` are unchanged. The notice line names the executing state,
  spec name and version and the authorised state.
- A log may hold `@0` lines after `@1` lines. Such a line is accepted and read as a line with no
  watch; it is not refused, since a refused log stops every later run and accepting it costs one line
  with no watch.
- It runs twice an hour, and the authorisation of Nov 12 was pending for 50 seconds: the watch mostly
  shows a landed change, and an authorisation only when a run falls inside its window.

## 8. Recordings

A recording is exactly what one RPC endpoint answered to a reviewed list of read calls, once, in
order. It exists so decoders (SCALE events and storage) can be built and tested against real data.
It is evidence for building them, never proof of chain state: no answer on it is checked against
anything, it trusts one endpoint as the live run does (section 7), and a block a list names is in
it because a person checked it by hand or a test record of the lab names it, and what it holds is
what an indexer or that record said, which no code here checks against the chain. Section 4 holds
for everything it reads.

- The request list is `recordings/requests.json`, reviewed like code. Its form is
  `flop-observatory/requests@0` (`src/requests.ts`): JSON in the written form (`src/feed.ts`),
  strict UTF-8, no key twice, nested at most 64 levels, exactly `calls` and `schema`, 1 to 64
  calls, each exactly `method` (an RPC method name), `params` (a list) and `why` (one plain line).
  Its sha256 is taken of its bytes as read.
- Which list is where: `recordings/requests.json` and `recordings/requests-inputs.json` are the
  current list. When a list is replaced, its request list and its inputs are already frozen in its
  recording's fixture folder, byte for byte, and the tests of that recording read those copies.
  Each list has one plan module (`test/helpers/requests/list-<n>.ts`) over one core that knows no
  list; nothing in a list is typed by hand. The first list was not derived (it predates this) and
  stays as its fixture keeps it.
- A block is in the encoding of the runtime that executed it. That is what
  `System.LastRuntimeUpgrade` at the block names, and it is the version and metadata read at the
  block's parent. `state_getRuntimeVersion` and `state_getMetadata` at a block describe the runtime
  of the next block, so at a block that carries a runtime upgrade they already answer for the new
  runtime. The third list read the upgrade from spec 1014014 to spec 1014020 by this rule: the
  version, `LastRuntimeUpgrade` and events at the four blocks around it, the metadata at the last
  block before it (the old runtime's) and at the block that carries it (the new runtime's, the one
  every later block is decoded with), our own storage records before and after it with the same
  key, and the deny list test's blocks. A storage key read at a block of the new runtime was built
  from the old runtime's metadata until the new one was in a committed file: a null there is not
  read as absent until the same key is built again from the new metadata.
- The fourth list reads the session rerun at spec 1014020, every key built from the 1014020
  metadata, which the third recording holds. It is the first list to ask `state_queryStorageAt`:
  asked one key a call, the events, the runtime record and the reads of its 23 blocks are 72 calls,
  over `MAX_CALLS`, and one `state_queryStorageAt` asks every key of one block and is answered as
  one set for that block. Each such call is exactly `[[key, ...], block hash]`, `System.Events` and
  `System.LastRuntimeUpgrade` first, then the step's reads in the plan's fixed order, no key twice;
  each block's hash is asked by its height too. A batch's answer is read only when it is exactly one
  set, for the block asked, listing every key asked once and no other; anything else is a refused
  read, and that block's values stay unknown. A key listed with null holds nothing. The reader is
  `test/helpers/batch-answer.ts`; it decodes nothing. What its values mean is the decoder's
  (section 9), and a value of an entry the reviewed shape does not state is not decoded: its bytes
  are kept apart and the value it answers stays unknown.
- The fifth list reads the encoder's devnet test at spec 1014020: the start block and the block of
  each sent step, each hash by its height, and at each one `state_queryStorageAt` of the same eight
  keys in one fixed order, built from the 1014020 metadata; each step's block whole by
  `chain_getBlock` at its hash; and for each step signed with a mortal era the hash at the era's
  birth height, which the step's signature binds. 32 calls. It reads `System.Account`, an entry the
  reviewed shape does not state: the recorder asks any key, and until a reviewed shape states it,
  the value it answers stays undecoded, kept apart, and unknown.
- Nothing is sent before the whole list is judged: a list not in that form is refused, and the run
  exits 1; a list that holds a method the read only guard refuses is refused, each refusal recorded
  as section 4 says, and the run exits 4. Either way nothing is read from the network. A method is
  allowed or refused by `guardRpc` alone; the list's form never decides it.
- Each call is made once, in order, one at a time (the next is asked only once the one before has
  its answer), through the one real transport
  (`src/net-root.ts`, `src/net.ts`): the guard and the allow list before every send, the 15 s
  limit, one socket. The tape is written by the same `Recorder` as the live run's (`src/tape.ts`).
  A call that failed on the way (an RPC error, the time limit, an answer over its limit, a socket
  that failed) is recorded as its error and the run goes on; anything else (a refusal, a tape that
  does not match) stops the run, which exits 4 when the guard or the transport refused and 1
  otherwise.
- Answer limits: every answer has the 1 MiB limit of section 7, but where a caller states a larger
  one for a named method, at most 8 MiB (`MAX_STATED_ANSWER_BYTES`). A recording states 8 MiB for
  `state_getMetadata` and nothing else; the live run states none, so its limit is unchanged. A
  message is read up to the largest limit of a call waiting at that moment, never more. An answer
  held to its call by its id that is over that call's limit fails that call alone. A message over
  every waiting call's limit cannot be held to one call: the socket fails, and every call after it
  is recorded as failed.
- The output folder holds exactly `tape.jsonl` (every request and answer in order; it holds no
  clock read), `run.json` (`flop-observatory/record-run@0`: started and ended, the source revision,
  the endpoint, the request list's sha256, how many calls were asked, answered and failed, the exit
  code and reason) and `SHA256SUMS`, written by the same code as the live run's
  (`src/run-command.ts`, `src/sums.ts`). The run exits 0 when every call was made and recorded,
  answered or failed on the way: a run whose every call failed (the endpoint down) exits 0 too, and
  its recording says so. It exits 2 for wrong flags or a folder that is not empty, and never writes
  over an earlier run.
- `judgeRecording` in `src/recording.ts` is the reader contract, pure: exactly the three files,
  each matching `SHA256SUMS` in its written form; `run.json` a `record-run@0` in the written form
  with exactly its keys, from `rpc wss://rpc.devnet.flop.network`, exit 0, a request list hash, its
  start and end in the recorder's form with the end not before the start, and counts that add up;
  a tape that parses and holds only rpc calls, each answered or failed on the way, as many as
  `run.json` counts; and, when the request list is given, its sha256 is the one `run.json` names
  and the tape holds exactly its calls, in order. It gives the calls with their answers, and the
  tape replays through `TapeTransport`.
- Publishing: only the `publish` job in `.github/workflows/observatory-record.yml` writes
  recordings, under the same discipline as section 7.1, by the same means: only on main, only when
  the record job exited 0 and uploaded its folder; no checkout and no repository code; file names
  from a fixed list (`RECORDING_FILES` and `SHA256SUMS`), nothing else in the artifact, every file
  checked against `SHA256SUMS` before anything reads it; every value from `run.json` checked
  against a fixed pattern and passed through the environment, only inside double quotes; plain
  git; the fetched branch held to plain files (mode `100644`) by the live job's own check, before
  anything on it is read or written; a push to `refs/heads/observatory-data` only, never forced,
  fetched again and tried once more when refused.
- Where: `recordings/<id>/` on `observatory-data`, `<id>` built by the shell from validated values
  only: the UTC time `run.json` says the run started, read digit by digit from the one form the
  recorder writes (`YYYY-MM-DDTHH:MM:SS.sssZ`) into 14 digits, a dash, and the first 16 hex of the
  request list's sha256. The publish step checks the id against that form again before it names a
  path with it.
- A recording is immutable: when anything is at `recordings/<id>/`, the job changes nothing, says
  so, and ends well. Two runs in one second of one list share an id, and the second is not
  published. The job writes nothing outside `recordings/<id>/`: not `latest/`, not `log/`, not
  `README.md`.
- The two publish jobs push to one branch and share no concurrency group: GitHub cancels a job
  that waits in a group behind another waiting one, which would drop a reading or a recording.
  Each job lays only its own paths on the branch as fetched and pushes a fast forward; a push
  refused because the other job pushed in between is fetched again, checked again and laid on top.
  The live job's checks read `log/` and the tree's modes alone, so recordings never change them.

## 9. The decoder

The decoder turns the bytes of a recording into values: `src/scale/` and `src/hash/`. No command
uses it yet. It reads bytes that came from the network, so every input is hostile, the metadata
included. At a runtime upgrade someone derives a shape from metadata nobody has reviewed yet, so
hostile metadata reaches the parser, the namer and `deriveShape` too. The promise: every exported
function of `src/scale/`, on any bytes, ends in a value or a `ScaleError`, within the bounds on work
below.

- What it decodes: the runtime metadata, version 14 only, read whole to its last byte; any value of
  a type that metadata defines, by the type and never by its name; the storage key of an entry,
  with the hashers the metadata states for it, each map key one whole value of its key type; a
  block's System.Events, by the type the metadata gives that entry; and the value of a storage
  entry the reviewed shape states, at a pinned block. Each event gets its pallet name and index,
  its name and variant index, its fields and its phase. The storage it reads today: System.Events
  and System.LastRuntimeUpgrade, ComputeChannel.Channels, and FlopSessionKeys Sessions,
  SessionNonces and CircuitBreakers (`STATED_ENTRIES`).
- Absent is an answer. A storage read whose answer is null is never an error and never a zero the
  chain did not send. For an Optional entry its value is null; for a Default entry its value is the
  default bytes the metadata states for that entry, decoded by its type; and either way it is
  marked not stored. Any answer with bytes is marked stored, even bytes equal to the default. So a
  caller can always tell a value the chain holds from a default.
- The key is checked. A storage value is decoded only with the key that was asked: the decoder
  builds the storage key from the entry and its key parts, and refuses when it is not the key the
  caller passes, so a value is never decoded under the wrong entry or account. The key asked is
  compared by its length first, never turned into text, then byte for byte, and no refusal prints
  it.
- The order of the storage door, in code and here: (1) the pallet and entry names, strings of at
  most 256 characters; (2) an entry the reviewed shape does not state is refused, before any other
  field of the input is read, so an unstated entry with malformed key parts is refused as not
  stated; (3) the pin; (4) the key parts, read by index once the list holds exactly as many as the
  entry takes, then the key asked; (5) the answer, bytes or null, and undefined is refused. Each
  field is read once, when its step comes.
- The doors trust no input object. `decodeStorageValue`, `decodeBlockEvents` and `pinShape` refuse
  an input that is not an object; anything thrown while a field is read (a getter, a Proxy trap)
  is a refusal with a fixed text of ours, never the foreign error's message; bytes are taken only
  from a real Uint8Array, measured from its own slots before anything is copied and copied once
  by the typed array's own set, never through an iterator, its constructor or its species, so a
  Proxy over one is refused; a byte array past `MAX_INPUT_BYTES`, a spec name past 256 characters and a
  shape file past `MAX_INPUT_BYTES` characters are refused. So the promise above holds for the
  doors on any input; the other exported functions take the inputs their types allow.
- What the metadata parser refuses beyond the encoding: type ids out of order, a type id or a type
  parameter or a signed extension type that names no type, mixed or repeated field names, a field
  or variant name of only digits (no Rust name is one), a variant index or name used twice, two
  pallets with one name, one index or one storage prefix, a storage entry or a constant named twice
  in a pallet, a signed extension listed twice, a modifier other than 0 or 1, a map with no hasher,
  and a map of several hashers whose key is no tuple of as many types.
- Values are JSON safe. u8 to u32 and i8 to i32 are numbers. Every wider integer is a decimal
  string, whatever its size, so no value is a float or past 2^53. Bytes are hex. A variant is
  `{ variant, fields }`. `Compact<()>` is null, read from no bytes. A bit sequence is refused, since
  the reviewed metadata holds none.
- A decoded value does not say its own type. A composite with the fields `variant` and `fields`
  decodes to the same form as an enum value. A reader goes by the type's kind in the metadata,
  never by the form of the value. A decoded object does not carry the order of its fields either:
  the shape file does.
- A decoded value is evidence, not proof. It is what one RPC endpoint answered (section 8), read.
  Nothing in it is checked against the chain.
- Pure: no module there reads a file, the network, a clock or a random source, or names process. A
  module there imports only from `src/scale/`, `src/hash/` and createHash from node:crypto. Of the
  names it does not declare itself, it names only the language built ins on the scan's list
  (`PURE_GLOBALS`), declares no name of a global, and takes no `.random`, by a member or by
  destructuring. The source scan holds it to this (section 4).
- The shape pin. Real chain data is decoded only through `decodeBlockEvents` and
  `decodeStorageValue` in `src/scale/block.ts`, and only when `pinShape` in `src/scale/shape.ts`
  pins the block. Outside
  `src/scale/`, a src module may import from it only `block.ts`, which the source scan checks. Both
  functions read each field of their input exactly once and copy every byte array, then hash,
  measure, parse and decode that one copy. `pinShape` refuses, and names the reason, when:
  1. the spec name and version are not in `REVIEWED`,
  2. the metadata bytes differ in length or sha256 from the reviewed bytes for that spec,
  3. the shape file given is not the reviewed file, by sha256,
  4. the shape derived again from the metadata differs from that file, byte for byte, or
  5. the block's System.LastRuntimeUpgrade does not decode, or names another spec.
  Refusal 3 is not implied by 2 and 4. It holds the code that derives the shape to the review: if
  `deriveShape` changes and the file is written again from it, 2 and 4 still pass and only 3
  refuses. A test shows that.
- The shape file, `flop-observatory/decoder-shape@3`, holds the spec and one section for each
  pallet of `STATED_TABLE` in `src/scale/shape.ts`, the one frozen table of what the shape states:
  each pallet by its name and its section (the name in snake case), each entry by its name and its
  key (the name in snake case). A section holds the pallet's index, its storage prefix (so a
  changed prefix changes the file) and each stated entry with its modifier, hashers, key type,
  value type and default bytes. The 16 stated entries: System Events, LastRuntimeUpgrade and
  Account; ComputeChannel Channels, FailedAcks and ChannelAuthoredOpenedAt; FlopSessionKeys
  Sessions, SessionNonces, CircuitBreakers and DelegateSessions; ModelRegistry Models,
  MeasuredRoots and AllowedDecodePolicies; MinerStaking Miners; HwCalibration CalibrationVersions
  and LastInitialCalibration. `STATED_ENTRIES` is derived from the table and `deriveShape` writes
  one entry for each of its lines, so the list and the file cannot differ; `deriveShape` refuses
  metadata that lacks a pallet or an entry of the table. Beside the entries the file holds the
  System.Version type, the ComputeChannel events, the fields of an event record, of
  LastRuntimeUpgrade and of a channel, and a channel's states, and a table of types: every type
  reachable from the key and the value of every stated entry and from the System.Version
  constant's type, keyed by its name, each with its kind, its path and what the kind holds.
  Version 2 added the default bytes, the storage prefixes and the FlopSessionKeys entries.
  Version 3 (round 29) added System.Account, FailedAcks, ChannelAuthoredOpenedAt, DelegateSessions
  and the pallets ModelRegistry, MinerStaking and HwCalibration with their entries; every part
  version 2 held is where it was, with the same name and meaning. A type with a path is named by
  the last part of its path, its parameters and its id; the table says what it is.
- A shape file is written by `scripts/write-shape.mjs` and by nothing else. For a reviewed line,
  by spec version, it finds the metadata on the third recording's tape by the line's metadata
  sha256, derives the shape and writes `shapes/<file>` only with `--write`; without it, it compares
  the committed file with what it derives, exit 0 or 1. `scripts/cli-checks.mjs` runs the compare
  for each line. A shape of another format is refused by every reader, with words that name both
  formats: the pin (refusal 3 says it), `scripts/shape-diff.mjs`, the writer's compare and
  imd-flop's `scripts/read-key-table.mjs`. The `decoder-shape@2` files are kept in
  `fixtures/shapes-at-2` for the tests that show it.
- `REVIEWED` starts with `tzkv-runtime` 1014014, metadata sha256
  `f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444` of 482132 bytes, and
  `shapes/tzkv-runtime-1014014.json`. Each line there is a review: a reviewer read the shape file
  and the metadata it came from, and a test derives the file a second way, from the reference
  decoder's own parse of the same metadata. A runtime upgrade is refused until its line is added.
- The second line is `tzkv-runtime` 1014020, metadata sha256
  `91294eb61225c4de7459e6a8fed3c37169a2c8a1b1906b46a5890d5e0d328238` of 487100 bytes, and
  `shapes/tzkv-runtime-1014020.json`, made as section 10 says.
- Which runtime reads a block is the decoder's decision, never the caller's: `runtimeOfBlock` in
  `src/scale/block.ts` takes the bytes of `System.LastRuntimeUpgrade` read at the block and nothing
  else, reads them whole as a Compact<u32> spec version then a string spec name of at most 256
  characters, and answers a copy of the `REVIEWED` line of that spec name and version, or a
  refusal. A refusal carries `named`: the spec name and version, as a number, when the bytes are a
  whole record no line names, and null when they are no record; a fresh object on each call, so no
  table leaves through it. The metadata a caller then gives the doors is the one that line names by its sha256.
  The version and the metadata read at the block itself are never used to choose: they answer for
  the next block.
- No caller can change what the decoder has reviewed. `REVIEWED` and each of its lines,
  `STATED_TABLE` with each pallet, entry list and entry in it, `STATED_ENTRIES` and each pair in it, and the parser's `PRIMITIVES` and `HASHERS` are frozen when
  their module loads. No reference to a line ever leaves `src/scale`: `pinShape`,
  `decodeBlockEvents`, `decodeStorageValue` and `runtimeOfBlock` each answer a fresh copy, made by
  `reviewedCopy` in `src/scale/shape.ts`. The parsed metadata a pin holds is parsed again on every
  call and never kept.
- Bounds on hostile input, each a refusal with a `ScaleError`, never another exception:
  - metadata of more than 16 MiB is refused before it is read, and so is a value or a
    System.Events of more than 16 MiB (`MAX_INPUT_BYTES`), so no string the decoder builds can
    reach the engine's limit;
  - a count or length that claims more than the bytes left is refused before anything is read
    or built for it, so no allocation is sized from an untrusted length; a list or array of
    elements that take no bytes is held to the same bound;
  - a compact integer must be in its shortest form and fit its type;
  - parsing metadata is linear in its bytes: each item it reads takes at least one byte, and the
    checks after it pass once over what it read;
  - a type nests at most 32 levels (`MAX_DEPTH`), so a type that refers to itself ends;
  - one decode takes at most `1024 + 8 * bytes` steps (`valueBudget`), one for each type it
    visits, the types a compact wraps included. Beside constant work, a step passes over its
    type's fields, each a step of its own, or searches its variants, of which there are at most
    256, since an index is one byte used once. A
    step that succeeds builds no text: a refusal's label is built only when it is thrown, and shows
    at most 120 characters of a type's path (`MAX_LABEL_PATH`);
  - one `deriveShape` has one budget, shared by every name and description it builds: at most
    1,000,000 steps (`MAX_SHAPE_STEPS`; each type visited or named again, each field, variant and
    parameter) and at most 4,000,000 characters of names and paths (`MAX_SHAPE_CHARS`). A name is
    built once per type id and kept, so the work is linear in the size of what it derives. A name
    is at most 2048 characters (`MAX_NAME_LENGTH`), nests at most 16 levels and visits at most 256
    types; `typeName` alone has a budget of its own. The reviewed shape takes 9,919 steps and
    19,244 characters;
  - finding the events layout looks up each variant of the outer enum among the pallets, at most
    256 times 256, since a pallet index is one byte used once.
- The hashes take their parameters from code, not bytes: a BLAKE2b length outside 1 to 64 or an
  xxHash64 seed outside 64 bits is a `RangeError`, a caller's mistake. A hasher name the metadata
  could not give is a `ScaleError`.
- The reference decoder (`@polkadot-api/substrate-bindings` and `@polkadot-api/metadata-builders`)
  and `@noble/hashes` are dev dependencies for tests only, pinned exactly. Tests compare the two
  decoders on the recorded metadata, on every recorded value and on seeded values of every type.
  No src module imports them, which the source scan checks.

## 10. At a runtime upgrade

A block is in the encoding of the runtime that executed it. That is what `System.LastRuntimeUpgrade`
at the block names, and it is the version and metadata read at the block's parent. The version and
the metadata read at a block answer for the next block. The decoder refuses every block of a new
runtime until these steps are done, in this order:

1. Record. A request list reads the blocks around the upgrade (the last block before it, the block
   that carries it, the first block the new runtime executed, and a later one): the hash, the
   version, `LastRuntimeUpgrade` and the events at each, and the metadata at the last block before
   it and at the block that carries it. The second is the new runtime's metadata. The record
   workflow records it and publishes it (section 8).
2. Fixture. The recording is copied into `fixtures/` byte for byte, with the request list and the
   inputs it was made from, frozen, and held to the lab's own reads of the upgrade.
3. Derive. The shape file is derived by `deriveShape` from the new metadata on the tape and written
   by `scripts/write-shape.mjs --spec <version> --write`, and a test derives it a second way from
   the reference decoder's own parse. If the strict parser does not
   read the metadata whole, or `deriveShape` needs a change of logic, the work stops for a rule
   from the lead before anything in `src/scale` changes.
4. Diff. `scripts/shape-diff.mjs` writes what differs from the shape before, types compared by
   structure, never by id, each pair of types followed once, and its output is committed beside the
   shape file and held to a fresh run by a test. Its first line names both specs. It refuses a file
   that cannot be read, is not JSON, is not `decoder-shape@3`, or lacks or adds a part it reads,
   with one line on stderr and exit code 2. Exit code 0 means it compared, whether or not something
   differs: the diff is a report, and the test that holds the committed diff to a fresh run is the
   check.
5. The line. The builder adds the runtime's line to `REVIEWED`: the spec name and version, the
   metadata's sha256 and length, and the shape file's sha256.
6. Independent review. A reviewer who wrote none of it reads the shape file, the metadata it came
   from, the diff and the line, and attacks the work. The line reaches main only after that review
   and the lead's rule for each defect it finds.

The stored values of the lab's own records are read with the same key at the last block before the
upgrade and at a block after it, and each key is built again from the new metadata, so the next
reader can say whether the upgrade changed a prefix, a hasher or a stored value.
