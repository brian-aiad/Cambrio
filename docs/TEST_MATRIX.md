# Cambrio v1 test matrix

This matrix records the release checks for the server-authoritative rules and the eight-player interface. Every rules test runs without a browser; clients cannot bypass these transitions.

## Master Pass II requirements coverage

| Requirement | Implementation location | Automated evidence | Browser, mobile, reduced-motion, and failure evidence |
| --- | --- | --- | --- |
| Authoritative rules and hidden information | `src/shared/game.ts`, `src/server/rooms.ts`, personalized `projectGame` views | Engine, edge, room, protocol, and 350-game projection checks; 1,000 competing stack races | Two live clients inspect every opponent card DOM node for opaque IDs and face-free labels/classes; the production bundle is checked separately for fixture/secret markers. |
| Stack, power, transfer, Cambrio, and ending concurrency | Shared engine plus contextual targeting in `src/client/App.tsx` | Stale-version, discard-generation, six-card, mandatory-transfer, 203 ending-rotation, idempotency, and timeout cases | Deterministic power/transfer/ending states at all core viewports; power-time stacking and table-wide Cambrio are asserted; latency tests lock conflicting intents from one browser without changing server concurrency. |
| Disconnect, pause, reconnect, and private reveal revocation | `src/server/rooms.ts`, `src/client/App.tsx` | Pause clock, reconnect identity, host transfer/forfeit, checkpoint, and temporary-reveal tests | Socket reconnect smokes plus deterministic ordinary/Black-King reveal revocation; no stale face or power stage remains after resume. |
| Hosted HTTP/SSE ordering | `api/realtime.ts`, `api/signal.ts`, `src/client/transport.ts` | Room-scoped monotonic revisions, stale poll rejection, superseded-membership rejection, SSE frame parsing | Hosted eight-client HTTP/Redis smoke, authenticated SSE smoke, and recorded two-browser production sync audit; polling remains the correctness path. |
| Socket.IO parity and load | `src/server/index.ts`, `src/client/transport.ts` | Shared RoomManager/game tests cover both transports | Real two-browser full round, real eight-player room, 96 simultaneous sockets in twelve full rooms, reload/reconnect and action-spam smokes. |
| Profile/account deployment parity | `src/server/profile-api.ts`, `api/me*`, `api/profiles/[handle].ts`, Express routes | Validation, same-origin writes, safe errors, private/public caching, public-field filtering, handle collision, and deployment-CSP tests | Account UI keeps guest play available on provider/storage failure; public profile exposes no user ID or anonymous marker. |
| Responsive 2–8 player table and stable perspectives | `src/client/styles.css`, `src/client/VisualAudit.tsx` | Browser geometry assertions cover every player count and edge/middle/wraparound viewers | Core state gallery at 320×568 through 1440×900; intermediate portrait/landscape/tablet/desktop matrix; long names, six-card hands, focused dense targeting, forfeited and zero-card seats. |
| Accessibility and private labels | Semantic controls/live regions in `src/client/App.tsx`; focus/forced-color rules in CSS | Twelve axe WCAG A/AA surfaces, keyboard power activation, focus restoration, hidden-label checks | Forced colors, reduced motion across draw/penalty/transfer/power/ending/results, pointer cancellation, paused timer without per-second announcements. |
| Motion, layout stability, and performance | Semantic game-version animation triggers and transform-only flight layer | Frame-budget, no-empty-landing, exact penalty slot, resize-during-flight cleanup, transient-layer cleanup | Actor/observer choreography, short-landscape collision checks, and visual screenshot review; heartbeat-only revisions do not rerender visual state. |
| Entry, invite, storage, and recoverable errors | Entry intent queue, bounded error copy, safe local/session storage, inline invite fallback | Transport and profile failure tests | Keyboard-like viewport contraction, typed invite-name guard, blocked-storage guest room, 320×568 clipboard fallback with zero page overflow and visible CTA. |

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
- Authenticated Upstash publish/subscribe delivery wakes a seated browser on the committed room revision without exposing room state; foreign origins and stolen memberships cannot open the stream. Polling remains the tested fallback.
- Monotonic client revision checks reject a late older poll after a newer action response, while revision-only heartbeats do not force duplicate visual renders.
- Global game-version checks reject delayed turn/power decisions; discard-generation checks keep legitimate stack races concurrent.

## Eight-player layout audit

Seven opponent grids and the local grid were checked at these viewport sizes:

