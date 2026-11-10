# Review log

What each outside review and independent rerun of FLOP Observatory M0 found, and the fix and proof for each, newest first. Rounds 1 to 10 were first written in the PR #5 description and are kept here word for word, so the log travels with the code it describes: a reviewer reads the rounds at the commit under review. RULES.md holds the rules themselves; where a round and RULES.md differ, RULES.md is binding.

## Round 15: the tenth independent rerun, of cf7d9b8, and the fix for each

A fresh agent reran cf7d9b8 from a fresh clone. 33 steps exit 0, 948 tests pass and 515 of 515 mutants are killed. The outputs digest is `1a57658a...081b0`, equal to the lead's: all 54 output files and 93 of 109 result files are byte identical, and the other 16 differ only in run ids, times, paths, the branch name and one random probe name. On 5349 snapshots the binaries of 97821ac, d0cb325 and cf7d9b8 give the same exit every time and the same answer whenever they serve, so the refactor changes no decision. J3 to J7 and J9 to J11 reproduce at 97821ac and are fixed at cf7d9b8, and with each fix taken out its proof fails. J8 is fixed, tested with real permission errors (root's file capabilities dropped). J1 and J2 are fixed as far as their guard cases, canaries and mutants show; the judge's probes, which try the network and a process, were not run. It found 2 low and 3 info items, and two notes by reading, nothing at medium or above; none changes an escrow state, a census total or a health value the snapshot command writes. Each is fixed in this round or written into the rules.

| # | Finding | Fix | Proof |
|---|---|---|---|
| U1 low | the table showed that every check fires alone, not that each is exact: of 24 weaker or stricter forms of the binary's checks, 16 passed the table, and 10 of those passed every step that reaches the binary. Weaker: an escrow bound or a pin height above the status's, a pin genesis or finalized hash of none, junk before a sha256 or a hash, a text list holding a number, an unverified escrow holding an open. Stricter: a time with an offset refused, equal heights with a lag of 0 refused | refused cases for the other side of each comparison, for junk before a hash, a mixed list and an unverified open; served cases for each field the command may write as none, a time with an offset and equal heights | 16 table cases (177 in all); the rerun's 16 survivors as hand mutants, each killed by the one case its why names |
| U2 low | `rpc.stale` read false for a fresh head whose stuck check could not run, where RULES.md 1.1 says null, so a gate waiting for `rpc.stale` false let that snapshot through | when the stuck check cannot run, a stale of false becomes null, and RULES.md 1.1 names the case | 2 status tests; 1 mutant |
| U3 info | RULES.md 1.1 said a head counts toward `reset_detected` false once the stuck check found it moving, where the code also counts a height held no longer than the stale limit | it says held for no longer than the stale limit, or new to the log | read |
| U4 info | clause 16's padded path sentence fit a padded path itself past the limit and missed one under it whose `event-pages` is past it | it says the command counts the folder a padded path names whenever that folder can be read, and the recount refuses past the limit, as a page file problem when only `event-pages` is past it and as an input problem when the folder path is | read |
| U5 info | RULES.md 4's canary bullet listed seven canaries, where there are ten | it lists the ten | read |
| dgram | found by reading: the stand in `dgram.Socket` kept the real prototype, whose `constructor` property still handed out the real function | the prototype's `constructor` names the stand in, and RULES.md 4 says so | 1 guard case; 1 mutant |
| wording | found by reading: d0cb325's commit message says 2000 seeded random edits, where round 14 says 5000; the table test's comment said its served cases make any stricter rule fail | the 5000 stand: they ran after that message was written, and a pushed message is not rewritten. The comment says what the cases prove, and that the table is no proof that every other form fails | read |

## Round 14: the third IMD audit, of 97821ac, a refactor of the MCP snapshot checks, and the fix for each

Four IMD agents audited 97821ac, each in one area, and a judge reproduced, merged and ranked what they found (job 9d67f583): 1 medium, 7 low and 3 info. Every specialist found all 15 findings of the audit c0ebfa5e fixed. None of the new ones can give a wrong escrow state or a partial count shown as complete, and none is a src path to the network, a process, a signature or a spend; the medium is a hole in the test harness. Three specialists could not finish the mutants step inside their sandbox's time limit, and two saw two command line checks fail on a warning Node printed for their environment; the last row answers both.

The ninth independent rerun reproduced 97821ac byte for byte and left 1 low and 1 info item open, with two notes found by reading; the rows marked N answer them.

The round first moves the MCP binary's snapshot checks out of one long expression into a module of named rules, as its own commit (d0cb325), proven to change no serve or refuse decision and no output. Each finding is then fixed in the module it belongs to. For J1 the guard case calls `register` with an empty hook module, which shows the call is refused and recorded; the judge's own probe, whose hook connects and starts a process, was not run again here, since a probe that tries the network or a process needs the owner's decision.

