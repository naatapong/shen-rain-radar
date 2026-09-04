/*
 * Radar nowcast by Lagrangian persistence.
 *
 * RainViewer withdrew its public future-radar product at the start of 2026, but
 * the observed frames are still open and served with permissive CORS, so the
 * short-range answer can be worked out here instead: line up the recent frames,
 * find the single translation that best explains how the echo moved, and carry
 * the current frame along that vector. What is over you in twenty minutes is
 * whatever is twenty minutes upwind of you now.
 *
 * The horizon is two hours, which means the ten-minute displacement gets
 * multiplied by twelve — and so does any error in it. A vector taken from a
 * single pair of frames is not steady enough to survive that, so the estimate is
 * averaged over several consecutive pairs and how far those pairs disagree
 * becomes the confidence reported alongside the answer.
 *
 * This still assumes rain drifts without growing or decaying, so the result is
 * always labelled as extrapolation rather than forecast.
 *
 * Every exit says why. A silent null made the strip vanish with no explanation,
 * which reads as "no rain coming" when it actually means "cannot tell" — the
 * opposite of what the caller should hear. The only failure shape now is
 * `{ ok: false, reason }`.
 */

const TILE = 256;
const ZOOM = 7; // the public tile service does not serve past this
const GRID = 3; // 3x3 tiles keeps the upwind area on the canvas
const CANVAS = TILE * GRID;

const COARSE = 4; // motion search runs on a 4x downsampled copy
const SEARCH = 6; // +/- 6 coarse cells is about 165 km/h at this zoom
const FRAME_GAP_MINUTES = 10;

// Pairs of frames averaged into the motion estimate. Three pairs spans the last
// forty minutes and costs four frames of tiles.
const MOTION_PAIRS = 3;

const HORIZON_MINUTES = 120;
const STEP_MINUTES = 10;

// Past this point persistence has had long enough to be overtaken by cells
// forming and dying, so the strip says so rather than pretending otherwise.
const FIRM_MINUTES = 60;

// Minimum share of the canvas that must hold echo before a motion estimate is
// trusted. Below this the search is matching noise.
const MIN_ECHO_CELLS = 40;
export const MAX_SPEED_KMH = 120;
export const MAX_SCATTER_KMH = 45;

/*
 * Two pairs can agree on speed and still disagree on where the rain is going —
 * an echo growing on its upwind flank looks like drift the other way. Speed
 * scatter does not catch that, so the bearings are checked on their own: a pair
 * further than this off the consensus means the field is changing shape rather
 * than drifting, and there is no honest vector to project forward.
 */
export const MAX_DIRECTION_SPREAD = 45;

// Under one coarse cell of displacement a pair has no meaningful bearing, so it
// is left out of the direction vote instead of dragging it around.
const MIN_VECTOR_CELLS = 1;

export const REASONS = {
  frames: "ยังไม่มีภาพเรดาร์ย้อนหลังพอจะจับการเคลื่อนตัว",
  echo: "ฝนแถวนี้น้อยหรือกระจัดกระจายเกินกว่าจะจับทิศทางได้",
  speed: "ความเร็วที่จับได้สูงเกินจริง",
  scatter: "การเคลื่อนตัวไม่คงที่พอจะยืดออกไปข้างหน้า",
  direction: "แต่ละช่วงเวลาให้ทิศทางไม่ตรงกัน",
  offCanvas: "กลุ่มฝนเคลื่อนออกนอกกรอบภาพที่ดึงมาได้",
};

const unable = (reason) => ({ ok: false, reason });

/*
 * The public tiles come back in one fixed palette — the colour-scheme segment in
 * the tile path is ignored on the free service — so intensity is read off the
 * palette's colour families. This is the ordering every weather radar uses:
 * blue is light, yellow is moderate, orange and red are heavy. No attempt is
 * made to turn a colour back into millimetres, which the palette cannot support.
 */
export const CLASSES = [
  { key: "dry", label: "ไม่มีฝน" },
  { key: "trace", label: "ฝนประปราย" },
  { key: "light", label: "ฝนเบา" },
  { key: "moderate", label: "ฝนปานกลาง" },
  { key: "heavy", label: "ฝนหนัก" },
  { key: "violent", label: "ฝนหนักมาก" },
];

export function intensity(r, g, b, a) {
  if (a < 20) return 0;

  // Semi-transparent sand tones sit below the first real reflectivity step.
  if (r > 170 && g > 150 && b < 190 && a < 230) return 1;

  if (r > 200 && g < 90) return 5; // red
  if (r > 200 && g < 180 && b < 90) return 4; // orange
  if (r > 200 && g > 150 && b < 120) return 3; // yellow
  if (b > 120 && b >= g) return 2; // the whole blue ramp

  return 1;
}

export function tileIndex(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`tile failed: ${url}`));
    image.src = url;
  });
}

/*
 * Paints the 3x3 tile block around the target and reduces it to one intensity
 * value per pixel, plus a downsampled copy for the motion search.
 */
