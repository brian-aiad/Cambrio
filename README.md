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
npm run stress:socket
```

`npm run check` runs linting, strict TypeScript checks, the deterministic rules suite, 350 randomized full games across every supported room size, and a production build. The Socket.IO load smoke opens 12 simultaneous eight-player rooms by default; set `CAMBRIO_LOAD_ROOMS=50` for the 400-client release stress pass.

## Production

1. Connect the GitHub repository in Supabase with working directory `.` and enable **Deploy to production**. The migration under `supabase/migrations/` is then applied from `main`.
2. Enable anonymous sign-ins, Google OAuth, email magic links, and manual identity linking. Configure Cloudflare Turnstile in Supabase Auth before setting `VITE_TURNSTILE_SITE_KEY`.
3. Configure the variables from `.env.example` in one Railway Node service. Leave `VITE_SERVER_URL` unset when the client and server use the same public domain.
4. Build with `npm run build`, start with `npm start`, and configure `/api/health` as the Railway deployment health check. Keep one service replica for v1; multiple replicas require a Socket.IO Redis adapter.

Do not commit the database password, service-role key, Supabase access token, or Turnstile secret. Only the Supabase project URL, publishable/anon key, and Turnstile site key belong in `VITE_*` variables.

The authoritative rules are in [`docs/GAME_SPEC.md`](docs/GAME_SPEC.md).
