/*
 * Trims the national rain-gauge list down to the caller's neighbourhood.
 *
 * The thaiwater endpoint only serves the whole country in one document — about
 * 4 MB, 640 KB over the wire — with no way to filter server-side. Doing that on
 * a phone once per session is the single heaviest thing the app did, so the
 * fetch happens here instead: the upstream document is cached at the edge and
 * shared by every visitor, and each caller gets back the handful of stations
 * near them with only the fields the app plots.
 */

const UPSTREAM =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h";

// Long enough to collapse a burst of visitors onto one upstream read, short
// enough that a station reporting on the hour is not stale by the time it lands.
const UPSTREAM_TTL = 300;
const EDGE_TTL = 120;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const MAX_RADIUS_KM = 300;

/*
 * The upstream is a 4 MB document from a service with no availability promise.
 * Without a deadline a slow read holds an edge invocation open until the
 * platform kills it, and the caller waits the whole time for nothing.
 */
const UPSTREAM_TIMEOUT_MS = 15_000;

export function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function trim(row, km) {
  return {
    id: row.station?.id,
    name: row.station?.tele_station_name?.th ?? "",
    lat: Number(row.station?.tele_station_lat),
    lon: Number(row.station?.tele_station_long),
    province: row.geocode?.province_name?.th ?? "",
    amphoe: row.geocode?.amphoe_name?.th ?? "",
    agency: row.agency?.agency_shortname?.th ?? "",
    mmPerHour: Number(row.rain_1h ?? 0),
    mmPerDay: Number(row.rain_24h ?? 0),
    at: row.rainfall_datetime ?? null,
    km: Math.round(km * 10) / 10,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Only a real answer is worth caching. Pinning a 502 to the edge for two
      // minutes would keep serving the failure after the upstream recovered.
      "cache-control":
        status === 200
          ? `public, max-age=${EDGE_TTL}, s-maxage=${EDGE_TTL}, stale-while-revalidate=300`
          : "no-store",
    },
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);

  /*
   * The parameters are read as text first. `Number(null)` and `Number("")` are
   * both 0, which is a real coordinate in the Gulf of Guinea, so a caller that
   * forgot the parameters altogether used to get a confident answer for a point
   * in the Atlantic instead of being told it had asked wrong.
   */
  const latText = url.searchParams.get("lat");
  const lonText = url.searchParams.get("lon");
  const lat = Number(latText);
  const lon = Number(lonText);

  const missing = !latText?.trim() || !lonText?.trim();
  const outOfRange =
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180;

  if (missing || outOfRange) {
    return json({ error: "lat and lon must be valid coordinates" }, 400);
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT)
  );

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return json({ error: "upstream unreachable" }, 504);
  }

  if (!upstream.ok) return json({ error: "upstream failed" }, 502);

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json({ error: "upstream returned malformed json" }, 502);
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];

  const near = [];
  for (const row of rows) {
    const stationLat = Number(row.station?.tele_station_lat);
    const stationLon = Number(row.station?.tele_station_long);
    if (!row.station?.id) continue;
    if (!Number.isFinite(stationLat) || !Number.isFinite(stationLon)) continue;

    const km = distanceKm(lat, lon, stationLat, stationLon);
    if (km > MAX_RADIUS_KM) continue;

    near.push(trim(row, km));
  }

  near.sort((a, b) => a.km - b.km);

  return json({ total: rows.length, stations: near.slice(0, limit) });
}
