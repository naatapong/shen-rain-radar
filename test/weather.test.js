import test from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel,
  ageMinutes,
  clock,
  combineForecastModels,
  confidence,
  distanceKm,
  isStale,
  median,
  parseThaiTime,
  rate,
  summarise,
  STATION_NEAR_KM,
} from "../src/weather.js";

test("Thaiwater wall-clock timestamps remain Thailand time", () => {
  assert.equal(
    parseThaiTime("2026-09-04 07:30:00").toISOString(),
    "2026-09-04T00:30:00.000Z"
  );
});

/*
 * The bug this guards: building the date with `new Date(y, m, d, ...)` reads the
 * machine's own offset, so the same reading came out seven hours wrong for a
 * traveller in London. The assertion is on an absolute instant, which is only
 * satisfiable if the parse never consults the local zone at all.
 */
test("station timestamps do not shift with the machine's timezone", () => {
  const parsed = parseThaiTime("2026-01-15 00:00:00");
  assert.equal(parsed.getTime(), Date.UTC(2026, 0, 14, 17, 0));
});

test("a midnight reading rolls back into the previous UTC day", () => {
  assert.equal(
    parseThaiTime("2026-09-04 03:00:00").toISOString(),
    "2026-09-03T20:00:00.000Z"
  );
});

test("unparseable timestamps are refused rather than guessed", () => {
  assert.equal(parseThaiTime(""), null);
  assert.equal(parseThaiTime(null), null);
  assert.equal(parseThaiTime("2026-09-04"), null);
  assert.equal(parseThaiTime("not a date at all"), null);
});

test("the clock renders in Bangkok time whatever the machine is set to", () => {
  assert.equal(clock(new Date("2026-09-04T00:30:00Z")), "07:30");
  assert.equal(clock(new Date("nope")), "--:--");
});

test("forecast consensus aligns models by timestamp", () => {
  const series = combineForecastModels([
    { points: [{ at: 100, rate: 1 }, { at: 200, rate: 5 }] },
    { points: [{ at: 200, rate: 7 }, { at: 300, rate: 9 }] },
  ]);
  assert.equal(series.length, 1);
  assert.equal(series[0].at.getTime(), 200_000);
  assert.equal(series[0].mmPerHour, 6);
});

test("consensus reports the disagreement it hid in the median", () => {
  const series = combineForecastModels([
    { points: [{ at: 100, rate: 0 }] },
    { points: [{ at: 100, rate: 4 }] },
    { points: [{ at: 100, rate: 12 }] },
  ]);
  assert.equal(series[0].mmPerHour, 4);
  assert.equal(series[0].spread, 12);
});

test("models with no timestamp in common produce nothing", () => {
  const series = combineForecastModels([
    { points: [{ at: 100, rate: 1 }] },
    { points: [{ at: 200, rate: 1 }] },
  ]);
  assert.equal(series.length, 0);
  assert.equal(combineForecastModels([]).length, 0);
});

test("consensus honours the step limit", () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ at: i, rate: i }));
  assert.equal(combineForecastModels([{ points }], 8).length, 8);
});

test("median survives an empty list and an odd one", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([Number.NaN, 2, 4]), 3);
});

test("rain classes retain their published boundaries", () => {
  assert.equal(rate(0).key, "dry");
  assert.equal(rate(0.09).key, "dry");
  assert.equal(rate(0.1).key, "light");
  assert.equal(rate(1.99).key, "light");
  assert.equal(rate(2).key, "moderate");
  assert.equal(rate(9.99).key, "moderate");
  assert.equal(rate(10).key, "heavy");
  assert.equal(rate(35).key, "violent");
  assert.equal(rate(500).key, "violent");
});

test("staleness has an explicit source-specific threshold", () => {
  assert.equal(isStale(new Date(0), 10, 600_001), true);
  assert.equal(isStale(new Date(0), 10, 600_000), false);
  assert.equal(isStale(null, 10, 0), true);
});

test("data age is reported in whole minutes, never negative", () => {
  const at = new Date(1_000_000_000_000);
  assert.equal(ageMinutes(at, at.getTime()), 0);
  assert.equal(ageMinutes(at, at.getTime() + 18 * 60_000), 18);
  // A source publishing a timestamp a little ahead of us is not "-2 minutes old".
  assert.equal(ageMinutes(at, at.getTime() - 120_000), 0);
  assert.equal(ageMinutes(null, 0), null);
  assert.equal(ageMinutes(new Date("nope"), 0), null);
});

test("age labels roll over from minutes into hours", () => {
  const at = new Date(1_000_000_000_000);
  const later = (minutes) => at.getTime() + minutes * 60_000;
  assert.equal(ageLabel(at, later(0)), "เมื่อสักครู่");
  assert.equal(ageLabel(at, later(18)), "18 นาทีที่แล้ว");
  assert.equal(ageLabel(at, later(59)), "59 นาทีที่แล้ว");
  assert.equal(ageLabel(at, later(60)), "1 ชม. ที่แล้ว");
  assert.equal(ageLabel(at, later(95)), "1 ชม. 35 นาทีที่แล้ว");
  assert.equal(ageLabel(null, 0), null);
});

