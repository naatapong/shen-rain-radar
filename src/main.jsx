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
 * Bounds are the geographic extent of the published Thailand composite.
 */
const TMD_COMPOSITE =
  "https://satda.tmd.go.th/wp-content/uploads/data/radar_composite/max/composite_th.png";
const TMD_BOUNDS = [
  [3.0, 94.0],
  [23.0, 108.0],
];

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
  const results = await Promise.all(
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

  return results;
}

function App() {
  const mapRef = useRef(null);
  const radarLayerRef = useRef(null);
  const tmdLayerRef = useRef(null);

  const [frames, setFrames] = useState([]);
  const [idx, setIdx] = useState(-1);
  const [loc, setLoc] = useState(DEFAULT);
  const [source, setSource] = useState("rainviewer");
  const [playing, setPlaying] = useState(false);
  const [models, setModels] = useState(null);
  const [loadingRadar, setLoadingRadar] = useState(true);
  const [error, setError] = useState("");

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
    if (!map || idx < 0 || !frames[idx] || source !== "rainviewer") return;

    if (radarLayerRef.current) {
      radarLayerRef.current.remove();
    }

    const frame = frames[idx];
    const url =
      `${RAINVIEWER_TILE}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;

    radarLayerRef.current = L.tileLayer(url, {
      opacity: 0.74,
      maxZoom: 7,
      attribution:
        'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a>',
    }).addTo(map);
  }, [frames, idx, source]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (tmdLayerRef.current) {
      tmdLayerRef.current.remove();
      tmdLayerRef.current = null;
    }

    if (source !== "tmd") return;

    tmdLayerRef.current = L.imageOverlay(TMD_COMPOSITE, TMD_BOUNDS, {
      opacity: 0.68,
      className: "tmd-overlay",
      attribution: 'Radar: <a href="https://weather.tmd.go.th/" target="_blank" rel="noreferrer">TMD</a>',
    }).addTo(map);
  }, [source]);

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
          🟦 ฝนอ่อน　🟨 ปานกลาง　🟥 ฝนหนัก
        </div>
      </main>

      {source === "tmd" && (
        <section className="notice">
          <b>กรมอุตุนิยมวิทยา (TMD) — Radar Composite</b>
          <p>
            แสดงภาพเรดาร์ composite ของประเทศไทยเป็น overlay
            บนแผนที่โดยตรง ส่วน animation ของ RainViewer
            ยังแยกไว้ในแท็บ Radar เพราะรูปแบบข้อมูลของสองแหล่งไม่เหมือนกัน
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
