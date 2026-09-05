# Holo Hele

Holo Hele is a mobile-first Oʻahu transit app built with React, TanStack Router,
TanStack Query, Vite, Bun, and Tauri 2.

## Prerequisites

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/) and the
  [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for desktop builds
- On Windows, Visual Studio Build Tools with the Desktop development with C++
  workload and Windows SDK

## Local setup

1. Run `bun install`.
2. Run `bun x playwright install chromium` if you will run browser tests.
3. Copy `.env.example` to `.env.local`.
4. Add `THEBUS_API_KEY` for live arrivals, or leave the placeholder/variable
   unset to use the official GTFS stop locations and scheduled services.
5. Run `bun run dev` for the browser app and Bun API.
6. Open `http://localhost:1420`.

Use `bun run tauri:dev` to launch the desktop app. The Tauri command starts the
same Vite and Bun development services automatically.

## Commands

- `bun run dev` — browser app and API in watch mode
- `bun run build` — type-check and build the browser app
- `bun run api` — Bun API only
- `bun run lint` — ESLint
- `bun run test:smoke` — mobile route and keyboard smoke test
- `bun run typecheck` — TypeScript
- `bun run tauri:dev` — Tauri development app
- `bun run tauri:build` — production desktop bundle

## Production deployment

### Render: one free service

The included `render.yaml` runs the website and transit API together at one HTTPS
URL. It explicitly selects **Free** compute. No database, paid service, custom
domain, or API key is required to try scheduled transit data.

1. Push this deployment branch to your GitHub repository.
2. In Render, choose **New > Blueprint**, connect Holo-Hele, and select
   `codex/render-free-deployment` as the branch containing `render.yaml`.
3. Confirm that `holo-hele-demo` uses the **Free** plan, then deploy.
4. Open the service's `https://…onrender.com` URL. This is the prototype link
   for the Framer case study. Verify it in a signed-out browser and on a phone.
5. Optional: add `THEBUS_API_KEY` in the service's **Environment** settings to
   enable live arrivals. Keep the key out of GitHub and frontend variables.

The Blueprint pins Bun 1.3.14, builds with `bun run build`, and serves `dist/`
using the existing API server with Bun's lower-memory `--smol` option. The GTFS
loader processes records incrementally and shares repeated schedule times to
reduce startup memory without removing stops, trips, or schedules.
It uses Render's `PORT` and permits same-site
requests from `RENDER_EXTERNAL_URL`. Leave `VITE_API_BASE_URL` empty. Nested
browser routes work when opened directly or refreshed; `/api/*` remains API-only.
Automatic deployment is off; use **Manual Deploy** for subsequent updates.

Free services sleep after 15 minutes without traffic and can take about a minute
to wake. The app must also load its GTFS transit dataset after restarting.
Free-tier memory, bandwidth, and build limits still apply; verify the initial
transit-data load before sharing the demo. Do not upgrade to paid compute without
the project owner's approval.

To test the production setup locally in PowerShell:

```powershell
bun install --frozen-lockfile
bun run build
$env:STATIC_SITE_DIR = 'dist'
$env:API_PORT = '3001'
bun --smol server/index.ts
```

Open `http://localhost:3001`. `/health` checks server availability; `/api/stops`
also checks that the external transit feed can load. Live arrivals require a
valid key and upstream availability.

### Separate website and API hosts

The TheBus key must remain on the Bun server. Deploy `server/index.ts` as a
Bun service, set `THEBUS_API_KEY` and `API_ALLOWED_ORIGINS` there, and build the
web and Tauri clients with `VITE_API_BASE_URL` set to that HTTPS service.

The static web build is emitted to `dist/`. Configure the web host to fall back
to `index.html` for client-side routes such as `/stops/:id`.
