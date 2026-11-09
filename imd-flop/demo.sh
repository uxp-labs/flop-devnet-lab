#!/usr/bin/env bash
# End-to-end demo against the MOCK provider: no key leaves the box, no network, no spend.
# init -> link (FLOP side + throwaway demo wallet) -> cap -> run (mock) -> status -> receipt.
set -euo pipefail
cd "$(dirname "$0")"
[ -f dist/bin.js ] || npm run -s build
export IMD_FLOP_HOME="$(mktemp -d -t imd-flop-demo-XXXXXX)"
trap 'rm -rf "$IMD_FLOP_HOME"' EXIT
f() { node dist/bin.js "$@"; }
step() { printf '\n== %s\n' "$*"; }

SEAT=1234
step "init (one Ed25519 key for seat $SEAT; the key file is 0600 and never printed)"
f init --network devnet --seat "$SEAT"
ls -l "$IMD_FLOP_HOME/seats/$SEAT/flop.key" | awk '{print "  key file mode:", $1}'

step "init again for the same seat (refused: one DID per seat)"
f init --seat "$SEAT" || echo "  exit $? (expected 5)"

step "link (FLOP side signed; EIP-712 typed data emitted for the seat wallet)"
f link --token "$SEAT" --agent 77 >/dev/null
echo "  link written: seats/$SEAT/link.json"
read -r ADDR SIG < <(node scripts/demo-wallet-sign.mjs "$IMD_FLOP_HOME/seats/$SEAT/link.json")
echo "  throwaway DEMO wallet $ADDR signed the typed data (stands in for the seat holder's wallet)"
f link verify "$IMD_FLOP_HOME/seats/$SEAT/link.json" --wallet-sig "$SIG" --wallet "$ADDR" --save

step "run before a cap is set (refused: no cap means FLOP is off)"
f run --job demo-job-1 --prompt "Be brief. Say hi." --max-tokens 8 || echo "  exit $? (expected 3)"

step "cap set 0.5 FLOP/day, 0.25 per call"
f cap set 0.5 --per-call 0.25

step "faucet (refused by team rule) and its dry run"
f faucet || echo "  exit $? (expected 9)"
f faucet --dry-run

step "enroll (dry run: prints the two gateway calls it would make)"
f enroll | head -3

step "run job demo-job-1 on the mock provider"
f run --job demo-job-1 --prompt "Be brief. Say hi." --max-tokens 8
step "run job demo-job-2 with a simulated timeout (spend recorded as unknown, not retried; counts the padded quote against the cap)"
f run --job demo-job-2 --prompt "hi" --max-tokens 4 --mock-scenario timeout --timeout-ms 200 || echo "  exit $? (expected 6)"
step "run job demo-job-3 (expected: refused, over the remaining daily cap)"
f run --job demo-job-3 --prompt "Extract the date: 9 Nov." --max-tokens 8 || echo "  exit $? (expected 3)"

step "status"
f status

RID=$(ls "$IMD_FLOP_HOME/receipts" | head -1 | sed 's/\.json$//')
step "receipt $RID"
f receipt "$RID"

step "secret scan of the demo data dir (key file excluded: it is the one place the key lives)"
if grep -rIlE '(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)|Bearer |flop_ek_|seed_b64' "$IMD_FLOP_HOME" --exclude=flop.key \
   | xargs -r grep -LE '"(genesisHash|prompt_sha256|output_sha256|statement_sha256)"' | grep . ; then
  echo "  SECRET-SHAPED DATA FOUND"; exit 1
else
  echo "  clean"
fi
echo; echo "demo done; temp IMD_FLOP_HOME removed."
