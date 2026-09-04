# Shen Rain Radar v2

## Data strategy

1. **RainViewer** — observed radar history for the last ~2 hours, 10-minute intervals. RainViewer discontinued its public future radar nowcast on 2026-01-01, so the app does not label RainViewer as a future nowcast.
2. **Thai Meteorological Department (TMD)** — official Thai radar network. TMD lists radar stations including Mae Hong Son, Chiang Rai, Lamphun and Doi Muser, plus nationwide composite products. A dedicated TMD adapter is kept separate because TMD's public presentation is image/composite based and should not be guessed into a tile URL.
3. **Open-Meteo multi-model** — ECMWF IFS, NOAA GFS and DWD ICON are requested separately and combined with a median for the short-range precipitation signal. Model disagreement is shown as spread rather than hidden.

## Why this design

For the first release, observed radar should remain the primary signal. The next 2 hours are treated as a **short-range precipitation outlook**, not as guaranteed radar nowcast. The architecture leaves room for a future TMD nowcast adapter where official coverage exists.

## Local
npm install
npm run dev

## Build
npm run build

## Sources
RainViewer: https://www.rainviewer.com/api/transition-faq.html
TMD radar: https://weather.tmd.go.th/
TMD satellite/radar analysis: https://satda.tmd.go.th/
Open-Meteo docs: https://open-meteo.com/en/docs
ECMWF API: https://open-meteo.com/en/docs/ecmwf-api
