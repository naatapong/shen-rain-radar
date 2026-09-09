import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { nowcast } from "./nowcast";
import {
  ageLabel,
  ageMinutes,
  clock,
  combineForecastModels,
  confidence,
  distanceKm,
  isStale,
  parseThaiTime,
  rate,
  summarise,
  STATION_NEAR_KM,
} from "./weather";
import "./styles.css";

const DEFAULT = { lat: 19.917, lon: 99.215, name: "ฝาง, เชียงใหม่" };
const SAVED_LOCATION = "shen-rain-location";

const RAINVIEWER_META = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_TILE = "https://tilecache.rainviewer.com";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const THAIWATER = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public";

/*
 * Refresh cadence, one per source rather than one for the app.
 *
 * RainViewer publishes a frame every ten minutes and the nowcast is the part
 * that goes off fastest, so the radar is checked twice per publishing interval.
 * The gauges report hourly and the models run every few hours, so pulling them
 * on the same clock would be several times the traffic for no newer numbers.
 *
 * The timer only asks what is actually due, which also means returning to the
 * tab after a while refreshes the stale half instead of firing everything.
 */
const RADAR_REFRESH_MS = 5 * 60_000;
const GROUND_REFRESH_MS = 12 * 60_000;
const DUE_CHECK_MS = 60_000;

// How old each source may get before the app says so on the face of the card.
const RADAR_STALE_MINUTES = 20;
const STATION_STALE_MINUTES = 60;

/*
 * TMD public composite image.
 *
 * The published PNG is a full matplotlib figure, not a bare raster: it carries a
 * title, axis labels, a reflectivity colorbar and a white page background around
 * the plotted map. The numbers below are the measured pixel box of the plot
 * frame inside the 1686x2070 figure, which lets us place the figure by its own
 * axes and clip everything outside the plot away.
 */
const TMD_COMPOSITE =
  "https://satda.tmd.go.th/wp-content/uploads/data/radar_composite/max/composite_th.png";

const TMD_FIGURE = { w: 1686, h: 2070 };
const TMD_FRAME = { left: 135, right: 1395, top: 88, bottom: 1936 };
const TMD_AXES = { west: 94, east: 108, south: 3, north: 23 };

const LON_PER_PX =
  (TMD_AXES.east - TMD_AXES.west) / (TMD_FRAME.right - TMD_FRAME.left);
const LAT_PER_PX =
  (TMD_AXES.north - TMD_AXES.south) / (TMD_FRAME.bottom - TMD_FRAME.top);

const TMD_WEST = TMD_AXES.west - TMD_FRAME.left * LON_PER_PX;
const TMD_EAST = TMD_AXES.east + (TMD_FIGURE.w - TMD_FRAME.right) * LON_PER_PX;

const mercator = (lat) =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmercator = (y) =>
  ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

const pct = (value) => `${(value * 100).toFixed(4)}%`;

/*
 * The figure has linear latitude axes, but Leaflet draws an image overlay in Web
 * Mercator, so a single overlay spanning 3N to 23N misplaces the echo by up to
 * 23 km in the middle of the country. Splitting the plot into horizontal bands
 * and giving each band its own bounds keeps the error inside one radar pixel:
 * six bands leave about 1 km, which is the resolution of the source data.
 *
 * Every band draws the same image and is clipped to its own rows, so the browser
 * still fetches and decodes one file.
 */
const TMD_BAND_COUNT = 6;

const TMD_BANDS = Array.from({ length: TMD_BAND_COUNT }, (_, i) => {
  const frameHeight = TMD_FRAME.bottom - TMD_FRAME.top;
  const y0 = TMD_FRAME.top + (frameHeight * i) / TMD_BAND_COUNT;
  const y1 = TMD_FRAME.top + (frameHeight * (i + 1)) / TMD_BAND_COUNT;

  const latTop = TMD_AXES.north - (y0 - TMD_FRAME.top) * LAT_PER_PX;
  const latBottom = TMD_AXES.north - (y1 - TMD_FRAME.top) * LAT_PER_PX;

  const a = y0 / TMD_FIGURE.h;
  const b = y1 / TMD_FIGURE.h;
  const span = (mercator(latBottom) - mercator(latTop)) / (b - a);
  const yTop = mercator(latTop) - a * span;

  return {
    bounds: [
      [unmercator(yTop + span), TMD_WEST],
      [unmercator(yTop), TMD_EAST],
    ],
    clip: `inset(${pct(y0 / TMD_FIGURE.h)} ${pct(
      (TMD_FIGURE.w - TMD_FRAME.right) / TMD_FIGURE.w
    )} ${pct(
      (TMD_FIGURE.h - Math.min(y1 + 1, TMD_FRAME.bottom)) / TMD_FIGURE.h
    )} ${pct(TMD_FRAME.left / TMD_FIGURE.w)})`,
  };
});

