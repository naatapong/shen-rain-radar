import test from "node:test";
import assert from "node:assert/strict";
import {
  bearing,
  CLASSES,
  findMotion,
  intensity,
  MAX_DIRECTION_SPREAD,
  MAX_SCATTER_KMH,
  MAX_SPEED_KMH,
  metresPerPixel,
  motionVerdict,
  nowcast,
  REASONS,
  tileIndex,
  trustFor,
  vectorStats,
} from "../src/nowcast.js";

/*
 * nowcast.js reaches for a canvas only inside readFrame, so everything up to
 * the tile fetch is testable in node. What is not covered here is the pixel
 * reading itself, which needs a real browser.
 */

test("transparent and near-transparent pixels are not rain", () => {
  assert.equal(intensity(255, 0, 0, 0), 0);
  assert.equal(intensity(255, 0, 0, 19), 0);
});

test("the palette's colour families map to the published ordering", () => {
  assert.equal(intensity(210, 40, 40, 255), 5); // red
  assert.equal(intensity(240, 150, 40, 255), 4); // orange
  assert.equal(intensity(240, 220, 60, 255), 3); // yellow
  assert.equal(intensity(60, 120, 220, 255), 2); // blue
  assert.equal(intensity(200, 170, 150, 200), 1); // the sand step below rain
});

test("every intensity has a class to name it", () => {
  for (const value of [0, 1, 2, 3, 4, 5]) {
    assert.ok(CLASSES[value], `no class for intensity ${value}`);
    assert.ok(CLASSES[value].label.length > 0);
  }
});

test("tile indices follow the Web Mercator convention", () => {
  const origin = tileIndex(0, 0, 0);
  assert.ok(Math.abs(origin.x - 0.5) < 1e-9);
  assert.ok(Math.abs(origin.y - 0.5) < 1e-9);

  // Longitude runs left to right, latitude runs top to bottom.
  assert.ok(tileIndex(0, 10, 7).x > tileIndex(0, -10, 7).x);
  assert.ok(tileIndex(20, 0, 7).y < tileIndex(0, 0, 7).y);
});

test("pixel scale shrinks with zoom and with latitude", () => {
  assert.ok(Math.abs(metresPerPixel(0, 0) - 156543.03392) < 1e-3);
  assert.ok(Math.abs(metresPerPixel(0, 1) - metresPerPixel(0, 0) / 2) < 1e-6);
  assert.ok(metresPerPixel(60, 7) < metresPerPixel(0, 7));
});

test("screen vectors read as compass bearings", () => {
  // Screen y grows southward, so a negative dy is northward movement.
  assert.equal(bearing(0, -1).degrees, 0);
  assert.equal(bearing(0, -1).name, "เหนือ");
  assert.equal(bearing(1, 0).degrees, 90);
  assert.equal(bearing(1, 0).name, "ตะวันออก");
  assert.equal(bearing(0, 1).degrees, 180);
  assert.equal(bearing(0, 1).name, "ใต้");
  assert.equal(bearing(-1, 0).degrees, 270);
  assert.equal(bearing(-1, 0).name, "ตะวันตก");
});

test("agreeing pairs average out with no disagreement to report", () => {
  const stats = vectorStats([
    { dx: 2, dy: -1 },
    { dx: 2, dy: -1 },
    { dx: 2, dy: -1 },
  ]);
  assert.equal(stats.dx, 2);
  assert.equal(stats.dy, -1);
  assert.equal(stats.scatterCells, 0);
  assert.equal(stats.spreadDegrees, 0);
});

test("scatter is the worst pair's distance from the average", () => {
  const stats = vectorStats([
    { dx: 0, dy: -4 },
    { dx: 0, dy: -6 },
  ]);
  assert.equal(stats.dy, -5);
  assert.equal(stats.scatterCells, 1);
});

/*
 * The case speed scatter cannot see: two pairs of equal length pointing 90
 * degrees apart average to a plausible north-east drift at a plausible speed,
 * while neither pair actually observed that.
 */
test("bearings that disagree are reported even when the speeds match", () => {
  const stats = vectorStats([
    { dx: 0, dy: -4 },
    { dx: 4, dy: 0 },
  ]);
  assert.ok(Math.abs(stats.spreadDegrees - 45) < 1e-6);
});

test("bearings either side of north are close, not 350 degrees apart", () => {
  const stats = vectorStats([
    { dx: -1, dy: -6 },
    { dx: 1, dy: -6 },
  ]);
  assert.ok(stats.spreadDegrees < 12, `got ${stats.spreadDegrees}`);
});

test("a stationary field has no bearing to disagree about", () => {
  const stats = vectorStats([
    { dx: 0, dy: 0 },
    { dx: 0, dy: 0 },
  ]);
  assert.equal(stats.spreadDegrees, 0);
});

