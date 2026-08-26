# Cambrio v1 test matrix

This matrix records the release checks for the server-authoritative rules and the eight-player interface. Every rules test runs without a browser; clients cannot bypass these transitions.

## Rules and hidden information

| Area | Covered scenarios |
| --- | --- |
| Deck and scoring | Unique 52-card deck, no Jokers, all rank values, red/black King differences, deck recycle, true exhaustion. |
| Initial knowledge | Stable TL/TR/BL/BR slots, only BL/BR revealed during the hold, reveal removed on release, no other client receives ranks. |
| Turn safety | Out-of-turn draw, discard before draw, swapping a foreign card, zero-card auto-discard, duplicate action replay, every timeout stage. |
| Powers | 7/8 own peek; 9/10 opponent peek; J/Q blind swap; both black Kings reveal/conceal/keep/swap; both red Kings have no power; decline, timeout, concurrent target movement, and every power with zero cards. Black King values are removed from the client projection before Swap/Keep appears. |
| Stacking | Rank match across suits, wrong guess plus unseen penalty, retry after a miss, strict six-card ceiling, valid stacks at the ceiling, one-discard lock after a ceiling miss, 1,000 first-winner races, stale-generation rejection, one success only, direct own/opponent targeting, stable vacant slots, mandatory gift, gift timeout, zero-card restriction, and per-player guess throttling. |
| Ending | Cambio during another turn, zero during own/another turn, later trigger rejection, all 203 active-seat/caller combinations for 2–8 players, complete final rotation, zero-card final turns, ties with shared placement, forfeit, and reveal/scoring. |
| Multiplayer | One-player start rejection; 2–8 active players; ninth player waiting; immediate FIFO promotion when a lobby seat opens; rematch promotion; explicit queue departure without ghost seats; reconnect without duplication; whole-round disconnect pause; frozen/restored phase clocks, including partial multi-disconnect forfeits and newly advanced turns; hosted heartbeat expiry; host preserved during reconnect grace; host transfer after grace/leave; checkpoint restoration; stale action/checkpoint rejection. |
| Projection security | Every personalized view is checked after every transition in 350 seeded full games. Drawn faces exist only in the active player's projection; only a viewer's temporary reveals and private power/transfer state are present; results and the public discard are the only forced reveals. Every live card uses a random, game-specific opaque ID that cannot encode its rank or suit. |

## Stress passes

- 350 deterministic full rounds distributed across all supported room sizes (2–8).
- 203 caller-centered ending sequences covering every active seat and caller pairing for 2–8 players.
- 1,000 competing stack races with exactly one authoritative winner.
- 750 wrong-then-correct stack gambles, checking that remembered positions never move.
- 25 simultaneous duplicate draws coalesced to one mutation with consistent acknowledgements; 25 unique discard taps accepted exactly once; 20 duplicate Cambrio calls started one ending sequence.
- 96 live Socket.IO clients in 12 simultaneous full rooms for the normal smoke.
- 400 live Socket.IO clients in 50 simultaneous full rooms for the release load pass.
- Live transport interruption freezes all actions and the exact remaining timer; recovery restores the same player ID, one seat, normalized name, and saved clock.
- Hard reload during initial peek revokes every temporary face; hard reload after drawing restores the exact pending card and accepts no duplicate draw.
- Three live browsers verify simultaneous disconnects, partial recovery, host removal of the remaining offline seat, voluntary host departure, control transfer, and a correctly scored forfeit result.
- Hosted request boundaries reject foreign browser origins, malformed JSON, and payloads larger than 32 KiB.
- Global game-version checks reject delayed turn/power decisions; discard-generation checks keep legitimate stack races concurrent.

## Eight-player layout audit

Seven opponent grids and the local grid were checked at these viewport sizes:

| Viewport | Result |
| --- | --- |
| 414×896, 390×844 | Dense tables use a stable 4+3 opponent grid for larger cards; a six-card local hand keeps TL/TR/BL/BR and stable +1/+2 positions; no overlap. |
| 375×812, 360×800 | All opponents visible, no horizontal overflow or card reordering. |
| 320×568 | Compact decision, stack, and power states preserve all controls without overlap. Seven opponents use a readable horizontal rail that auto-centers a distant active seat; four- and six-card hands remain fully visible in stable positions. |
| 667×375, 844×390, 932×430 landscape | All seven opponents stay in fixed positions; the local hand docks left of the piles; discard, deck, drawn decision, and Cambrio remain separate; there is no page scroll or board overlap. |
| 1440×900 desktop | All seven opponent grids visible in one row with the full table and local hand. |

The production landing page scores 100 for Accessibility, Best Practices, and SEO in the throttled Lighthouse mobile profile, with zero cumulative layout shift. Performance is 84 with 10 ms total blocking time; the remaining score cost is initial JavaScript transfer for realtime, auth, and motion support.

The first-class Playwright harness checks 100 table-state/device combinations: the initial BL/BR hold-to-peek, every power phase, local and opponent draw decisions, stack decisions, transfer and ending states, tied/eight-player results, zero/six-card hands, every player count from 2–8, four viewport classes, and a gallery of all 52 card faces. Focused browser assertions additionally verify the compact first-screen entry action, automatic peek concealment, readable auto-following opponent rails that never scroll the document, unclipped six-card opponent targets, player-anchored hidden draw staging, unobstructed piles and local hands, named spectator discard/replacement paths, visibly dealt penalty cards, responsive long-distance eight-player exchanges, transform-only card travel, cleanup of transient animation layers, a mobile frame budget, immediate reduced-motion decisions, coordinated active-player/deck/timer cues, and keyboard focus restoration for the rules guide. The six representative game screens plus the open how-to-play guide must pass automated WCAG A/AA analysis with no violations.

The full-lobby browser audit creates eight isolated identities at both 320×568 and 390×844. It verifies two stable seat columns, all eight visible tiles, no horizontal overflow, an in-viewport deal control, and coalescing of three immediate deal taps into one initial-peek round. Power audits verify numbered source/destination markers, visual completed/current steps, two concealed Black King endpoints, and all 28 legal opponent-card targets in an eight-player blind swap without repeated dense-rail badges.

Two live-browser acceptance flows exercise the actual Socket.IO application rather than deterministic fixtures. One creates eight isolated seated identities plus a ninth queued identity, verifies the full-table and active-round queue states, leaves that queue cleanly, completes the private BL/BR peeks, drives all eight real turns, verifies every client receives each spatial card flight, disconnects a seated browser, asserts the whole table and timer freeze, rejoins the exact seat, and checks 320×568 plus 844×390 overflow. The other opens the rules guide in both lobby and active-table phases, adds a third player during a two-player round, completes a Cambrio ending, verifies both result projections reveal and score the same round without stale notices, promotes the waiting player into the rematch lobby, returns a host-removed player home with a clear explanation, and verifies a voluntary seated-player leave.

The production-preview performance audit uses a four-times CPU slowdown and mobile-3G network profile. Its current cold-load result is 1.46 s first contentful paint, 1.39 s load, four requests, and 185 KiB transferred. A warmed draw transition samples at 11.8 ms p95 frame interval; input becomes responsive in 31 ms. The audit keeps card motion on transform/opacity paths and includes reduced-motion coverage.

## Release commands

```bash
npm run check
npm run test:browser
npm run check:release
npm run smoke:runtime
npm run smoke:reconnect
npm run smoke:http
npm run stress:socket
npm run stress:actions
```

For the 400-client pass in PowerShell:

```powershell
$env:CAMBRIO_LOAD_ROOMS='50'
npm run stress:socket
Remove-Item Env:CAMBRIO_LOAD_ROOMS
```