async function readFrame(host, path, originX, originY) {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const tiles = [];
  for (let dy = 0; dy < GRID; dy += 1) {
    for (let dx = 0; dx < GRID; dx += 1) {
      const url = `${host}${path}/${TILE}/${ZOOM}/${originX + dx}/${
        originY + dy
      }/2/0_0.png`;
      tiles.push(
        loadImage(url)
          .then((image) => context.drawImage(image, dx * TILE, dy * TILE))
          // A missing tile is ocean or out of coverage, not a failure.
          .catch(() => {})
      );
    }
  }
  await Promise.all(tiles);

  const { data } = context.getImageData(0, 0, CANVAS, CANVAS);

  const fine = new Uint8Array(CANVAS * CANVAS);
  for (let i = 0; i < fine.length; i += 1) {
    const p = i * 4;
    fine[i] = intensity(data[p], data[p + 1], data[p + 2], data[p + 3]);
  }

  const size = CANVAS / COARSE;
  const coarse = new Float32Array(size * size);
  for (let y = 0; y < CANVAS; y += 1) {
    for (let x = 0; x < CANVAS; x += 1) {
      coarse[Math.floor(y / COARSE) * size + Math.floor(x / COARSE)] +=
        fine[y * CANVAS + x];
    }
  }

  return { fine, coarse, size };
}

/*
 * Finds the whole-field translation between two frames by direct search. Cells
 * where both frames are empty are skipped so the score cannot be won by lining
 * up empty sky.
 */
export function findMotion(previous, current, size, focus) {
  let best = null;
  // Estimate the storm that can reach this point, rather than averaging a
  // distant line of storms with the air above the user. This also halves the
  // work on a phone compared with scanning the entire 3x3 block.
  const radius = Math.min(48, Math.floor(size / 3));
  const minX = Math.max(SEARCH, Math.floor(focus.x - radius));
  const maxX = Math.min(size - SEARCH, Math.ceil(focus.x + radius));
  const minY = Math.max(SEARCH, Math.floor(focus.y - radius));
  const maxY = Math.min(size - SEARCH, Math.ceil(focus.y + radius));

  for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
      let error = 0;
      let counted = 0;

      for (let y = minY; y < maxY; y += 1) {
        for (let x = minX; x < maxX; x += 1) {
          const now = current[y * size + x];
          const then = previous[(y - dy) * size + (x - dx)];
          if (now === 0 && then === 0) continue;
          const diff = now - then;
          error += diff * diff;
          counted += 1;
        }
      }

      if (counted < MIN_ECHO_CELLS) continue;

      const score = error / counted;
      if (!best || score < best.score) best = { dx, dy, score, counted };
    }
  }

  return best;
}

export function bearing(dx, dy) {
  // Screen y grows southward, so flip it before reading a compass angle.
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const compass = (degrees + 360) % 360;
  const names = [
    "เหนือ",
    "ตะวันออกเฉียงเหนือ",
    "ตะวันออก",
    "ตะวันออกเฉียงใต้",
    "ใต้",
    "ตะวันตกเฉียงใต้",
    "ตะวันตก",
    "ตะวันตกเฉียงเหนือ",
  ];
  return { degrees: compass, name: names[Math.round(compass / 45) % 8] };
}

/*
 * Reduces the per-pair vectors to one drift plus two measures of disagreement:
 * how far the pairs sit from the average, and how far the worst of them sits
 * from the consensus bearing.
 */
export function vectorStats(vectors) {
  const n = vectors.length;
  const dx = vectors.reduce((sum, v) => sum + v.dx, 0) / n;
  const dy = vectors.reduce((sum, v) => sum + v.dy, 0) / n;

  const scatterCells = Math.max(
    ...vectors.map((v) => Math.hypot(v.dx - dx, v.dy - dy))
  );

  const moving = vectors.filter(
    (v) => Math.hypot(v.dx, v.dy) >= MIN_VECTOR_CELLS
  );
  const meanAngle = Math.atan2(dx, -dy);

  // With a near-stationary consensus there is no bearing to disagree with, and
  // the magnitude gate is the one doing the work.
  const spreadDegrees =
    Math.hypot(dx, dy) < MIN_VECTOR_CELLS || moving.length < 2
      ? 0
      : Math.max(
          ...moving.map((v) => {
            const diff = Math.atan2(v.dx, -v.dy) - meanAngle;
            // Wrap into +/-180 so two bearings either side of north compare
            // close rather than 350 degrees apart.
            return (
              (Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) * 180) /
              Math.PI
            );
          })
        );

  return { dx, dy, scatterCells, spreadDegrees };
}

/*
 * The quality gate. Every case it names is one where a plausible-looking storm
 * path would be invented rather than measured, so the caller is told the drift
 * cannot be estimated instead of being handed the invention.
 */
export function motionVerdict({ speedKmh, scatterKmh, spreadDegrees, pairs }) {
  if (!pairs) return REASONS.echo;
  if (speedKmh > MAX_SPEED_KMH) return REASONS.speed;
  if (scatterKmh > MAX_SCATTER_KMH) return REASONS.scatter;
  if (spreadDegrees > MAX_DIRECTION_SPREAD) return REASONS.direction;
  return null;
}

