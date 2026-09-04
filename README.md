# SHEN RAIN RADAR

Mobile-first rain app for Thailand. It answers one question first — is it raining
where I am, and what happens in the next two hours — and shows the map second.

## Where the numbers come from

| Part of the screen | Source | Kind |
| --- | --- | --- |
| Headline reading | Nearest telemetry rain gauge via the National Hydroinformatics Data Center (HII) | measured |
| Past 6 hours | Hourly rainfall from that same station | measured |
| Next 2 hours | Median of ECMWF IFS, NOAA GFS and DWD ICON at 15-minute steps, via Open-Meteo | modelled |
| Map, animated | RainViewer observed radar, last 2 hours | radar |
| Map, still | Thai Meteorological Department radar composite | radar |

Everything is expressed as a rain rate in millimetres per hour so the measured
past and the modelled outlook share one axis. Forecast bars are hatched so a
modelled value never reads as a measurement.

## Notes on the sources

**HII / thaiwater** publishes about 4,400 stations in one document. It is fetched
once per session and trimmed to what the app plots. `rain_24h_graph` then gives
the hourly series for the single nearest station.

**RainViewer** public tiles stop at zoom 7 — past that the service answers 200
with a "Zoom Level Not Supported" image rather than an error, so the layer caps
`maxNativeZoom` and upscales instead of requesting tiles that do not exist.

**TMD** publishes a full matplotlib figure, not a bare raster. The app measures
the plot frame inside it, clips the title, axis labels and colorbar away, and
composites the rest with multiply so the white page drops out. The figure has
linear latitude axes while Leaflet draws in Web Mercator, so the plot is split
into six latitude bands to keep the echo within about a kilometre of where it
belongs.

The two-hour outlook is a short-range model consensus, not a radar nowcast.
Model disagreement is shown as spread rather than hidden.

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

## Deploy

Cloudflare Pages, framework preset Vite, build command `npm run build`, build
output directory `dist`.

## Next

1. Trim the station list server-side so the first load does not carry the whole
   country.
2. Radar motion extrapolation for 0–120 minutes, blended with the model
   consensus.
3. Calibrate the outlook against the station readings it can already see.

## Sources

- Thaiwater / HII public API: https://api-v3.thaiwater.net
- RainViewer public weather maps API
- Thai Meteorological Department: https://weather.tmd.go.th and https://satda.tmd.go.th
- Open-Meteo: https://open-meteo.com
- OpenStreetMap basemap
