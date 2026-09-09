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

Before any of that is shown it has to clear a quality gate, and a refusal is a
first-class result: `nowcast()` returns `{ ok: false, reason }` rather than
nothing, and the strip prints the reason. A silent absence read as "no rain
coming" when it actually meant "cannot tell", which is the wrong way round for
the one thing this app exists to answer. The gate refuses when there is too
little echo to match, when the pairs disagree on speed, when the search is
pinned against its speed cap, and when the pairs disagree on *bearing* —
scatter alone misses that last one, because two equal vectors ninety degrees
apart average to a perfectly plausible drift that neither frame observed.

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

Every outside call has a timeout and one retry, and the retry only fires for the
transport failing or the server admitting it broke — a 4xx is an answer and will
not change on a second ask. A source that goes down leaves its last values on
screen with a note saying so, rather than blanking the card.

## Freshness

Nothing on screen is undated. The gauge reading carries its own age, the radar
frame carries its own age, and both say when they have gone past the point where
they should still be read as current — twenty minutes for radar, an hour for a
gauge that reports hourly.

Each source refreshes on its own clock, because they publish on different ones:
radar every 5 minutes, gauges and models every 12. The timer checks what is
actually due rather than reloading everything, which is also what happens on
returning to the tab — a tab left open for an hour catches up on both, and a tab
switched away for thirty seconds does nothing.

## The headline's source

The gauge wins the headline while it is within 15 km, because it is a
measurement. Past that the radar pixel overhead takes over and the gauge drops
to a supporting line: convective rain here is routinely narrower than the
distance to the nearest telemetry station, and a reading from 40 km away
presented as the headline reads as "the rain here" when it is not. Whichever
source is carrying the answer is named directly under it.

## Install

`public/sw.js` caches the app shell so the app opens instantly and still opens
with no signal. It does not cache data: every number on screen comes from a live
source, and a cached rain reading is worse than no reading. The shell is fetched
network-first — cache-first saves a few milliseconds and pins an installed app
to whichever build was current when the service worker installed, which is how a
PWA ends up serving a version nobody can update out of.

The header carries its own **ติดตั้งแอป** button rather than leaving the user to
find the browser's — a menu item on Android, a small address-bar glyph on
desktop. Chrome only hands over the `beforeinstallprompt` event that button
needs once it has accepted the manifest and the service worker, so the button
appearing *is* the installability check: if it is missing, the browser would not
have offered to install the app either. Safari never fires the event, so iOS
gets the Share → เพิ่มไปยังหน้าจอโฮม instruction instead of a button that could
not do anything.

Manifest icons are PNG at 192 and 512, plus maskable variants for the Android
launcher crop, with the SVGs kept last for displays that can use them. Chrome
will not install an app whose only icons are SVG, and iOS ignores the manifest
entirely: `apple-touch-icon` has to be a raster or the home screen shows a
screenshot of the page. `public/icon-apple.svg` is the source those PNGs are
rendered from — full-bleed, because iOS rounds the corners itself.

Installing needs a secure context. `localhost` counts; the LAN address that
`vite dev --host` prints does not, so a phone pointed at `http://192.168.x.x`
will never offer to install however correct the manifest is. Test installs
against `npm run preview` on the machine itself, or against the deployed
Pages URL.

## Test

```bash
npm test
```

Pure logic only, no browser: timezone handling, data ages, model consensus
alignment, the rain-class boundaries, the motion search and its confidence
grading, the quality gate's refusals, which source the headline picks, and the
edge function's validation and upstream failure modes.

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
4. Pick a location by searching for a place, and keep a few saved ones — home,
   the shop, a delivery route. Tapping the map is the only way in at the moment.

Deliberately not here: rain alerts. They need a push subscription, a stored
location and a server-side sender, which is a lot of standing machinery for a
notification that this app's own confidence gate would suppress most of the
time. Opening the app answers the question.

## Sources

- Thaiwater / HII public API: https://api-v3.thaiwater.net
- RainViewer public weather maps API
- Thai Meteorological Department: https://weather.tmd.go.th and https://satda.tmd.go.th
- Open-Meteo: https://open-meteo.com
- OpenStreetMap basemap
