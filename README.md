# SHEN RAIN RADAR

Mobile-first rain app for Thailand. It answers one question first — is it raining
where I am, and what happens in the next two hours — and shows the map second.

## Where the numbers come from

| Part of the screen | Source | Kind |
| --- | --- | --- |
| Headline reading | Nearest telemetry rain gauge via the National Hydroinformatics Data Center (HII) | measured |
| Past 6 hours | Hourly rainfall from that same station | measured |
| Next 2 hours, radar | Radar echo carried along its own measured motion | extrapolated |
| Next 2 hours | Median of ECMWF IFS, NOAA GFS and DWD ICON at 15-minute steps, via Open-Meteo | modelled |
| Map, animated | RainViewer observed radar, last 2 hours | radar |
| Map, still | Thai Meteorological Department radar composite | radar |

Everything is expressed as a rain rate in millimetres per hour so the measured
past and the modelled outlook share one axis. Forecast bars are hatched so a
modelled value never reads as a measurement, and the two short-range answers say
on their face which horizon they came from.

## The nowcast

RainViewer withdrew its public future-radar product at the start of 2026, so the
two hours are worked out from the observed frames instead. `src/nowcast.js` paints
the recent frames over a 3x3 tile block around the point, searches for the single
translation that best explains how the echo moved, and carries the current frame
along that vector: what is over you in twenty minutes is whatever is twenty
minutes upwind of you now.

A two-hour horizon multiplies the ten-minute displacement by twelve, and any
error in it by the same amount — one coarse cell of search error becomes about
55 km at the far end. So the vector is averaged over three consecutive pairs of
frames rather than taken from the newest pair alone, and how far those pairs
disagree is reported as the confidence beside the strip.

This is Lagrangian persistence: it assumes rain drifts without growing or
decaying. Past the first hour that assumption is doing most of the work, so the
strip draws those blocks hollow instead of filled. The same vector gives the
storm direction and speed shown beside it.

The strip stops early if the drift would carry the answer off the painted block,
which is what the horizon note means when it appears — better than reporting
tiles that were never fetched as clear sky.

Intensity is read off the tile palette's colour families — blue light, yellow
moderate, red heavy — because the free tile service ignores the colour-scheme
segment of the tile path and serves one fixed palette. No attempt is made to turn
a colour back into millimetres, which the palette cannot support.

## Notes on the sources

**HII / thaiwater** publishes about 4,400 stations in one 4 MB document with no
way to filter it server-side. `functions/api/stations.js` reads it at the edge,
caches it there, and returns only the nearest few stations with only the fields
the app plots — a few hundred bytes per visitor instead of 640 KB. The client
falls back to reading the upstream directly when that function is not present,
which is what happens under `vite dev`.

**RainViewer** public tiles stop at zoom 7 — past that the service answers 200
with a "Zoom Level Not Supported" image rather than an error, so the layer caps
`maxNativeZoom` and upscales instead of requesting tiles that do not exist.

**TMD** publishes a full matplotlib figure, not a bare raster. The app measures
the plot frame inside it, clips the title, axis labels and colorbar away, and
composites the rest with multiply so the white page drops out. The figure has
linear latitude axes while Leaflet draws in Web Mercator, so the plot is split
into six latitude bands to keep the echo within about a kilometre of where it
belongs.

Beyond the first hour the outlook is a short-range model consensus, not radar.
Model disagreement is shown as spread rather than hidden.

## Run

```bash
npm install
npm run dev
```

`vite dev` does not run Pages Functions, so the station lookup falls back to
reading thaiwater directly. To exercise the function locally:

```bash
npm run build
npx wrangler pages dev dist
```

## Build

```bash
npm run build
npm run preview
```

## Deploy

Cloudflare Pages, framework preset Vite, build command `npm run build`, build
output directory `dist`. `functions/` is picked up automatically.

## Next

1. Blend the radar extrapolation into the model consensus rather than presenting
   the two side by side, weighted by how far out the answer is.
2. Estimate motion per region instead of one vector for the whole block, so a
   line of storms and the air behind it are not averaged together. This matters
   most at the far end of the two hours.
3. Calibrate the outlook against the station readings it can already see.
4. Rain alerts. This needs a service worker and push, which the app does not
   have yet.

## Sources

- Thaiwater / HII public API: https://api-v3.thaiwater.net
- RainViewer public weather maps API
- Thai Meteorological Department: https://weather.tmd.go.th and https://satda.tmd.go.th
- Open-Meteo: https://open-meteo.com
- OpenStreetMap basemap
