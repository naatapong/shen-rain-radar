import test from "node:test";
import assert from "node:assert/strict";
import { distanceKm, onRequestGet, trim } from "../functions/api/stations.js";

/*
 * The edge function is the app's only server-side code, and the app cannot tell
 * a wrong answer from a right one — a station 400 km away sorted first looks
 * exactly like a station next door. So its contract is pinned here: what it
 * rejects, what it does when the upstream misbehaves, and what it must never
 * cache.
 */

const ask = (query) =>
  onRequestGet({ request: new Request(`https://shen.test/api/stations?${query}`) });

function station(id, lat, lon, extra = {}) {
  return {
    station: {
      id,
      tele_station_name: { th: `สถานี ${id}` },
      tele_station_lat: String(lat),
      tele_station_long: String(lon),
    },
    geocode: { province_name: { th: "เชียงใหม่" }, amphoe_name: { th: "ฝาง" } },
    agency: { agency_shortname: { th: "สสน." } },
    rain_1h: 1.5,
    rain_24h: 12,
    rainfall_datetime: "2026-09-04 07:00:00",
    ...extra,
  };
}

function stubUpstream(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const jsonUpstream = (data, init = {}) => () =>
  Promise.resolve(
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      ...init,
    })
  );

test("coordinates outside the real range are refused", async () => {
  for (const query of [
    "",
    "lat=19.9",
    "lon=99.2",
    "lat=abc&lon=99.2",
    "lat=91&lon=99.2",
    "lat=-91&lon=99.2",
    "lat=19.9&lon=181",
    "lat=19.9&lon=-181",
    "lat=NaN&lon=NaN",
    "lat=Infinity&lon=99",
  ]) {
    const response = await ask(query);
    assert.equal(response.status, 400, `accepted "${query}"`);
  }
});

test("a refusal is never cached at the edge", async () => {
  const response = await ask("lat=999&lon=999");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the boundary coordinates themselves are accepted", async () => {
  const restore = stubUpstream(jsonUpstream({ data: [] }));
  try {
    for (const query of ["lat=90&lon=180", "lat=-90&lon=-180", "lat=0&lon=0"]) {
      const response = await ask(query);
      assert.equal(response.status, 200, `rejected "${query}"`);
    }
  } finally {
    restore();
  }
});

test("stations come back nearest first", async () => {
  const restore = stubUpstream(
    jsonUpstream({
      data: [
        station("far", 18.0, 99.215),
        station("near", 19.92, 99.215),
        station("middle", 19.0, 99.215),
      ],
    })
  );
  try {
    const body = await (await ask("lat=19.917&lon=99.215&limit=3")).json();
    assert.deepEqual(
      body.stations.map((s) => s.id),
      ["near", "middle", "far"]
    );
    assert.ok(body.stations[0].km < 1);
    assert.equal(body.total, 3);
  } finally {
    restore();
  }
});

test("the limit is honoured and clamped into a sane range", async () => {
  const data = {
    data: Array.from({ length: 12 }, (_, i) => station(`s${i}`, 19.9 + i / 100, 99.2)),
  };

  const restore = stubUpstream(jsonUpstream(data));
  try {
    const one = await (await ask("lat=19.917&lon=99.215&limit=1")).json();
    assert.equal(one.stations.length, 1);

    const dflt = await (await ask("lat=19.917&lon=99.215")).json();
    assert.equal(dflt.stations.length, 8);

    // Junk and zero fall back to the default rather than returning nothing.
    const junk = await (await ask("lat=19.917&lon=99.215&limit=abc")).json();
    assert.equal(junk.stations.length, 8);
    const zero = await (await ask("lat=19.917&lon=99.215&limit=0")).json();
    assert.equal(zero.stations.length, 8);

    // The cap protects the response size, not the caller's request.
    const huge = await (await ask("lat=19.917&lon=99.215&limit=9999")).json();
    assert.ok(huge.stations.length <= 12);
  } finally {
    restore();
  }
});

