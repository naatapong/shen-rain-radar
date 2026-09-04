# SHEN RAIN RADAR

Mobile-first rain radar web app for Thailand.

## Current architecture

- RainViewer: observed radar history / animation.
- TMD: Thailand radar composite image overlay.
- Open-Meteo: ECMWF + NOAA GFS + DWD ICON model comparison.
- Consensus: median precipitation + model spread.
- Location: browser geolocation.
- No ads.

## Important data semantics

RainViewer public weather maps are used for historical radar frames. The app does **not**
pretend that RainViewer public data is a future radar nowcast.

The 0–2 hour panel is currently a short-range model consensus, not a radar-derived
nowcast. A later version can add radar-motion extrapolation from sequential TMD/RainViewer
frames.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Next planned upgrade

1. TMD station-level radar sequence ingestion where a stable public endpoint is available.
2. Radar motion estimation / extrapolation for 0–120 minutes.
3. Blend radar extrapolation with NWP consensus.
4. Calibration against recent observed radar/QPE.
5. Cloudflare deployment after the source is stable.

## Sources

- RainViewer public weather maps API
- Thai Meteorological Department radar / SATDA public products
- Open-Meteo forecast APIs
- OpenStreetMap basemap