export function trustFor({ scatterKmh, pairs, spreadDegrees }) {
  if (pairs < 2 || scatterKmh > 25 || spreadDegrees > 30) {
    return { key: "low", label: "ต่ำ" };
  }
  if (scatterKmh > 12 || spreadDegrees > 15) {
    return { key: "medium", label: "ปานกลาง" };
  }
  return { key: "high", label: "สูง" };
}

/**
 * Works out what the radar says is heading for a point.
 *
 * @param frames RainViewer's `radar.past` list, oldest first
 * @param host   the tile host from the same document
 * @returns `{ ok: true, ... }` or `{ ok: false, reason }` — never null
 */
export async function nowcast({ frames, host, lat, lon }) {
  if (!Array.isArray(frames) || frames.length < 2) return unable(REASONS.frames);

  // As many consecutive pairs as the history allows, up to the cap.
  const wanted = Math.min(MOTION_PAIRS + 1, frames.length);
  const window = frames.slice(-wanted);

  const centre = tileIndex(lat, lon, ZOOM);
  const originX = Math.floor(centre.x) - 1;
  const originY = Math.floor(centre.y) - 1;

  // Where the point sits inside the painted block.
  const px = (centre.x - originX) * TILE;
  const py = (centre.y - originY) * TILE;

  const painted = await Promise.all(
    window.map((frame) => readFrame(host, frame.path, originX, originY))
  );

  const current = painted[painted.length - 1];
  const currentFrame = window[window.length - 1];

  const vectors = [];
  const focus = { x: px / COARSE, y: py / COARSE };
  for (let i = 1; i < painted.length; i += 1) {
    const found = findMotion(
      painted[i - 1].coarse,
      painted[i].coarse,
      current.size,
      focus
    );
    if (found) vectors.push(found);
  }

  if (!vectors.length) return unable(REASONS.echo);

  /*
   * Average the pairs rather than trusting the newest one. Over a two-hour
   * horizon a single coarse cell of search error becomes 48 pixels — about 55 km
   * — so the steadier vector is worth more than the freshest one.
   */
  const { dx, dy, scatterCells, spreadDegrees } = vectorStats(vectors);

  // Coarse cells back to full-resolution pixels, then to pixels per minute.
  const perMinuteX = (dx * COARSE) / FRAME_GAP_MINUTES;
  const perMinuteY = (dy * COARSE) / FRAME_GAP_MINUTES;

  const metres = metresPerPixel(lat, ZOOM);
  const toKmh = (pixelsPerMinute) => (pixelsPerMinute * metres * 60) / 1000;

  const speedKmh = toKmh(Math.hypot(perMinuteX, perMinuteY));

  /*
   * How far the individual pairs sit from that average, in km/h. This is the
   * honest confidence signal: pairs that agree mean a steady drift that survives
   * being projected forward, pairs that scatter mean the field is changing shape
   * and the far end of the strip is guesswork.
   */
  const scatterKmh = toKmh((scatterCells * COARSE) / FRAME_GAP_MINUTES);

  const refused = motionVerdict({
    speedKmh,
    scatterKmh,
    spreadDegrees,
    pairs: vectors.length,
  });
  if (refused) return unable(refused);

  const trust = trustFor({ scatterKmh, pairs: vectors.length, spreadDegrees });

  const sample = (x, y) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= CANVAS || iy >= CANVAS) return null;
    return current.fine[iy * CANVAS + ix];
  };

  const nowValue = sample(px, py) ?? 0;

  const steps = [];
  for (let t = STEP_MINUTES; t <= HORIZON_MINUTES; t += STEP_MINUTES) {
    // What is upwind now will be overhead at t.
    const value = sample(px - perMinuteX * t, py - perMinuteY * t);
    // Running off the painted block means the source of that minute was never
    // fetched, so the strip stops there rather than reporting empty sky as dry.
    if (value === null) break;
    steps.push({
      minutes: t,
      value,
      klass: CLASSES[value],
      firm: t <= FIRM_MINUTES,
    });
  }

  // Not one usable step means the drift leaves the block within ten minutes,
  // which is a refusal rather than an answer with a short horizon.
  if (!steps.length) return unable(REASONS.offCanvas);

  const change = steps.find((step) => step.value !== nowValue);

  return {
    ok: true,
    at: currentFrame.time * 1000,
    now: CLASSES[nowValue],
    steps,
    change: change ?? null,
    // Below a few km/h the search has effectively found no movement, and a
    // direction read off it would be noise.
    moving: speedKmh >= 5,
    speedKmh,
    direction: bearing(dx, dy),
    horizonMinutes: steps[steps.length - 1].minutes,
    firmMinutes: FIRM_MINUTES,
    trust,
    scatterKmh,
    spreadDegrees,
    pairs: vectors.length,
  };
}
