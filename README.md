# 🎬 Ringer Film Draft

A season-long fantasy film league for cinephiles. Players act as studio executives with a fixed $1,000 budget, bidding in live real-time auctions to acquire upcoming films. Points accumulate over the calendar year as movies release, get scored by critics, and are recognized at the Oscars. Highest score at the end of award season wins.

Inspired by The Ringer's film coverage.

---

## Project Structure

```
ringer-draft/
├── backend/          # Node.js + Express + Socket.io server
│   ├── server.js
│   ├── src/
│   │   ├── api/          # REST routes + auth middleware
│   │   ├── clients/      # TMDB, OMDb, Oscar dataset wrappers
│   │   ├── db/           # SQLite schema + league queries
│   │   ├── draft/        # Real-time WebSocket draft room
│   │   ├── scrapers/     # Festival + critics poll scrapers
│   │   └── sync/         # Scoring engine + data sync CLI
│   ├── test/
│   └── package.json
│
├── frontend/         # React + Vite single-page app
│   ├── src/
│   │   ├── App.jsx        # All screens (auth, draft room, dashboard, roster)
│   │   ├── lib/api.js     # REST API client
│   │   └── hooks/         # useDraftSocket, useLeague
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
├── .gitignore
└── README.md
```

---

## Features

- **Live auction draft** — real-time bidding via WebSocket with 30-second countdown timer
- **Season-long scoring** — box office, Metacritic, Oscar nominations/wins, festival awards, CinemaScore, critics polls
- **Budget enforcement** — dynamic max-bid calculation prevents overspending while guaranteeing minimum roster fill
- **Shareable rosters** — public roster page for each player
- **Commissioner tools** — pool management, CinemaScore entry, session control
- **Auto data sync** — TMDB for film pool, OMDb for box office/scores, Oscar JSON dataset, Wikipedia scrapers for festivals

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Socket.io client |
| Backend | Node.js, Express, Socket.io |
| Database | SQLite via sql.js (WASM — no native bindings) |
| Auth | Token-based (invite link + bearer token, no passwords) |
| Hosting | Vercel (frontend) + Railway (backend) |

---

## Scoring System

| Category | Threshold | Points |
|---|---|---|
| Box Office (domestic) | $25M – $99M | 3 |
| | $100M – $249M | 7 |
| | $250M – $499M | 12 |
| | $500M+ | 20 |
| Profitability (gross/budget) | >1× | 3 |
| | 2× | 6 |
| | 3×+ | 10 |
| Metacritic | 40 – 59 | 1 |
| | 60 – 79 | 3 |
| | 80+ | 6 |
| Oscar nominations | per nomination | 2 |
| Oscar wins | per win | 5 |
| Best Picture win | bonus | +10 |
| CinemaScore | A– or A | 3 |
| | A+ | 6 |
| Festival (Cannes/Venice/Berlin top prize) | | 4 |
| Other major festival prizes | | 2 |
| AFI Top 10 / NYFCC Best / NBR Best Film | | 3 |
| Other NYFCC / NBR awards | | 2 |

---

## Local Development

### Prerequisites