| # | Finding | Fix | Proof |
|---|---|---|---|
| refactor | every check the MCP binary makes sat in one expression with no name, and its 76 mutants each ran the end to end script, so the mutants step outran the auditors' time limits | `src/snapshot-check.ts` declares each object's fields once with the check each value must pass and each settlement agreement as a named rule; `checkSnapshot` returns the names a snapshot breaks, and a refusal names them | 161 table cases, the 79 old variants among them, each naming exactly the checks its edit breaks; a test that every check has a case; 143 mutants, killed as unit tests in under two minutes; the 506 and 61 honest snapshots still served; 18 of 20 earlier edits refused before and after; 5000 seeded random edits get the same exit from the binary at 97821ac and at d0cb325; outputs byte identical to 97821ac's given the same source sha |
| J1 medium | `module.register` runs its hooks on a loader thread whose modules hold none of the harness's patches, so a test could connect and start a process with nothing recorded | `module.register` and `module.registerHooks` are refused and recorded, and RULES.md 4 names them | 2 guard cases; 1 canary; 2 mutants |
| J2 low | `net.Server`'s `_listen2` and a `dgram.Socket` made directly opened sockets with nothing recorded | both are refused and recorded; the real `dgram.Socket` prototype's methods stay blocked too | 5 guard cases, 2 of them in place of the old direct socket cases; 2 canaries; 2 mutants |
| J3 low | `escrow` and `census` printed `meta.json` `now` unchecked: left out when it was missing, any text when it was given | one resolver gives every command its time: `--now`, or else `meta.json` `now`, which must be a time with a zone; `census` refuses as an input problem, the command's alone in clause 16, since the recount reads no clock | 1 command line check of 10 refusals and 3 runs given `--now`; 4 mutants |
| J4 low | a saved reading, or the snapshot the MCP binary serves, that is a named pipe hung `status`, `snapshot` and the binary | `src/files.ts` reads a regular file only, opened without waiting; the fixture reader, the snapshot log, the drift spec and the binary all read through it | 2 command line checks, five runs on named pipes, each with ten seconds to answer; 5 reader tests; 4 mutants |
| J5 low | an `rpc-head.json` with keys left out, `{"error": ...}` say, read as degraded with a made up genesis conflict | the head's fields are filled with null before any check, as a head that read nothing writes them; a head that is not an object read nothing and says so | 2 status tests; 3 mutants |
| J6 low | `escrowState` took NaN, Infinity, 1.5 or -1 as a finalized height | a height that is not a whole number from 0 bounds nothing and reads as none, with the not bounded note | 1 escrow test of six values; 2 mutants |
| J7 low | with `--semantic-only`, a labeled row replaced by a bare marked span passed | every value must sit in the element the renderer writes it in | 1 tamper named by that check (109 in all) |
| J8 low | an `event-pages` folder that cannot be listed was an input refusal in TypeScript and a page file refusal in the recount | it is a page file problem on both sides, naming `event-pages`, and so is one that cannot be read: that also settles round 13's S2, a path past the system's limit, which both now refuse alike. A scenario folder that cannot be searched stays the command's `meta.json` input problem alone, as clause 16 says | 2 reader tests and 1 recount test, each making the call fail, since root opens any folder; a cross-check scenario made at run time past the path limit; 2 mutants |
| J9 info | a `/chain` http status of `"200"` read "does not count: http 200" | it says the status is not a whole number; the faucet, the gateway and `/chain` share the one wording | 1 status test; 1 mutant |
| J10 info | `get_escrow_state` echoed an unseen escrow id in the caller's case | it answers in lower case, as every escrow id is shown | 1 MCP test; 1 mutant |
| J11 info | `reset_detected` stayed false with the finalized height stuck, or with a stuck check that could not run | false also needs the finalized height known not to be stuck; another genesis counts either way, and the head still bounds escrow evidence, since a finalized height stays final however long it holds | 2 status tests; 4 mutants |
| N1 low | at the grain of single conditions, 8 more the binary checks had no case that only they break: funded with a release or with a refund, refunded with a release or with two opens, a height from 0 and whole, an http status whole and a hash of exactly 64 hex; and two mutants' why lines said more than their kill showed | the refactor's table has a case for each, with a mutant of each condition alone, and every mutant's why names only cases the run shows killing it | table cases; 143 mutants |
| N2 info | clause 16 missed two path edges: a folder path itself past the system's limit, and a path padded with `/.` or `//`, which Node folds, so the command counts the real folder where the recount refuses | clause 16 says what each side does at each edge near the limit, and that a padded path is outside what the two sides compare | the cross-check's path limit scenario (J8); read |
| N3 | found by reading: a reading the system will not open was named by Node's own message, which holds the path as given, a line break and all | it is named by its error code | 1 reader test; 1 mutant |
| N4 | found by reading: RULES.md 5 said the status genesis holds three hashes, where two of them may be none | it says so | read |
| warning | two command line checks read a refusal whole, so a warning Node printed for its environment (`NODE_USE_ENV_PROXY`) failed a correct build | every node the checks start runs with its warnings off and a time limit; README.md shows how to run the mutants one file at a time inside a short time limit | 43 of 43 checks pass with `NODE_USE_ENV_PROXY=1` set, where 38 of 40 passed before |

## Round 13: the eighth independent rerun, of e91e10c, and the fix for each

A fresh agent reran e91e10c from a fresh clone. 33 steps exit 0, 761 tests pass and 406 of 406 mutants are killed. The outputs digest is `97229b95...cd35c4`, and every result file is byte identical to the lead's run but for run ids, times and paths. All seven round 12 items are fixed: with each fix taken out, its proof fails. All 506 honest snapshots of the seventh rerun's corpus are served, and so are 16 more with odd revisions and http statuses. The six type checks round 12 called equivalent are equivalent, and so are the pin's own three. RULES.md section 5 and the binary match both ways. It found 1 low and 1 info item, nothing at medium or above. Each is fixed in round 13 or written into the rules. No code the outputs come from changed in this round: only proofs and one sentence of RULES.md.

| # | Finding | Fix | Proof |
|---|---|---|---|
| S1 | at the grain of single conditions, 12 conditions the binary checks had no variant that only they break: an event twice within one escrow, a bound with no RPC genesis at all, seq from 0, a later line naming the line before, funded on one open and nothing else, refunded on one refund, at most one open, no event of the other kind, a service's detail and its time, each faucet limit, and an evidence index that is whole and from 0 | for each, a variant that only it refuses | 13 variants (79 in all); 13 mutants |
| S2 | a scenario path so long that `event-pages` cannot be read is a partial census in TypeScript and a refusal in the recount, which names the path quoted | clause 16 names the case, as it names a folder that is not UTF-8 | read |

## Round 12: the seventh independent rerun, of 979298d, and the fix for each

A fresh agent reran 979298d from a fresh clone. 33 steps exit 0, 761 tests pass and 378 of 378 mutants are killed. The outputs digest is `0f13d8c5...fe75129`, and every result file is byte identical to the lead's run but for run ids, times and paths. Rounds 1 to 10 in this log are word for word what the PR description held. Of the sixth rerun's ten items, nine are fixed and one is partly fixed. It took out each fix the round 11 map names, and every proof failed as it should. It wrote 506 snapshots from the repo's fixtures: every status fixture with every escrow fixture, one log through all of them, and 13 histories. 501 were served, and every served folder passes the output check both ways. It found 2 low and 5 info items, nothing at medium or above. Each is fixed in round 12 or written into the rules. The first commit of this round, 544ab6f, failed its own check, as 1e4949f did in round 10: two older variants also broke the two agreements R7 adds, so the mutants of the rules they were written for survived. The commit after it keeps each of those variants to its one rule; the two mutants were run again before it, and its full check kills every mutant.

| # | Finding | Fix | Proof |
|---|---|---|---|
| R1 | round 11 made the MCP binary refuse two kinds of honest snapshot: a source sha that is short, upper case or the `unknown` that check.sh passes outside a git checkout, and a saved reading's http status of -1, which RULES.md 1.1 allows | the binary takes the pin's `source_sha` as text or none and an http status as any safe integer, as the snapshot command writes them, and RULES.md says so | 4 variants that must be served; 2 mutants that restore the old rules |
| R2 | 24 of the binary's stated checks had no variant or mutant, so any one could go unseen | for each, a variant that only it refuses, and a mutant; six more type checks follow from the agreements (the status's finalized height and hash and RPC genesis against the pin's, the lag, an escrow's bound, an evidence genesis), so a mutant of one of them is equivalent and none is written | 24 variants; 24 mutants |
| R3 | round 11 U10: a meta.json that is a pipe, among the fixtures, still hangs the cross-check's own read | the cross-check reads meta.json only when it is a regular file | read |
| R4 | clause 16 on folder names: the recount printed the path in its "not a folder" refusal raw, and Node decodes a folder name before the command reads it, so one that is not UTF-8 cannot be named or opened as the recount can | the recount shows that path with `%XX`; clause 16 says a folder name that is not UTF-8 is outside what the two sides compare | 1 recount test, which fails with its rule taken out by hand |
| R5 | the empty shells check's comment said the status check alone refuses it | the comment says the pin agreements refuse it too, and the variants case proves the status check alone | read |
| R6 | interfaces/README.md said every field of a snapshot is type checked | it says the census and the drift report are checked for their schema only | read |
| R7 | within the stated limit, the binary served an escrow bound from a head on another genesis, and one finalized event as evidence twice | both are refused, and RULES.md lists both, with the status and escrow times it already checked | 2 variants; 2 mutants |

## Round 11: the sixth independent rerun, of 5238c74, and the fix for each

