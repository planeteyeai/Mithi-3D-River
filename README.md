<p align="center">
  <img src="docs/images/river-eye-logo.webp" alt="RiverEye Mountain River" width="220" />
</p>

# Mithi River 3D Digital Twin

**Geographically accurate 3D twin of the Mithi River (Mumbai)** — live Sentinel-2 water extent, bathymetry depth shades, DTM terrain, OSM infrastructure, CSIA airport, chainage navigation, and hydrology analytics.

<p align="center">
  <img src="docs/images/mithi-river-hero.jpg" alt="Mithi River Digital Twin" width="100%" />
</p>

---

## What’s inside

| Layer | Source | Notes |
|-------|--------|--------|
| **Live water** | Sentinel-2 MNDWI GroundOverlay (`water_depth (1).kml`) | Observed footprint (~72.5 ha), not an invented corridor |
| **Bathymetry shades** | `mithi_river_depth.kml` relative depth 0.2–5.5 m | Always-on class colours on the live sheet |
| **Terrain** | FABDEM DTM | Natural banks; no sat drape by default |
| **Chainage** | `Mithi_Chainage_10m.kml` | Station navigation along the main stem |
| **Infrastructure** | OSM + curated bridges | Western Express, Sion–Bandra Link Road, BKC, railways |
| **Vegetation** | Vegetation health + densified mangrove points | Banks & parks; cleared only from real water pixels |
| **Hydrology / WQ** | JalNetra + RiverEye APIs | BOD/COD, salinity, flood, AQI |
| **History cache** | Express + Postgres | Local Docker DB on port **5433** |

### Depth colour scale (always-on live water)

| Class | Range | Colour |
|-------|-------|--------|
| Shallow | &lt; 1.5 m | `#8FEAF8` |
| Moderate | 1.5–3.0 m | `#55C4EE` |
| Medium-Deep | 3.0–4.5 m | `#3AA0D6` |
| Deep | &gt; 4.5 m | `#2B86C0` |

<p align="center">
  <img src="docs/images/mithi-mndwi-water.png" alt="MNDWI live water mask" width="48%" />
  <img src="docs/images/mithi-bathymetry-depth.png" alt="Relative depth overlay" width="48%" />
</p>
<p align="center"><em>Left: MNDWI live-water mask · Right: relative depth GroundOverlay</em></p>

---

## Architecture

```
Browser (Vite + Three.js SPA :5180)
   │
   ├─ /api/history  ──proxy──► History API (Express :5181)
   │                              │
   │                              └─► Postgres 16 (Docker :5433)
   │
   ├─ /jalnetra-api ──proxy──► JalNetra (Railway)
   └─ /rivereye-api ──proxy──► RiverEye (Railway)
```

- **Frontend:** Vite 5 + vanilla Three.js (no React)
- **Backend:** `server/` Express history API (`mithi-history-api`)
- **Database:** Postgres 16 via Docker Compose (`mithi_river` / user `mithi`)

---

## Quick start (local)

### Prerequisites

- Node.js 20+
- Docker Desktop (for Postgres)

### 1. Install

```bash
npm install
npm run history:install
```

### 2. Environment

```bash
cp .env.example .env
cp server/.env.example server/.env
```

Local defaults (already correct for Docker Compose):

```env
DATABASE_URL=postgresql://mithi:mithi@127.0.0.1:5433/mithi_river
MITHI_PROJECT_ID=mithi
HISTORY_API_PORT=5181
VITE_HISTORY_API_BASE=/api/history
```

> Never put database passwords in `VITE_*` variables. `.env` files are gitignored.

### 3. Start database + API

**Option A — Postgres only, API on host**

```bash
npm run db:up
npm run dev:server
```

**Option B — full stack in Docker**

```bash
npm run stack:up
```

Health check:

```bash
npm run history:health
# → {"ok":true,"service":"mithi-history","db":true,...}
```

### 4. Start the 3D twin

```bash
npm run dev
```

Open **http://127.0.0.1:5180**

---

## Useful scripts

| Script | Purpose |
|--------|---------|
| `npm run db:up` | Start Postgres container |
| `npm run stack:up` | Postgres + history API containers |
| `npm run dev` | Vite SPA on :5180 |
| `npm run dev:server` | History API on :5181 |
| `npm run history:health` | Hit `/api/health` |
| `npm run db:tables` | Inspect `component_history` |
| `npm run build` | Production SPA build → `dist/` |

---

## API (history backend)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | DB + pool status |
| `GET` | `/api/history/:component` | Cached component rows |
| `GET` | `/api/history/:component/latest` | Latest payload |
| `POST` | `/api/history/:component` | Upsert JalNetra snapshot |

Schema: `server/schema.sql` → table `component_history` (auto-applied on boot).

---

## Data highlights (Mithi)

- **River:** Mithi River, Mumbai (Powai → Mahim Creek)
- **CRS:** WGS84 ↔ UTM 43N → local Three.js frame
- **Live water KML:** `src/data/water_depth (1).kml` (MNDWI, freq 0.5, window 2026-10-13 → 2026-11-12)
- **Depth KML:** `src/data/mithi_river_depth.kml` (relative band-ratio 0.2–5.5 m)
- **Static packs:** `public/data/mithi/**` (KML, GeoJSON, overlays, aeroway, trees)

---

## Backend mode (local first)

**Right now we use the local backend only** (no hosted history API URL yet).

```bash
npm run db:up          # Postgres :5433
npm run dev:server     # Express  :5181
npm run history:health # {"ok":true,"db":true}
npm run dev            # SPA      :5180  (proxies /api/history → :5181)
```

Env: copy `.env.example` → `.env` and `server/.env.example` → `server/.env`.  
Defaults already point at `postgresql://mithi:mithi@127.0.0.1:5433/mithi_river`.

### When you get a hosted API later

1. Set `DATABASE_URL` on the host (Render/Neon) and deploy `server/` (`render.yaml`).
2. Set `HISTORY_API_PUBLIC_URL=https://YOUR-SERVICE…` in the deploy env.
3. Add these rewrites to `vercel.json` (above the SPA catch-all) and redeploy:

```json
{ "source": "/api/health", "destination": "https://YOUR-SERVICE/api/health" },
{ "source": "/api/history/:path*", "destination": "https://YOUR-SERVICE/api/history/:path*" }
```

Until then: **Vercel = frontend only**; history/cache needs local `db:up` + `dev:server`.

## Production notes

Recommended split (after a hosted URL exists):

1. **Frontend** → Vercel (Vite SPA + `vercel.json` proxies)
2. **History API** → Render Web Service (`server/`)
3. **Database** → Render Postgres / Neon (`DATABASE_URL`)

See `render.yaml` for a Render blueprint.

---

## Security

- `.env` / `server/.env` are **not** committed
- Only templates: `.env.example`, `server/.env.example`
- No JWT secrets or DB passwords in `VITE_*` vars

---

## License / attribution

- © PlanetEye AI — Mithi 3D River / RiverEye
- Map data © OpenStreetMap contributors
- Satellite products: Sentinel-2 MNDWI / relative depth (JalNetra)

---

<p align="center">
  <img src="docs/images/mithi-live-water-mask.png" alt="Live water mask" width="70%" />
</p>
<p align="center"><em>Observed Mithi live-water footprint used by the 3D twin</em></p>
