import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { nowcast } from "./nowcast";
import "./styles.css";

const DEFAULT = { lat: 19.917, lon: 99.215, name: "ฝาง, เชียงใหม่" };

const RAINVIEWER_META = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_TILE = "https://tilecache.rainviewer.com";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const THAIWATER = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public";

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
const RATES = [
  { limit: 0.1, label: "ไม่มีฝน", key: "dry" },
  { limit: 2, label: "ฝนเบา", key: "light" },
  { limit: 10, label: "ฝนปานกลาง", key: "moderate" },
  { limit: 35, label: "ฝนหนัก", key: "heavy" },
  { limit: Infinity, label: "ฝนหนักมาก", key: "violent" },
];

function rate(mmPerHour) {
  return RATES.find((step) => mmPerHour < step.limit) ?? RATES[RATES.length - 1];
}

function clock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function confidence(spread) {
  if (spread <= 0.8) return { label: "สูง", key: "high" };
  if (spread <= 2.5) return { label: "ปานกลาง", key: "medium" };
  return { label: "ต่ำ", key: "low" };
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// thaiwater timestamps are plain Thailand local time, with no zone marker.
function parseThaiTime(text) {
  if (!text) return null;
  const parts = text.trim().split(/[-: ]/).map(Number);
  if (parts.length < 5 || parts.some(Number.isNaN)) return null;
  const [year, month, day, hour, minute] = parts;
  return new Date(year, month - 1, day, hour, minute);
}

async function getRadarFrames() {
  const response = await fetch(RAINVIEWER_META, { cache: "no-store" });
  if (!response.ok) throw new Error("RainViewer metadata failed");
  const data = await response.json();
  return {
    host: data?.host ?? RAINVIEWER_TILE,
    frames: data?.radar?.past ?? [],
  };
}

async function getForecast(lat, lon) {
  const settled = await Promise.allSettled(
    MODELS.map(async ([name, model]) => {
      const url = new URL(OPEN_METEO);
      url.searchParams.set("latitude", lat);
      url.searchParams.set("longitude", lon);
      url.searchParams.set("minutely_15", "precipitation");
      url.searchParams.set("forecast_minutely_15", String(FORECAST_STEPS));
      url.searchParams.set("timezone", "auto");
      url.searchParams.set("models", model);

      const response = await fetch(url);
      if (!response.ok) throw new Error(`${name} failed`);
      const data = await response.json();

      return {
        name,
        time: data.minutely_15?.time ?? [],
        // mm per quarter hour on the wire, mm per hour everywhere in the app
        rate: (data.minutely_15?.precipitation ?? []).map(
          (value) => Number(value ?? 0) * 4
        ),
      };
    })
  );

  // One model going down must not blank out the whole outlook.
  const models = settled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);

  if (!models.length) throw new Error("all forecast models failed");

  const steps = Math.min(...models.map((model) => model.rate.length));

  const series = Array.from({ length: steps }, (_, i) => {
    const values = models.map((model) => model.rate[i]);
    return {
      at: new Date(models[0].time[i]),
      mmPerHour: median(values),
      spread: Math.max(...values) - Math.min(...values),
    };
  });

  return { models: models.map((model) => model.name), series };
}

/*
 * The public station list is one 4 MB document covering the whole country, so it
 * is fetched once per session and trimmed to what the app plots.
 */
let stationCache = null;

async function getStations() {
  if (stationCache) return stationCache;

  const response = await fetch(`${THAIWATER}/rain_24h`);
  if (!response.ok) throw new Error("thaiwater station list failed");
  const data = await response.json();

  stationCache = (data?.data ?? [])
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

  return stationCache;
}

async function getStationHistory(stationId) {
  const response = await fetch(
    `${THAIWATER}/rain_24h_graph?station_id=${stationId}`
  );
  if (!response.ok) throw new Error("thaiwater station history failed");
  const data = await response.json();

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
async function getNearestFromEdge(lat, lon) {
  const response = await fetch(`/api/stations?lat=${lat}&lon=${lon}&limit=1`);
  if (!response.ok) throw new Error("station function unavailable");

  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new Error("station function not deployed here");
  }

  const data = await response.json();
  const station = data?.stations?.[0];
  if (!station) throw new Error("no station in range");

  return { ...station, at: parseThaiTime(station.at) };
}

