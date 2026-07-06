# 🦈 Live Shark Tracker

A live map of satellite-tagged sharks with an info card for every animal —
last ping, 30-day and all-time distance traveled, size, and its full ping
trail on the map. Runs entirely on free infrastructure: GitHub Actions keeps
the data fresh and GitHub Pages serves the site at a public URL.

## Where the data comes from

[OCEARCH](https://www.ocearch.org/tracker/) is the only organization that
publishes live, free shark tracking data. Their tracker is powered by
[Mapotic](https://www.mapotic.com/), whose
[public API](https://mapotic.github.io/mapotic.com-api-docs/) requires no key
for reading map data:

| Endpoint | Gives you |
|---|---|
| `GET {base}/api/v1/maps/{mapId}/pois.geojson/` | every tagged animal + last position |
| `GET {base}/api/v1/maps/{mapId}/public-pois/{id}/` | detail: species, length, weight, sex |
| `GET {base}/api/v1/maps/{mapId}/pois/{id}/motion/` | ping history (the trail) |

`scripts/fetch-sharks.mjs` discovers the OCEARCH map id at runtime, pulls all
three, computes distance traveled (haversine over the ping trail), and writes
a compact `data/sharks.json`. Sharks only "ping" when their dorsal-fin tag
breaks the surface — often hours or days apart — so a 30-minute refresh is
effectively real time for this data.

## How it stays live

```
GitHub Action (every 30 min)
  └─ node scripts/fetch-sharks.mjs   → commits data/sharks.json if changed
  └─ deploys the static site to GitHub Pages
Browser
  └─ re-reads the snapshot every 5 min
  └─ if the Mapotic API allows CORS, also pulls live positions directly every 2 min
```

## One-time setup (public URL)

1. Merge this branch into `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Run the **Update shark data & deploy** workflow once from the Actions tab
   (it then runs automatically every 30 minutes).

The site goes live at **https://ricknogerscreative.github.io/Shark-Tracking/**.

Until the first workflow run, the site shows clearly-labeled sample data.

## Local development

```bash
node scripts/fetch-sharks.mjs   # optional: pull real data (needs internet)
python3 -m http.server 8000     # then open http://localhost:8000
```

No build step, no dependencies — plain HTML/CSS/JS with a vendored
[Leaflet](https://leafletjs.com/) 1.9.4.

## Credits & fair use

Tracking data © [OCEARCH](https://www.ocearch.org/) via the Mapotic public
API. This project is educational/non-commercial, is not affiliated with
OCEARCH, and keeps request volume low (one polite crawl every 30 minutes).
If you build on this, please keep the attribution — and consider
[supporting OCEARCH](https://www.ocearch.org/donate/). Basemap tiles ©
OpenStreetMap contributors, © CARTO.
