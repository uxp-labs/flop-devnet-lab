# FLOP Observatory

Read-only observatory for FLOP devnet: network status, reset detection, spec drift, an event
census, and escrow states from finalized blocks. Output as a page, JSON feeds and an MCP server.

M0 runs on saved fixtures only. No network, no keys, no spend, no signatures. The first step of
live reads is one command that reads network status from FLOP devnet, read only, and nothing else
([Live network status](#live-network-status)). Every other command still reads saved fixtures.

## Check

```sh
cd observatory
npm run check
```

One command. Each run writes `check-runs/<source-sha>/<run>/` with a pinned report, every log,
and `SHA256SUMS`:

| Step | Proves |
|---|---|
| install, typecheck, build | clean install from the lockfile and a clean compile |
| test | unit, boundary and consistency tests. Every network and child process path is blocked at runtime (fetch, WebSocket, node:http, https, http2, net, tls, dgram, dns, child_process, worker threads, module hooks, and the lower layers: net.Server's _listen2, the dgram.Socket constructor, dgram and dns resolver objects, ChildProcess spawn, native bindings, process.dlopen, inspector), and any attempt left in the log, or any refused write, signature or spend, fails its file. One exemption: `runShell` in `test/setup.ts` lets `test/publish-shell.test.ts`, and that file only, run `bash`, in a clean environment with git limited to `file://` remotes, so the publish job's shell is run against a local bare repository; a call from any other file is recorded as a process attempt. Every attempt is also written to a journal the moment it happens, and the journal is checked once every file has ended. The checks the MCP binary makes before it serves a snapshot are one module, `src/snapshot-check.ts`, each check named; its table, `test/snapshot-check.test.ts`, gives every check a case that breaks it and nothing else, refused cases on both sides of each comparison, holds snapshots the rules allow, which must be served (a short or unknown source sha, an http status of -1, a reset read on the faucet's genesis alone, evidence at its bound, each field the command may write as none, a time with an offset, heights of 0, equal heights with a lag of 0, ...), and fails if any check has no case; its grid, `test/snapshot-check-grid.test.ts`, holds the same checks to RULES.md section 5 as `test/helpers/snapshot-spec.ts` writes it down apart from the code: every field at every place given each value of its type's pool, inside and outside the type, each object given a field more, one left out or one renamed, and the settlement agreements walked over grids of small domains, where every verdict must equal the reference's. The pools and grids are finite, so they show the checks and section 5 agree on those values, not on every value |
| test-report | the test report read again: every test file ran, each ran exactly the tests `test/test-counts.json` pins, by number and by a digest of their names in their order (so a test removed, renamed or moved shows; adding, renaming or moving one means updating its entry there), and no test was skipped, left as a todo or shut out by a `.only`, which vitest's exit code alone would not show; the test sources hold no `.fails` test and no empty `.each` or `.for` table, which a status cannot show; the same rules fail doctored copies of the report (one test skipped, one todo, one file missing, one test removed, one renamed, two that swap names). A table held in a variable and a test that returns before its assertion are still not seen |
| attempts | the journal again, after the test run has exited: no attempt left in a file's log, nothing at all after a file's final check (a blocked call fired from a timer, say), and every test file reached that check, each file counted once (a file checked in two runs is itself a problem) |
| source-scan | every src module read as a syntax tree, with escapes decoded and comments skipped: imports only from an allow-list (node:fs, node:path, node:readline, node:url, node:crypto for createHash only, yaml) or relative ones that land on a scanned .ts module in src, each by name (no default or namespace import, no default export taken by its name, no export *, no dynamic import, so src holds no module object), no import-equals, no banned name as an identifier, a property, a string key, a template key, a regular expression or any other string (transports, the global object, the Web Crypto global, eval, Function, Reflect, constructor, the APIs that define getters on a prototype or list its names, atob, Object.assign, the stack trace hook, WebAssembly, connect, listen and bind, the Web Crypto classes, module loading, signing, key and cipher APIs), no underscore name, as an identifier or a string, no reader's .input or .output, the reader itself only as `rl.on(event, arrow function)` in a statement of its own (rl a const that is not exported and holds the whole `createInterface(...)` call, the one place createInterface is named but its import), process only as version, argv, exit, stdout.write, stderr.write and `createInterface({ input: process.stdin })`, no computed key that is not a literal (src reads a data record by a run time key only through `own()`, which never reaches an inherited member or hands back a function), no RPC write method named, and nothing in src but regular .ts files. It first catches 129 known bad samples (the reader listed, exported, kept as the value on returns, given to a listener as this or stood in for by a function of src's own, an underscore name as a string, the default export by its name, the reader's stream read back, escaped names, legacy and third party modules, a comment before the module name, string and template keys, a getter on a prototype, an import-equals, paths out of src, keys read back from a regular expression, decoded, listed or trimmed, a stream asked to connect, a dynamic import of node:crypto, a namespace or default import, export *, the Web Crypto classes, stdin read back) and passes 18 good ones, and its file list names a .mts module, a .js file and a link in a throwaway folder. Its one exemption, `src/net-root.ts` naming WebSocket and fetch as the options of `new NetTransport(...)`, is proved on 2 good and 18 bad samples in that file, and the same form fails in 7 other module names, the live command and the recorder among them |
| canary | the harness fails a throwaway test that leaves a fetch, an https request, a net connection, a child process, module hooks, a listening handle made under listen, a dgram socket made directly, a refused RPC write, a refused signature or a refused spend, and two that make their attempt from a timer after the file's final check; a clean throwaway test passes, and so does the late timer once the journal check is taken out, so that check is what catches it |
| mutants | in a copy of every file git tracks (nothing untracked), an unmutated control passes, then each injected bug (reset ignored, stale RPC, conflicts dropped, malformed escrow accepted, one event claiming two escrows, an unreadable page dropped, a partial census shown complete, an account named `__proto__` dropped from a feed, ...) makes at least one test fail. Bugs in the command line, the MCP binary and the syntax tree scan are caught by their end to end checks on a fresh build of the copy; each check in `src/snapshot-check.ts`, turned off, made weaker or made stricter one at a time, is caught by the table case that names it. A mutant that only breaks loading is never counted as caught, a replacement is written exactly as given, a copy that cannot be made is reported as setup-failed, and a run with no mutant fails. Four kills (a repeated key served by the MCP binary or trusted in the log, deep nesting unchecked, and a blank log line accepted) show the refusal names its reason: the written form and canonical form checks, and the log's other line rules, refuse those files too, and are mutated on their own |
| mutants-canary | the mutation runner classifies a real bug, an equivalent change, a syntax error, a missing test, a replacement holding `$$`, and a command line bug and no-op correctly; its copy holds exactly the tracked files of a throwaway repo; a copy it cannot make is reported as setup-failed; it still works when the temp folder is reached through a link; and a mutant file with no mutant fails the run |
| recount | the TypeScript census and an independent Python recount agree on every census fixture, and on scenarios made at run time for inputs git cannot hold (a page file name that is not UTF-8, a scenario whose event-pages, or whose one page file, is past the system's path limit, which both refuse as a page file problem naming it). Where both refuse, they must refuse for the same reason and name the same file (RULES.md 3.1 clause 16). A nudged total, or a changed refusal reason, is caught in every scenario, and the canary fails unless it nudged at least one count and one refusal. A page file name that holds a colon and a semicolon is compared whole, and so are two that differ only after a line break, which both sides show as %0A. Command line inputs both sides must refuse alike are compared too: request numbers that are not plain digits or are too long, an inverted range, an empty genesis, a missing folder, and flags read other than as `--name` and then its value (`--name=value`, an abbreviation, an unknown flag, a flag twice, with no value or an empty one, a stray argument, the folder flag left out); a value that starts with a dash is a value on both sides, and the same flags in another order count the same. The recount's own tests read recount.py as a syntax tree: five plain imports with no alias and no submodule, only the builtins and the attributes it uses, no match statement, no frame or code field, and no call that runs code, starts a process, opens a socket or writes |
| cli-checks | the command line passes unreadable pages to the census and escrows, refuses parts pinned to another chain and an escrow id listed twice, catches a rollback even across a snapshot with no RPC reading or after one with no head time, a restart that keeps the genesis but reports a low best height and no finalized head, and a log that runs backwards, refuses a log line that is not in canonical form, reads request numbers as plain digits and refuses a missing folder as an input problem after any request problem, writes pin.json in the feed format, reports the health rules, takes an earlier best height as a floor though that snapshot read no finalized head, says in the faucet's detail when a usable /chain reading names no genesis, refuses an escrow id that is not 0x plus 64 hex, refuses a flag a command does not read, one given twice, a value after =, a stray argument, an empty value and a --now that is no time, refuses census without its folder flag, or with no range given and none in meta.json, as a request problem, names a missing folder in one line with a line break in its name as %0A, and after a finality stall reads a fall of the best height further than the lag limit as a conflict until it is back within the limit; every command refuses a scenario whose meta.json now is missing or no time unless --now gives one; a saved reading, a meta.json, a snapshot log, a drift spec and a served snapshot that is a named pipe are refused at once, never waited on; every node it starts runs with its warnings off, so a warning Node prints for its environment cannot fail a check; the MCP binary serves a snapshot whose hash verifies and refuses one that does not, one with a key twice, one that is not valid UTF-8, one behind a byte order mark, one with an integer the parser would round, one nested 20000 levels deep, an object that hashes to itself but is no snapshot and one whose status is an empty shell, a refusal naming the checks of `src/snapshot-check.ts` the file breaks (one shape, one agreement, two at once, and the first five of fourteen with how many more), and serves what the snapshot command writes, an http status of -1 included |
| snapshot, mcp, consistency | six real snapshots (healthy, reset, nothing read, degraded faucet, conflicting evidence, and accounts named `__proto__`, `constructor` and other inherited names), each rendered as feeds, page, snapshot log and a real MCP stdio transcript. Every page cell is resolved in the snapshot and compared, in data-v, in its whole visible text and in its class; every td and span must carry data-k; each row's label must name its cell, and each escrow card and drift row may hold only its own cells; each table holds only its own section's cells, under that section's heading, and the drift columns come in the order every row holds its cells; nothing is hidden (no comment, only the elements and attributes the page writes, each attribute once, only its own stylesheet); no text states a value outside the compared cells (every th is read as a label or a column, the head is fixed, tags are lower case and every < opens one, the banner is one of two whole sentences, every other piece of text is the page's fixed words, aria-label only says unknown); every file is read as strict UTF-8 and every JSON file and MCP line is parsed first, so a file cut short fails at once, then read with no key twice and in its written format, the transcript included (one compact server line per exchange, the script's key order, nothing else in the file); every element's class is the renderer's (a class on a row, a table or a card fails) and the page holds exactly its paragraphs, cards and tables; every value cell carries its data-v, compared as a value; every value sits in a labeled row or a drift item row (data-row only drift.<index>), each label plain text with scope="row", and a bare code element only around an escrow id; snapshot.json must be an observatory snapshot, and an output of any shape the check cannot read ends it with a failure; each feed holds exactly its five keys and equals the snapshot; the MCP transcript is exactly the exchanges the transcript script makes, the initialize answer and the tool list are exactly the server's, each refusal has its own code and words, an escrow id the snapshot does not hold reads unverified, and each answer is exactly one text item equal to the feeds byte for byte; the folder holds exactly its nine files, the whole log's hash chain verifies and its last line is snapshot.json in canonical form; a marked cell holds no markup but a bare code element, sits in the element the renderer writes it in (a td for every value but the snapshot's hash, time and trust and the census status), and the page holds exactly the renderer's keys in its order; and last, every file equals what the code writes for the snapshot, byte for byte, MCP lines included |
| consistency-canary | clean copies pass, and 109 tampered copies (an attribute named twice on a cell, two labeled rows turned into item rows, a value cut out of its row, a row turned into a bare span, two heights cut to bare cells, a label wrapped in h1 or stripped of its scope, a value wrapped in code, a blank cell that says data-v null, snapshot.json null or with escrows that are no list, status.json null, a transcript line null, snapshot.json, status.json or a transcript line cut short, snapshot.json not UTF-8, the transcript respelled with its keys reversed, CR LF line ends and blank lines, every server line respelled, a row, a table or an escrow card painted with a class, an empty banner and card added, a cell's data-v removed, initialize instructions that say spend, tool descriptions and schemas changed, an extra answer for an unseen escrow or under a tool name with a trailing space, a refusal that says signed, lines of the transcript removed or given a note, the unseen escrow answered claimed, two lines added before the log's real one, two extra files in the folder, pin.json keys reversed, a health word painted down in a nested span, two rows removed, escrow cards swapped, an upper case row, table or paragraph, bare text typed into a row or a card, words behind a lone <, a th outside every row or inside a drift item row, a banner whose later words say the opposite, a head with another charset, a feed with extra top level keys, a key said twice or a renamed schema, the same in snapshot.json, pin.json and the log line, an MCP answer with a second item, structuredContent or isError, a server line with a key twice, a signing tool listed or answered, an account named `__proto__` dropped from a feed or from snapshot.json, a reset flipped on the page or in the feed, stale flipped, a conflict dropped, a census total nudged, an empty list shown blank, a key dropped or invented, a wrong value hidden in a nested span or shown in a cell without data-k, value cells swapped between rows or escrow cards, a row label renamed, a row commented out, hidden or styled away, a section folded or rewritten by a script, a row moved to another section, headings swapped, drift columns swapped or dropped, a fabricated row of two th cells, a free paragraph, a second h1, the title, a stray code element or a changed seq stating a value, an aria-label or a class that misreads a cell, the snapshot edited after hashing, ...) each fail, the newer ones by the check they name. A run that prints no report, exits other than 0 or 1, or runs past its time limit gives no verdict and never counts as a catch, and a tamper that names no check is caught only by a failure other than the check's own crash report. Each tamper is checked twice, with and without the final byte comparison, and must fail both, so the rules alone catch it; one tamper that changes only bytes the rules do not model (a line break) passes the rules and fails the byte comparison, which shows that comparison bites |

The last line of the check prints the outputs digest, and `report.txt` records it, so a CI log
can be compared with a local run without downloading anything.

The mutants step runs every file in `mutants/`. Where a sandbox stops a command after a few
minutes, run them one file at a time instead, each with its own report:

```sh
for f in mutants/*.json; do node scripts/mutate.mjs "$f" > "mutants-$(basename "$f")"; echo "$f exit $?"; done
```

Each file passes on its own when all its mutants are killed. Those in `mutants/cli.json` each
rebuild a copy and run the command line checks, so that file takes longest; the rest are unit test
runs of a second or two each.

`SHA256SUMS` shows files were not changed after the run. It does not prove the run was honest.
For that, rerun on the same revision in a fresh clone (or read the CI artifact) and compare
`outputs/`. They are byte-identical for the same revision on the same Node version only: each
snapshot's pin records `process.version`, so a published outputs digest holds for the exact Node
version stated beside it (v22.23.4 so far), and a run on any other version differs in `pin.node`
and in every hash that covers it.

## Commands

```sh
node dist/cli.js status   --fixtures fixtures/status-healthy
node dist/cli.js escrow   --fixtures fixtures/escrows-verification
node dist/cli.js census   --fixtures fixtures/census-complete
node dist/cli.js drift    --fixtures fixtures/drift-seeded
node dist/cli.js snapshot --status fixtures/status-healthy --escrows fixtures/escrows-verification \
  --census fixtures/census-complete --drift fixtures/drift-seeded --out out --log out/snapshots.jsonl
node dist/mcp-bin.js out/snapshot.json    # MCP over stdio, read-only tools
```

Every flag is `--name` followed by its value as the next argument. A flag the command does not
read, one given twice, `--name=value`, an empty value (an unset shell variable gives one) and an
argument that is no flag's value are refused (for `census` as a request refusal, as
`tools/recount.py` reads its own flags). `--now` must be a time with a zone; without it a command
takes the scenario's `meta.json` `now`, which must be one too. The `status` command
reads no log, so the checks against earlier snapshots run only in `snapshot`.

The snapshot log is the memory behind the rollback, changed hash and stuck height checks. Every
earlier head on the same genesis sets the finalized height floor, one that came with a read
error included, so the floor fails closed, and every earlier best height sets a floor less the lag
limit, with or without a finalized head. After a finality stall a long fork that falls away keeps
the head unusable until its best height is back within the lag limit, since a restart looks the
same. If a reading that later proves wrong keeps every later
snapshot degraded, start a new log (a new `--log` path) and keep the old one for audit: the floor
starts again from the first snapshot in the new log.

## Live network status

```sh
npm run build
node dist/live-bin.js --out <a new folder> --log <the published log folder> [--source-sha <revision>]
```

What it does, once per run:

- Reads the published log first: `--log` names a folder of day files, `<UTC date>.jsonl`, the
  `log/` folder of the branch `observatory-data` ([Published readings](#published-readings)). A
  folder that does not exist is a first run. The day files are read in name order as one hash
  chained log, through the store's own reader and chain check (`src/store.ts`, `src/history.ts`).
- GETs the faucet's `/health` and `/chain` and the gateway's `/v1/models`.
- Opens one WebSocket to `wss://rpc.devnet.flop.network` and calls `system_chain`,
  `chain_getBlockHash(0)`, `chain_getFinalizedHead`, `chain_getHeader` for the finalized head (by
  its hash) and for the best head, and `state_getRuntimeVersion` at the finalized head. When the log
  holds a finalized head on the pinned genesis, it then calls `chain_getBlockHash` at the height of
  the latest one, the anchor, to read that block back. A first run makes no such call.
- Builds a `networkStatus` snapshot from those answers with the same code the fixtures go through,
  pinned to the genesis in `src/status.ts`, on top of every snapshot in the log. So the checks
  against earlier snapshots run, unchanged, over real history: a finalized height below the
  highest one logged on this genesis, a changed hash at a logged height, a best height below the
  floor, a finalized height stuck past the stale limit, and a runtime version below the highest one
  logged on this genesis (a higher one is an upgrade, and changes nothing). The anchor read back
  under another hash, or gone (the node has no block at that height), is a conflict and
  `reset_detected` true: the finalized chain is not the one the log saw. An anchor read that failed
  gives no verdict: `reset_detected` is not `false` then, and the RPC detail says why.
- Writes into the folder, which must be new or empty: the snapshot (`snapshot.json`, the feeds and
  `snapshots.jsonl`, its one new line of the log, with the `seq` and `prev_hash` that follow the
  log's last line), `tape.jsonl` (every request and its answer, in order), `run.json` (start, end,
  the revision if given, which case the log was in, how it ended) and `SHA256SUMS`.
- Prints one line in the GitHub Actions notice format with the trust, the three geneses,
  `reset_detected`, the heights, the runtime version, each service's health, the snapshot's `seq`
  and `prev_hash`, and the snapshot hash.
- Exits 0 when a truthful snapshot was written, even with a service down or unknown. It exits 3 for a
  reset signal (`reset_detected` true, or any conflict), 4 when the guard or the transport refused a
  request, 1 when the run broke or the log was refused, and 2 for wrong flags or a folder that is
  not empty.

`run.json` names the case the log was in, as `history.state`:

| State | What the run does |
|---|---|
| `absent` | the folder does not exist: a first run, `seq` 0 |
| `empty` | the folder holds no day file: the same as a first run |
| `read` | every line read, the chain verifies, every snapshot passes `src/snapshot-check.ts`: the new snapshot follows the last line |
| `unreadable` | a name that is no day file, a link, a day file with no line, or a line that is not what the store writes: refused |
| `broken` | a line does not follow the one before it: refused |
| `unchecked` | a line in the chain is no snapshot this code can check: refused |

A refused log is never read as no log. The run reads nothing from the network, writes no snapshot,
exits 1 and says why. It never starts a new log over a broken one. To start a new log on purpose,
move `log/` aside on the data branch by hand, in a commit of its own, and keep it for audit: the
next run finds no log and starts at `seq` 0. The readings published before runs kept memory are
each a log of one line, `seq` 0 with no `prev_hash`. The reader accepts such lines only at the
start of the log, before any chained line, and the chain goes on from the last of them.

Every run reads the whole log. The checks need the highest finalized and best heights ever logged
on the genesis, every hash logged at the current height, and the latest run of snapshots at that
height, which can be any length. Any bound short of the whole log would need a summary of those,
which is a second owner of the rules in `src/status.ts`. Measured on Node 22: a year of readings,
48 a day, is about 31 MB in 366 day files and takes about 1.4 s to read and check. The floors are
found by a fold over the earlier heights, so no count of them breaks the checks; a test holds them
at 200,000 earlier heads, more than eleven years at 48 a day.

A live snapshot's trust is `"trusted RPC"`. It trusts one RPC endpoint, and the faucet and gateway
as they answer. It is not proof: no light client, and no header hash is checked. The anchor is one
block read from that same endpoint: it catches a chain that changed under the log (a chain restored
from a backup, or restarted from the same spec and grown past the log's heights, keeps its genesis),
not an endpoint that lies consistently.

What it never does: call an RPC method outside the guard's list, send anything but GET, reach a host
other than `rpc.devnet.flop.network`, `faucet.flop.network` and `api.flop.network`, follow a
redirect, hold a key, sign, or spend. Each request has a 15 s limit and each answer a 1 MiB limit.
Its memory is the published log and nothing else: it keeps no cache. Its history is only as
durable as that branch: lines cut from the end of the log, a line from before memory added to,
removed from or moved within its start (those lines are each checked alone, not chained to each
other), or the whole log removed cannot be detected from the log itself. The chain catches damage
and reordering after its first chained line; it is no defence against someone who can write to the
branch, who can rebuild every hash. It reads no events, so it writes no census, no escrow state and
no drift.

`.github/workflows/observatory-live.yml` runs it at 7 and 37 past each hour, by hand, and on a push
that changes the workflow or a live source file, and uploads the folder as an artifact. The live
job checks out `observatory-data` read only and without credentials, when it exists, and passes
its `log/`. It uses no secrets. On main, a second job publishes the folder to a branch
([Published readings](#published-readings)).

Offline, `npm test` covers it without a network: synthetic tapes in `fixtures/live-*` replayed
through the status code, the transport with a fake socket class and a fake HTTP call, a run whose
tape replays to the same snapshot, and the workflow read as data. Real readings taken from the data
branch are in `fixtures/published-*` (marked `synthetic: false`, with the data branch commit, the
workflow run, the revision and the tape's sha256 in `meta.json`). The first two are first runs:
each replays to its recorded snapshot, and the second is built on the first in one chain. The
third, `published-2026-11-11-1206`, is the first reading the memory step published, built on the
five before it, with the RPC down. Replayed on that log it asks for the anchor its tape does not
hold; with that call answered as the socket answered every other (synthetic), it gives the recorded
status but for the RPC detail, which says the anchor could not be read. The fourth,
`published-2026-11-11-1239`, is the next one, with a finalized head: replayed on its log with the
anchor answered with the hash the log holds (synthetic), it gives its recorded status but for its
trust. From its log a test builds the anchor request the next run makes, block 3473481. Synthetic second readings in
`fixtures/memory-*`, made from the first real tape, show each check against history and each
refused log. Those tapes, and the real ones, were recorded before runs read an anchor back, so they
hold no anchor call: a first run's tape replays as a first run exactly, and on a log that names an
anchor any of them is refused at the call it never answered, unless a test answers it, synthetic, as that fixture's own chain would
(`test/helpers/tapes.ts` says each answer and why). Synthetic readings in `fixtures/anchor-*`, made
the same way, hold the anchor call and show each case of the anchor and the spec floor.
`npm run check` runs those with everything else, and `mutants/live.json`, `mutants/memory.json` and
`mutants/anchor.json` hold the bugs they must catch.

## Recordings

```sh
npm run build
node dist/record-bin.js --requests <the request list> --out <a new folder> [--source-sha <revision>]
```

A recording is exactly what one RPC endpoint answered to a reviewed list of read calls, for
building and testing decoders against real data. It is evidence, never proof of chain state
(RULES.md section 8).

- The request list is `recordings/requests.json`: a `flop-observatory/requests@0` in the written
  form (sorted keys, two space indent, a newline at the end), with no other key and no key twice,
  and 1 to 64 calls, each `method`, `params` (a list) and `why` (one plain line). It is reviewed
  like code. The first list asks the finalized head and the genesis hash, then for each of twelve
  blocks with compute channel events its hash by height, its header, `System.Events` and
  `System.LastRuntimeUpgrade` at its hash, then the runtime version and the metadata at the last.
- A list that is not in that form, or that holds a method the read only guard refuses, is refused
  before anything is sent: nothing is read from the network, and the run says why.
- Each call is made once, in order, on one socket, through the same transport and guard as the
  live run (`src/net-root.ts`, `src/net.ts`), and recorded on a tape by the same code. A call that
  failed on the way (an RPC error, the 15 s limit, an answer over its limit, a socket that failed)
  is recorded as its error, and the run goes on.
- Each answer has the 1 MiB limit, but `state_getMetadata`'s, which has 8 MiB (about 964 KB as hex
  today). The live run states no larger limit, so its limit is unchanged.
- It writes `tape.jsonl`, `run.json` (start, end, the revision if given, the endpoint, the sha256 of
  the request list as read, how many calls were asked, answered and failed, how it ended) and
  `SHA256SUMS` into a new folder, prints one notice line with the counts and the byte length and
  sha256 of each metadata answer's decoded bytes, and exits 0 when every call was made and
  recorded (answered or failed), 4 when the guard refused a request, 1 when the list could not be
  read or was refused or the run broke, and 2 for wrong flags or a folder that is not empty.

`judgeRecording` in `src/recording.ts` reads a recording: exactly its three files, each matching
`SHA256SUMS`, `run.json` a `flop-observatory/record-run@0` in the written form that exited 0 and
names the list's hash, and a tape that holds exactly the calls of that list, in order, each
answered or failed. It gives the calls with their answers, and the tape replays through
`TapeTransport`.

## Published readings

On main, the publish job in `.github/workflows/observatory-live.yml` puts each live reading on the
branch `observatory-data` of this repository. It holds block heights, hashes and service health.
It holds no key and nothing personal. Every commit on it is made by that job.

| Path on `observatory-data` | What |
|---|---|
| `latest/` | the output folder of the newest published run: `snapshot.json`, `status.json`, `escrows.json`, `census.json`, `drift.json`, `snapshots.jsonl`, `tape.jsonl`, `run.json` and `SHA256SUMS`. Each run replaces it whole |
| `log/<UTC date>.jsonl` | one snapshot per line, one line for each reading published that day, as the run's `snapshots.jsonl` holds it. Read in name order, the day files are one hash chained log: each line names the hash of the line before it. The readings published before runs kept memory are each `seq` 0 with no `prev_hash`, at the start of the log |
| `README.md` | what the branch is, written when it is missing |

A run is published only when it wrote a truthful snapshot: exit 0, or exit 3 for a reset signal.
A run that broke or was refused leaves the branch as it was, so `latest/` can be old: check its
time. A reading whose line does not follow the branch's last line (another reading was published
after it read the branch) is not published either. The job fails and pushes nothing, and the next
run builds on the branch as it is then.

Read it with a plain GET of the raw file, no login:

```sh
curl -s https://raw.githubusercontent.com/uxp-labs/flop-devnet-lab/observatory-data/latest/status.json
```

`status.json` holds `reset_detected`, `conflicts`, the heights and each service's health. Its trust
is `"trusted RPC"`: one RPC endpoint was trusted. It is not proof. A reader must check
`observed_at` and refuse a stale reading. `judgeLatest` in `src/published.ts` is the reader
contract: given the text of every file in `latest/`, a time it trusts as now and the oldest age it
accepts, it says whether the reading may be used, and the reset signal it holds. It refuses, and
reads no further, when:

1. the files are not exactly the nine above,
2. a file differs from its line in `SHA256SUMS`, or `SHA256SUMS` is not in the written form,
3. `snapshot.json` is not JSON in the written form, breaks a check in `src/snapshot-check.ts`, fails
   its hash check, or its trust is not `"trusted RPC"`,
4. a feed or `snapshots.jsonl` is not the one the snapshot gives, or `run.json` is not a
   `flop-observatory/live-run@1`, names another snapshot or another exit (3 with a reset signal,
   else 0), or does not name the log line the snapshot follows (`history.last_hash` equal to its
   `prev_hash`, or a first run and `seq` 0),
5. the snapshot's `observed_at` or its status's is after now, or older than the limit.

It is pure: it reads no file, clock or network. It does not read `log/`: a reader who wants the
chain reads that folder with `readHistory` in `src/history.ts`. The sums show the files are the
ones the job checked. They do not show the reading is true. A raw GET can also be served from a
cache for a few minutes, which is one more reason to check the time.

## Rules

[RULES.md](RULES.md) is the spec: unknown is never good news, only finalized events on the pinned
genesis are evidence, gateway reports are not chain proof, settlement says nothing about output
quality, partial counts are never complete, and nothing signs, spends or writes.

The two interfaces other teams import are in [../interfaces](../interfaces).

## Layout

| Path | What |
|---|---|
| `src/status.ts` | network status, reset, stale and conflict detection |
| `src/escrow.ts` | escrow state from finalized events |
| `src/census.ts`, `src/drift.ts` | event census and spec drift |
| `src/store.ts`, `src/feed.ts`, `src/page.ts`, `src/mcp.ts` | snapshot log (one file, or split by day), feeds, page, MCP |
| `src/history.ts` | the earlier snapshots a snapshot is built on, and the case a published log is in |
| `src/guard.ts` | the read-only guard every transport must pass through |
| `src/transport.ts` | the one interface a live read goes through |
| `src/net.ts` | the live transport: the guard and the allow list before every send, time and size limits, one socket |
| `src/tape.ts` | the recording of a live run, and its replay, which refuses any request that is not next |
| `src/rpc-head.ts`, `src/live-source.ts` | the RPC answers turned into a head, and the Source over a transport |
| `src/live-run.ts`, `src/live-bin.ts` | one live run and its files, and the command |
| `src/net-root.ts` | the one module that names the real socket class and HTTP call: the live command and the recorder take their transport from it |
| `src/sums.ts` | the one form of `SHA256SUMS`, for the live run that writes it and the reader that checks it |
| `src/published.ts` | the reader contract for `latest/` on the branch `observatory-data` |
| `src/snapshot.ts`, `src/cli.ts` | one pass and the command line |
| `src/snapshot-check.ts`, `src/mcp-bin.ts` | every check a snapshot must pass before the MCP binary serves it, each by name, and the binary that reads, checks and serves it |
| `src/own.ts` | the one way src reads a data record by a key only known at run time |
| `src/files.ts` | the one way src reads a file it is handed: a regular file only, opened without waiting, so a named pipe is refused instead of blocking |
| `tools/recount.py` | independent census recount, written from RULES.md alone |
| `fixtures/` | saved scenarios; `meta.json` says which values are real and which are made up; `live-*` and `memory-*` are synthetic tapes; `published-*` are real readings from the data branch, with their provenance |
| `mutants/` | the injected bugs and the tests that must catch them |
| `REVIEW-LOG.md` | what each outside review and independent rerun found, and the fix and proof for each, newest first |
| `test/setup.ts` | the runtime block on every network and process path, its one exemption (`runShell`, for `test/publish-shell.test.ts` only), the leftover attempt check, and the attempts journal |
| `test/global-setup.ts`, `scripts/attempts-check.mjs` | the journal check once every test file has ended, and again after the run |
| `scripts/tracked.mjs` | the copy of exactly the tracked files that the mutation runner and the canary work in |
| `scripts/check.sh` | the check |
| `scripts/mutate.mjs`, `scripts/mutate-canary.mjs` | the mutation runner and its self-test |
| `scripts/canary.mjs` | the harness canary |
| `scripts/compare-recount.mjs` | TypeScript census against the Python recount, per fixture |
| `scripts/cli-checks.mjs` | the command line wiring, end to end |
| `scripts/source-scan.mjs` | the syntax tree scan of src and its self-test |
| `scripts/consistency.mjs`, `scripts/consistency-canary.mjs` | page, feeds and MCP against the snapshot, and the tampers that prove it bites |
| `scripts/mcp-transcript.mjs`, `scripts/mcp-exchanges.mjs` | drives the real MCP binary over stdio, and the exact list of exchanges the output check holds the transcript to |
| `scripts/test-report-check.mjs`, `test/test-counts.json` | the test report read again: every file ran its pinned number of tests, nothing skipped |