A fresh agent reran 5238c74 from a fresh clone: 33 steps exit 0, 760 tests pass, 350 of 350 mutants are killed, the outputs digest is `ab3d3d5f...4ac9539`, and every result file is byte identical to the lead's run but for run ids, times and paths. A second full mutant run through a pipe came back whole. All 15 findings of the IMD audit c0ebfa5e are fixed. Every round 7 to 10 item it sampled holds. It took seven fixes out itself: five proofs failed as they should and two were partial. Offline it found nothing at medium or above, only 4 low and 6 info items, each fixed in round 11 or written into the rules. It ran no network or process bypass probe and did not search the source scan's reach, which needs a person's decision.

| # | Finding | Fix | Proof |
|---|---|---|---|
| U1 | the MCP binary served 13 snapshots that contradict themselves or hold nothing behind a value (services with only a health word, a pin `{}` with seq "banana", claimed on evidence `[null]` or on an open alone, `reset_detected` false with no heights, a bound the status has no height for), though RULES.md said its checks catch a file that contradicts itself | every object but the census and the drift report holds exactly its fields with their types, at every level, and the settlement values agree: `reset_detected` false needs both heights, the lag adds up, each state rests on its own events on the pinned genesis, the bound is the status's height with no evidence above it, the pin is the status's chain point, and a fixture part makes a fixture snapshot. RULES.md lists every check the binary makes and says what it does not compare | 22 more MCP variants, and 3 kept to the one rule they test; 21 more mutants, 2 repointed; of the 13, 12 are now refused, and the one still served (a fixture snapshot whose status was read from RPC) is a label snapshot.ts writes; the rerun's 61 honest snapshots are all still served and pass both modes |
| U2 | round 10 I3's proof covered three of its five rules | the two left: `reset_detected` true on the pinned genesis, and an unverified escrow holding evidence | 2 variants; 2 mutants |
| U3 | round 10 I2's proof tested five names, so DEL, U+2029 and the recount's page structure names could break unseen | four more names on both sides (U+001F, DEL, U+009F, U+2029), and a recount test of all six page structure refusals | snapshot and recount tests; 3 mutants; each recount rule taken out by hand fails its test, as the runner drives TypeScript and the check scripts only |
| U4 | RULES.md 1.1 listed two restarts the history cannot see; there is a third, a new chain already past every height the log holds | stated in RULES.md, with when it matters | read |
| U5 | a duplicate attribute passed `--semantic-only` | each attribute only once on its element | 3 tampers (108 in all) |
| U6 | a fourth kill shows only a refusal's words (a blank log line) | its why line and README say so | read |
| U7 | the journal check counted runs, not files | each file is counted once, and a file checked in two runs fails | 1 test |
| U8 | three census refusals fell outside clause 16 | no range at all is now a request refusal, named as one; a missing folder is named with `%XX` on both sides; clause 16 says a pinned genesis in `meta.json` that is not text is the command's input problem alone | 2 command line checks; 1 recount test; 2 mutants |
| U9 | the output check never applies the binary's serve rules | RULES.md says so, and says that the binary's step fails first in the check | read |
| U10 | the recount cross-check gave each side no time limit | each side gets two minutes, and a side that is stopped is never a refusal | read |

## Round 10: a fifth Fable review, of round 9, and the fix for each

A Fable review of 1737934 reproduced every figure of that commit's evidence, then rechecked the 16 items of round 9: 11 fixed, 1 fixed by rule but not whole and 4 partly fixed, each tied to a finding below. It found 5 low and 6 info, nothing at medium or above, the first round with none. It also ran 30,000 fuzzed histories and 20,000 fuzzed readings against an oracle written from RULES.md 1.1 (none against it either way), 600 fuzzed census argument lists against the recount, and 364 honest snapshots through both modes of the output check, none refused. Its own note: its probe of the read only area stopped short of what was asked, so "nothing reached" there covers its four probe modules. Every item is fixed in 5238c74 or written into the rules. The first commit of this round, 1e4949f, failed its own check: the new underscore and reader rules also caught the only samples two older bans were proven on, so those two mutants survived. 5238c74 adds a sample each ban alone catches. Before that commit a full mutation run on the working tree killed every mutant, and the 62 guard and scan mutants were run again after the last row's rule was added. One more item came from the lead's own check while writing this up (the last row).

| # | Finding | Fix | Proof |
|---|---|---|---|
| L1 | an underscore name written as a string key (`x["__proto__"]`, `console["_stdout"]`) passed both scans | the underscore rule reads strings and templates as the banned list does | 4 more samples; 1 mutant |
| L2 | `import { default as m } from "node:fs"` still handed over a module object | the default export taken by its name fails, imported or re-exported | 2 more samples; 1 mutant |
| L3 | the reader handed stdin back as `rl.input` | the reader's `.input` and `.output` fail, read or destructured | 3 more samples; 2 mutants |
| L4 | the round 9 best height rule missed a restart after a finality stall | every earlier best height is a floor again, whether or not that head read a finalized head; after a stall a long fork that falls away keeps the head unusable until it is back within the lag limit, which RULES.md says is the cost of seeing the restart | status test; command line check of a stall, a fall and the recovery; 2 mutants dropped with their rule |
| L5 | with `--semantic-only` a labeled row turned into a `data-row` row lost its label | a `data-row` row must be `drift.<index>` | 1 tamper |
| I1 | an empty pinned genesis in `meta.json` is now the command's input problem alone | RULES.md says the recount reads its genesis only from its flag, so the cross-check compares that case through none | read |
| I2 | the recount showed a page structure refusal's file name raw, and both sides showed C1 controls and line separators raw | every refusal that names a file shows it the one way, and `%`, C0, DEL, C1 and the line and paragraph separators are shown as the `%XX` of their UTF-8 bytes on both sides | a snapshot test and a recount test of five names |
| I3 | the MCP binary checked types, not sense | it also refuses `reset_detected` false without both readings on the pinned genesis, true without one on another, a funded, claimed or refunded escrow with no evidence, an unverified one with some, and a snapshot trust off the two labels; RULES.md says the hash is no signature | command line check of 3 more snapshots, each named in the report; 3 mutants |
| I4 | 23 tampers name no check, and since round 9 a crash of the check reads as a failure | a tamper that names no check counts as caught only by a failure other than the crash report | canary rule |
| I5 | the recount scans passed a submodule import and `sys.stderr.buffer.raw.truncate` | a submodule import fails, and every attribute must be one of the 34 recount.py uses | 3 more samples; 2 raw text patterns |
| I6 | the test names were pinned as a sorted set, so a swap passed; the MCP check's failure did not say which snapshot was served | the names are pinned in their order, with a doctored copy that swaps two; the check reports each snapshot by name with its exit | a doctored copy |
| Lead | `Object.entries` of the readline reader listed stdin, against RULES.md's own "never listed"; a hash object, a `Dirent`, `Stats` and a file error list only data | the reader is named only as `rl.on(event, arrow function)` in a statement of its own, by a `const` that is not exported and holds the whole `createInterface(...)` call, the one place `createInterface` is named but its import; RULES.md says the scan does not read what the other objects hold | 5 more samples; 5 mutants |

## Round 9: a fourth Fable review, of round 8, and the fix for each