test("distance is great-circle, not planar", () => {
  assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.19) < 0.5);
  assert.equal(distanceKm(19.917, 99.215, 19.917, 99.215), 0);
  const bangkokToChiangMai = distanceKm(13.7563, 100.5018, 18.7883, 98.9853);
  assert.ok(bangkokToChiangMai > 570 && bangkokToChiangMai < 595);
});

test("model agreement is graded on spread", () => {
  assert.equal(confidence(0).key, "high");
  assert.equal(confidence(0.8).key, "high");
  assert.equal(confidence(0.81).key, "medium");
  assert.equal(confidence(2.5).key, "medium");
  assert.equal(confidence(2.51).key, "low");
});

/* The headline's choice of source ---------------------------------------- */

const seriesAt = (minutes, mmPerHour) => ({
  at: new Date(Date.now() + minutes * 60_000),
  mmPerHour,
  spread: 0,
});

test("a nearby gauge is the headline, because it is a measurement", () => {
  const summary = summarise(
    { mmPerHour: 5, km: 3 },
    { series: [seriesAt(15, 5)] },
    { ok: true, now: { key: "dry", label: "ไม่มีฝน" } }
  );
  assert.equal(summary.basis, "station");
  assert.equal(summary.now.key, "moderate");
});

/*
 * The bug this guards: the gauge publishes an hourly accumulation, so at the
 * onset of rain a nearby station still reads 0.0. It used to carry the headline
 * anyway, which printed "no rain" directly above a radar strip drawing rain.
 */
test("a dry gauge cannot outrank radar echo overhead", () => {
  const summary = summarise({ mmPerHour: 0, km: 3 }, null, {
    ok: true,
    now: { key: "light", label: "ฝนเบา" },
  });
  assert.equal(summary.basis, "radar");
  assert.equal(summary.now.key, "light");
});

test("a nearby gauge still wins when the radar sees nothing", () => {
  const summary = summarise({ mmPerHour: 0, km: 3 }, null, {
    ok: true,
    now: { key: "dry", label: "ไม่มีฝน" },
  });
  assert.equal(summary.basis, "station");
  assert.equal(summary.now.key, "dry");
});

test("a far gauge hands the headline to the radar overhead", () => {
  const summary = summarise(
    { mmPerHour: 5, km: STATION_NEAR_KM + 10 },
    null,
    { ok: true, now: { key: "dry", label: "ไม่มีฝน" } }
  );
  assert.equal(summary.basis, "radar");
  assert.equal(summary.now.key, "dry");
});

test("the near/far handover is at the published threshold", () => {
  const radar = { ok: true, now: { key: "dry", label: "ไม่มีฝน" } };
  assert.equal(summarise({ mmPerHour: 5, km: STATION_NEAR_KM }, null, radar).basis, "station");
  assert.equal(
    summarise({ mmPerHour: 5, km: STATION_NEAR_KM + 0.1 }, null, radar).basis,
    "radar"
  );
});

test("a far gauge with no usable radar is still used, and says so", () => {
  const summary = summarise({ mmPerHour: 5, km: 40 }, null, {
    ok: false,
    reason: "ฝนกระจัดกระจาย",
  });
  assert.equal(summary.basis, "station-far");
  assert.equal(summary.now.key, "moderate");
});

test("with no measurement at all the model carries the headline", () => {
  const summary = summarise(null, { series: [seriesAt(15, 20)] }, null);
  assert.equal(summary.basis, "model");
  assert.equal(summary.now.key, "heavy");
});

test("with nothing at all the answer is dry and unsourced", () => {
  const summary = summarise(null, null, null);
  assert.equal(summary.basis, "none");
  assert.equal(summary.now.key, "dry");
  assert.equal(summary.outlook, null);
});

/*
 * Guards a mix-up that produced nonsense: the radar palette has a class the
 * gauge scale does not, so comparing the model series against the radar's
 * current class reported a change of class at the first step every time.
 */
test("the model outlook is measured against the model's own present", () => {
  const summary = summarise(
    { mmPerHour: 0, km: 40 },
    { series: [seriesAt(15, 0), seriesAt(30, 0)] },
    { ok: true, now: { key: "trace", label: "ฝนประปราย" } }
  );
  assert.equal(summary.basis, "radar");
  assert.equal(summary.outlook, "อีก 2 ชั่วโมงข้างหน้ายังไม่มีฝน");
});

test("the outlook names when the class changes and which way", () => {
  const rising = summarise({ mmPerHour: 0, km: 2 }, { series: [seriesAt(30, 6)] }, null);
  assert.equal(rising.outlook, "อีก 30 นาที หนักขึ้นเป็นฝนปานกลาง");

  const stopping = summarise({ mmPerHour: 6, km: 2 }, { series: [seriesAt(45, 0)] }, null);
  assert.equal(stopping.outlook, "อีก 45 นาที ฝนหยุด");
});
