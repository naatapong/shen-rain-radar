import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

const DEFAULT = { lat: 19.917, lon: 99.215, name: "ฝาง, เชียงใหม่" };
const RAINVIEWER_META = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_TILE = "https://tilecache.rainviewer.com";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

/*
 * TMD public composite image.
 * This is deliberately kept as an image overlay, not a guessed tile API.
 *
 * The published PNG is a full matplotlib figure, not a bare raster: it carries a
 * title, axis labels, a reflectivity colorbar and a white page background around
 * the plotted map. Dropping the whole figure on the map is what washed the
 * basemap out. The numbers below are the measured pixel box of the plot frame
 * inside the 1686x2070 figure, which lets us do two things:
 *
 *   1. place the figure by its own extent, so the plot frame lands on the
 *      latitudes and longitudes its axes actually claim, and
 *   2. clip everything outside the plot frame away in CSS.
 *
 * The remaining white page inside the frame is removed by compositing the layer
 * with multiply (see the tmd pane below), so only the radar echo and the grey
 * coverage rings darken the map.
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
const TMD_EAST =
  TMD_AXES.east + (TMD_FIGURE.w - TMD_FRAME.right) * LON_PER_PX;

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

  // Latitudes this band of pixels represents, read off the figure's own axes.
  const latTop = TMD_AXES.north - (y0 - TMD_FRAME.top) * LAT_PER_PX;
  const latBottom = TMD_AXES.north - (y1 - TMD_FRAME.top) * LAT_PER_PX;

  // Solve for the bounds that make rows y0..y1 land on latTop..latBottom once
  // Leaflet has stretched the whole figure across them in projected space.
  const a = y0 / TMD_FIGURE.h;
  const b = y1 / TMD_FIGURE.h;
  const span = (mercator(latBottom) - mercator(latTop)) / (b - a);
  const yTop = mercator(latTop) - a * span;

  return {
    bounds: [
      [unmercator(yTop + span), TMD_WEST],
      [unmercator(yTop), TMD_EAST],
    ],
    /*
     * Keeps this band only, and trims the axis labels and colorbar sideways.
     * The bottom edge is carried one source pixel into the next band so that
     * rounding between the separate image elements cannot open a hairline seam
     * across the map.
     */
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

function fmt(ts) {
  return new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts * 1000));
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function classify(totalMm) {
  if (totalMm >= 10) return ["หนัก", "danger"];
  if (totalMm >= 2) return ["ปานกลาง", "warn"];
  if (totalMm > 0.1) return ["เล็กน้อย", "light"];
  return ["ไม่มี/ต่ำ", "dry"];
}

function confidence(spread) {
  if (spread <= 0.8) return ["สูง", "high"];
  if (spread <= 2.5) return ["ปานกลาง", "medium"];
  return ["ต่ำ", "low"];
}

async function getRadar() {
  const response = await fetch(RAINVIEWER_META, { cache: "no-store" });
  if (!response.ok) throw new Error("RainViewer metadata failed");
  const data = await response.json();
  return data?.radar?.past ?? [];
}

async function getForecast(lat, lon) {
  const settled = await Promise.allSettled(
    MODELS.map(async ([name, model]) => {
      const url = new URL(OPEN_METEO);
      url.searchParams.set("latitude", lat);
      url.searchParams.set("longitude", lon);
      url.searchParams.set(
        "hourly",
        "rain,precipitation,precipitation_probability"
      );
      url.searchParams.set("forecast_hours", "3");
      url.searchParams.set("timezone", "auto");
      url.searchParams.set("models", model);

      const response = await fetch(url);
      if (!response.ok) throw new Error(`${name} failed`);
      const data = await response.json();

      return {
        name,
        time: data.hourly?.time ?? [],
        rain:
          data.hourly?.rain ??
          data.hourly?.precipitation ??
          [],
        prob: data.hourly?.precipitation_probability ?? [],
      };
    })
  );

  // One model going down must not blank out the whole consensus panel.
  const results = settled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);

  if (!results.length) throw new Error("all forecast models failed");

  return results;
}