A Fable review of 6638c3f reproduced every figure of that commit's evidence, then rechecked the 15 items of round 8: 11 fixed (2 by rule), 3 partly fixed and 1 not fixed in the repo (I4 was stated in this description only), each tied to a finding below. It found 2 medium, 7 low and 7 info, nothing critical or high. It also ran 40,000 fuzzed status readings against an oracle written from RULES.md 1.1 (none read `reset_detected` false against it), 60,000 fuzzed page sets against a census oracle and 1,500 fuzzed census scenarios against the recount, with no difference. Every item is fixed in 1737934 or written into the rules.

| # | Finding | Fix | Proof |
|---|---|---|---|
| M1 | `await import("node:crypto")` passed both scans, since the `createHash` only rule read import declarations alone; `Object.entries` of the module then gave the signing and key APIs by names joined at run time | every import names what it takes: no dynamic `import()`, no default or namespace import and no `export *`, so `src` holds no module object and nothing but `createHash` comes from `node:crypto`; the Web Crypto classes are banned names | 9 more bad samples; 4 scan mutants, and 1 dropped with the rule it tested |
| M2 | `import os as o` then `o.system("id")` passed both recount scans | an import under an alias fails in both | 5 more samples; a raw text pattern |
| L1 | a `match` class pattern read any attribute by keyword, and `Exception.mro()` handed over `object` | a `match` statement and `.mro` fail in both | 5 more samples; 2 raw text patterns |
| L2 | `Object.entries` of an allowed module read its functions without naming them, against a sentence of RULES.md | the module object is gone (M1), and the rule says what a listing can hand over: what an object `src` holds holds itself | the namespace import sample of M1 |
| L3 | an empty flag value (an unset shell variable) read as the flag left out: `--log ""` gave a snapshot with no history check | an empty value is a flag with no value on both sides | command line check; 2 cross-check cases; recount tests; 1 mutant |
| L4 | with `--semantic-only` a value cut out of its row sat in its table with no label | every marked `td` sits in a labeled row or a drift item row; a label is plain text with `scope="row"`; a bare `<code>` only in an escrow id's cell; `data-v` compared as a value, so `data-v="null"` is no longer read as none | 6 tampers |
| L5 | the best height floor refused an honest log after a finality stall and a reorganisation | only an earlier head with no finalized head sets a best height floor; one with a finalized head sets the finalized floor, which no reorganisation can pass; the read error case is stated as failing closed | status test; command line check; 2 mutants, 2 repointed |
| L6 | the MCP binary served a non-hex escrow id, an id twice with two states, and a status whose genesis and services were empty | each id lower case hex and listed once, the genesis exactly its three hashes, each health one of the four words | command line check of 4 more snapshots; 4 mutants |
| L7 | `scripts/mutate.mjs` and six more scripts ended with `process.exit`, so a report read through a pipe was cut at 64 kB | every script sets `exitCode` and lets its report flush | a piped run parses whole |
| I1 | `--now` was not checked outside two commands, and census without its folder flag refused with no kind | `--now` must be a time with a zone; the folder flag left out is a request refusal, as in the recount; RULES.md says `--now` has no counterpart in the recount | 2 command line checks; a cross-check case; 2 mutants |
| I2 | a page file name with a line break was compared only up to it, and `%FF` as text looked like a byte that is not UTF-8 | both sides show `%` and the control characters as `%XX` | a generated scenario with names that differ after a line break |
| I3 | a restart on an earlier head with no valid genesis, or within the lag limit, is not seen | stated in RULES.md 1.1 | read |
| I4 | the output check ended with a TypeError and no report on JSON of the wrong shape | `snapshot.json` must be an observatory snapshot, and any error still ends with a report | 4 tampers |
| I5 | test names were not pinned; `.for([])` and a `fails` key were not read | each file's test names are pinned by digest beside their number; both forms are read; a table in a variable is stated | a doctored copy; 2 more samples |
| I6 | three kills show a refusal's words, not that it stands on that check, and one kill came from a parse error, not a hang | each mutant's `why` line says what its kill shows, and the README says it of the three | read |
| I7 | `{ input: process.stdin }.input` read stdin back under another name | `process.stdin` only in `createInterface({ input: process.stdin })` | 2 more samples; 1 mutant, 1 repointed |

## Round 8: a third Fable review, of round 7, and the fix for each

A Fable review of 2bf817f reproduced every figure of that commit's evidence, then rechecked the 20 items of round 7: 18 fixed, 2 partly fixed, 0 not fixed, each partly fixed one tied to a new finding below. It found 1 medium, 7 low and 7 info, nothing critical or high. It also ran 100,000 fuzzed page sets against a census oracle and 4,000 fuzzed census scenarios against the recount, with no difference. Every item is fixed in 6638c3f or written into the rules.

| # | Finding | Fix | Proof |
|---|---|---|---|
| M1 | both source scans passed static code that reached `Function`, and through it fetch, WebSocket and the Web Crypto signing call: the key `constructor` read back from a regular expression, decoded with `atob` or `JSON.parse`, trimmed, or listed with `getOwnPropertyNames`; and `process.stdout.connect` | the class is closed rather than listed: no computed key that is not a string or number literal anywhere in `src` (its 34 such sites rewritten: records through `own()` in the new `src/own.ts`, which walks own entries and never hands back a function or an inherited member, lists through `.at()`, text through `.charAt()`, counts through a `Map`); regular expression patterns read; the socket calls `connect`, `listen` and `bind`, `atob`, `Object.assign`, the stack trace hook, `WebAssembly` and the name listing APIs banned; no underscore name; `process.stdout` and `stderr` only as `.write(...)`, `stdin` only as `{ input: process.stdin }` | 32 more bad samples and 4 good; 6 scan mutants and 2 `own()` mutants; 7 raw text patterns |
| L1 | a restart on the same genesis read `reset_detected` false when the earlier snapshots saw a best height but no finalized head | every earlier best height on the genesis is a floor, less the lag limit (30 blocks), with or without a finalized head on either side | status tests; command line check; 4 mutants |
| L2 | a usable /chain reading whose body named no genesis left no trace | the faucet's detail says the reading does not count and why | 3 status tests; command line check; 1 mutant |
| L3 | a JSON output cut short made the output check spin for ever | the check parses first, reads every file as strict UTF-8, ends at once on a file that is not JSON, and the repeated key reader stops at the end of the text; its report is written to the pipe whole (a long report was cut short by `process.exit`), and the canary counts a run with no report, an exit other than 0 or 1, or a time out as no verdict | 4 tampers; 5 strict tests; 1 mutant |
| L4 | the transcript passed in full mode however it was spelled | in both modes each line is its four keys in the script's order, the request as the script sends it and the response as the server's own compact line, one line per exchange and nothing else; in full mode the whole file equals what the transcript script writes | 2 tampers |
| L5 | with `--semantic-only` a class on a row, a table or a card painted cells; an empty banner and card added marks; `data-v` could be dropped | every element's class is the renderer's (none but on marked cells, the fixed paragraphs and the cards), the page holds exactly its paragraphs, cards and tables, and every value cell but the intro's carries `data-v` | 5 tampers |
| L6 | the recount scans passed a generator's frame globals, `open` with unpacked arguments, `type(...)` and `help` | every name is one the file binds or a builtin on a fixed list of the 26 it uses, a builtin off the list fails wherever it appears, frame, code and traceback fields fail, and `open` takes a file, a mode and only `encoding`, `errors` and `newline` | 18 more samples, 2 more good; 3 raw text patterns |
| L7 | the census commands read `--flag=value`, abbreviations, unknown flags and a value that starts with a dash differently | one rule on both sides: every flag is `--name` and then its value; `--name=value`, an unknown or abbreviated flag, a flag twice or with no value and a stray argument are request problems; a dash value is a value. The recount drops argparse for a hand parser | 11 more command line cases in the cross-check; a recount test of 12 inputs; command line check; 4 mutants |
| I1 | the MCP binary served a status or escrow holding only its schema | the status and each escrow must hold exactly their schema's fields, with `reset_detected`, the state, trust, heights, lists and scope of their types | command line check of 5 snapshots; 3 mutants |
| I2 | an escrow id that is not `0x` plus 64 hex reached the page and `list_escrows` but not `get_escrow_state`; three held ids left no unseen one | the snapshot command refuses such an id; the unseen id tries all 256 single byte ids | command line check; 1 mutant |
| I3 | the banned names refuse plain words | stated in RULES.md section 4; `src` uses none of them | read |
| I4 | three kills change only a refusal's words, since the written form check refuses anyway | stated in the evidence: those three show the refusal names its reason, and the written form and canonical form checks are what refuse | read |
| I5 | the test report check read statuses only and pinned no count | each file must run exactly the tests `test/test-counts.json` pins, and the sources hold no `.fails` and no `.each([])`; a test that returns early is still not seen | 2 more rules and a doctored copy |
| I6 | the cross-check cut a named file at a colon or semicolon and stderr at 400 characters | the file is read whole as the longest entry of the scenario the message names, and the whole stderr is compared | a generated scenario whose page file name holds a colon and a semicolon |
| I7 | the `status` command runs no history check | stated in RULES.md 1.1, README.md and interfaces/README.md: only the snapshot command's status counts history | read |

