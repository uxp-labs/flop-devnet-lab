# FLOP Observatory

Read-only observatory for FLOP devnet: network status, reset detection, spec drift, an event
census, and escrow states from finalized blocks. Output as a page, JSON feeds and an MCP server.

M0 runs on saved fixtures only. No network, no keys, no spend, no signatures. Live reads (M1)
wait for ultrapara's approval.

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
| test | unit, boundary and consistency tests. Every network and child process path is blocked at runtime (fetch, WebSocket, node:http, https, http2, net, tls, dgram, dns, child_process, worker threads, module hooks, and the lower layers: net.Server's _listen2, the dgram.Socket constructor, dgram and dns resolver objects, ChildProcess spawn, native bindings, process.dlopen, inspector), and any attempt left in the log, or any refused write, signature or spend, fails its file. Every attempt is also written to a journal the moment it happens, and the journal is checked once every file has ended. The checks the MCP binary makes before it serves a snapshot are one module, `src/snapshot-check.ts`, each check named; its table, `test/snapshot-check.test.ts`, gives every check a case that breaks it and nothing else, refused cases on both sides of each comparison, holds snapshots the rules allow, which must be served (a short or unknown source sha, an http status of -1, a reset read on the faucet's genesis alone, evidence at its bound, each field the command may write as none, a time with an offset, heights of 0, equal heights with a lag of 0, ...), and fails if any check has no case; its grid, `test/snapshot-check-grid.test.ts`, holds the same checks to RULES.md section 5 as `test/helpers/snapshot-spec.ts` writes it down apart from the code: every field at every place given each value of its type's pool, inside and outside the type, each object given a field more, one left out or one renamed, and the settlement agreements walked over grids of small domains, where every verdict must equal the reference's. The pools and grids are finite, so they show the checks and section 5 agree on those values, not on every value |
| test-report | the test report read again: every test file ran, each ran exactly the tests `test/test-counts.json` pins, by number and by a digest of their names in their order (so a test removed, renamed or moved shows; adding, renaming or moving one means updating its entry there), and no test was skipped, left as a todo or shut out by a `.only`, which vitest's exit code alone would not show; the test sources hold no `.fails` test and no empty `.each` or `.for` table, which a status cannot show; the same rules fail doctored copies of the report (one test skipped, one todo, one file missing, one test removed, one renamed, two that swap names). A table held in a variable and a test that returns before its assertion are still not seen |
| attempts | the journal again, after the test run has exited: no attempt left in a file's log, nothing at all after a file's final check (a blocked call fired from a timer, say), and every test file reached that check, each file counted once (a file checked in two runs is itself a problem) |
| source-scan | every src module read as a syntax tree, with escapes decoded and comments skipped: imports only from an allow-list (node:fs, node:path, node:readline, node:url, node:crypto for createHash only, yaml) or relative ones that land on a scanned .ts module in src, each by name (no default or namespace import, no default export taken by its name, no export *, no dynamic import, so src holds no module object), no import-equals, no banned name as an identifier, a property, a string key, a template key, a regular expression or any other string (transports, the global object, the Web Crypto global, eval, Function, Reflect, constructor, the APIs that define getters on a prototype or list its names, atob, Object.assign, the stack trace hook, WebAssembly, connect, listen and bind, the Web Crypto classes, module loading, signing, key and cipher APIs), no underscore name, as an identifier or a string, no reader's .input or .output, the reader itself only as `rl.on(event, arrow function)` in a statement of its own (rl a const that is not exported and holds the whole `createInterface(...)` call, the one place createInterface is named but its import), process only as version, argv, exit, stdout.write, stderr.write and `createInterface({ input: process.stdin })`, no computed key that is not a literal (src reads a data record by a run time key only through `own()`, which never reaches an inherited member or hands back a function), no RPC write method named, and nothing in src but regular .ts files. It first catches 129 known bad samples (the reader listed, exported, kept as the value on returns, given to a listener as this or stood in for by a function of src's own, an underscore name as a string, the default export by its name, the reader's stream read back, escaped names, legacy and third party modules, a comment before the module name, string and template keys, a getter on a prototype, an import-equals, paths out of src, keys read back from a regular expression, decoded, listed or trimmed, a stream asked to connect, a dynamic import of node:crypto, a namespace or default import, export *, the Web Crypto classes, stdin read back) and passes 18 good ones, and its file list names a .mts module, a .js file and a link in a throwaway folder. Its one exemption, `src/live-bin.ts` naming WebSocket and fetch as the options of `new NetTransport(...)`, is proved on 2 good and 18 bad samples in that file, and the same form fails in 5 other module names |
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
| `src/store.ts`, `src/feed.ts`, `src/page.ts`, `src/mcp.ts` | snapshot log, feeds, page, MCP |
| `src/guard.ts` | the read-only guard every transport must pass through |
| `src/snapshot.ts`, `src/cli.ts` | one pass and the command line |
| `src/snapshot-check.ts`, `src/mcp-bin.ts` | every check a snapshot must pass before the MCP binary serves it, each by name, and the binary that reads, checks and serves it |
| `src/own.ts` | the one way src reads a data record by a key only known at run time |
| `src/files.ts` | the one way src reads a file it is handed: a regular file only, opened without waiting, so a named pipe is refused instead of blocking |
| `tools/recount.py` | independent census recount, written from RULES.md alone |
| `fixtures/` | saved scenarios; `meta.json` says which values are real and which are made up |
| `mutants/` | the injected bugs and the tests that must catch them |
| `REVIEW-LOG.md` | what each outside review and independent rerun found, and the fix and proof for each, newest first |
| `test/setup.ts` | the runtime block on every network and process path, the leftover attempt check, and the attempts journal |
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