async function getNearestFromSource(lat, lon) {
  const stations = await getStations();

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

async function getNearest(lat, lon) {
  const nearest = await getNearestFromEdge(lat, lon).catch(() =>
    getNearestFromSource(lat, lon)
  );

  const history = await getStationHistory(nearest.id).catch(() => []);
  return { ...nearest, history };
}

/*
 * The headline answer. The measured reading is what the ground station is
 * reporting right now; the outlook is where the model consensus first crosses
 * into a different rain class, which is the thing worth telling someone.
 */
function summarise(station, forecast) {
  const nowRate = station ? station.mmPerHour : forecast?.series?.[0]?.mmPerHour;
  const now = rate(nowRate ?? 0);

  if (!forecast?.series?.length) {
    return { now, nowRate: nowRate ?? 0, outlook: null };
  }

  const change = forecast.series.find((step) => rate(step.mmPerHour).key !== now.key);

  if (!change) {
    return {
      now,
      nowRate: nowRate ?? 0,
      outlook:
        now.key === "dry"
          ? "อีก 2 ชั่วโมงข้างหน้ายังไม่มีฝน"
          : "อีก 2 ชั่วโมงข้างหน้าฝนยังแรงเท่าเดิม",
    };
  }

  const minutes = Math.max(
    15,
    Math.round((change.at.getTime() - Date.now()) / 60000 / 15) * 15
  );
  const next = rate(change.mmPerHour);
  const direction = change.mmPerHour > (nowRate ?? 0) ? "หนักขึ้นเป็น" : "เบาลงเป็น";

  return {
    now,
    nowRate: nowRate ?? 0,
    outlook:
      next.key === "dry"
        ? `อีก ${minutes} นาที ฝนหยุด`
        : `อีก ${minutes} นาที ${direction}${next.label}`,
  };
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

function App() {
  const mapRef = useRef(null);
  const radarLayerRef = useRef(null);
  const tmdLayerRef = useRef([]);

  const [loc, setLoc] = useState(DEFAULT);
  const [source, setSource] = useState("rainviewer");
  const [frames, setFrames] = useState([]);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [station, setStation] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState([]);
  const [drift, setDrift] = useState(null);
  const [stamp, setStamp] = useState(() => Date.now());

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

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  async function load(lat = loc.lat, lon = loc.lon) {
    setLoading(true);
    setDrift(null);
    const problems = [];

    const [radar, outlook, nearest] = await Promise.allSettled([
      getRadarFrames(),
      getForecast(lat, lon),
      getNearest(lat, lon),
    ]);

    if (radar.status === "fulfilled") {
      const { host, frames: past } = radar.value;
      setFrames(past);
      setIdx(past.length ? past.length - 1 : -1);

      /*
       * The extrapolation reads pixels out of a dozen tiles, so it runs after
       * the map and the measured reading are already on screen rather than
       * holding them up.
       */
      nowcast({ frames: past, host, lat, lon })
        .then(setDrift)
        .catch(() => setDrift(null));
    } else {
      problems.push("โหลดภาพเรดาร์ RainViewer ไม่ได้");
    }

    if (outlook.status === "fulfilled") setForecast(outlook.value);
    else problems.push("โหลดโมเดลพยากรณ์ไม่ได้");

    if (nearest.status === "fulfilled") setStation(nearest.value);
    else problems.push("โหลดสถานีวัดน้ำฝนไม่ได้");

    setNotes(problems);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      `${RAINVIEWER_TILE}${frames[idx].path}/256/{z}/{x}/{y}/2/1_1.png`,
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
  }, [frames, idx, source]);

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
      setNotes(["เครื่องนี้ไม่รองรับการอ่านตำแหน่ง"]);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          name: "ตำแหน่งของฉัน",
        };
        setLoc(next);
        mapRef.current?.setView([next.lat, next.lon], 9);
        load(next.lat, next.lon);
      },
      () => setNotes(["อ่านตำแหน่งของเครื่องไม่ได้"])
    );
  }

  function refresh() {
    setStamp(Date.now());
    load();
  }

  const summary = useMemo(() => summarise(station, forecast), [station, forecast]);
  const spread = forecast?.series?.length
    ? Math.max(...forecast.series.map((step) => step.spread))
    : 0;
  const trust = confidence(spread);

  return (
    <div className="app">
      <header>
        <div>
          <div className="brand">SHEN RAIN RADAR</div>
          <div className="sub">{loc.name}</div>
        </div>
        <div className="tools">
          <button onClick={locate} aria-label="ใช้ตำแหน่งของฉัน">
            📍
          </button>
          <button onClick={refresh} aria-label="อัปเดตข้อมูล">
            ↻
          </button>
        </div>
      </header>

      <section className={`answer ${summary.now.key}`}>
        {loading && !station ? (
          <div className="verdict">กำลังโหลด…</div>
        ) : (
          <>
            <div className="verdict">{summary.now.label}</div>

            {station ? (
              <div className="measured">
                {station.name}
                {station.amphoe ? ` อ.${station.amphoe}` : ""} ห่าง{" "}
                {station.km.toFixed(0)} กม. วัดได้{" "}
                <b>{station.mmPerHour.toFixed(1)} มม./ชม.</b>
                {station.at ? ` เมื่อ ${clock(station.at)}` : ""}
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
            {drift && (
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
              <div className={drift ? "secondary" : "outlook"}>
                {summary.outlook}
                {drift && <span className="from">จากโมเดลพยากรณ์</span>}
              </div>
            )}

            <div className="chips">
              {drift?.moving && (
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
            </div>
          </>
        )}
      </section>

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
          </div>
        </div>

        {source === "rainviewer" ? (
          <div className="player">
            <input
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

      {notes.length > 0 && (
        <section className="problems">
          {notes.map((note) => (
            <div key={note}>{note}</div>
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
