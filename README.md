# Cambrio

Cambrio is a polished, server-authoritative online memory card game for 2–8 friends. Create a private room, share its link, and play immediately as a guest or with a persistent account.

## Local development

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
copy .env.example .env
npm run dev
```

The web client runs at `http://localhost:5173`; the realtime server runs at `http://localhost:3001`. If Supabase variables are blank, Cambrio uses development-only in-memory identity, profiles, stats, and room checkpoints.

## Validation

```bash
npm run check
npm run smoke:runtime
npm run smoke:reconnect
npm run smoke:signal
npm run smoke:http
npm run audit:hosted-sync
npm run audit:eight -- ROOMCODE
npm run stress:socket
npm run stress:actions
```

`npm run check` runs linting, strict TypeScript checks, 92 deterministic rules, transport, profile/deployment, and server tests, the one-player lobby gate, 350 randomized full games across every supported 2–8 player room size, an exhaustive 203-case caller/active-seat ending matrix, 1,000 competing stack races, 750 wrong-then-correct stack gambles, and a production build. `npm run test:browser` runs 55 real-Chromium lifecycle, entry-form, rules-guide, viewport, local-seat-perspective, target-density, turn-affordance, spectator-choreography, pointer-cancellation, storage-failure, latency, motion-budget, reduced-motion, forced-colors, and WCAG A/AA checks. `npm run check:release` runs both suites plus runtime, reconnect, authenticated SSE, hosted HTTP, action-race, and 96-client Socket.IO smokes. The Socket.IO load smoke opens 12 simultaneous eight-player rooms by default; set `CAMBRIO_LOAD_ROOMS=50` for the 400-client release stress pass. `npm run audit:eight -- ROOMCODE` attaches seven real helper clients to an existing host room for hands-on eight-seat inspection. `npm run audit:hosted-sync` records two 390×844 browsers, Playwright traces, sampled frames, and six turns of actor/observer timing under `output/hosted-sync/`.

## Free production hosting

The production site is deployed from `main` to `https://cambrio.vercel.app`. Vercel serves the React client plus health, realtime, signal, current-profile, profile-update, and public-profile functions. A free Upstash Redis database stores authoritative room checkpoints, serializes simultaneous moves, publishes private-state-free revision signals, and provides optional profile persistence.

1. Import this GitHub repository into a free Vercel project.
2. Add `VITE_HTTP_TRANSPORT=true`, `KV_REST_API_URL`, and `KV_REST_API_TOKEN` to the Production environment. Keep the deployment on free plans with automatic paid upgrades disabled.
3. Add the optional Supabase URL and keys only when accounts, persistent profiles, and match history are required. Guest rooms work without account setup.
4. Push to `main`; Vercel builds and promotes the new deployment automatically.

The hosted transport keeps viewer-specific projections authoritative through polling, then uses an authenticated Upstash SSE subscription to wake other seats immediately after a committed revision. Signals contain no cards or private game state, and polling remains the correctness fallback. Every room view carries a monotonic revision, so a slow older poll can never overwrite a newer action response and make the board jump backward. Periodic presence heartbeats pause an active round when a browser disappears and restore the same seat and remaining clock when it returns. Returning to a visible tab or regaining network access triggers an immediate resync. If someone cannot return, the host can forfeit that disconnected hand without abandoning the table; host departure transfers that control safely. Temporary card faces are revoked on disconnect and never restored from stale browser state.

Expired invite links preserve and display the requested room code, explain what happened, and offer either a direct route home or a one-tap fresh table. Local development continues to use Socket.IO for faster feedback unless `VITE_HTTP_TRANSPORT=true` is set.

Hosted realtime requests reject cross-site browser origins, malformed payloads, and bodies larger than 32 KiB. Production responses also set a restrictive Content Security Policy and anti-framing, MIME-sniffing, referrer, and browser-permission headers.

Optional account/profile endpoints are available in both full Express hosting and the Vercel `api/` deployment. Account-provider or browser-storage failure falls back to guest play; it never blocks room entry. The production CSP permits only the official Cloudflare challenge script/frame origin required by optional Turnstile verification, while the development-only visual-audit route is not published by Vercel.

Do not commit the database password, service-role key, Supabase access token, or Turnstile secret. Only the Supabase project URL, publishable/anon key, and Turnstile site key belong in `VITE_*` variables.

The authoritative rules are in [`docs/GAME_SPEC.md`](docs/GAME_SPEC.md). The interaction and visual language are in [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md). Automated and live release coverage is documented in [`docs/TEST_MATRIX.md`](docs/TEST_MATRIX.md).