## Round 7: a second Fable review, of round 6, and the fix for each

A Fable review of bda6af3 reproduced every figure of that commit's evidence, then rechecked the 48 items of round 6: 43 fixed, 5 partly fixed, 0 not fixed, each partly fixed one tied to a new finding below. It found 4 medium, 9 low and 7 info, nothing critical or high. It also ran 350,000 fuzzed page sets against a census oracle (no funded, claimed or refunded without finalized evidence) and 16,000 fuzzed census scenarios against the recount (no difference in any count or refusal). Every item is fixed in 2bf817f or written into the rules.

| # | Finding | Fix | Proof |
|---|---|---|---|
| M1 | after a restart on the same genesis, a head with no finalized head and a low best height counted: `reset_detected` false | a head counts only with a valid finalized head and best height, and a best height below an earlier finalized height on the genesis is a conflict | status tests; command line check; 2 mutants |
| M2 | the output check read little of the MCP transcript beyond the tool texts | the transcript is exactly the exchanges the script makes, the initialize answer, tool list and refusals are exactly the server's, every server line is compared byte for byte, and the binary is asked for an escrow id the snapshot does not hold | 8 tampers |
| M3 | both scans missed banned names spelled as strings: keys, template keys, arguments, a getter on a prototype, the Web Crypto global | every string and template is read against the banned list; the getter-defining APIs and `crypto` are banned | 8 samples; 4 mutants |
| M4 | an import-equals, a `.mts` module and relative paths out of `src` passed both scans | an import-equals fails, `src` must hold only `.ts` files, and a relative import must land on a scanned module | 5 samples and a file list self-test; a guard test; 3 mutants |
| L1 | a log running backwards passed when the earlier snapshot had no head time or no head | every earlier snapshot's own time reaches the status | status tests; command line check; 2 mutants |
| L2 | a reading with no `error` key read as no error | it counts as a failed read | status test; 1 mutant |
| L3 | an unusable /chain reading left no trace | `genesis.faucet` shows it as `genesis.rpc` does, another genesis there is a conflict, and the faucet detail says why it does not count | status tests; 3 mutants |
| L4 | census and recount differed on an empty genesis, a 5000 digit request number and a missing folder | both refuse alike, and the cross-check compares 8 command line inputs | recount tests; 2 command line checks; 2 mutants |
| L5 | the recount scans passed reaches through `argparse._os`, aliases and `open` kept in a name | every module use must be one of 14 full dotted names, no private attribute, and `open` only called directly | 9 more samples |
| L6 | the log reader and the MCP binary accepted a byte order mark, padding and an integer the parser rounds | both read only their written form | 3 log tests; 3 command line checks; 6 mutants |
| L7 | the output check read only the log's last line and ignored extra files | the whole chain verifies, the folder holds exactly nine files, and `pin.json` is in the feed format | 3 tampers; command line check; 1 mutant |
| L8 | three page tampers passed without the byte comparison | a cell holds no markup but a bare `<code>`, and the page holds exactly the renderer's keys in order | 3 tampers |
| L9 | one unusable reading sets the rollback floor for good | kept, because it fails closed; RULES.md and README.md say so and how to start a new log | read |
| I1 | a time's fraction was rounded into the next second | cut to whole milliseconds | strict test; 1 mutant |
| I2 | the binary served empty parts and crashed on deep nesting | each part's schema is checked, and nesting before parsing | 2 command line checks; 2 mutants |
| I3 | an earlier snapshot with no valid genesis sets no floor | as the rule says ("on the same genesis") | read |
| I4 | two runs that printed nothing would agree | a run that exits 0 must print a census holding every compared key | read |
| I5 | a skipped or `.only` test would not fail the run | the `test-report` step, proved on doctored copies of the report | step |
| I6 | two events in one block may disagree on block number | stated in RULES.md section 2, and the code comment made exact | read |
| I7 | the pinned genesis comes from the status scenario's `meta.json` | stated in RULES.md section 1; M1 takes it from the code | read |

## Round 6: the IMD follow-up audit and a Fable review, and the fix for each

IMD job c0ebfa5e audited b4a7a99: four specialists, then judge #784 reproduced, merged and ranked 15 findings (2 high, 5 medium, 7 low, 1 info). Its rechecks found the 15 findings of job a24f9aa1 fixed, with a few marked partly fixed by one specialist each; each of those is a finding below. A Fable review of b4a7a99 then looked for what the audit missed: 10 medium, 15 low and 8 info, nothing critical or high. Every item from both is fixed in bda6af3 or written into the rules, each with a test, a mutant or a tamper that proves the test bites.

