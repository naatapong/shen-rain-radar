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

function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function trim(row, km) {
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
      "cache-control": `public, max-age=${EDGE_TTL}`,
    },
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "lat and lon are required" }, 400);
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
    });
  } catch {
    return json({ error: "upstream unreachable" }, 502);
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