const MODELS = [
  ["ECMWF IFS", "ecmwf_ifs025"],
  ["NOAA GFS", "gfs_seamless"],
  ["DWD ICON", "icon_seamless"],
];

const PAST_HOURS = 6;
const FORECAST_STEPS = 8; // 8 x 15 minutes = the next two hours

/*
 * Every number in the app is a rain rate in mm per hour, so the measured past and
 * the forecast can share one axis:
 *   thaiwater rain_1h and rain_24h_graph are already mm accumulated over an hour
 *   open-meteo minutely_15 is mm per 15 minutes, so it is multiplied by four
 */

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true }
    );
  });

async function fetchWithTimeout(url, init = {}, timeout = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeout);
  const abort = () => controller.abort("cancelled");
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

/*
 * Every outside source goes through here: a timeout, then one retry, and only
 * for the transport failing or the server saying it broke. A 4xx is an answer
 * and will not change on a second ask, and hammering a public source that is
 * already struggling is how an app gets rate-limited off it.
 */
async function fetchJson(url, { signal, timeout, cache, retry = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(url, { signal, cache }, timeout);
    } catch (error) {
      if (signal?.aborted || attempt >= retry) throw error;
      await pause(700, signal);
      continue;
    }

    if (response.status >= 500 && attempt < retry) {
      await pause(700, signal);
      continue;
    }
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);

    // A host without Functions answers the API path with the SPA shell, which
    // parses as neither JSON nor an error. Treat it as the route being absent.
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/html")) throw new Error(`${url} answered the app shell`);

    return response.json();
  }
}

async function getRadarFrames(signal) {
  const data = await fetchJson(RAINVIEWER_META, { signal, cache: "no-store" });
  return {
    host: data?.host ?? RAINVIEWER_TILE,
    frames: Array.isArray(data?.radar?.past) ? data.radar.past : [],
  };
}

async function getForecast(lat, lon, signal) {
  const settled = await Promise.allSettled(
    MODELS.map(async ([name, model]) => {
      const url = new URL(OPEN_METEO);
      url.searchParams.set("latitude", lat);
      url.searchParams.set("longitude", lon);
      url.searchParams.set("minutely_15", "precipitation");
      url.searchParams.set("forecast_minutely_15", String(FORECAST_STEPS));
      url.searchParams.set("timeformat", "unixtime");
      url.searchParams.set("timezone", "GMT");
      url.searchParams.set("models", model);

      const data = await fetchJson(url, { signal });

      return {
        name,
        points: (data.minutely_15?.time ?? [])
          .map((at, i) => ({
            at: Number(at),
            // mm per quarter hour on the wire, mm per hour everywhere in the app
            rate: Number(data.minutely_15?.precipitation?.[i] ?? 0) * 4,
          }))
          .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.rate)),
      };
    })
  );

  // One model going down must not blank out the whole outlook.
  const models = settled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);

  if (!models.length) throw new Error("all forecast models failed");

  const series = combineForecastModels(models, FORECAST_STEPS);
  if (!series.length) throw new Error("forecast models have no common time");

  return { models: models.map((model) => model.name), series };
}

/*
 * The public station list is one 4 MB document covering the whole country, so it
 * is fetched at most once every few minutes and trimmed to what the app plots.
 * It used to be held for the whole session, which quietly pinned the fallback
 * path to whatever the gauges said when the tab was opened.
 */
const STATION_CACHE_MS = 5 * 60_000;
let stationCache = null;

