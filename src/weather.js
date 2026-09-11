export const RATES = [
  { limit: 0.1, label: "ไม่มีฝน", key: "dry" },
  { limit: 2, label: "ฝนเบา", key: "light" },
  { limit: 10, label: "ฝนปานกลาง", key: "moderate" },
  { limit: 35, label: "ฝนหนัก", key: "heavy" },
  { limit: Infinity, label: "ฝนหนักมาก", key: "violent" },
];

export function rate(mmPerHour) {
  return RATES.find((step) => mmPerHour < step.limit) ?? RATES.at(-1);
}

// Thaiwater sends a wall-clock value without an offset. Keep it Thailand time
// regardless of the browser's own timezone (travellers should see the same time).
export function parseThaiTime(text) {
  if (!text) return null;
  const parts = String(text).trim().split(/[-: ]/).map(Number);
  if (parts.length < 5 || parts.some(Number.isNaN)) return null;
  const [year, month, day, hour, minute] = parts;
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute));
}

export function clock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bangkok",
  }).format(date);
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Models can publish different start times. Combine only matching timestamps,
// never "the third value" from one model with "the third value" from another.
export function combineForecastModels(models, limit = 8) {
  if (!models.length) return [];
  const maps = models.map((model) => new Map(model.points.map((p) => [p.at, p.rate])));
  const times = [...maps[0].keys()].filter((at) => maps.every((map) => map.has(at)));
  return times.slice(0, limit).map((at) => {
    const values = maps.map((map) => map.get(at));
    return {
      at: new Date(at * 1000),
      mmPerHour: median(values),
      spread: Math.max(...values) - Math.min(...values),
    };
  });
}

/*
 * Freshness.
 *
 * Every source publishes on its own cadence and any of them can quietly stop
 * updating, so the app reports the age of what it is showing rather than only
 * the timestamp. A rain app that silently keeps a twenty-minute-old radar frame
 * on screen is worse than one that admits the frame is twenty minutes old.
 */
export function ageMinutes(at, now = Date.now()) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
  return Math.max(0, Math.round((now - at.getTime()) / 60_000));
}

export function isStale(at, maxAgeMinutes, now = Date.now()) {
  return !(at instanceof Date) || now - at.getTime() > maxAgeMinutes * 60_000;
}

export function ageLabel(at, now = Date.now()) {
  const minutes = ageMinutes(at, now);
  if (minutes === null) return null;
  if (minutes < 1) return "เมื่อสักครู่";
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ชม. ${rest} นาทีที่แล้ว` : `${hours} ชม. ที่แล้ว`;
}

export function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function confidence(spread) {
  if (spread <= 0.8) return { label: "สูง", key: "high" };
  if (spread <= 2.5) return { label: "ปานกลาง", key: "medium" };
  return { label: "ต่ำ", key: "low" };
}

/*
 * How near a gauge has to be before its reading can stand in for the point the
 * user asked about. Convective rain in Thailand is routinely narrower than this,
 * so past it the gauge is a nearby report and the radar pixel overhead is the
 * better description of "here".
 */
export const STATION_NEAR_KM = 15;

/*
 * The headline answer, and which source it rests on.
 *
 * The gauge wins while it is close, because it is a measurement. Once it is far
 * the radar takes over the headline and the gauge drops to a supporting line —
 * otherwise a reading from 40 km away reads as "the rain here".
 */
export function summarise(station, forecast, drift) {
  const stationRate =
    station && Number.isFinite(station.mmPerHour) ? station.mmPerHour : null;
  const stationNear = station ? Number(station.km) <= STATION_NEAR_KM : false;
  const radarNow = drift?.ok ? drift.now : null;
  const modelRate = forecast?.series?.[0]?.mmPerHour;

  /*
   * A gauge reading of zero is not evidence that it is dry right now. Thaiwater
   * publishes `rain_1h`, an accumulation over the hour that just ended, once an
   * hour — so at the onset of rain the nearest gauge still reports 0.0 while the
   * radar pixel overhead already holds echo. Letting the gauge win there put
   * "no rain" at the top of a card whose own radar strip was drawing rain.
   *
   * So the near gauge carries the headline while it is wet, and hands over to
   * the radar when the two disagree about whether it is raining at all.
   */
  const stationWet = stationRate !== null && rate(stationRate).key !== "dry";
  const radarWet = Boolean(radarNow) && radarNow.key !== "dry";
  const gaugeOutranked = radarWet && !stationWet;

  let now;
  let basis;
  if (stationRate !== null && stationNear && !gaugeOutranked) {
    now = rate(stationRate);
    basis = "station";
  } else if (radarNow) {
    now = radarNow;
    basis = "radar";
  } else if (stationRate !== null) {
    now = rate(stationRate);
    basis = "station-far";
  } else if (Number.isFinite(modelRate)) {
    now = rate(modelRate);
    basis = "model";
  } else {
    now = rate(0);
    basis = "none";
  }

  // The model outlook is compared against the model's own view of the present,
  // not against the headline. Mixing a radar class with a model series would
  // report a change of class that neither source actually claims.
  const reference = stationRate ?? (Number.isFinite(modelRate) ? modelRate : 0);
  const series = forecast?.series ?? [];

  if (!series.length) {
    return { now, basis, nowRate: reference, outlook: null };
  }

  const modelNow = rate(reference);
  const change = series.find((step) => rate(step.mmPerHour).key !== modelNow.key);

  if (!change) {
    return {
      now,
      basis,
      nowRate: reference,
      outlook:
        modelNow.key === "dry"
          ? "อีก 2 ชั่วโมงข้างหน้ายังไม่มีฝน"
          : "อีก 2 ชั่วโมงข้างหน้าฝนยังแรงเท่าเดิม",
    };
  }

  const minutes = Math.max(
    15,
    Math.round((change.at.getTime() - Date.now()) / 60000 / 15) * 15
  );
  const next = rate(change.mmPerHour);
  const direction = change.mmPerHour > reference ? "หนักขึ้นเป็น" : "เบาลงเป็น";

  return {
    now,
    basis,
    nowRate: reference,
    outlook:
      next.key === "dry"
        ? `อีก ${minutes} นาที ฝนหยุด`
        : `อีก ${minutes} นาที ${direction}${next.label}`,
  };
}
