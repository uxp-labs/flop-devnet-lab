# Piece F progress (claude/encoder-test-final-record)

Done:
- D2 refactor: test/helpers/block-fill.ts holds what both fills need (pinBlock, extrinsicFill, readThroughDoor, errorRows); rerun-fill.ts uses it. Rerun results.json refills byte for byte (sha256 47292f1e...). Mutants that moved follow their code.

Done also: A1 fixture (commit 2), A2 and B1 to B6 (test/encoder-recording.test.ts, test/helpers/recorded-encoder.ts); the fifth list tests read the fixture copies.
Next: the encoder fill, C tests, words.

Decisions:
- The shared module imports only src/scale/block.ts (BlockEvent type derived from BlockEvents).