async function getStations(signal) {
  if (stationCache && Date.now() - stationCache.at < STATION_CACHE_MS) {
    return stationCache.rows;
  }

  const data = await fetchJson(`${THAIWATER}/rain_24h`, { signal, timeout: 20_000 });

  const rows = (data?.data ?? [])
    .map((row) => ({
      id: row.station?.id,
      name: row.station?.tele_station_name?.th ?? "ไม่ทราบชื่อสถานี",
      lat: Number(row.station?.tele_station_lat),
      lon: Number(row.station?.tele_station_long),
      province: row.geocode?.province_name?.th ?? "",
      amphoe: row.geocode?.amphoe_name?.th ?? "",
      agency: row.agency?.agency_shortname?.th ?? "",
      mmPerHour: Number(row.rain_1h ?? 0),
      mmPerDay: Number(row.rain_24h ?? 0),
      at: parseThaiTime(row.rainfall_datetime),
    }))
    .filter(
      (station) =>
        station.id && Number.isFinite(station.lat) && Number.isFinite(station.lon)
    );

  stationCache = { at: Date.now(), rows };
  return rows;
}

async function getStationHistory(stationId, signal) {
  const data = await fetchJson(
    `${THAIWATER}/rain_24h_graph?station_id=${encodeURIComponent(stationId)}`,
    { signal }
  );

  return (data?.data ?? [])
    .map((row) => ({
      at: parseThaiTime(row.rainfall_datetime),
      mmPerHour: Number(row.rainfall_value ?? 0),
    }))
    .filter((row) => row.at)
    .sort((a, b) => a.at - b.at);
}

/*
 * Preferred path: the site's own function has already read the national list at
 * the edge and hands back only the stations near the caller, a few hundred bytes
 * instead of the better part of a megabyte. It is absent under `vite dev` and on
 * any host without functions, so the direct route stays as a fallback.
 */
async function getNearestFromEdge(lat, lon, signal) {
  const data = await fetchJson(`/api/stations?lat=${lat}&lon=${lon}&limit=1`, {
    signal,
  });
  const station = data?.stations?.[0];
  if (!station) throw new Error("no station in range");

  return { ...station, at: parseThaiTime(station.at) };
}

async function getNearestFromSource(lat, lon, signal) {
  const stations = await getStations(signal);

  let nearest = null;
  let best = Infinity;

  for (const station of stations) {
    const km = distanceKm(lat, lon, station.lat, station.lon);
    if (km < best) {
      best = km;
      nearest = station;
    }
  }

  if (!nearest) throw new Error("no station in range");
  return { ...nearest, km: best };
}

async function getNearest(lat, lon, signal) {
  const nearest = await getNearestFromEdge(lat, lon, signal).catch((error) => {
    if (signal?.aborted) throw error;
    return getNearestFromSource(lat, lon, signal);
  });

  const history = await getStationHistory(nearest.id, signal).catch(() => []);
  return { ...nearest, history };
}

/*
 * Names the source the headline rests on, so a reading taken 40 km away is never
 * read as "the rain here".
 */
function basisLine(basis, station) {
  if (basis === "station") {
    return `จากสถานีวัดน้ำฝนห่าง ${station.km.toFixed(0)} กม.`;
  }
  if (basis === "radar") return "จากภาพเรดาร์เหนือจุดนี้";
  if (basis === "station-far") {
    return `จากสถานีวัดน้ำฝนห่าง ${station.km.toFixed(0)} กม. — ไม่มีเรดาร์มายืนยัน`;
  }
  if (basis === "model") return "จากโมเดลพยากรณ์ — ยังไม่มีค่าตรวจวัดในบริเวณนี้";
  return null;
}

/*
 * The two-hour extrapolation as one block per ten minutes. Everything past the
 * firm mark is drawn hollow: persistence has had long enough by then that cells
 * forming and dying matter as much as the drift, and the strip should look less
 * certain there rather than merely say so in small print.
 */
