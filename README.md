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
```

## Production

1. Create a Supabase project and apply `supabase/migrations/0001_cambrio.sql`.
2. Enable anonymous sign-ins, Google OAuth, email magic links, and manual identity linking. Configure Cloudflare Turnstile in Supabase Auth before setting `VITE_TURNSTILE_SITE_KEY`.
3. Configure the variables from `.env.example` in Railway.
4. Deploy the repository as one Node service with `npm run build` and `npm start`; set `/api/health` as the health check.

The authoritative rules are in [`docs/GAME_SPEC.md`](docs/GAME_SPEC.md).