function App() {
  const mapRef = useRef(null);
  const radarLayerRef = useRef(null);
  const tmdLayerRef = useRef([]);

  const [frames, setFrames] = useState([]);
  const [idx, setIdx] = useState(-1);
  const [loc, setLoc] = useState(DEFAULT);
  const [source, setSource] = useState("rainviewer");
  const [playing, setPlaying] = useState(false);
  const [models, setModels] = useState(null);
  const [loadingRadar, setLoadingRadar] = useState(true);
  const [error, setError] = useState("");
  // Bumped on every manual refresh so the cached TMD composite is re-fetched.
  const [stamp, setStamp] = useState(() => Date.now());

  useEffect(() => {
    const map = L.map("map", {
      zoomControl: false,
      preferCanvas: true,
    }).setView([DEFAULT.lat, DEFAULT.lon], 8);

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
    const tmdPane = map.createPane("tmd");
    tmdPane.style.zIndex = "350";
    tmdPane.style.mixBlendMode = "multiply";
    tmdPane.style.pointerEvents = "none";

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  async function refreshRadar() {
    setLoadingRadar(true);
    setError("");
    try {
      const past = await getRadar();
      setFrames(past);
      setIdx(past.length ? past.length - 1 : -1);
    } catch {
      setError("โหลด RainViewer ไม่สำเร็จ");
    } finally {
      setLoadingRadar(false);
    }
  }

  async function refreshForecast(lat = loc.lat, lon = loc.lon) {
    try {
      setModels(await getForecast(lat, lon));
    } catch {
      setModels(null);
      setError("โหลด forecast model ไม่สำเร็จ");
    }
  }

  useEffect(() => {
    refreshRadar();
    refreshForecast();
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

    const frame = frames[idx];
    const url =
      `${RAINVIEWER_TILE}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;

    radarLayerRef.current = L.tileLayer(url, {
      opacity: 0.74,
      /*
       * The public RainViewer tile service stops at z7 — past that it answers
       * 200 with a "Zoom Level Not Supported" placeholder rather than an error.
       * Capping the layer at maxZoom 7 hid it entirely at the z8 default view,
       * so use maxNativeZoom instead: Leaflet keeps drawing the z7 tiles and
       * upscales them as the user zooms in.
       */
      maxNativeZoom: 7,
      maxZoom: 19,
      attribution:
        'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a>',
    }).addTo(map);
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
        // Only one band carries the credit, otherwise it is counted six times.
        attribution:
          i === 0
            ? 'Radar: <a href="https://weather.tmd.go.th/" target="_blank" rel="noreferrer">TMD</a>'
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
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          name: "ตำแหน่งของฉัน",
        };
        setLoc(next);
        mapRef.current?.setView([next.lat, next.lon], 10);
        refreshForecast(next.lat, next.lon);
      },
      () => setError("ไม่สามารถอ่านตำแหน่งของเครื่องได้")
    );
  }

  function updateAll() {
    setStamp(Date.now());
    refreshRadar();
    refreshForecast();
  }

  const consensus = useMemo(() => {
    if (!models?.length) return [];

    const len = Math.min(
      3,
      ...models.map((model) => model.rain.length)
    );

    return Array.from({ length: len }, (_, i) => {
      const values = models.map((model) => Number(model.rain[i] ?? 0));
      const probs = models.map((model) => Number(model.prob[i] ?? 0));

      return {
        time: new Date(models[0].time[i]).getTime(),
        mm: median(values),
        prob: Math.round(median(probs)),
        spread: Math.max(...values) - Math.min(...values),
      };
    });
  }, [models]);

  const total = consensus.reduce((sum, item) => sum + item.mm, 0);
  const status = classify(total);
  const maxSpread = consensus.length
    ? Math.max(...consensus.map((item) => item.spread))
    : 0;
  const confidenceResult = confidence(maxSpread);

  return (
    <div className="app">
      <header>
        <div>
          <div className="brand">🌧️ SHEN RAIN RADAR</div>
          <div className="sub">{loc.name}</div>
        </div>
        <button onClick={locate} aria-label="ตำแหน่งของฉัน">
          📍
        </button>
      </header>

      <div className="sourcebar">
        <button
          className={source === "rainviewer" ? "active" : ""}
          onClick={() => setSource("rainviewer")}
        >
          Radar
        </button>
        <button
          className={source === "tmd" ? "active" : ""}
          onClick={() => setSource("tmd")}
        >
          TMD
        </button>
        <button onClick={updateAll}>↻ อัปเดต</button>
      </div>

      <main>
        <div id="map" />
        <div className="status">
          {source === "tmd"
            ? "TMD Radar Composite"
            : loadingRadar
              ? "กำลังโหลด…"
              : idx >= 0
                ? `Radar ${fmt(frames[idx].time)}`
                : "ไม่มีข้อมูล"}
        </div>
        <div className="legend">
          {source === "tmd"
            ? "🟩 ฝนอ่อน　🟨 ปานกลาง　🟥 ฝนหนัก"
            : "🟦 ฝนอ่อน　🟨 ปานกลาง　🟥 ฝนหนัก"}
        </div>
      </main>

      {source === "tmd" && (
        <section className="notice">
          <b>กรมอุตุนิยมวิทยา (TMD) — Radar Composite</b>
          <p>
            แสดงภาพเรดาร์ composite ของประเทศไทยเป็น overlay บนแผนที่โดยตรง
            ค่าสีคือ reflectivity (dBZ) เขียว = ฝนอ่อน เหลือง-ส้ม = ปานกลาง
            แดง-ม่วง = หนัก ส่วนพื้นเทาจาง ๆ คือขอบเขตที่เรดาร์ครอบคลุมแต่ไม่พบฝน
            ส่วน animation ของ RainViewer ยังแยกไว้ในแท็บ Radar
            เพราะรูปแบบข้อมูลของสองแหล่งไม่เหมือนกัน
          </p>
        </section>
      )}

      <section className="panel">
        <div className="title">Radar ย้อนหลัง</div>
        <input
          type="range"
          min="0"
          max={Math.max(0, frames.length - 1)}
          value={Math.max(0, idx)}
          onChange={(event) => setIdx(Number(event.target.value))}
          disabled={!frames.length || source !== "rainviewer"}
        />
        <div className="times">
          <span>{frames[0] ? fmt(frames[0].time) : "--:--"}</span>
          <strong>
            {frames[idx] ? fmt(frames[idx].time) : "--:--"}
          </strong>
          <span>
            {frames.at(-1) ? fmt(frames.at(-1).time) : "--:--"}
          </span>
        </div>
        <button
          className="play"
          disabled={source !== "rainviewer" || frames.length < 2}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? "⏸ หยุด" : "▶ เล่น Animation"}
        </button>
      </section>

      <section className="forecast">
        <div className="title">แนวโน้มฝน 0–2 ชั่วโมงข้างหน้า</div>
        <div className="big">
          {models
            ? `${status[0]} · median ${total.toFixed(1)} mm`
            : "กำลังโหลด…"}
        </div>

        <div className={`confidence ${confidenceResult[1]}`}>
          ความเห็นของโมเดล: <b>{confidenceResult[0]}</b>
          {models ? ` · spread สูงสุด ${maxSpread.toFixed(1)} mm` : ""}
        </div>

        <div className="grid">
          {consensus.map((item, i) => (
            <div className="hour" key={i}>
              <b>{fmt(item.time / 1000)}</b>
              <span>{item.mm.toFixed(1)} mm</span>
              <small>โอกาส {item.prob}%</small>
              <small>ต่างกัน {item.spread.toFixed(1)} mm</small>
            </div>
          ))}
        </div>

        {models && (
          <div className="modelnote">
            ใช้ ECMWF IFS + NOAA GFS + DWD ICON ผ่าน Open-Meteo
            แล้วคำนวณค่ากลาง (median) และความแตกต่างระหว่างโมเดล
            เพื่อสื่อระดับความมั่นใจ ไม่ใช่การรับรองความแม่นยำ
          </div>
        )}
      </section>

      <footer className="footer">
        {error && <span className="error">{error}</span>}
        Radar: RainViewer · TMD Composite · Forecast:
        ECMWF / GFS / ICON via Open-Meteo
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