function DriftStrip({ drift }) {
  // The radar refusing to guess is worth a line of its own. Dropping the strip
  // silently left the card reading as though nothing were on the way.
  if (drift && !drift.ok) {
    return (
      <section className="drift unavailable">
        <div className="axis">
          <span className="measured">เรดาร์ · ทิศทางกลุ่มฝน</span>
        </div>
        <div className="scale">ประเมินทิศทางจากเรดาร์ไม่ได้ — {drift.reason}</div>
      </section>
    );
  }

  if (!drift?.steps?.length) return null;

  const marks = [30, 60, 90, 120];

  return (
    <section className="drift">
      <div className="axis">
        <span className="measured">เรดาร์ · ทิศทางกลุ่มฝนที่วัดได้</span>
        <span className="forecast">
          แม่นยำ: {drift.trust.label}
          {drift.pairs > 1 ? ` · จาก ${drift.pairs} ช่วงเวลา` : ""}
        </span>
      </div>

      <div className="blocks">
        {drift.steps.map((step) => (
          <div
            className={`block ${step.klass.key} ${step.firm ? "firm" : "soft"}`}
            key={step.minutes}
            title={`อีก ${step.minutes} นาที · ${step.klass.label}`}
          />
        ))}
      </div>

      <div className="marks">
        {marks
          .filter((minutes) => minutes <= drift.horizonMinutes)
          .map((minutes) => (
            <span key={minutes} style={{ left: `${(minutes / 120) * 100}%` }}>
              {minutes} น.
            </span>
          ))}
      </div>

      {drift.horizonMinutes < 120 && (
        <div className="scale">
          บอกได้ถึง {drift.horizonMinutes} นาที — กลุ่มฝนเคลื่อนเร็วจนพ้นขอบภาพที่ดึงมา
        </div>
      )}
    </section>
  );
}

function Timeline({ station, forecast }) {
  const past = useMemo(() => {
    if (!station?.history?.length) return [];
    return station.history.slice(-PAST_HOURS);
  }, [station]);

  const future = forecast?.series ?? [];
  const peak = Math.max(
    1,
    ...past.map((row) => row.mmPerHour),
    ...future.map((row) => row.mmPerHour)
  );

  if (!past.length && !future.length) return null;

  /*
   * On a phone the fourteen slots leave about 22px each, which is narrower than
   * a "04:00" label, so only every second slot is marked as a tick and the rest
   * drop their label under the narrow breakpoint.
   */
  const bar = (row, key, kind, position) => {
    const height = Math.max(3, (row.mmPerHour / peak) * 100);
    return (
      <div className={`slot ${position % 2 === 0 ? "tick" : ""}`} key={key}>
        <div className="track">
          <div
            className={`bar ${kind} ${rate(row.mmPerHour).key}`}
            style={{ height: `${height}%` }}
          />
        </div>
        <span>{clock(row.at)}</span>
      </div>
    );
  };

  return (
    <section className="timeline">
      <div className="axis">
        <span className="measured">ตรวจวัด · ย้อนหลัง {PAST_HOURS} ชม.</span>
        <span className="forecast">คาดการณ์ · 2 ชม. ข้างหน้า</span>
      </div>

      <div className="bars">
        {past.map((row, i) => bar(row, `p${i}`, "measured", i))}
        <div className="now" />
        {future.map((row, i) => bar(row, `f${i}`, "forecast", past.length + i))}
      </div>

      <div className="scale">สูงสุดในกราฟ {peak.toFixed(1)} มม./ชม.</div>
    </section>
  );
}

/*
 * The browser's own install entry is buried — a menu item on Android, a small
 * address-bar glyph on desktop — and on iOS it does not exist at all. So the
 * app carries its own button.
 *
 * Chrome hands over a deferred `beforeinstallprompt` event only once it has
 * accepted the manifest and the service worker, which makes the button's
 * presence the honest signal: if it is not there, the browser would not have
 * installed the app either. It fires before React mounts often enough that the
 * listener is attached in index.html and the event parked on `window`, rather
 * than being missed and leaving an installable app looking uninstallable.
 *
 * Safari never fires it, so iOS gets the manual instruction instead of a button
 * that could not do anything.
 */
function useInstall() {
  const [prompt, setPrompt] = useState(() => window.__installPrompt ?? null);
  const [installed, setInstalled] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
  );

  useEffect(() => {
    const offer = (event) => {
      event.preventDefault();
      setPrompt(event);
    };
    const done = () => {
      setPrompt(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", offer);
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // The event is single-use whichever way it went; a dismissed prompt is
    // offered again on the next visit, not by this same object.
    window.__installPrompt = null;
    setPrompt(null);
    if (outcome === "accepted") setInstalled(true);
  }, [prompt]);

  const ios =
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);

  return { can: Boolean(prompt) && !installed, installed, ios, install };
}

