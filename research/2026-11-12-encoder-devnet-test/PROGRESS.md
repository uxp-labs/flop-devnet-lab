# Progress of the builder (read first if you take over)

Branch `claude/encoder-devnet-test-prep`, from main `6d7ad0e`. Brief:
`/mnt/user-data/outputs/briefs/2026-11-12-d1-encoder-devnet-test-prep.md`.

Order of work: (1) steps.json, plan.md, plan.test.mjs; (2) sign-device.mjs and tests; (3)
pane-runner.js and tests; (4) results.template.json, check.mjs and tests; (5) README, cost
table, stop rule.

## Done

- (1) steps.json, lib.mjs, plan.mjs, plan.md (made from /tmp scratch template; regenerate the
  tables with `node plan.mjs table|costs|stops|commands` and paste), plan.test.mjs: 17 tests pass.

- (4) DONE results.template.json (node plan.mjs template), judge.mjs, check.mjs, check.test.mjs
  (18 tests). judge.mjs wraps the rerun's judgeStep; adds recorded steps, balances, session, stop.

## Next

- (5) README.md; final run of node --test (58 tests now) under setpriv; GitHub checks; report.

- (3) DONE pane-runner.js and pane-runner.test.mjs (12 tests). Interface: createRunner({transport, eventsKey, deadlineMs, store}); heads, read,
  deviceReads(device, sessionNonceKey), send(bundleText, sha256). wsTransport(url) for the browser.

- (2) DONE sign-device.mjs and sign-device.test.mjs (12 tests). It took: step id, --key, --results (channel id of T3/T5 events), --reads JSON
  {runtime{specName,specVersion,transactionVersion,genesisHash}, birth{number,hash}, account_nonce,
  session_nonce | session_nonce_raw}. Writes signed/<id>.json, prints sha256 of it.

## For a successor

- `imd-flop/dist/chain/` is built by `npm run build` in `imd-flop/` (it is ignored by git).
- Facts found: System.Account is not in the observatory decoder's reviewed shape; open_channel
  emits ChannelOpened and its channel is Open at once; no lower bound on max_duration is stated.