test("stations beyond the radius are dropped, not merely sorted last", async () => {
  const restore = stubUpstream(
    jsonUpstream({ data: [station("antipode", -19.917, -80.785)] })
  );
  try {
    const body = await (await ask("lat=19.917&lon=99.215")).json();
    assert.equal(body.stations.length, 0);
    assert.equal(body.total, 1);
  } finally {
    restore();
  }
});

test("rows without usable coordinates are skipped", async () => {
  const restore = stubUpstream(
    jsonUpstream({
      data: [
        station("ok", 19.92, 99.215),
        station("no-id", 19.92, 99.215, { station: { tele_station_lat: "19.92" } }),
        {
          station: {
            id: "no-coords",
            tele_station_lat: "not a number",
            tele_station_long: "",
          },
        },
      ],
    })
  );
  try {
    const body = await (await ask("lat=19.917&lon=99.215")).json();
    assert.deepEqual(
      body.stations.map((s) => s.id),
      ["ok"]
    );
  } finally {
    restore();
  }
});

test("an unreachable upstream is a gateway timeout, uncached", async () => {
  const restore = stubUpstream(() => Promise.reject(new Error("network down")));
  try {
    const response = await ask("lat=19.917&lon=99.215");
    assert.equal(response.status, 504);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    restore();
  }
});

test("an upstream error is not passed off as an empty neighbourhood", async () => {
  const restore = stubUpstream(() =>
    Promise.resolve(new Response("upstream on fire", { status: 500 }))
  );
  try {
    const response = await ask("lat=19.917&lon=99.215");
    assert.equal(response.status, 502);
  } finally {
    restore();
  }
});

test("malformed upstream json is an error rather than a crash", async () => {
  const restore = stubUpstream(() =>
    Promise.resolve(
      new Response("<html>maintenance</html>", {
        headers: { "content-type": "application/json" },
      })
    )
  );
  try {
    const response = await ask("lat=19.917&lon=99.215");
    assert.equal(response.status, 502);
  } finally {
    restore();
  }
});

test("an upstream document with no data array is an empty answer, not a throw", async () => {
  const restore = stubUpstream(jsonUpstream({ result: "ok" }));
  try {
    const response = await ask("lat=19.917&lon=99.215");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.stations, []);
    assert.equal(body.total, 0);
  } finally {
    restore();
  }
});

test("a successful answer is cacheable at the edge", async () => {
  const restore = stubUpstream(jsonUpstream({ data: [station("a", 19.92, 99.215)] }));
  try {
    const response = await ask("lat=19.917&lon=99.215");
    const cache = response.headers.get("cache-control");
    assert.match(cache, /s-maxage=\d+/);
    assert.match(response.headers.get("content-type"), /application\/json/);
  } finally {
    restore();
  }
});

test("the trimmed row keeps only what the app plots", async () => {
  const trimmed = trim(station("a", 19.92, 99.215), 3.14159);
  assert.deepEqual(Object.keys(trimmed).sort(), [
    "agency",
    "amphoe",
    "at",
    "id",
    "km",
    "lat",
    "lon",
    "mmPerDay",
    "mmPerHour",
    "name",
    "province",
  ]);
  // The wall-clock string is passed through untouched; the client parses it as
  // Thailand time, which is the only place that knows the convention.
  assert.equal(trimmed.at, "2026-09-04 07:00:00");
  assert.equal(trimmed.km, 3.1);
  assert.equal(trimmed.mmPerHour, 1.5);
});

test("the trimmed row tolerates a row missing every optional field", () => {
  const trimmed = trim({ station: { id: "bare" } }, 1);
  assert.equal(trimmed.id, "bare");
  assert.equal(trimmed.name, "");
  assert.equal(trimmed.at, null);
  assert.equal(trimmed.mmPerHour, 0);
});

test("the function and the client measure distance the same way", () => {
  assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.19) < 0.5);
  assert.equal(distanceKm(19.917, 99.215, 19.917, 99.215), 0);
});
