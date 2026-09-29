# Holo Hele

A mobile-first transit app prototype for Oʻahu, designed to help riders understand nearby bus stops, routes, and arrival information at a glance.

**Status:** Work in progress. This repository contains a design and development prototype, not an official TheBus service.

## Experience

- Onboarding screens for language and location preferences.
- A map and nearby-stop interface.
- Stop details with route and arrival information.
- A bus-tracking screen.
- Favorites and help routes; favorites are currently a placeholder.

The design focuses on clear information, easy scanning, and comfortable use on a phone. Design references are available in [design-reference](design-reference/), with interface guidance in [DESIGN.md](DESIGN.md).

## Transit data

The nearby-stop and arrival API routes use mock data when `THEBUS_API_KEY` is not configured. Their responses identify the data source as `mock` or `live`.

A configured server-side key enables requests to TheBus. Live behavior depends on the external API and available data. Mock arrivals are for reviewing the interface and should not be used to plan a trip.

## Run locally

Install Node.js and npm compatible with the Next.js version in [package.json](package.json), then run:

```sh
git clone https://github.com/unsatisfied3/holo-hele.git
cd holo-hele
npm ci
npm run dev
```

Open the local URL printed by the development server, normally `http://localhost:3000`.

To enable TheBus integration, create an untracked `.env.local` file in the project root:

```dotenv
THEBUS_API_KEY=your_thebus_api_key
```

Restart the development server after changing environment variables. Keep this key on the server; do not add it to client code or commit it.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run lint` | Run ESLint |
| `npm run build` | Create a production build |
| `npm start` | Serve the production build |

## Built with

Next.js, React, TypeScript, Tailwind CSS, Material UI, Leaflet, and React Leaflet.

## Project structure

| Folder | Contents |
| --- | --- |
| `app/` | Pages and server API routes |
| `components/` | Interface and map components |
| `lib/thebus/` | TheBus configuration, client, and stop data |
| `lib/mock/` | Prototype data |
| `types/` | Shared transit types |
| `design-reference/` | Design reference images |

See [AGENTS.md](AGENTS.md) for development instructions.

## Designer

[Aveline Wang](https://www.avelinewang.com/)