- Node.js v18+ ([nodejs.org](https://nodejs.org))
- Git ([git-scm.com](https://git-scm.com))
- A free TMDB API key ([themoviedb.org/settings/api](https://www.themoviedb.org/settings/api))
- A free OMDb API key ([omdbapi.com](https://www.omdbapi.com))

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env and add your TMDB_API_KEY and OMDB_API_KEY

npm install

# Populate the movie pool (run once, or re-run to refresh)
node src/sync/index.js tmdb 2026
node src/sync/index.js omdb 2026
node src/sync/index.js oscars 2026
node src/sync/index.js scrapers 2026

# Start the server
node server.js
# Server running at http://localhost:3001
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
# .env.local already points to localhost:3001 by default

npm install
npm run dev
# App running at http://localhost:5173
```

### Run Tests

```bash
cd backend
npm test
# 69 tests across scoring engine and draft room logic
```

---

## Deployment

### Backend → Railway

1. Create a new project at [railway.app](https://railway.app)
2. Deploy from GitHub → set root directory to `backend/`
3. Add environment variables:
   - `TMDB_API_KEY`
   - `OMDB_API_KEY`
   - `PORT=3001`
   - `NODE_ENV=production`
4. Generate a domain under Settings → Networking
5. Run the sync commands once via Railway's Run Command panel

### Frontend → Vercel

1. Import the repo at [vercel.com](https://vercel.com)
2. Set root directory to `frontend/`
3. Framework preset: **Vite**
4. Add environment variables:
   - `VITE_API_URL=https://your-backend.up.railway.app`
   - `VITE_WS_URL=https://your-backend.up.railway.app`
5. Deploy

### After deploying both — update CORS

In `backend/server.js`, update the CORS origin to include your Vercel URL:

```js
app.use(cors({
  origin: ['https://your-app.vercel.app', 'http://localhost:5173']
}));

const io = new Server(server, {
  cors: { origin: ['https://your-app.vercel.app', 'http://localhost:5173'] }
});
```

Then `git push` — Railway redeploys automatically.

---

## Data Sync CLI

Run from the `backend/` directory:

```bash
node src/sync/index.js tmdb 2026      # populate/refresh movie pool from TMDB
node src/sync/index.js omdb 2026      # update box office + Metacritic from OMDb
node src/sync/index.js oscars 2026    # load Oscar nominations/wins
node src/sync/index.js scrapers 2026  # scrape Cannes, Venice, Berlin, AFI, NYFCC, NBR
node src/sync/index.js all 2026       # run all of the above
```

Re-run these throughout the season as new data becomes available. Scoring is idempotent — re-running won't create duplicate scoring events.

---

## API Reference

### Auth

All authenticated endpoints require:
```
Authorization: Bearer <token>
```

Tokens are issued on league creation and join. No passwords — invite-link based.

### Key Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/leagues` | None | Create league |
| POST | `/api/leagues/join/:code` | None | Join via invite code |
| GET | `/api/leagues/:id` | Player | Full league state |
| GET | `/api/leagues/:id/standings` | None | Public standings |
| GET | `/api/leagues/:id/pool` | Player | Movie pool |
| POST | `/api/leagues/:id/nominate` | Player | Nominate for auction |
| GET | `/api/leagues/:id/feed` | Player | Scoring feed |
| GET | `/api/leagues/:id/roster/:playerId` | None | Public roster |
| POST | `/api/leagues/:id/cinema-score` | Commissioner | Enter CinemaScore |
| POST | `/api/draft/sessions` | Commissioner | Create draft session |

### WebSocket Events

**Client → Server:**
- `draft:join { token }` — authenticate
- `draft:start { sessionId }` — commissioner starts draft
- `draft:nominate { movieId }` — put a film on the block
- `draft:bid { amount }` — place a bid
- `draft:pass` — commissioner skips current film

**Server → Client:**
- `draft:state` — full authoritative draft state
- `draft:timer { secondsLeft }` — countdown tick
- `draft:sold { movie, winner, amount }` — film assigned
- `draft:complete { standings }` — draft over
- `queue:updated { queue }` — nomination queue changed

---

## Rules

- **Budget:** $1,000 per player (commissioner-configurable)
- **Roster:** minimum 6 films required (configurable)
- **Max bid:** `remaining_budget − ($1 × unfilled required slots)`
- **Date-shifted films:** auto-moved to waiver wire; original owner loses the film
- **Streaming-only releases:** scored on viewership, not box office
- **Profitability:** calculated against reported production budget only (not P&A)
- **Tiebreaker:** fewer dollars spent wins; commissioner decides if still tied

---

## External Data Sources

| Source | Used For | Key Required |
|---|---|---|
| [TMDB](https://www.themoviedb.org) | Movie pool, posters, cast/crew, release dates | Yes — free |
| [OMDb](https://www.omdbapi.com) | Domestic box office, Metacritic score, IMDb rating | Yes — free (1,000 req/day) |
| [json-nominations](https://github.com/delventhalz/json-nominations) | Oscar nominations + wins | No |
| Wikipedia | Cannes, Venice, Berlin award winners | No |
| AFI / NYFCC / NBR | Critics polls | No (scraped) |
| CinemaScore | CinemaScore grades | No — commissioner entry |

---

## License

Private project. All rights reserved.