### IMD c0ebfa5e (judge #784)

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 high | escrow took an event with no `block_number` key as evidence | a missing key is malformed; an explicit `null` is kept with a note that no finalized height bounds it | fixture `escrows-no-block-number`; 2 mutants |
| 2 high | the rollback check read only the last log line | every earlier snapshot that recorded a finalized head counts, oldest first, after the log's hash chain verifies | command line check: a rollback after a snapshot with no RPC reading; 4 mutants |
| 3 medium | a stuck height was measured only since the previous snapshot | counted from the oldest of the latest run of snapshots at the same height | status tests; 1 mutant |
| 4 medium | the RPC genesis counted toward `reset_detected` with no gate | only a usable head counts: no error, a time that parses, fresh, not later than the snapshot, and not contradicting itself or an earlier snapshot. The same head alone bounds escrow evidence | status tests, including a table of `rpcHeadUsable`; 6 mutants |
| 5 medium | a page file name with a non UTF-8 byte was dropped | names are read and sorted as bytes; such a name refuses, in TypeScript and Python | a scenario made at run time in the cross-check; 1 mutant |
| 6 medium | escrow ignored page chains | escrow follows census clause 2: a broken chain on the pinned genesis makes every escrow `unverified`, and a page the walk never reaches is never evidence | fixtures `escrows-broken-chain`, `escrows-off-chain-release`; 3 mutants |
| 7 medium | free text could state a value | every piece of text outside a marked cell and a `th` must be the page's fixed words, in order | 7 tampers: a th-only row, two th cells in one row, a free paragraph, a second h1, the title, a code element, a changed seq |
| 8 low | `aria-label` and `class` could say anything | `aria-label` only reads unknown on a blank unknown cell; each cell's class is the one its value calls for | 2 tampers |
| 9 low | heights read with `Number.isInteger` | the shared safe integer reading everywhere | status tests; 1 mutant |
| 10 low | an earlier head time that did not parse skipped the stuck check | the check reports that it cannot run, so health is unknown, not ok | status tests; 1 mutant |
| 11 low | an unparsable release did not block claimed | a suspect release or refund blocks funded, claimed and refunded alike | escrow tests; 2 mutants |
| 12 low | the recount crashed on deep nesting and refused 4300 digit integers | nesting over 64 levels refuses on both sides, checked before parsing; a long integer is just an unsafe one | fixtures `census-deep-nesting`, `census-huge-integer`; 3 mutants |
| 13 low | the source scan missed computed access on `process`, `.constructor` and subfolders | `process` only through six members, `.constructor` banned, `src` read recursively | scan samples; 3 mutants |
| 14 low | the mutation runner failed through a temp folder reached by a link | the temp folder is resolved to its real path | mutation runner self-test, through a link |
| 15 info | mutant replacements went through `String.replace` patterns | a function replacer writes them exactly | mutation runner self-test, a `$$` replacement |

Also fixed: the sums step no longer needs `mktemp`, which one auditor's sandbox blocked. New rule, clause 16: a refusal names its kind (`request`, `page-file`, `page-structure`, `input`) and the file, and the cross-check now requires the same kind and file from both sides, where it used to count any two refusals as agreement (2 mutants).

### Fable review of b4a7a99

| # | Finding | Fix | Proof |
|---|---|---|---|
| M1 | copies of one event that disagree on the account: escrow funded, census malformed | the account is part of escrow copy agreement, as in census clause 9 | escrow test; 1 mutant |
| M2 | a faucet or gateway reading that carries an error read ok | with an HTTP status it is degraded and its detail names the error | status tests; 2 mutants |
| M3 | a head that rolled back, changed hash or put best below finalized still counted as usable | usable excludes a contradicted head: no bound, and `reset_detected` cannot be false | status and snapshot tests; 1 mutant |
| M4 | a rollback was missed when the earlier snapshot had no head time | that snapshot still sets the floor; only the stuck check needs the time | status tests; command line check; 1 mutant |
| M5 | a key twice in a saved reading, a log line or the served snapshot: the last copy won | each is refused (and a byte that is not UTF-8): a saved reading counts as nothing read, with the file and reason in its detail; a log line breaks the chain; the MCP binary serves nothing | 6 status tests, 3 log tests, 3 command line checks; 8 mutants |
| M6 | an account named `__proto__` vanished from the feeds and broke snapshot.json's hash | the feed writer defines every key as its own property | fixture `census-odd-accounts` (both sides agree, code point order included); a sixth check scenario; 2 tampers; 2 mutants |
| M7 | upper case tags passed the page check | tag and attribute names must be lower case, as the renderer writes them, and a closing tag holds only its name | 4 tampers |
| M8 | bare text typed into a row or a card | the fixed words rule catches it; a `<` that opens no tag is refused, and every `th` must be read as a label or a column | 5 tampers |
| M9 | extra, repeated or renamed fields in feeds, snapshot.json and MCP answers | strict reads, exact keys and schema, the written format, the exact MCP answer shape, each server line read as written, and a final byte comparison with what the code writes | 13 tampers |
| M10 | the scan missed escaped names, legacy modules, a comment before the module name and key APIs | a second scan reads each module as a syntax tree, escapes decoded, imports against an allow-list | 57 bad and 15 good samples; 6 mutants |
| L1 | a release that lost its section or method was ignored | it leaves the escrow it names `unverified` | escrow tests; 1 mutant |
| L2 | the census banner was checked by its first word | read whole, as one of two fixed sentences | 1 tamper |
| L3 | a snapshot earlier than the last one appended with no conflict | an earlier snapshot read later than now is a conflict | status test; 1 mutant |
| L4 | a future time on a head that read nothing was no conflict | it is a conflict whatever the head holds | status test; 1 mutant |
| L5 | an empty string in `error` meant no error | any value but `null` is an error | status tests; 1 mutant |
| L6 | status took an upper case genesis as the pin | a genesis is lower case hex as written, here as in the census | status test; 1 mutant |
| L7 | wrong typed fields went into the interface | each field reaches the status only with its interface type, else `null` | status tests; 3 mutants |
| L8 | an escrow id listed twice broke an honest snapshot's check | the command line refuses it, in either case | 2 command line checks; 1 mutant |
| L9 | the mutation step passed with no mutants; the recount canary could nudge nothing | a run with no mutant fails, so does a control that ran no test, and the recount canary needs one nudged count and one nudged refusal | mutation runner self-test; the recount canary rule is read |
| L10 | the harness canary called `npx vitest` without `--no-install` | it passes `--no-install` | read |
| L11 | the recount took " 0", "+5" and "1_0" as request numbers | both sides read ASCII digits only and refuse anything else as a request problem | recount test; command line check |
| L12 | the recount scan read only the first name of an import line | its own tests walk recount.py's syntax tree; the guard test reads every name | recount tests with 19 bad and 4 good samples |
| L13 | the page check did not pin the `meta` tags | the whole head is fixed | 1 tamper |
| L14 | the census `reset_detected` reads beside the status value of the same name | RULES.md section 3 says what it means and that only the status value counts | read |
| L15 | spec drift had no rules | RULES.md section 6; the runtime version is a safe integer and its time must parse | drift test; 2 mutants |
| I1 to I8 | times to the millisecond, list shaped event data, no block order, clause 14 on doubles, MCP tools with no feed file, a second copy of the guard, unanchored ignore patterns, a truncated log | written into RULES.md and interfaces/README.md; a test fails any test that loads a second copy of the guard; the ignore patterns are anchored | read, and 1 test |

## Round 5: the IMD audit findings and the fourth rerun's open items, and the fix for each

