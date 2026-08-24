# Cambrio v1 test matrix

This matrix records the release checks for the server-authoritative rules and the eight-player interface. Every rules test runs without a browser; clients cannot bypass these transitions.

## Rules and hidden information

| Area | Covered scenarios |
| --- | --- |
| Deck and scoring | Unique 52-card deck, no Jokers, all rank values, red/black King differences, deck recycle, true exhaustion. |
| Initial knowledge | Stable TL/TR/BL/BR slots, only BL/BR revealed during the hold, reveal removed on release, no other client receives ranks. |
| Turn safety | Out-of-turn draw, discard before draw, swapping a foreign card, zero-card auto-discard, duplicate action replay, every timeout stage. |
| Powers | 7/8 own peek; 9/10 opponent peek; J/Q blind swap; both black Kings reveal/keep/swap; both red Kings have no power; decline, timeout, concurrent target movement, and every power with zero cards. |
| Stacking | Rank match across suits, wrong guess plus unseen penalty, retry after a miss, strict six-card ceiling, blocked risk-free guesses at the ceiling, 1,000 first-winner races, stale-generation rejection, one success only, direct own/opponent targeting, stable vacant slots, mandatory gift, gift timeout, zero-card restriction, and per-player guess throttling. |
| Ending | Cambio during another turn, zero during own/another turn, later trigger rejection, complete final rotation, zero-card final turns, ties, forfeit, and reveal/scoring. |
| Multiplayer | 2–8 active players, ninth player waiting, reconnect without duplication, host preserved during reconnect grace, host transfer after grace/leave, waiting-player promotion, checkpoint restoration, stale checkpoint rejection. |
| Projection security | Every personalized view is checked after every transition in 350 seeded full games. Only a viewer's temporary reveals and private drawn/power/transfer state are present; results and the public discard are the only forced reveals. |

## Stress passes

- 350 deterministic full rounds distributed across all supported room sizes (2–8).
- 1,000 competing stack races with exactly one authoritative winner.
- 750 wrong-then-correct stack gambles, checking that remembered positions never move.
- 25 simultaneous duplicate draws coalesced to one mutation with consistent acknowledgements; 25 unique discard taps accepted exactly once; 20 duplicate Cambrio calls started one ending sequence.
- 96 live Socket.IO clients in 12 simultaneous full rooms for the normal smoke.
- 400 live Socket.IO clients in 50 simultaneous full rooms for the release load pass.

## Eight-player layout audit

Seven opponent grids and the local grid were checked at these viewport sizes:

| Viewport | Result |
| --- | --- |
| 414×896, 390×844 | All opponents visible; a six-card local hand keeps TL/TR/BL/BR and extends +1/+2 as a right column; no scroll or overlap. |
| 375×812, 360×800 | All opponents visible, no horizontal overflow or overlap. |
| 320×568 | All opponents visible; intentional vertical page scroll preserves cards instead of overlapping or reflowing them. |
| 667×375, 844×390, 932×430 landscape | All seven opponents stay in fixed positions; the local hand docks left of the piles, with no page scroll or board overlap. |
| 1440×900 desktop | All seven opponent grids visible in one row with the full table and local hand. |

The active eight-player game passes Lighthouse snapshot audits at 100 for Accessibility, Best Practices, SEO, and Agentic Browsing, with zero failed checks.

## Release commands

```bash
npm run check
npm run smoke:runtime
npm run stress:socket
npm run stress:actions
```

For the 400-client pass in PowerShell:

```powershell
$env:CAMBRIO_LOAD_ROOMS='50'
npm run stress:socket
Remove-Item Env:CAMBRIO_LOAD_ROOMS
```