test("a stationary pair does not vote against the ones that moved", () => {
  const stats = vectorStats([
    { dx: 6, dy: 0 },
    { dx: 6, dy: 0 },
    { dx: 0, dy: 0 },
  ]);
  assert.ok(stats.spreadDegrees < 1, `got ${stats.spreadDegrees}`);
});

/* The quality gate --------------------------------------------------------- */

const sound = { speedKmh: 30, scatterKmh: 5, spreadDegrees: 5, pairs: 3 };

test("a steady, plausible drift passes the gate", () => {
  assert.equal(motionVerdict(sound), null);
});

test("no usable pair is a scattered-echo refusal", () => {
  assert.equal(motionVerdict({ ...sound, pairs: 0 }), REASONS.echo);
});

test("a search pinned at its maximum speed is refused", () => {
  assert.equal(
    motionVerdict({ ...sound, speedKmh: MAX_SPEED_KMH + 1 }),
    REASONS.speed
  );
  assert.equal(motionVerdict({ ...sound, speedKmh: MAX_SPEED_KMH }), null);
});

test("pairs that disagree on speed are refused", () => {
  assert.equal(
    motionVerdict({ ...sound, scatterKmh: MAX_SCATTER_KMH + 1 }),
    REASONS.scatter
  );
});

test("pairs that disagree on direction are refused", () => {
  assert.equal(
    motionVerdict({ ...sound, spreadDegrees: MAX_DIRECTION_SPREAD + 1 }),
    REASONS.direction
  );
  assert.equal(
    motionVerdict({ ...sound, spreadDegrees: MAX_DIRECTION_SPREAD }),
    null
  );
});

test("every refusal carries a reason a reader can act on", () => {
  for (const reason of Object.values(REASONS)) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 8, `reason too terse: ${reason}`);
  }
});

test("confidence falls with either kind of disagreement", () => {
  assert.equal(trustFor({ scatterKmh: 3, pairs: 3, spreadDegrees: 4 }).key, "high");
  assert.equal(trustFor({ scatterKmh: 20, pairs: 3, spreadDegrees: 4 }).key, "medium");
  assert.equal(trustFor({ scatterKmh: 3, pairs: 3, spreadDegrees: 20 }).key, "medium");
  assert.equal(trustFor({ scatterKmh: 40, pairs: 3, spreadDegrees: 4 }).key, "low");
  assert.equal(trustFor({ scatterKmh: 3, pairs: 3, spreadDegrees: 40 }).key, "low");
  // A single pair has nothing to be checked against, whatever it reports.
  assert.equal(trustFor({ scatterKmh: 0, pairs: 1, spreadDegrees: 0 }).key, "low");
});

/* The motion search itself ------------------------------------------------- */

function field(size, blocks) {
  const grid = new Float32Array(size * size);
  for (const { x, y, w, h, value } of blocks) {
    for (let j = y; j < y + h; j += 1) {
      for (let i = x; i < x + w; i += 1) grid[j * size + i] = value;
    }
  }
  return grid;
}

test("the search recovers a known translation", () => {
  const size = 48;
  // The echo has to cover at least MIN_ECHO_CELLS for the search to consider a
  // candidate at all, which is what keeps it off isolated speckle.
  const previous = field(size, [{ x: 16, y: 16, w: 8, h: 8, value: 5 }]);
  // current[y][x] === previous[y - dy][x - dx], so this block moved by (2, -1).
  const current = field(size, [{ x: 18, y: 15, w: 8, h: 8, value: 5 }]);

  const found = findMotion(previous, current, size, { x: 24, y: 24 });
  assert.ok(found, "no motion found at all");
  assert.equal(found.dx, 2);
  assert.equal(found.dy, -1);
  assert.equal(found.score, 0, "an exact translation should score perfectly");
});

test("an echo too small to be anything but speckle is not tracked", () => {
  const size = 48;
  const previous = field(size, [{ x: 16, y: 16, w: 3, h: 3, value: 5 }]);
  const current = field(size, [{ x: 18, y: 15, w: 3, h: 3, value: 5 }]);
  assert.equal(findMotion(previous, current, size, { x: 24, y: 24 }), null);
});

test("the search reports nothing when there is nothing to match", () => {
  const size = 48;
  const empty = field(size, []);
  assert.equal(findMotion(empty, empty, size, { x: 24, y: 24 }), null);
});

/* The entry point's own guards --------------------------------------------- */

test("too little history is a refusal with a reason, never a null", async () => {
  for (const frames of [null, undefined, [], [{ time: 1, path: "/a" }]]) {
    const result = await nowcast({ frames, host: "https://example.test", lat: 19, lon: 99 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASONS.frames);
  }
});
