# FLOP Observatory

Read-only observatory for FLOP devnet: network status, reset detection, spec drift, an event
census, and escrow states from finalized blocks. Output as a page, JSON feeds and an MCP server.

M0 runs on saved fixtures only. No network, no keys, no spend, no signatures. The first step of
live reads is one command that reads network status from FLOP devnet, read only, and nothing else
([Live network status](#live-network-status)). A second one records what the RPC answers to a
reviewed list of read calls, for building decoders ([Recordings](#recordings)). Every other command
still reads saved fixtures. The decoder turns recorded bytes into values; the upgrade watch uses one door of it, `runtimeOfBlock`,
in the live run and in the snapshot command's `--upgrade`, and nothing else does ([Decoder](#decoder)).

## Check

```sh
cd observatory
npm run check
```

One command. Each run writes `check-runs/<source-sha>/<run>/` with a pinned report, every log,
and `SHA256SUMS`:

| Step | Proves |
|---|---|
| install, typecheck, build | clean install from the lockfile and a clean compile. The typecheck step reads `tsconfig.check.json`, which sees `src` and `test` (with the types of the scripts the tests import inferred), and emits nothing; the build step reads `tsconfig.json` and emits `src` only (`test/typecheck-config.test.ts`) |
| test | unit, boundary and consistency tests. Every network and child process path is blocked at runtime (fetch, WebSocket, node:http, https, http2, net, tls, dgram, dns, child_process, worker threads, module hooks, and the lower layers: net.Server's _listen2, the dgram.Socket constructor, dgram and dns resolver objects, ChildProcess spawn, native bindings, process.dlopen, inspector), and any attempt left in the log, or any refused write, signature or spend, fails its file. One exemption: `runShell` in `test/setup.ts` lets `test/publish-shell.test.ts`, and that file only, run `bash`, in a clean environment with git limited to `file://` remotes, so the publish job's shell is run against a local bare repository; a call from any other file is recorded as a process attempt. Every attempt is also written to a journal the moment it happens, and the journal is checked once every file has ended. The checks the MCP binary makes before it serves a snapshot are one module, `src/snapshot-check.ts`, each check named; its table, `test/snapshot-check.test.ts`, gives every check a case that breaks it and nothing else, refused cases on both sides of each comparison, holds snapshots the rules allow, which must be served (a short or unknown source sha, an http status of -1, a reset read on the faucet's genesis alone, evidence at its bound, each field the command may write as none, a time with an offset, heights of 0, equal heights with a lag of 0, ...), and fails if any check has no case; its grid, `test/snapshot-check-grid.test.ts`, holds the same checks to RULES.md section 5 as `test/helpers/snapshot-spec.ts` writes it down apart from the code: every field at every place given each value of its type's pool, inside and outside the type, each object given a field more, one left out or one renamed, and the settlement agreements walked over grids of small domains, where every verdict must equal the reference's. The pools and grids are finite, so they show the checks and section 5 agree on those values, not on every value |
| test-report | the test report read again: every test file ran, each ran exactly the tests `test/test-counts.json` pins, by number and by a digest of their names in their order (so a test removed, renamed or moved shows; adding, renaming or moving one means updating its entry there), and no test was skipped, left as a todo or shut out by a `.only`, which vitest's exit code alone would not show; the test sources hold no `.fails` test and no empty `.each` or `.for` table, which a status cannot show; the same rules fail doctored copies of the report (one test skipped, one todo, one file missing, one test removed, one renamed, two that swap names). A table held in a variable and a test that returns before its assertion are still not seen |
| attempts | the journal again, after the test run has exited: no attempt left in a file's log, nothing at all after a file's final check (a blocked call fired from a timer, say), and every test file reached that check, each file counted once (a file checked in two runs is itself a problem) |
| source-scan | every src module read as a syntax tree, with escapes decoded and comments skipped: imports only from an allow-list (node:fs, node:path, node:readline, node:url, node:crypto for createHash only, yaml) or relative ones that land on a scanned .ts module in src, each by name (no default or namespace import, no default export taken by its name, no export *, no dynamic import, so src holds no module object), no import-equals, no banned name as an identifier, a property, a string key, a template key, a regular expression or any other string (transports, the global object, the Web Crypto global, eval, Function, Reflect, constructor, the APIs that define getters on a prototype or list its names, atob, Object.assign, the stack trace hook, WebAssembly, connect, listen and bind, the Web Crypto classes, module loading, signing, key and cipher APIs), no underscore name, as an identifier or a string, no reader's .input or .output, the reader itself only as `rl.on(event, arrow function)` in a statement of its own (rl a const that is not exported and holds the whole `createInterface(...)` call, the one place createInterface is named but its import), process only as version, argv, exit, stdout.write, stderr.write and `createInterface({ input: process.stdin })`, no computed key that is not a literal (src reads a data record by a run time key only through `own()`, which never reaches an inherited member or hands back a function), no RPC write method named, and nothing in src but regular .ts files. It first catches 132 known bad samples (the reference decoder or `@noble/hashes` imported into src, the reader listed, exported, kept as the value on returns, given to a listener as this or stood in for by a function of src's own, an underscore name as a string, the default export by its name, the reader's stream read back, escaped names, legacy and third party modules, a comment before the module name, string and template keys, a getter on a prototype, an import-equals, paths out of src, keys read back from a regular expression, decoded, listed or trimmed, a stream asked to connect, a dynamic import of node:crypto, a namespace or default import, export *, the Web Crypto classes, stdin read back) and passes 18 good ones, and its file list names a .mts module, a .js file and a link in a throwaway folder. The decoder's folders, `src/scale` and `src/hash`, are pure: a module there imports only from those two folders and createHash from node:crypto, names no global but the language built ins on `PURE_GLOBALS`, declares no global's name and takes no `.random`, which is proved on 24 bad samples and 4 good ones in each folder, and on 3 forms still allowed outside them; outside `src/scale`, a module may import only `scale/block.ts` from it, proved on 5 samples. Its one exemption, `src/net-root.ts` naming WebSocket and fetch as the options of `new NetTransport(...)`, is proved on 2 good and 18 bad samples in that file, and the same form fails in 7 other module names, the live command and the recorder among them |
| canary | the harness fails a throwaway test that leaves a fetch, an https request, a net connection, a child process, module hooks, a listening handle made under listen, a dgram socket made directly, a refused RPC write, a refused signature or a refused spend, and two that make their attempt from a timer after the file's final check; a clean throwaway test passes, and so does the late timer once the journal check is taken out, so that check is what catches it |
| check-canary | the check itself, cut: `scripts/check-lib.sh` (the step runner, the signal handling and finalize of `check.sh`) run on a small driver of the canary's own, never the real check. Cut by SIGTERM, SIGINT and SIGHUP during a step, the run says NOT FINISHED, exits 128 plus the signal's number, lists the step as `cut by SIG...` in `steps.tsv`, gives no digest and leaves neither the step nor its child running, within seconds; a SIGTERM between two steps, with a job of the driver's own running in a group of its own, says `finished: no (stopped after step first by SIGTERM)` and leaves that job stopped; an early exit 0 is not finished and exits 1; a finished run with no output file gives the digest `none`, one with a failing step exits 1 with `finished: yes`, and a passing one exits 0 with the digest the canary computes itself. A step that fails or is cut says why in the check's own output: right after its exit line, or its cut line, come the last 20 lines of its log, each after the prefix `  log| ` and cut at 300 characters, and a step that exits 0 prints only its exit line (case `failing-step-tail`, and the cut cases). Seventeen tampered copies of the library, at least one for each of these rules, each fail a case |
| mutants | in a copy of every file git tracks (nothing untracked), an unmutated control passes, then each injected bug (reset ignored, stale RPC, conflicts dropped, malformed escrow accepted, one event claiming two escrows, an unreadable page dropped, a partial census shown complete, an account named `__proto__` dropped from a feed, a compact read in a long form, a byte of metadata left over, a map key hashed unchecked, a block decoded with a shape file nobody reviewed, ...) makes at least one test fail. Bugs in the command line, the MCP binary and the syntax tree scan are caught by their end to end checks on a fresh build of the copy; each check in `src/snapshot-check.ts`, turned off, made weaker or made stricter one at a time, is caught by the table case that names it. A mutant that only breaks loading is never counted as caught, a replacement is written exactly as given, a copy that cannot be made is reported as setup-failed, and a run with no mutant fails. Four kills (a repeated key served by the MCP binary or trusted in the log, deep nesting unchecked, and a blank log line accepted) show the refusal names its reason: the written form and canonical form checks, and the log's other line rules, refuse those files too, and are mutated on their own |
| mutants-canary | the mutation runner classifies a real bug, an equivalent change, a syntax error, a missing test, a replacement holding `$$`, and a command line bug and no-op correctly; its copy holds exactly the tracked files of a throwaway repo; a copy it cannot make is reported as setup-failed; it still works when the temp folder is reached through a link; and a mutant file with no mutant fails the run. A run that is not a pass writes why to stderr, so to the step's log and its tail in the check's output, in at most 20 lines (`scripts/mutate-why.mjs`): the summary, both controls with a failed one's first failing test, and each mutant not killed with its outcome; a pass writes none of it, and the stdout document is the same either way |
| recount | the TypeScript census and an independent Python recount agree on every census fixture, and on scenarios made at run time for inputs git cannot hold (a page file name that is not UTF-8, a scenario whose event-pages, or whose one page file, is past the system's path limit, which both refuse as a page file problem naming it). Where both refuse, they must refuse for the same reason and name the same file (RULES.md 3.1 clause 16). A nudged total, or a changed refusal reason, is caught in every scenario, and the canary fails unless it nudged at least one count and one refusal. A page file name that holds a colon and a semicolon is compared whole, and so are two that differ only after a line break, which both sides show as %0A. Command line inputs both sides must refuse alike are compared too: request numbers that are not plain digits or are too long, an inverted range, an empty genesis, a missing folder, and flags read other than as `--name` and then its value (`--name=value`, an abbreviation, an unknown flag, a flag twice, with no value or an empty one, a stray argument, the folder flag left out); a value that starts with a dash is a value on both sides, and the same flags in another order count the same. The recount's own tests read recount.py as a syntax tree: five plain imports with no alias and no submodule, only the builtins and the attributes it uses, no match statement, no frame or code field, and no call that runs code, starts a process, opens a socket or writes |
| cli-checks | the command line passes unreadable pages to the census and escrows, refuses parts pinned to another chain and an escrow id listed twice, catches a rollback even across a snapshot with no RPC reading or after one with no head time, a restart that keeps the genesis but reports a low best height and no finalized head, and a log that runs backwards, refuses a log line that is not in canonical form, reads request numbers as plain digits and refuses a missing folder as an input problem after any request problem, writes pin.json in the feed format, reports the health rules, takes an earlier best height as a floor though that snapshot read no finalized head, says in the faucet's detail when a usable /chain reading names no genesis, refuses an escrow id that is not 0x plus 64 hex, refuses a flag a command does not read, one given twice, a value after =, a stray argument, an empty value and a --now that is no time, refuses census without its folder flag, or with no range given and none in meta.json, as a request problem, names a missing folder in one line with a line break in its name as %0A, and after a finality stall reads a fall of the best height further than the lag limit as a conflict until it is back within the limit; every command refuses a scenario whose meta.json now is missing or no time unless --now gives one; a saved reading, a meta.json, a snapshot log, a drift spec and a served snapshot that is a named pipe are refused at once, never waited on; every node it starts runs with its warnings off, so a warning Node prints for its environment cannot fail a check; the MCP binary serves a snapshot whose hash verifies and refuses one that does not, one with a key twice, one that is not valid UTF-8, one behind a byte order mark, one with an integer the parser would round, one nested 20000 levels deep, an object that hashes to itself but is no snapshot and one whose status is an empty shell, a refusal naming the checks of `src/snapshot-check.ts` the file breaks (one shape, one agreement, two at once, and the first five of fourteen with how many more), and serves what the snapshot command writes, an http status of -1 included |
| snapshot, mcp, consistency | seven real snapshots (healthy, reset, nothing read, degraded faucet, conflicting evidence, accounts named `__proto__`, `constructor` and other inherited names, and an upgrade watch read at the status's finalized head), each rendered as feeds, page, snapshot log and a real MCP stdio transcript. Every page cell is resolved in the snapshot and compared, in data-v, in its whole visible text and in its class; every td and span must carry data-k; each row's label must name its cell, and each escrow card and drift row may hold only its own cells; each table holds only its own section's cells, under that section's heading, and the drift columns come in the order every row holds its cells; nothing is hidden (no comment, only the elements and attributes the page writes, each attribute once, only its own stylesheet); no text states a value outside the compared cells (every th is read as a label or a column, the head is fixed, tags are lower case and every < opens one, the banner is one of two whole sentences, every other piece of text is the page's fixed words, aria-label only says unknown); every file is read as strict UTF-8 and every JSON file and MCP line is parsed first, so a file cut short fails at once, then read with no key twice and in its written format, the transcript included (one compact server line per exchange, the script's key order, nothing else in the file); every element's class is the renderer's (a class on a row, a table or a card fails) and the page holds exactly its paragraphs, cards and tables; every value cell carries its data-v, compared as a value; every value sits in a labeled row or a drift item row (data-row only drift.<index>), each label plain text with scope="row", and a bare code element only around an escrow id; snapshot.json must be an observatory snapshot, and an output of any shape the check cannot read ends it with a failure; each feed holds exactly its five keys and equals the snapshot; the MCP transcript is exactly the exchanges the transcript script makes, the initialize answer and the tool list are exactly the server's, each refusal has its own code and words, an escrow id the snapshot does not hold reads unverified, and each answer is exactly one text item equal to the feeds byte for byte; the folder holds exactly its ten files, the whole log's hash chain verifies and its last line is snapshot.json in canonical form; a marked cell holds no markup but a bare code element, sits in the element the renderer writes it in (a td for every value but the snapshot's hash, time and trust and the census status), and the page holds exactly the renderer's keys in its order; and last, every file equals what the code writes for the snapshot, byte for byte, MCP lines included |
| consistency-canary | clean copies pass, and 117 tampered copies (the upgrade watch's sha256 changed on the page, the upgrade watch's authorised state, a reviewed runtime shown unknown, its bytes cut on the page, its appearance flipped or a watch invented in upgrade.json and get_upgrade, its heading renamed and its table named status, an attribute named twice on a cell, two labeled rows turned into item rows, a value cut out of its row, a row turned into a bare span, two heights cut to bare cells, a label wrapped in h1 or stripped of its scope, a value wrapped in code, a blank cell that says data-v null, snapshot.json null or with escrows that are no list, status.json null, a transcript line null, snapshot.json, status.json or a transcript line cut short, snapshot.json not UTF-8, the transcript respelled with its keys reversed, CR LF line ends and blank lines, every server line respelled, a row, a table or an escrow card painted with a class, an empty banner and card added, a cell's data-v removed, initialize instructions that say spend, tool descriptions and schemas changed, an extra answer for an unseen escrow or under a tool name with a trailing space, a refusal that says signed, lines of the transcript removed or given a note, the unseen escrow answered claimed, two lines added before the log's real one, two extra files in the folder, pin.json keys reversed, a health word painted down in a nested span, two rows removed, escrow cards swapped, an upper case row, table or paragraph, bare text typed into a row or a card, words behind a lone <, a th outside every row or inside a drift item row, a banner whose later words say the opposite, a head with another charset, a feed with extra top level keys, a key said twice or a renamed schema, the same in snapshot.json, pin.json and the log line, an MCP answer with a second item, structuredContent or isError, a server line with a key twice, a signing tool listed or answered, an account named `__proto__` dropped from a feed or from snapshot.json, a reset flipped on the page or in the feed, stale flipped, a conflict dropped, a census total nudged, an empty list shown blank, a key dropped or invented, a wrong value hidden in a nested span or shown in a cell without data-k, value cells swapped between rows or escrow cards, a row label renamed, a row commented out, hidden or styled away, a section folded or rewritten by a script, a row moved to another section, headings swapped, drift columns swapped or dropped, a fabricated row of two th cells, a free paragraph, a second h1, the title, a stray code element or a changed seq stating a value, an aria-label or a class that misreads a cell, the snapshot edited after hashing, ...) each fail, the newer ones by the check they name. A run that prints no report, exits other than 0 or 1, or runs past its time limit gives no verdict and never counts as a catch, and a tamper that names no check is caught only by a failure other than the check's own crash report. Each tamper is checked twice, with and without the final byte comparison, and must fail both, so the rules alone catch it; one tamper that changes only bytes the rules do not model (a line break) passes the rules and fails the byte comparison, which shows that comparison bites |

The last line of the check prints the outputs digest, and `report.txt` records it, so a CI log
can be compared with a local run without downloading anything.

A run is a pass only when `report.txt` says `finished: yes`, the line right after
`overall_exit:`. A run stopped by SIGINT, SIGTERM or SIGHUP stops the running step's whole process
tree, lists that step in `steps.tsv` with `cut by <SIGNAL>` as its exit, and exits 128 plus the
signal's number; `report.txt` says `finished: no (stopped during step <name> by <SIGNAL>)`, or
`finished: no (stopped after step <name> by <SIGNAL>)` for a signal that lands between two steps.
On a signal every job of the script still running is stopped, each as its process group. A run
that exits before its last step for any other reason says `finished: no (the script ended before
its last step, after step <name>)` and never exits 0. Either way `outputs_digest` is `none (the run
did not finish)` and the second to last line reads `evidence: check-runs/<sha>/<run> (NOT FINISHED:
<the same words>, exit <status>)`. An `outputs/` folder with no file gives the digest `none`, never
the hash of empty input.

A step that is itself stopped by a signal, while the script is not, is a failed step in a finished
run: its exit is 128 plus the signal, the run goes on and ends with `overall_exit: 1` and
`finished: yes`. Not covered: SIGKILL cannot be handled. Then no `report.txt` is written, which is
no pass, and the running step may be left running, because each step runs in a process group of
its own.

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
  --census fixtures/census-complete --drift fixtures/drift-seeded [--upgrade fixtures/watch-authorized] \
  --out out --log out/snapshots.jsonl
node dist/mcp-bin.js out/snapshot.json    # MCP over stdio, read-only tools
```

Every flag is `--name` followed by its value as the next argument. A flag the command does not
read, one given twice, `--name=value`, an empty value (an unset shell variable gives one) and an
argument that is no flag's value are refused (for `census` as a request refusal, as
`tools/recount.py` reads its own flags). `--upgrade` names a folder whose `storage.json` holds the
two reads of the upgrade watch, each a call's answer as a tape keeps it, counted as read at the
status fixture's finalized head ([The upgrade watch](#the-upgrade-watch)). `--now` must be a time with a zone; without it a command
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
  its hash) and for the best head, `state_getRuntimeVersion` at the finalized head, and right after it
  the two reads of the upgrade watch at that same head, `state_getStorage` of `System.LastRuntimeUpgrade`
  then of `System.AuthorizedUpgrade` ([The upgrade watch](#the-upgrade-watch)). When the log
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
- Writes into the folder, which must be new or empty: the snapshot (`snapshot.json`, the feeds, `upgrade.json` among them, and
  `snapshots.jsonl`, its one new line of the log, with the `seq` and `prev_hash` that follow the
  log's last line), `tape.jsonl` (every request and its answer, in order), `run.json` (start, end,
  the revision if given, which case the log was in, how it ended) and `SHA256SUMS`.
- Prints one line in the GitHub Actions notice format with the trust, the three geneses,
  `reset_detected`, the heights, the runtime version, the runtime that executed the finalized head and
  whether an upgrade is authorised (the watch's executing state, spec name and version, and authorised
  state, each null when no watch was read), each service's health, the snapshot's `seq`
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

### The upgrade watch

At the finalized head F the live run reads two storage values, right after `state_getRuntimeVersion(F)`
and only when it reads that, through the same guard and transport (`state_getStorage` was already on
the guard's list, which does not change). `src/upgrade-watch.ts` turns them into the snapshot's part
`upgrade` (RULES.md 7.2):

- `executing`: which runtime executed F, from `System.LastRuntimeUpgrade` read by the decoder's door
  `runtimeOfBlock`. `reviewed` when a `REVIEWED` line names it, `not reviewed` when the record is
  whole but no line names it (the name and version it states are given), `absent` when the node held
  no value, `unknown` when the call failed, the answer was no storage answer, or the bytes are no
  record.
- `authorized`: whether `System.AuthorizedUpgrade` held a value at F: `present`, `absent` or
  `unknown`. A present authorisation always carries `length` in bytes and `sha256` of the raw bytes,
  lower case hex; `bytes` is the hex as answered only when `length` is at most 256, and above that
  null, with a fixed detail. Nothing of it is decoded.
- `compared_with`, `executing_changed`, `authorization_appeared`: against the latest earlier watch in
  the log on the same RPC genesis at a lower block. An authorisation appeared when it is present now
  and was absent there, or is present with another length or another sha256; the hex is never
  compared. `at` is the status's finalized head, its hash and its height.

A failed or malformed read is `unknown`, never `absent`, and no answer's text is echoed. The watch
adds no conflict, never touches `reset_detected` and never changes an exit code; the spec floor and
`runtime_version` stay where they are. The part has its own feed, `upgrade.json`, a page section,
Runtime upgrade, and an MCP tool, `get_upgrade`. A snapshot with the part is `snapshot@1`; the lines
already in the log stay `snapshot@0`, keep their hashes and still read, and an `@0` line after `@1`
lines is read as a line with no watch, never refused.

What it can see: the live run is at 7 and 37 past each hour, twice an hour. The authorisation of
Nov 12 was pending for 50 seconds before the upgrade landed (`research/2026-11-12-runtime-upgrade`),
so the watch will mostly show a landed change, a new runtime against the one before it, and shows an
authorisation only when a run falls inside its window. A more frequent read is a separate decision.

The real tapes in `fixtures/published-*` were recorded before runs made these reads: a test answers
them, synthetic, from the table in `test/helpers/tapes.ts`, which says why for each. The synthetic
tapes that read a runtime version hold both reads, and their `meta.json` names where each answer
comes from. `fixtures/upgrade-*` show each case: before the authorisation, the authorising block, the
first block of the new runtime (each on a log of the ones before it), a runtime no line names, both
reads failed, and answers that are no storage answer. `mutants/upgrade.json` holds the bugs they must
catch.

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
  like code, and it is the list to be recorded next.
- The list it holds now is the fourth: the lab's session rerun at spec 1014020
  (`research/2026-11-12-session-rerun-1014020`), 23 transactions in blocks 3552721 to 3553566, 48
  calls. It asks the finalized head and the genesis hash, then for each step, in the order of the
  rerun's `steps.json`, the hash at the height its `results.json` gives and one
  `state_queryStorageAt` at that hash. Each of those 23 batches asks `System.Events` and
  `System.LastRuntimeUpgrade` first, so every block names the runtime that executed it, then the
  stored values the step's `reads_after` names in `steps.json`, in one fixed order:
  `FlopSessionKeys` `Sessions(owner, device)` (active, spent, epoch_spent), `SessionNonces(owner,
  device)`, `CircuitBreakers(device)`, `ComputeChannel` `FailedAcks(named account)`,
  `FlopSessionKeys` `DelegateSessions(device)`. The device is dev1 for the steps of session A and
  dev2 for those of session B. 26 reads in all, 72 keys. By method: chain_getFinalizedHead 1,
  chain_getBlockHash 24, state_queryStorageAt 23.
- Why `state_queryStorageAt`: it is the first list to ask it. Asked one key a call, the events and
  the runtime record of 23 blocks are 46 calls and the 26 reads 26 more, over the 64 call bound
  (`MAX_CALLS`). One `state_queryStorageAt` asks all keys of one block in one call and is answered as
  one set for that block, a key that holds nothing listed with null. The guard already allowed it;
  nothing in src changed. How such an answer is read (exactly one set, the block asked, every key
  asked once and nothing else, or the read is refused) is `test/helpers/batch-answer.ts`.
- Its recording is `fixtures/recording-20261112132634-0a472f1b49f7b661`, 48 of 48 answered, which
  keeps that list and its inputs byte for byte. `test/rerun-recording.test.ts` holds it to the
  rerun's `results.json`: every hash by height, the genesis, the sha256 of every `System.Events`
  value against the one the lead computed at run time, and every block's `LastRuntimeUpgrade`
  naming spec 1014020 through `runtimeOfBlock`. `scripts/fill-rerun-results.mjs --out <file>`
  fills `results.json` from it through `src/scale/block.ts` (`test/helpers/rerun-fill.ts`), and
  `test/rerun-results.test.ts` holds the committed file to that fill byte for byte and pins the
  verdict of the rerun's `check.mjs`: 22 steps pass, A10 is incomplete for its one read of
  `FlopSessionKeys.DelegateSessions`, an entry the reviewed shape does not state, whose bytes
  `results.json` keeps apart in `reads_not_decoded`.
- Which read covers which claim of the rerun's `plan.md`: every claim that rests on a stored value
  has the read of the step it names. probe:23 the session record and nonce at A3 (`steps.json` names no breaker read there, so the breaker part rests on the breaker read at A6 and A8); probe:28 the
  session record and `DelegateSessions` at A10; escrow:19 and escrow:28 the session record at A6;
  escrow:22 and escrow:31 the session record at A9; escrow:35 the session record and nonce at A5 and
  those and the breaker at A8; escrow:46 `FailedAcks` at A9; escrow:99 the breaker at A8; deny:41 the nonce at B9
  and B10. The reads at A2, A4, A7, B1 and B11 hold the fields `check.mjs` judges there. Every other
  claim rests on the events of its step's extrinsic, which every batch reads: the outcomes and
  errors, what moved and who paid the fee, `SessionCallExecuted`'s running totals (escrow:94), the
  ack deadline (escrow:96) and the acceptance of a `force_open` naming a non miner (escrow:44).
- Nothing in it is typed by hand: `test/helpers/requests/list-4.ts`, its plan, derives it from
  `recordings/requests-inputs.json`, where each account, height and block hash names the file and
  field it was taken from (the rerun's `results.json`, and the deny list test's record for the
  named account), and from the 1014020 metadata, found on the third recording's tape by the sha256
  its `REVIEWED` line gives. `test/rerun-requests.test.ts` holds the file to that plan byte for byte,
  reads its design a second way from `steps.json` and `results.json`, builds every key again with
  the reference decoder, and holds every input to the record it names.
  `node scripts/write-requests.mjs --out recordings/requests.json` writes the file through that same
  plan, and the check runs it and compares the bytes. A storage value a node does not hold is
  answered as null, and that is an answer too.
- Which list is where: `recordings/requests.json` and `recordings/requests-inputs.json` are the
  current list. When a list is replaced, its request list and its inputs are already frozen in its
  recording's fixture folder. Each list has one plan module in `test/helpers/requests/`
  (`list-2.ts`, `list-3.ts`, `list-4.ts`) over one core (`core.ts`) that knows no list, and
  `test/helpers/requests-list.ts` names the current one. The first list was not derived (it
  predates this) and stays as its fixture keeps it.
- The third list read FLOP devnet's runtime upgrade from spec 1014014 to spec 1014020
  (`research/2026-11-12-runtime-upgrade`), the lab's own storage records on both sides of it, and
  the blocks of the deny list test (`research/2026-11-11-session-deny-list`), 63 calls. Part A
  asked the finalized head and the genesis hash, then for the four blocks around the upgrade
  (3528527, the last before it; 3528528, which carries it; 3528529, the first the new runtime
  executed; 3530299, a later finalized block of the new runtime) each hash by height, the runtime
  version at each, the metadata at 3528527 and at 3528528, and `System.LastRuntimeUpgrade` and
  `System.Events` at each. Part B read our own records at 3528527 and again at 3530299 with the same
  key. Part C read, at the blocks of steps 2, 3, 10, 11 and 12 of the deny list test, each hash by
  height, `System.LastRuntimeUpgrade` and `System.Events`, then the session of D3 at the create and
  revoke blocks and its nonce and breaker at the step that succeeded. A block is in the encoding of
  the runtime that executed it, which is what `System.LastRuntimeUpgrade` at the block names;
  `state_getRuntimeVersion` and `state_getMetadata` at a block describe the runtime of the next
  block, so at 3528528 they already answered for the new one. Its recording is
  `fixtures/recording-20261112080132-05842a6db1e9c890`, which keeps that list and the inputs it was
  derived from byte for byte. `test/helpers/requests/list-3.ts` is its plan, and
  `test/upgrade-requests.test.ts` holds the frozen list to it byte for byte.
- The second list read the storage the lab's two devnet session tests left behind
  (`research/2026-11-11-session-probe` and `research/2026-11-11-session-escrow`), 56 calls: the
  finalized head and the genesis hash, then for each of twelve blocks (ten of those tests, and two
  for one gateway channel to compare with ours) its hash by height, `System.LastRuntimeUpgrade` at
  the hash the test record gives, and the reads named there: `FlopSessionKeys` `Sessions`,
  `SessionNonces` and `CircuitBreakers`, `ComputeChannel` `Channels`, and `System.Events` where a
  call was sent, then the runtime version and the metadata at block 3498313, the last block of the
  second test. Its recording is `fixtures/recording-20261112004113-0b2b505d2d4b703b`, which keeps
  that list (`requests.json`) and the inputs it was derived from (`requests-inputs.json`) byte for
  byte. `test/helpers/requests/list-2.ts` is its plan, and `test/storage-requests.test.ts` holds the
  frozen list to it byte for byte, with every key built again and every input held to its record.
- The first list asked the finalized head and the genesis hash, then for each of twelve blocks
  with compute channel events its hash by height, its header, `System.Events` and
  `System.LastRuntimeUpgrade` at its hash, then the runtime version and the metadata at the last.
  Its recording's fixture keeps it, byte for byte, as
  `fixtures/recording-20261111160917-3c228907aa129a01/requests.json`, and the tests that read that
  recording read that copy.
- A list that is not in that form, or that holds a method the read only guard refuses, is refused
  before anything is sent: nothing is read from the network, and the run says why.
- Each call is made once, in order, one at a time, on one socket, through the same transport and
  guard as the live run (`src/net-root.ts`, `src/net.ts`), and recorded on a tape by the same code. The next call is
  asked only once the one before has its answer, which `test/record-run.test.ts` holds with a fake
  transport that counts the calls in flight: four `state_getMetadata` calls sent at once over one
  socket failed with a socket error where one at a time answered. A call that
  failed on the way (an RPC error, the 15 s limit, an answer over its limit, a socket that failed)
  is recorded as its error, and the run goes on.
- Each answer has the 1 MiB limit, but `state_getMetadata`'s, which has 8 MiB (about 964 KB as hex
  for spec 1014014 and 974 KB for spec 1014020). The live run states no larger limit, so its limit is unchanged.
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

`.github/workflows/observatory-record.yml` runs it by hand, and on a push to any branch that changes
the request list, the workflow or any src module the command is built from, and uploads the folder
as an artifact. The record job reads the repository and nothing else, uses no secrets and no cache,
and checks out without credentials. On main, when the record job exited 0, its publish job puts
the recording on the branch `observatory-data` under `recordings/<id>/`, where `<id>` is the UTC
time the run started as 14 digits, a dash and the first 16 hex of the request list's sha256, built
by the shell from validated values only. A recording is immutable: when that folder is already
there, the job changes nothing and says so. It writes nothing outside it, and the live publish job
writes nothing inside `recordings/`. On any other branch the run is a smoke run and publishes
nothing.

So a push to `main` that changes `recordings/requests.json`, or a source file listed in the push
paths of `.github/workflows/observatory-record.yml` (`src/types.ts` among them), starts a new
public recording. A push to `main` that changes a file listed in the push paths of
`.github/workflows/observatory-live.yml` publishes a reading. Read both lists before you change a
file under `src`. A recording is copied into `fixtures/` by hand, with its provenance and the request list
it was made from, when a decoder needs it.

Offline, `npm test` covers the request list's form, each list against what it was made from, the
run over a fake socket that answers each call
(answers, RPC errors, a time limit, answers over and under their limits, a socket refused), the
reader on doctored copies, the workflow read as data, and both publish jobs' shells run with bash
against a local bare repository, on one branch.

## Decoder

`src/scale/` and `src/hash/` turn the bytes of a recording into values: the runtime metadata, any
value by its type, storage keys, the events of a block, and the value of a storage entry at a
block. One door is used: the upgrade watch reads `System.LastRuntimeUpgrade` through `runtimeOfBlock`, in
the live run and in the snapshot command's `--upgrade` ([The upgrade watch](#the-upgrade-watch));
nothing else of the decoder reaches an output. They parse bytes that came from the network, so every input is treated as hostile. They
are pure: no file, network, clock or random access, which the source scan holds them to.

| Module | What |
|---|---|
| `src/scale/reader.ts` | SCALE bytes with a position: compact integers in their shortest form only, fixed width integers to 256 bits, bools, strict UTF-8, and lengths that must fit in the bytes left. Every refusal is a `ScaleError` |
| `src/hash/xxhash64.ts`, `src/hash/blake2b.ts` | xxHash64 and BLAKE2b, written from their specifications, with no dependency |
| `src/scale/metadata.ts` | a strict parser of metadata version 14, read whole to its last byte; any other version is refused |
| `src/scale/decode.ts` | any type of a parsed metadata into a JSON safe value: integers past u32 as decimal strings, bytes as hex, variants as `{ variant, fields }` |
| `src/scale/storage-key.ts` | a storage key from a pallet, an entry and its map keys, with the hashers the metadata states |
| `src/scale/events.ts` | System.Events by the type the metadata gives it: each event with its pallet name and index, its name and variant index, its fields and its phase |
| `src/scale/shape.ts`, `shapes/` | the shape pin: the reviewed shapes, the shape with its table of types, and the one function that refuses any other |
| `src/scale/block.ts` | the one way real chain data is decoded, only once the block's shape is pinned: which reviewed runtime reads a block (`runtimeOfBlock`), a block's events (`decodeBlockEvents`), and the value of a storage entry the shape states (`decodeStorageValue`) |

What this package exports to another package (`package.json` `exports`, held by
`test/package-exports.test.ts`): exactly two entries. `flop-observatory/scale/block` is the door,
`src/scale/block.ts` as built to `dist/scale/` with its declarations (`tsconfig.json` emits them).
`flop-observatory/shapes/*.json` are the reviewed shape files. Nothing else of the package can be
imported by name. imd-flop reaches the decoder this way (`file:../observatory`, its
`src/chain-read/door.ts`), so the observatory is built before imd-flop wherever imd-flop is built
or tested.

What a decoded value proves: nothing about the chain on its own. A recording is what one RPC
endpoint answered (RULES.md section 8), and a decoded value is that answer read. It is evidence,
not proof. A value does not say its own type either: a reader goes by the type's kind in the
metadata, never by the form of the value.

The shape pin. `REVIEWED` in `src/scale/shape.ts` lists each reviewed shape: a spec name and
version, the sha256 and length of the metadata bytes at that spec, and the sha256 of the shape
file. The first is `tzkv-runtime` 1014014, metadata `f4fd2add...3444` of 482132 bytes, and
`shapes/tzkv-runtime-1014014.json` (sha256 `679f98aa...60e7`, `decoder-shape@2`). A reviewer read
the shape file and the metadata it came from, and a test derives the file a second way, from the
reference decoder's own parse. The shape file is derived from that metadata: the spec, the
ComputeChannel pallet index, its 60 events with each field's name and type, the Channels entry, the
fields and states of a channel, the System.Events and System.LastRuntimeUpgrade entries, the
FlopSessionKeys pallet index (94) and its Sessions, SessionNonces and CircuitBreakers entries, the
System.Version type, and a table of the 469 types reachable from those, each with its kind, path
and what the kind holds. Each entry is stated with its modifier, hashers, key type, value type and
the default bytes the metadata gives it, and each of the three pallets with the storage prefix
every key of it starts from, so a changed prefix changes the file. `STATED_ENTRIES` lists those six
entries. `pinShape` refuses, and says why, when the spec is not reviewed, the
metadata bytes or the shape file are not the reviewed ones, the shape derived again differs from
the file, or the block's LastRuntimeUpgrade names another spec. It reads each part of its input
once and copies the bytes, so what is hashed is what is parsed. The first recording pins and
decodes exactly as it did under `decoder-shape@1`. The shape file's own sha256 is what
holds the deriving code to the review: a changed `deriveShape` with a file written again from it
passes every other check. A new runtime spec is decoded only after its shape file and its line are
added to `REVIEWED`. Outside `src/scale/`, only `block.ts` may be imported from it.

Two reviewed runtimes. The second line of `REVIEWED` is `tzkv-runtime` 1014020, metadata
`91294eb6...8238` of 487100 bytes, and `shapes/tzkv-runtime-1014020.json` (sha256 `650b3491...dc81`,
469 types), derived by the same `deriveShape` from the metadata the third recording holds at block
3528528 and a second way from the reference's parse (`test/upgrade-shape.test.ts`). What differs
from 1014014 is `shapes/diff-tzkv-runtime-1014014-1014020.txt`, written by `scripts/shape-diff.mjs`,
which compares types by structure and never by id: ComputeChannel adds the events
CapacityReservationRateSet and CapacityReservationDropped, Aleph adds CommitteeSeedFallback to the
outer event enum, and FlopSessionKeys has no difference. Every stated entry's prefix, hashers, key,
modifier and default bytes are unchanged, and so is the value type of every stated entry but
System.Events, whose value is the outer event enum, which gained those three event variants. The
diff's first line names both specs; it refuses, in one line on stderr and with exit code 2, a file
that cannot be read, is not JSON, is not `decoder-shape@2`, or lacks or adds a part it reads. Exit
code 0 means it compared, a difference found or not: a test holds the committed diff to a fresh run,
and that test is the check.

No caller can change what was reviewed. `REVIEWED` and each line, `STATED_ENTRIES` and each pair,
`PRIMITIVES` and `HASHERS` are frozen when their module loads, and `pinShape`, `decodeBlockEvents`,
`decodeStorageValue` and `runtimeOfBlock` each answer a fresh copy of the line
(`reviewedCopy`), so a write to an answer changes nothing a later call pins
(`test/reviewed-frozen.test.ts`).

Which runtime reads a block. A block is in the encoding of the runtime that executed it, and
`System.LastRuntimeUpgrade` at the block names that runtime. `runtimeOfBlock` in
`src/scale/block.ts` reads those bytes and nothing else, whole (a Compact<u32> spec version then a
string spec name, as each reviewed shape states the record), and answers a copy of the `REVIEWED`
line of that spec, or a refusal, which carries what the record names (`named`: the spec name and
version when the bytes are a whole record no line names, null when they are no record), a fresh
object each call. The caller then takes that line's metadata by its sha256 and its
shape file, and the pin checks all of it again. Never the version or the metadata read at the
block itself: those answer for the next block, so at a block that carries an upgrade they name the
new runtime though the old one executed it. On the third recording
(`fixtures/recording-20261112080132-05842a6db1e9c890`) block 3528528 decodes under 1014014 with the
metadata recorded at its parent, to its 64 events, and 3528529 and 3530299 under 1014020, event by
event as the reference reads them (`test/upgrade-decode.test.ts`).

Storage values. `decodeStorageValue` in `src/scale/block.ts` takes the pin input, the pallet and
entry names, the SCALE bytes of each key part, the storage key that was asked (as the tape holds
it) and the answer: bytes, or null when the node held no value. It reads its input in this order,
each field once and only when its step comes: the pallet and the entry, strings of at most 256
characters, and an entry the reviewed shape does not state is refused before any other field is
read; then the pin input, and a block that does not pin is refused with the pin's reason; then the
key parts, read by index once the list holds exactly as many as the entry takes; then the key
asked, refused when its length is not the length of the key `src/scale/storage-key.ts` builds from
that entry and those parts (never turned into text) or when a byte differs, so a value is never
read under another entry or account, and no refusal prints it; then the answer, refused when it is
not null and not one whole value of the entry's type, a byte after it included, or undefined. The
three doors (`decodeStorageValue`, `decodeBlockEvents`, `pinShape`) trust no object they are
handed: an input that is not an object is a refusal; anything thrown while a field is read (a
getter, a Proxy trap) is a refusal with a fixed text, never the foreign error's message; bytes are
taken only from a real Uint8Array, measured from its own slots before anything is copied and
copied once by the typed array's own set, never through an iterator, its constructor or its
species, so a Proxy over one is refused; and a byte array past 16 MiB, a spec name past 256 characters or a shape
file past 16 MiB of text is refused. Absent is an answer, never an error and never a zero the
chain did not send: a null answer for an Optional entry is the value null, and for a Default entry
the default bytes the metadata states for it, decoded; either way `stored` is false. Any answer with
bytes is `stored` true, even bytes equal to the default, so a caller can always tell a stored value
from a default. Numbers and accounts come in the decoder's forms: every integer past u32 a decimal
string, an account 0x and 32 bytes of hex.

Bounds on hostile input, the metadata included. Every exported function of `src/scale/` ends in a
value or a `ScaleError` (the three doors in a value that may be a refusal), for the inputs its
types allow, and the three doors for any input at all. Metadata or a value of more than 16 MiB is refused unread. A count is
refused when it claims more than the bytes left, before anything is read or built for it, so
nothing is sized from an untrusted length. A type nests at most 32 levels (`MAX_DEPTH`). One decode
takes at most `1024 + 8 * bytes` steps (`valueBudget`), one step for each type it visits, and a
step that succeeds builds no text. One `deriveShape` takes at most 1,000,000 steps and 4,000,000
characters of names, each name built once, at most 2048 characters and 16 levels deep; the reviewed
shape takes 9,733 steps. RULES.md section 9 states each bound. The fuzz tests in
`test/scale-fuzz.test.ts` count the steps of every decode against its bound.

The reference. `@polkadot-api/substrate-bindings` and `@polkadot-api/metadata-builders` are pinned
dev dependencies for tests only, and so is `@noble/hashes`. `test/reference.test.ts` parses the
recorded metadata with both decoders and compares the two whole, and decodes every recorded value
with both and compares them in one plain form. `test/review-decoder.test.ts`, the review of round
18, compares them on seeded values of every type. The source scan refuses any src module that
imports them.

Offline, `npm test` covers: the reader, the hashes against published values, `@noble/hashes` and
the reference, the metadata parser on every kind and every refusal, the decoder's forms and limits,
the three storage keys read by hand, all twelve recorded blocks of events with the numbers read by
hand at block 3479299, the shape pin and its refusals, the type closure, the reference, hostile
bytes, and the review's defects, gaps and held attacks. On the third recording,
`test/upgrade-storage.test.ts` decodes our twelve records at 3528527 and at 3530299 under each
block's own runtime (the same bytes and values both sides, each the reference's), and the deny list
test's reads at 1014014 held to its results file. On the second recording
(`fixtures/recording-20261112004113-0b2b505d2d4b703b`), `test/storage-values.test.ts` decodes all 28
storage reads through `decodeStorageValue` (22 of the session, nonce, breaker and channel entries,
6 of System.Events) and holds each of the 22 to what the lab's two devnet session tests recorded in
`research/*/results.json`. Every field of every one of the 21 stored entry values has a source,
named in `FIELDS` there: 99 fields a results file gives (the session's terms in the steps' own
words, spent and epoch_spent after each step, expires_at, allowed_pallets, active after the revoke,
the nonce, the breaker after steps 4, 6 and 7, our channel after force_open, its state after
expire_force_open), 2 the first recording's ToplocEvidenceSubmitted event gives (the gateway's
miner), and 72 marked READ, held to the reference decoder's decode of the same bytes; each whole
value is compared with the reference too, and the bytes decoded with the fixture tape's own text.
The six System.Events reads are held to the test records: four to the sha256 the escrow file gives
of the value, and all six to their step's outcome event at its extrinsic index, success or the
module error the file names. An assert that rests on a chain rule and not on a results file is
marked RULE there (a refused call leaves the record as it was, compared block with block). Every
prefix of every stored value is refused, and every bit flip of each value of at most 512 bytes, and
of each larger one the bit at its byte index mod 8 in every byte, ends in a value or a `ScaleError`
within its budget.

## Published readings

On main, the publish job in `.github/workflows/observatory-live.yml` puts each live reading on the
branch `observatory-data` of this repository, and the publish job in
`.github/workflows/observatory-record.yml` puts each recording there. It holds block heights,
hashes, service health and what the RPC answered to read calls. It holds no key and nothing
personal. Every commit on it is made by one of those two jobs, and each leaves the other's paths
alone.

| Path on `observatory-data` | What |
|---|---|
| `latest/` | the output folder of the newest published run: `snapshot.json`, `status.json`, `escrows.json`, `census.json`, `drift.json`, `upgrade.json`, `snapshots.jsonl`, `tape.jsonl`, `run.json` and `SHA256SUMS`. Each run replaces it whole |
| `log/<UTC date>.jsonl` | one snapshot per line, one line for each reading published that day, as the run's `snapshots.jsonl` holds it. Read in name order, the day files are one hash chained log: each line names the hash of the line before it. The readings published before runs kept memory are each `seq` 0 with no `prev_hash`, at the start of the log |
| `README.md` | what the branch is, written when it is missing |
| `recordings/<id>/` | one recording each: `tape.jsonl`, `run.json` and `SHA256SUMS`, written once by the record workflow's publish job and never changed ([Recordings](#recordings)) |

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

1. the files are not exactly the ten above (a `latest/` written before the upgrade watch, nine files
   and no `upgrade.json`, is refused until the next run replaces it),
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
| `src/upgrade-watch.ts` | the two reads at the finalized head turned into the upgrade watch, and its comparison with the one before |
| `src/live-run.ts`, `src/live-bin.ts` | one live run and its files, and the command |
| `src/net-root.ts` | the one module that names the real socket class and HTTP call: the live command and the recorder take their transport from it |
| `src/sums.ts` | the one form of `SHA256SUMS`, and the check of a folder against it, for the runs that write it and the readers that check it |
| `src/run-command.ts` | what the live run and the recorder share: exit codes, flags, `SHA256SUMS` over the folder, how the command ends |
| `src/requests.ts`, `recordings/requests.json` | the request list's form, and the list to be recorded next |
| `recordings/requests-inputs.json`, `test/helpers/requests/` | the inputs of the current list, each with the file and field it comes from; the core that turns a plan into calls (`core.ts`), and one plan module per list (`list-2.ts`, `list-3.ts`, `list-4.ts`) |
| `scripts/fill-rerun-results.mjs`, `test/helpers/rerun-fill.ts`, `test/helpers/batch-answer.ts` | the fill of the session rerun's `results.json` from the fourth recording (`--out <file>`), through `src/scale/block.ts` and the reader of a batch answer, which refuses and never guesses |
| `scripts/write-requests.mjs`, `scripts/ts-resolve.mjs`, `test/helpers/requests-list.ts` | the writer of `recordings/requests.json` (`--out <file>`), through the current list's plan, the same the tests use, run under Node's own type stripping with a hook that resolves a relative .js import from a .ts module to the .ts file |
| `src/record-run.ts`, `src/record-bin.ts` | one record run and its files, and the command |
| `src/recording.ts` | the reader contract for a recording |
| `src/scale/`, `src/hash/` | the decoder, pure: reader, hashes, metadata, decode by type, storage keys, events, the shape pin and the one entry point for a block's events ([Decoder](#decoder)) |
| `shapes/` | the reviewed shape files, one for each runtime spec the decoder may read, and the diff of each against the one before |
| `scripts/shape-diff.mjs` | what differs between two shape files for what they state, types compared by structure |
| `src/published.ts` | the reader contract for `latest/` on the branch `observatory-data` |
| `src/snapshot.ts`, `src/cli.ts` | one pass and the command line |
| `src/snapshot-check.ts`, `src/mcp-bin.ts` | every check a snapshot must pass before the MCP binary serves it, each by name, and the binary that reads, checks and serves it |
| `src/own.ts` | the one way src reads a data record by a key only known at run time |
| `src/files.ts` | the one way src reads a file it is handed: a regular file only, opened without waiting, so a named pipe is refused instead of blocking |
| `tools/recount.py` | independent census recount, written from RULES.md alone |
| `fixtures/` | saved scenarios; `meta.json` says which values are real and which are made up; `live-*` and `memory-*` are synthetic tapes; `published-*` are real readings from the data branch, with their provenance; `recording-*` are real recordings, byte for byte, each with the request list it was made from (and, from the second on, its inputs): the first of compute channel events, the second of the storage the lab's two devnet session tests left behind, the third of the runtime upgrade to spec 1014020 |
| `mutants/` | the injected bugs and the tests that must catch them |
| `REVIEW-LOG.md` | what each outside review and independent rerun found, and the fix and proof for each, newest first |
| `test/setup.ts` | the runtime block on every network and process path, its one exemption (`runShell`, for `test/publish-shell.test.ts` only, which runs both publish jobs' shells), the leftover attempt check, and the attempts journal |
| `test/global-setup.ts`, `scripts/attempts-check.mjs` | the journal check once every test file has ended, and again after the run |
| `scripts/tracked.mjs` | the copy of exactly the tracked files that the mutation runner and the canary work in |
| `scripts/check.sh` | the check |
| `scripts/mutate.mjs`, `scripts/mutate-why.mjs`, `scripts/mutate-canary.mjs` | the mutation runner, the lines it writes to stderr when its result is not a pass, and its self-test |
| `test/helpers/interleaved-fastest.ts` | the timing ratio of the wall clock tests: the fastest of 15 interleaved samples of each case, never decided early, its clock an argument (`test/interleaved-fastest.test.ts`) |
| `tsconfig.json`, `tsconfig.check.json` | the build (`src` only, with declarations) and the typecheck (`src` and `test`) |
| `package.json` `exports`, `test/package-exports.test.ts` | what another package may import: the door `scale/block` and the shape files, nothing else ([Decoder](#decoder)) |
| `scripts/canary.mjs` | the harness canary |
| `scripts/check-lib.sh`, `scripts/check-canary.mjs` | the step runner, signal handling and finalize of the check, and the canary that cuts it on a driver of its own |
| `scripts/compare-recount.mjs` | TypeScript census against the Python recount, per fixture |
| `scripts/cli-checks.mjs` | the command line wiring, end to end |
| `scripts/source-scan.mjs` | the syntax tree scan of src and its self-test |
| `scripts/consistency.mjs`, `scripts/consistency-canary.mjs` | page, feeds and MCP against the snapshot, and the tampers that prove it bites |
| `scripts/mcp-transcript.mjs`, `scripts/mcp-exchanges.mjs` | drives the real MCP binary over stdio, and the exact list of exchanges the output check holds the transcript to |
| `scripts/test-report-check.mjs`, `test/test-counts.json` | the test report read again: every file ran its pinned number of tests, nothing skipped |