function App() {
  const mapRef = useRef(null);
  const radarLayerRef = useRef(null);
  const tmdLayerRef = useRef([]);
  const markerRef = useRef(null);

  // One request counter and one controller per source, so a slow gauge lookup
  // landing late cannot overwrite the radar for a location the user has since
  // moved away from — and neither can hold the other up.
  const radarSeq = useRef(0);
  const groundSeq = useRef(0);
  const radarAbort = useRef(null);
  const groundAbort = useRef(null);
  const radarFetched = useRef(0);
  const groundFetched = useRef(0);

  // The map is built once, so its click handler must reach the current loaders
  // rather than the ones that existed on the first render.
  const actions = useRef({});

  const [loc, setLoc] = useState(DEFAULT);
  const [source, setSource] = useState("rainviewer");
  const [frames, setFrames] = useState([]);
  const [radarHost, setRadarHost] = useState(RAINVIEWER_TILE);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [station, setStation] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [radarBusy, setRadarBusy] = useState(true);
  const [groundBusy, setGroundBusy] = useState(true);
  const [notes, setNotes] = useState({});
  const [drift, setDrift] = useState(null);
  const [stamp, setStamp] = useState(() => Date.now());

  // Ages are re-read from this rather than from Date.now() during render, so
  // "8 นาทีที่แล้ว" actually counts up while the tab sits open.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  function note(key, message) {
    setNotes((old) => {
      if ((old[key] ?? null) === (message ?? null)) return old;
      const next = { ...old };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  async function loadRadar(lat, lon) {
    radarAbort.current?.abort();
    const controller = new AbortController();
    radarAbort.current = controller;
    const seq = ++radarSeq.current;

    setRadarBusy(true);
    setDrift(null);

    try {
      const { host, frames: past } = await getRadarFrames(controller.signal);
      if (seq !== radarSeq.current) return;

      radarFetched.current = Date.now();
      setRadarHost(host);
      setFrames(past);
      setIdx(past.length ? past.length - 1 : -1);
      note("radar", null);

      /*
       * The extrapolation reads pixels out of a dozen tiles, so the map and the
       * measured reading are already on screen before it starts.
       */
      const value = await nowcast({ frames: past, host, lat, lon }).catch(() => ({
        ok: false,
        reason: "โหลดภาพเรดาร์มาคำนวณไม่ได้",
      }));
      if (seq === radarSeq.current) setDrift(value);
    } catch {
      if (seq === radarSeq.current) note("radar", "โหลดภาพเรดาร์ RainViewer ไม่ได้");
    } finally {
      if (seq === radarSeq.current) setRadarBusy(false);
    }
  }

  async function loadGround(lat, lon) {
    groundAbort.current?.abort();
    const controller = new AbortController();
    groundAbort.current = controller;
    const seq = ++groundSeq.current;

    setGroundBusy(true);

    const [outlook, nearest] = await Promise.allSettled([
      getForecast(lat, lon, controller.signal),
      getNearest(lat, lon, controller.signal),
    ]);
    if (seq !== groundSeq.current) return;

    groundFetched.current = Date.now();

    if (outlook.status === "fulfilled") {
      setForecast(outlook.value);
      note("forecast", null);
    } else {
      note("forecast", "โหลดโมเดลพยากรณ์ไม่ได้ — ใช้ค่าที่ดึงมาได้ล่าสุด");
    }

    if (nearest.status === "fulfilled") {
      setStation(nearest.value);
      note("station", null);
    } else {
      note("station", "โหลดสถานีวัดน้ำฝนไม่ได้ — ใช้ค่าที่ดึงมาได้ล่าสุด");
    }

    setGroundBusy(false);
  }

  function load(lat = loc.lat, lon = loc.lon) {
    loadRadar(lat, lon);
    loadGround(lat, lon);
  }

  function pick(next, zoom = 9) {
    setLoc(next);
    try {
      localStorage.setItem(SAVED_LOCATION, JSON.stringify(next));
    } catch {
      /* private browsing: the choice just does not survive a reload */
    }
    const map = mapRef.current;
    if (map) map.setView([next.lat, next.lon], Math.max(map.getZoom(), zoom));
    load(next.lat, next.lon);
  }

  actions.current = { load, loadRadar, loadGround, pick };

  useEffect(() => {
    const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(
      [DEFAULT.lat, DEFAULT.lon],
      8
    );

    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);

    /*
     * The TMD figure gets its own pane so multiply blending has the basemap as
     * its backdrop. Putting mix-blend-mode on the image instead would blend it
     * inside Leaflet's overlay pane, which is its own stacking context and has
     * nothing behind it, so the white page would stay opaque.
     */
    const pane = map.createPane("tmd");
    pane.style.zIndex = "350";
    pane.style.mixBlendMode = "multiply";
    pane.style.pointerEvents = "none";

    mapRef.current = map;
    map.on("click", (event) => {
      actions.current.pick({
        lat: event.latlng.lat,
        lon: event.latlng.lng,
        name: "จุดที่เลือกบนแผนที่",
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let start = DEFAULT;
    const saved = localStorage.getItem(SAVED_LOCATION);
    if (saved) {
      try {
        const next = JSON.parse(saved);
        if (Number.isFinite(next?.lat) && Number.isFinite(next?.lon)) {
          start = next;
          setLoc(next);
          mapRef.current?.setView([next.lat, next.lon], 9);
        }
      } catch {
        /* use the default location */
      }
    }
    actions.current.load(start.lat, start.lon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Each source is refreshed on its own clock, and only when it is actually due.
   * Coming back to the tab runs the same check, so a tab left open for an hour
   * catches up on both and a tab switched away for thirty seconds does nothing.
   */
  useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState !== "visible") return;
      const at = Date.now();
      if (at - radarFetched.current >= RADAR_REFRESH_MS) {
        actions.current.loadRadar(loc.lat, loc.lon);
      }
      if (at - groundFetched.current >= GROUND_REFRESH_MS) {
        actions.current.loadGround(loc.lat, loc.lon);
      }
      setNow(at);
    };

    const timer = setInterval(catchUp, DUE_CHECK_MS);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [loc]);

  useEffect(
    () => () => {
      radarAbort.current?.abort();
      groundAbort.current?.abort();
    },
    []
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Drop the old frame before deciding whether to draw a new one, otherwise
    // switching to the TMD tab leaves the RainViewer frame stacked underneath.
    if (radarLayerRef.current) {
      radarLayerRef.current.remove();
      radarLayerRef.current = null;
    }

    if (idx < 0 || !frames[idx] || source !== "rainviewer") return;

    radarLayerRef.current = L.tileLayer(
      `${radarHost}${frames[idx].path}/256/{z}/{x}/{y}/2/1_1.png`,
      {
        opacity: 0.74,
        /*
         * The public RainViewer tile service stops at z7 — past that it answers
         * 200 with a "Zoom Level Not Supported" placeholder rather than an
         * error, which is what used to paint that text across the map. Capping
         * maxNativeZoom keeps Leaflet on the z7 tiles and upscales them.
         */
        maxNativeZoom: 7,
        maxZoom: 19,
        attribution:
          'เรดาร์: <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a>',
      }
    ).addTo(map);
  }, [frames, idx, source, radarHost]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerRef.current?.remove();
    markerRef.current = L.circleMarker([loc.lat, loc.lon], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#2b78ff",
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip(loc.name, { direction: "top" });
  }, [loc]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    tmdLayerRef.current.forEach((layer) => layer.remove());
    tmdLayerRef.current = [];

    if (source !== "tmd") return;

    const url = `${TMD_COMPOSITE}?t=${stamp}`;

    tmdLayerRef.current = TMD_BANDS.map((band, i) => {
      const layer = L.imageOverlay(url, band.bounds, {
        pane: "tmd",
        // The figure's own coastlines and province borders multiply to solid
        // black, so hold the layer back a little to keep the basemap readable.
        opacity: 0.75,
        className: "tmd-overlay",
        attribution:
          i === 0
            ? 'เรดาร์: <a href="https://weather.tmd.go.th/" target="_blank" rel="noreferrer">กรมอุตุนิยมวิทยา</a>'
            : undefined,
      }).addTo(map);

      const image = layer.getElement();
      if (image) image.style.clipPath = band.clip;

      return layer;
    });
  }, [source, stamp]);

  useEffect(() => {
    if (!playing || frames.length < 2 || source !== "rainviewer") return;

    const timer = setInterval(() => {
      setIdx((current) => {
        if (current >= frames.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 650);

    return () => clearInterval(timer);
  }, [playing, frames.length, source]);

  function locate() {
    if (!navigator.geolocation) {
      note("locate", "เครื่องนี้ไม่รองรับการอ่านตำแหน่ง");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        note("locate", null);
        actions.current.pick({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          name: "ตำแหน่งของฉัน",
        });
      },
      () => note("locate", "อ่านตำแหน่งของเครื่องไม่ได้")
    );
  }

  function refresh() {
    setStamp(Date.now());
    load();
  }

  const app = useInstall();
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  const summary = useMemo(
    () => summarise(station, forecast, drift),
    [station, forecast, drift]
  );

  const spread = forecast?.series?.length
    ? Math.max(...forecast.series.map((step) => step.spread))
    : 0;
  const trust = confidence(spread);

  const busy = radarBusy || groundBusy;
  const stationFar = station && station.km > STATION_NEAR_KM;
  const stationAge = ageLabel(station?.at, now);
  const stationStale = station && isStale(station.at, STATION_STALE_MINUTES, now);

  const radarAt = frames.length ? new Date(frames.at(-1).time * 1000) : null;
  const radarMinutes = ageMinutes(radarAt, now);
  const radarStale = radarAt && isStale(radarAt, RADAR_STALE_MINUTES, now);

  const problems = Object.values(notes);

  return (
    <div className="app">
      <header>
        <div>
          <div className="brand">SHEN RAIN RADAR</div>
          <div className="sub">{loc.name}</div>
        </div>
        <div className="tools">
          {app.can && (
            <button className="install" onClick={app.install}>
              ติดตั้งแอป
            </button>
          )}
          {!app.can && !app.installed && app.ios && (
            <button
              className="install"
              onClick={() => setIosHint((open) => !open)}
              aria-expanded={iosHint}
            >
              ติดตั้งแอป
            </button>
          )}
          <button onClick={locate} aria-label="ใช้ตำแหน่งของฉัน">
            📍
          </button>
          <button
            onClick={refresh}
            disabled={busy}
            aria-label="อัปเดตข้อมูล"
            aria-busy={busy}
          >
            ↻
          </button>
        </div>
      </header>

      {iosHint && (
        <div className="ios-hint">
          iOS ติดตั้งจาก Safari เท่านั้น — แตะ <b>แชร์</b> ที่แถบล่าง แล้วเลือก{" "}
          <b>เพิ่มไปยังหน้าจอโฮม</b>
        </div>
      )}

      <section className={`answer ${summary.now.key}`}>
        {busy && !station && !drift?.ok ? (
          <div className="verdict">กำลังโหลด…</div>
        ) : (
          <>
            <div className="verdict">{summary.now.label}</div>

            {basisLine(summary.basis, station) && (
              <div className="basis">{basisLine(summary.basis, station)}</div>
            )}

            {station ? (
              <div className="measured">
                {stationFar ? "สถานีใกล้สุด " : ""}
                {station.name}
                {station.amphoe ? ` อ.${station.amphoe}` : ""} ห่าง{" "}
                {station.km.toFixed(0)} กม. วัดได้{" "}
                <b>{station.mmPerHour.toFixed(1)} มม./ชม.</b>
                {station.at ? ` เมื่อ ${clock(station.at)}` : ""}
                {stationAge ? ` (${stationAge})` : ""}
                {stationFar ? (
                  <span className="warning">
                    {" "}
                    · ไกลเกิน {STATION_NEAR_KM} กม. จึงใช้แทนจุดนี้ไม่ได้
                  </span>
                ) : null}
                {stationStale ? (
                  <span className="warning"> · ยังไม่มีค่าใหม่เกิน 1 ชม.</span>
                ) : null}
              </div>
            ) : (
              <div className="measured">ไม่มีสถานีวัดน้ำฝนใกล้เคียง</div>
            )}

            {/*
              Two horizons, kept apart on purpose. The radar line is the echo
              that already exists being carried along its own motion, which is
              the sharper answer for the next hour; the model line covers the
              rest of the window, where nothing has formed yet.
            */}
            {drift?.ok && (
              <div className="outlook">
                {drift.change
                  ? `อีก ${drift.change.minutes} นาที ${drift.change.klass.label}`
                  : drift.now.key === "dry"
                    ? `อีก ${drift.horizonMinutes} นาทีข้างหน้ายังไม่มีฝน`
                    : `อีก ${drift.horizonMinutes} นาทีข้างหน้าฝนยังอยู่`}
                <span className="from">จากการเคลื่อนตัวของกลุ่มฝนบนเรดาร์</span>
              </div>
            )}

            {summary.outlook && (
              <div className={drift?.ok ? "secondary" : "outlook"}>
                {summary.outlook}
                {drift?.ok && <span className="from">จากโมเดลพยากรณ์</span>}
              </div>
            )}

            <div className="chips">
              {drift?.ok && drift.moving && (
                <span className="chip">
                  <span
                    className="arrow"
                    style={{ transform: `rotate(${drift.direction.degrees}deg)` }}
                  >
                    ↑
                  </span>
                  ฝนเคลื่อนไปทาง{drift.direction.name}{" "}
                  {Math.round(drift.speedKmh)} กม./ชม.
                </span>
              )}

              {forecast && (
                <span className={`chip trust ${trust.key}`}>
                  โมเดลเห็นตรงกัน: {trust.label}
                </span>
              )}

              {radarMinutes !== null && (
                <span className={`chip ${radarStale ? "warning" : ""}`}>
                  ภาพเรดาร์{" "}
                  {radarMinutes < 1 ? "ล่าสุด" : `เก่า ${radarMinutes} นาที`}
                </span>
              )}

              {busy && <span className="chip">กำลังอัปเดต…</span>}
            </div>
          </>
        )}
      </section>

      <DriftStrip drift={drift} />

      <Timeline station={station} forecast={forecast} />

      <section className="mapcard">
        <div className="maphead">
          <span>แผนที่ฝน</span>
          <div className="switch">
            <button
              className={source === "rainviewer" ? "active" : ""}
              onClick={() => setSource("rainviewer")}
            >
              RainViewer
            </button>
            <button
              className={source === "tmd" ? "active" : ""}
              onClick={() => setSource("tmd")}
            >
              TMD
            </button>
          </div>
        </div>

        <div className="mapwrap">
          <div id="map" />
          <div className="stamp">
            {source === "tmd"
              ? "ภาพ composite ล่าสุดของกรมอุตุฯ"
              : idx >= 0 && frames[idx]
                ? `เรดาร์ ${clock(frames[idx].time * 1000)}`
                : "ไม่มีภาพเรดาร์"}
            <span className="from">แตะแผนที่เพื่อเลือกจุดใหม่</span>
          </div>
        </div>

        {source === "rainviewer" ? (
          <div className="player">
            <input
              aria-label="เลือกเวลาภาพเรดาร์ย้อนหลัง"
              type="range"
              min="0"
              max={Math.max(0, frames.length - 1)}
              value={Math.max(0, idx)}
              onChange={(event) => setIdx(Number(event.target.value))}
              disabled={frames.length < 2}
            />
            <button
              className="play"
              disabled={frames.length < 2}
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? "⏸ หยุด" : "▶ เล่นย้อนหลัง 2 ชม."}
            </button>
          </div>
        ) : (
          <p className="note">
            ภาพจากกรมอุตุนิยมวิทยาเป็นภาพนิ่งภาพเดียว ไม่มี animation
            สีเขียวคือฝนอ่อน เหลืองถึงส้มคือปานกลาง แดงถึงม่วงคือหนัก
            พื้นเทาจาง ๆ คือพื้นที่ที่เรดาร์ครอบคลุมแต่ไม่พบฝน
          </p>
        )}
      </section>

      {problems.length > 0 && (
        <section className="problems">
          {problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </section>
      )}

      <footer className="footer">
        <div>
          ตรวจวัด: สถานีโทรมาตรผ่าน คลังข้อมูลน้ำแห่งชาติ (สสน.) ·
          เรดาร์: RainViewer และกรมอุตุนิยมวิทยา
        </div>
        <div>
          คาดการณ์: ค่ากลางของ {MODELS.map(([name]) => name).join(" / ")}{" "}
          ผ่าน Open-Meteo — เป็นผลจากโมเดล ไม่ใช่การรับรองความแม่นยำ
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
