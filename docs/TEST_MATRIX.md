# Cambrio v1 test matrix

This matrix records the release checks for the server-authoritative rules and the eight-player interface. Every rules test runs without a browser; clients cannot bypass these transitions.

## Rules and hidden information

| Area | Covered scenarios |
| --- | --- |
| Deck and scoring | Unique 52-card deck, no Jokers, all rank values, red/black King differences, deck recycle, true exhaustion. |
| Initial knowledge | Stable TL/TR/BL/BR slots, only BL/BR revealed during the hold, reveal removed on release, no other client receives ranks. |
| Turn safety | Out-of-turn draw, discard before draw, swapping a foreign card, zero-card auto-discard, duplicate action replay, every timeout stage. |
| Powers | 7/8 own peek; 9/10 opponent peek; J/Q blind swap; both black Kings reveal/conceal/keep/swap; both red Kings have no power; decline, timeout, concurrent target movement, and every power with zero cards. Black King values are removed from the client projection before Swap/Keep appears. |
| Stacking | Rank match across suits, wrong guess plus unseen penalty, retry after a miss, strict six-card ceiling, blocked risk-free guesses at the ceiling, 1,000 first-winner races, stale-generation rejection, one success only, direct own/opponent targeting, stable vacant slots, mandatory gift, gift timeout, zero-card restriction, and per-player guess throttling. |
| Ending | Cambio during another turn, zero during own/another turn, later trigger rejection, complete final rotation, zero-card final turns, ties, forfeit, and reveal/scoring. |
| Multiplayer | 2–8 active players, ninth player waiting, immediate FIFO promotion when a lobby seat opens, rematch promotion, explicit queue departure without ghost seats, reconnect without duplication, host preserved during reconnect grace, host transfer after grace/leave, checkpoint restoration, stale action/checkpoint rejection. |
| Projection security | Every personalized view is checked after every transition in 350 seeded full games. Only a viewer's temporary reveals and private drawn/power/transfer state are present; results and the public discard are the only forced reveals. |

## Stress passes

- 350 deterministic full rounds distributed across all supported room sizes (2–8).
- 1,000 competing stack races with exactly one authoritative winner.
- 750 wrong-then-correct stack gambles, checking that remembered positions never move.
- 25 simultaneous duplicate draws coalesced to one mutation with consistent acknowledgements; 25 unique discard taps accepted exactly once; 20 duplicate Cambrio calls started one ending sequence.
- 96 live Socket.IO clients in 12 simultaneous full rooms for the normal smoke.
- 400 live Socket.IO clients in 50 simultaneous full rooms for the release load pass.
- Live transport interruption and recovery with the same player ID, exactly one restored seat, and preserved normalized name.
- Global game-version checks reject delayed turn/power decisions; discard-generation checks keep legitimate stack races concurrent.

## Eight-player layout audit

Seven opponent grids and the local grid were checked at these viewport sizes:

| Viewport | Result |
| --- | --- |
| 414×896, 390×844 | All opponents visible in one seat-ordered rail; a six-card local hand keeps TL/TR/BL/BR and stable +1/+2 positions; no overlap. |
| 375×812, 360×800 | All opponents visible, no horizontal overflow or card reordering. |
| 320×568 | Compact decision, stack, and power states preserve all controls without overlapping the discard, deck, or local cards. |
| 667×375, 844×390, 932×430 landscape | All seven opponents stay in fixed positions; the local hand docks left of the piles, with no page scroll or board overlap. |
| 1440×900 desktop | All seven opponent grids visible in one row with the full table and local hand. |

The production landing page scores 100 for Accessibility, Best Practices, and SEO in the throttled Lighthouse mobile profile, with zero cumulative layout shift. Performance is 84 with 10 ms total blocking time; the remaining score cost is initial JavaScript transfer for realtime, auth, and motion support.

The deterministic Playwright harness captures 50 state/device combinations: the initial BL/BR hold-to-peek, every power phase, draw and stack decisions, transfer and ending states, two- and eight-player results, zero/six-card hands, all player counts from 2–8, four viewport classes, and a gallery of all 52 card faces. Focused browser assertions additionally verify all 52 vector suit faces and mini result cards, corner/center suit geometry, automatic peek concealment, exact-slot two-card Jack/Queen and Black King flights, responsive long-distance eight-player exchanges, face-up hand-to-discard motion, correct/wrong stack feedback, stable penalty placement, and mutually exclusive decision surfaces.

Two live-browser acceptance flows exercise the actual Socket.IO application rather than deterministic fixtures. One creates eight isolated seated identities plus a ninth queued identity, verifies the full-table and active-round queue states, leaves that queue cleanly, completes the private BL/BR peeks, drives six real turns, verifies every client receives each spatial card flight, forces one browser offline and back to **Live**, reloads that seated player, and checks 320×568 plus 844×390 overflow. The other adds a third player during a two-player round, completes a Cambrio ending, verifies both result projections reveal and score the same round without stale notices, promotes the waiting player into the rematch lobby, returns a host-removed player home with a clear explanation, and verifies a voluntary seated-player leave.

## Release commands

```bash
npm run check
npm run smoke:runtime
npm run smoke:reconnect
npm run stress:socket
npm run stress:actions
```

For the 400-client pass in PowerShell:

```powershell
$env:CAMBRIO_LOAD_ROOMS='50'
npm run stress:socket
Remove-Item Env:CAMBRIO_LOAD_ROOMS
```