| Viewport | Result |
| --- | --- |
| 390×844, 393×852, 412×915, 430×932 | Dense tables use a stable 4+3 opponent grid for larger cards; a six-card local hand keeps TL/TR/BL/BR and stable +1/+2 positions; no overlap. |
| 340×640, 360×640, 360×800, 375×667, 375×812 | All opponents remain visible, with no horizontal overflow or card reordering across breakpoint edges. |
| 320×568 | Compact decision and stack states preserve a simultaneous 4+3 overview of all seven opponents plus the full local hand. Opponent powers keep that overview fixed, then promote one chosen opponent's stable slots to 47px direct targets; four- and six-card hands remain fully reachable without a nested horizontal rail. Partially filled lobbies and clipboard failure also remain fully contained. |
| 568×320, 667×375, 720×400, 740×360, 812×375, 844×390, 852×393, 915×412, 932×430 landscape | All seven opponents stay in fixed positions; the local hand docks left of the piles; discard, deck, drawn decision, power prompts, and Cambrio remain separate; there is no page scroll or board overlap. |
| 768×1024, 820×1180, 1024×768, 1180×820 tablet | Portrait and landscape tablets preserve table scale, target reachability, and local-seat priority without stretching the phone layout. |
| 1280×720, 1366×768, 1440×900, 1920×1080 desktop | All seven opponent grids remain visible in one row with a cohesive centered table and full local hand. |

The production landing page scores 100 for Accessibility, Best Practices, and SEO in the throttled Lighthouse mobile profile, with zero cumulative layout shift. Performance is 84 with 10 ms total blocking time; the remaining score cost is initial JavaScript transfer for realtime, auth, and motion support.

The first-class Playwright harness checks the initial BL/BR hold-to-peek, every power phase, local and opponent draw decisions, stack decisions, transfer and ending states, tied/eight-player results, zero/six-card hands, every player count from 2–8, all edge/middle local-seat perspectives, six full-scene viewport classes, twenty-three additional phone/tablet/desktop dimensions, and a gallery of all 52 card faces. Focused browser assertions additionally verify the compact first-screen entry action, automatic and pointer-cancel peek concealment, a simultaneous seven-opponent compact overview, stable choose-player targeting with 47–50px focused card targets, unclipped six-card opponent targets, player-anchored hidden draw staging, unobstructed piles and local hands, named spectator discard/replacement paths, visibly dealt penalty cards, responsive long-distance eight-player exchanges, transform-only card travel, cleanup of transient animation layers, a stable deck hit target, no empty draw-panel landing frame, serialized latency feedback, a mobile frame budget, full-flow reduced motion, coordinated active-player/deck/timer cues, and keyboard focus restoration for both the rules guide and compact player panel. Eleven representative app/game scenes plus the open how-to-play guide must pass automated WCAG A/AA analysis with no violations.

The hosted synchronization audit records two simultaneous 390×844 browser videos and screenshot-enabled Playwright traces, samples paired frames across the first draw/discard choreography, and measures six alternating turns. The observer must see the hidden card staged at the acting player's physical seat before that exact card travels to discard or a replacement slot; actor and observer frames must converge on the same public result without a stale-state reversal.

The full-lobby browser audit creates eight isolated identities at both 320×568 and 390×844. It verifies two stable seat columns, all eight visible tiles, no horizontal overflow, an in-viewport deal control, and coalescing of three immediate deal taps into one initial-peek round. Power audits verify numbered source/destination markers, visual completed/current steps, two concealed Black King endpoints, all seven opponent focus controls, and every stable slot in the selected opponent's four- or six-card hand.

Live-browser acceptance flows exercise the actual Socket.IO application rather than deterministic fixtures. They create eight isolated seated identities plus a ninth queued identity with maximum-pressure names, verify the full-table and active-round queue states, complete private BL/BR peeks, drive real turns, verify spatial card flights, disconnect/reconnect seats, and check 320×568 plus 844×390 overflow. A separate two-player round covers inline clipboard failure, hidden-card DOM opacity, Cambrio, results, rematch promotion, and recovery copy. Additional live flows cover pointer cancellation against the authoritative reveal acknowledgement, blocked browser storage, and observer draw/discard/replacement choreography.

Current release inventory: `npm test` contains 92 passing tests across nine files, including the long deterministic simulations above. `npm run test:browser` contains 57 Chromium tests across four files. Exact command outcomes are recorded in the release report for each candidate rather than inferred from this document.

The production-preview performance audit uses a four-times CPU slowdown and mobile-3G network profile. Its current cold-load result is 1.46 s first contentful paint, 1.39 s load, four requests, and 185 KiB transferred. A warmed draw transition samples at 11.8 ms p95 frame interval; input becomes responsive in 31 ms. The audit keeps card motion on transform/opacity paths and includes reduced-motion coverage.

## Release commands

```bash
npm run check
npm run test:browser
npm run check:release
npm run smoke:runtime
npm run smoke:reconnect
npm run smoke:signal
npm run smoke:http
npm run audit:hosted-sync
npm run stress:socket
npm run stress:actions
```

For the 400-client pass in PowerShell:

```powershell
$env:CAMBRIO_LOAD_ROOMS='50'
npm run stress:socket
Remove-Item Env:CAMBRIO_LOAD_ROOMS
```
