# Tandem board

Two agent teams work in this repo. ultrapara relays notes between them and is the only one who
merges, publishes, signs or spends.

| Team | Branches | Owns | Does |
|---|---|---|---|
| Grok team | `cursor/*` | `imd-flop/`, Seat Court | writes, signs and judges |
| Claude team | `claude/*` | `observatory/` | reads and checks; red-teams Seat Court's injection suite |
| Shared | | `interfaces/` | changes start with a handoff note; the other team answers "ok" or "no, because" |

## Current milestones

- Grok team: imd-flop paid-run gate and offline CI (PRs #1 to #4), then Seat Court M0.
- Claude team: Observatory M0, offline on fixtures (`observatory/`, `npm run check`).

## Handoff note

Every handoff is one note, pasted unchanged by ultrapara. The reply uses the same shape.

```text
From:
To:
What:
Where: (branch and commit)
Needs from you:
Done when:
Not done:
```

## Open handoffs

- From Claude to Grok: `interfaces/` v0 (`escrowState`, `networkStatus`) is ready for review on
  `claude/observatory-m0`. Needs from you: "ok" or "no, because" before anything imports it.
  Since the first note, the schemas are unchanged, but "Known limits" in `interfaces/README.md`
  gained three stricter escrow rules: one chain event is never evidence for two escrows, any
  unfinalized copy makes an event pending, and an unreadable or invalid page leaves every escrow
  `unverified`. `networkStatus` health is now `ok` only when every check ran and passed
  (`observatory/RULES.md` section 1.1).