Every finding below is fixed in f90e197, with one more test case in b4a7a99. Each fix has a test, a mutant or canary that proves the test bites, and a fixture where it helps the TypeScript and Python cross-check. A new shared module, `src/strict.ts`, holds the one reading of a safe integer and of an ISO 8601 time with a zone and a real calendar date, so escrow, census and status cannot drift apart again.

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 | escrow took an index or block_number above 2^53 | safe integers only; such an event is malformed | fixture `escrows-unsafe-index`; 2 mutants |
| 2 | escrow took a page field above 2^53 | such a page is invalid, every escrow `unverified` | fixture `escrows-unsafe-page-range`; 2 mutants |
| 3 | lossy UTF-8 turned a bad byte into evidence | strict UTF-8; a bad byte or a byte order mark refuses | fixtures `census-invalid-utf8`, `census-byte-order-mark` (both sides refuse); a test proves the bad byte would parse if decoded lossily; 2 mutants |
| 4 | the snapshot command never passed the previous snapshot | it reads the previous one from its log, after verifying the hash chain; a broken log is refused | 2 command line checks; 1 mutant |
| 5 | the faucet /chain reading was never checked | it counts only with HTTP 200, no error and a fresh time; a time later than the snapshot is a conflict. The fixture clocks now follow the real reading (23:47:52 UTC) | 10 status tests; 5 mutants |
| 6 | `event-pages` as a file | a file or a link refuses, in TypeScript and Python | fixtures `census-event-pages-file`, `census-event-pages-link`; 1 mutant |
| 7 | two opens plus a release came out claimed | two distinct finalized opens conflict whatever else exists | fixture `escrows-two-opens-and-release`; 1 mutant |
| 8 | a blocked call from a late timer was never seen | every attempt, reset and final check goes to a journal the moment it happens; the journal is checked when all test files end, and again as its own step | 11 tests; 9 mutants; 2 late-timer canaries, plus a control that passes once the journal check is taken out |
| 9 | the mutation runner copied untracked files | the runner and the canary copy exactly the files git tracks; a copy that cannot be made is a structured `setup-failed` | the runner's self-test checks the copy on a throwaway repo and the failure report |
| 10 | drift rounded long decimals | decimals compare from their source text, never a double | fixture `drift-long-decimal`; 4 mutants |
| 11 | a release above the finalized height left the escrow funded | it leaves the escrow `unverified` with a note | fixture `escrows-release-above-height`; 2 mutants |
| 12 | the page check ignored comments and hidden rows | it fails any comment, and any element, attribute or stylesheet the renderer does not write; a test reviews every property the stylesheet sets | 6 tampers: a comment, `hidden`, `display:none`, a hiding style rule, a `details` fold, a script that rewrites a cell |
| 13 | the scan missed `fetch.call` and aliases | it bans the bare names `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `globalThis`, and member or computed access on `global`, `self` or `window` | 10 new samples; 3 mutants |
| 14 | a negative block_number was malformed in escrow only | it is out of range, as in the census. New rule, to close the gap this opened: a page whose range starts below block 0 is invalid, in census, escrow and recount | fixtures `escrows-negative-block-number`, `census-negative-from-block`; 3 mutants |
| 15 | the digest holds on one Node version | the README says so, and CI is pinned to Node 22.23.4 | read, not run |

The fourth independent rerun reproduced bce10dc byte for byte, killed all 159 mutants with real assertions in its own run, and confirmed 5 of the 6 round three fixes. Its four open items:

| Item | Fix | Proof |
|---|---|---|
| Same-label rows across sections | every table holds only its own section's cells, under that section's heading, headings in order | 2 tampers: a census row moved into the status table, two headings swapped |
| Drift columns | the header names each field once and reads it, and every row follows its order | 3 tampers: two columns swapped, a column relabeled, a column dropped |
| Impossible dates | times need a real calendar date and clock time; 2026-11-31 never rolls over | 32 tests; 7 mutants |
| One event, two copies, one out of range | the census and the recount group copies first; a group with copies in and out of range counts once as malformed, never as a release | fixture `census-mixed-range-copies`; 3 mutants |

## IMD audit a24f9aa1 (outside review by the IMD swarm)

An outside review of this PR at bce10dc by the IMD swarm, not by the Claude team. ultrapara's seat #1828 ordered it. Four specialist agents (economics #1879, flow #1188, permissions #32, math #777) each audited one area, and a judge (#531) reproduced, merged and ranked their findings. The receipt and scores are on Ethereum mainnet. Nothing in the code was changed.

Job: https://explorer.imd.fun/jobs/a24f9aa1-8a2e-49de-85c9-0c23ef14aed3 (15 findings: 5 medium, 8 low, 2 info).

The Claude team reran every finding against bce10dc. All 15 held: 13 reproduced by running, and 2 confirmed by reading. None was on the known and accepted list. None is a network, sign or spend path. All 15 are fixed in round 5 above.

| # | Severity | Finding | Our check |
|---|---|---|---|
| 1 | medium | escrow.ts takes an event index or block_number above 2^53 as evidence (Number.isInteger, not isSafeInteger). The census and recount call the same event malformed, while the escrow comes out funded or claimed. | reproduced: funded, with index 9007199254740993 rounded to ...992 |
| 2 | medium | escrow.ts pageProblem takes a page field above 2^53. The census refuses the page, but escrows still reach claimed. | reproduced: claimed, census exit 2 |
| 3 | medium | Fixture files are decoded as lossy UTF-8. A page with an invalid byte becomes a complete census and escrow evidence in TypeScript, while the recount refuses it. | reproduced: TS complete and claimed, Python exit 2 |
| 4 | medium | The snapshot command never passes the previous log entry to networkStatus, so the rollback, changed hash and stuck height checks never run from the command line. They were tested only with a hand-built previous. | reproduced: seq 1 rolled back 3341575 to 3340000 with rpc ok, stale false, no conflict |
| 5 | medium | The faucet /chain reading (half of reset_detected) is never checked for HTTP status, a response or its reading time. The shipped status-healthy /chain reading is 11 s after the snapshot time with no conflict. | reproduced: http 500, no response, old and future readings all leave reset_detected false and conflicts empty |
| 6 | low | event-pages as a regular file: the TS loader stops with a raw ENOTDIR, while the recount prints a partial census and exits 0. | reproduced |
| 7 | low | Two distinct finalized opens are a conflict only without a terminal event. With a release, the escrow is claimed and the opens are dropped without a note. | reproduced: claimed, no note (unverified without the release) |
| 8 | low | The harness checks the attempt log once, in afterAll, so a blocked call fired from a timer after that hook is never recorded or failed. | reproduced: exit 0, no attempts file |
| 9 | low | mutate.mjs copies every entry of the repo root, tracked or not. An unreadable file aborts the step (fails closed), and untracked files can change what kills a mutant. | confirmed by reading; we run as root, so EACCES does not reproduce here |
| 10 | low | Drift rounds YAML decimals to a double before the exact comparison, so a value 1 base unit off reports match. | reproduced: both items match |
| 11 | low | A finalized release above the RPC finalized height is ignored and the escrow shows funded, unlike the out-of-range rule, which makes it unverified. This matches the letter of RULES section 2. | reproduced: funded, note "1 event above the finalized height ignored" |
| 12 | low | consistency.mjs ignores HTML comments and hidden rows, so a page that hides reset_detected passes. | reproduced: comment, hidden and display:none all pass with 1107 checks |
| 13 | low | The source scan misses fetch.call, an aliased globalThis.fetch and new globalThis.WebSocket. | reproduced: 50 of 50 guard tests pass with all three in src |
| 14 | info | A negative block_number is malformed in the escrow but out of range in the census. Both are conservative. | reproduced |
| 15 | info | The outputs digest holds only on Node v22.23.4, because pin.node is process.version. | confirmed by reading; the digest above is for v22.23.4 only |

## What the first rerun (of c1cc476) found, and the fix for each

A separate agent reran c1cc476 from a fresh clone. Its outputs were byte-identical to the lead's run. It then found the gaps below; each is fixed here, and each fix has a test and a mutant that the test kills.

- **U1, mutation proof.**
  - The runner now copies the whole repo layout (observatory, interfaces, imd-flop and the rest).
  - It runs an unmutated control before and after the mutants; both must pass.
  - A kill counts only when at least one test fails, and each result names the test that failed (`caught_by`). A mutant that only breaks loading is a `load-error`, never a kill.
  - `mutants-canary` proves the runner classifies a real bug, an equivalent change, a syntax error and a missing test correctly.
  - The equivalent escrow mutant and its dead line are gone.
- **U2, outputs.**
  - `consistency.mjs` resolves every page cell in the snapshot and compares it. A cell it cannot resolve, or a required field missing from the page, fails.
  - Feed payloads must equal the snapshot exactly, MCP text must equal the feeds byte for byte, and the snapshot hash and log must verify.
  - It runs on five real scenarios: healthy, reset, nothing read, degraded faucet, and conflicting evidence.
  - `consistency-canary` flips reset on the page and in the feed (the rerun's two experiments). Both are caught, along with 12 other tampers.
- **U3, census outside the request.** A chain whose range does not intersect the request counts nothing.
- **U4, unreadable pages.** The census refuses, and every escrow is `unverified` with a note naming the file. This is checked end to end through the command line (`cli-checks`).
- **U5, one event claiming two escrows.**
  - Copies are grouped by (genesis, block_hash, index) first.
  - Copies that disagree on section, method, escrow id or block number leave every named escrow `unverified`.
- **U6, health.** `ok` only when every check ran and passed (RULES.md 1.1):
  - no head time: `unknown`
  - no best height, no genesis, a read error or a head time later than the snapshot: `degraded`
  - a 503 with an ok body: `degraded`
- **U7, network block.**
  - Tests block every node network and process path at runtime, named imports included: http, https, http2, net, tls, dgram, dns, child_process and worker threads. Each block is asserted at its own layer.
  - The source scan also catches those imports and signing, spending and key APIs, and it checks recount.py's imports.
  - The canary covers a fetch, an https request, a net connection, a child process, an RPC write, a signature and a spend, plus a passing control.
- **U8, census readings.**
  - Disagreeing copies of an unreachable page break the chain.
  - A negative `page` refuses; a negative `next_page` breaks the chain.
  - From the census builder's own probes: a missing `block_number` key is malformed, integers are judged by value (`1.0` is 1), and NaN or Infinity in a page file refuses.
  - The TypeScript census and the Python recount follow each rule.
- **U9, finality disagreement.** Any unfinalized copy makes the event pending, in escrow as in census.
- **U10, known-empty values.** An empty list shows `none` with `data-n="0"` and an empty string shows `(empty)`; only null is blank.
- **U11.**
  - The committed `.pyc` is removed and ignored.
  - Tests remove their temp directories.
  - The README no longer claims the recount canary covers "every one".
- **Also.**
  - A snapshot now refuses any part pinned to a different genesis, and every census fixture pins the devnet genesis, so each demo snapshot describes one chain. This was listed as unresolved before.
  - The pin takes its genesis from the RPC that gave the finalized head, never from the faucet.

## What the second rerun (of e09e393) found, and the fix for each

The second independent rerun reproduced e09e393 byte for byte and confirmed 10 of the 11 round one fixes, with U7 partly fixed. Trying to break it again found the items below. Each is fixed here, with a test, and a mutant that the test kills.

- **U-new-1, escrow (a real bug).**
  - Conflicting copies of one event used to switch off the rule for a terminal event whose escrow id does not parse, leaving an escrow "funded".
  - Every finalized terminal copy with an unparsable id now leaves every escrow it could contradict `unverified`, whatever the other copies say.
- **U-new-2, escrow rules with no test.** Two refunds, two releases, two opens, and a refund or release against a malformed opposite terminal now have tests. All five escrow probe mutants from the rerun are killed.
- **U-new-3, another chain's height.**
  - Escrows are bounded by a finalized height only from an RPC head on the pinned genesis.
  - Otherwise `finalized_height` is null, and a result with evidence says its evidence is not bounded by a finalized height.
- **U-new-4, escrow against census.**
  - An event outside its page's block range is not evidence, as in the census.
  - Genesis values and block hashes are compared exactly.
  - A block hash must be `0x` plus 64 lower case hex, in the escrow, the census and the recount alike (clause 7).
- **U-new-5, the page check.**
  - `consistency.mjs` now compares each marked element's whole visible text, nested tags included, as well as its `data-v`.
  - Every `td` and `span` outside a marked element must carry `data-k`.
  - The rerun's five page tampers, plus a value in a new span, are in the canary: 20 tampers, all caught.
- **U-new-6, the runtime block (the rest of U7).**
  - Tests now also block `dgram.Socket` send, bind and connect, `dns.Resolver` queries, `ChildProcess.prototype.spawn`, the native bindings behind `process.binding`, `process.dlopen` and `inspector.open`.
  - The source scan also fails `process.getBuiltinModule`, `createRequire`, a computed `import()` or `require()`, `eval` and `new Function`.
- **U-new-7, status.**
  - Faucet and gateway readings must be fresh: an old reading is `degraded`, one with no time is `unknown`, and one later than the snapshot time is a conflict.
  - Only HTTP 200 is ok.
  - The lag, stale and future boundaries are tested on both sides, and the five status probe mutants from the rerun are killed.
- **U-new-8, census and recount.**
  - Integers must be safe, up to 2^53 minus 1 (clause 14).
  - Every entry in `event-pages/` must be a page file, so a dotfile, another extension or a folder refuses the census and leaves escrows `unverified` (clause 15).
  - The below-range clause has a test.

## What the third rerun (of e1976b6) found, and the fix for each

The third independent rerun reproduced e1976b6 byte for byte and confirmed 7 of the 8 round two fixes. U-new-3 was partly fixed, because of an MCP residue. It found no partial count shown as complete. Each item below is fixed here, with a test and a mutant that the test kills.

- **1. Values tied to where a person reads them.**
  - Every labeled row binds its `th` to its `td` with `data-for`, and the label is derived from the key.
  - Each escrow card carries `data-escrow` and holds only its own cells.
  - Each drift row carries `data-row`.
  - `consistency.mjs` checks all three, so a page that shows one escrow's state on another's card, or swaps the reset and stale rows, now fails. The canary has three new placement tampers.
- **2. Time zones.** Times must carry a zone (`Z` or an offset). A reading time without one is `unknown` on every machine, and a snapshot time without one is refused. A test runs the same input under UTC, New York and Tokyo.
- **3. Out-of-range events.** Copies are grouped before the range check, so an out-of-range copy still counts for the copy agreement and unparsable id rules. An out-of-range finalized release or refund that names an escrow leaves it `unverified`.
- **4. MCP fallback.** An escrow id that is not in the snapshot is `unverified` with `finalized_height` null.
- **5. Symlinks.** A symlinked page file is not a page file, in the TypeScript census and the recount alike (clause 15), with a fixture.
- **6. Conflict note.** A reading time later than the snapshot time is a conflict whatever the reading's health.

