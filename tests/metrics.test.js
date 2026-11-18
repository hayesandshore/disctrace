import { test } from "node:test";
import assert from "node:assert/strict";

import {
  G, DEFAULT_RADIUS_MM, restingOffset, estimatedSpin, calibrateRadius, analyse,
} from "../js/metrics.js";

const RAD_PER_RPM = Math.PI / 30;

// In-plane acceleration in g felt by a sensor radiusMm from the spin axis.
const centripetalG = (rpm, radiusMm) => ((rpm * RAD_PER_RPM) ** 2 * radiusMm) / 1000 / G;

// Rows at 100 Hz. spinAt(t_ms) gives the true RPM; the in-plane pull is split
// across x and y the way an arbitrarily rotated chip would see it.
function capture({ spinAt, radiusMm = DEFAULT_RADIUS_MM, from = -300, to = 2000, offset = [0, 0], gyroLimit = 316.7 }) {
  const rows = [];
  for (let t = from; t <= to; t += 10) {
    const rpm = spinAt(t);
    const pull = centripetalG(rpm, radiusMm);
    const flagged = Math.abs(rpm) >= gyroLimit;
    rows.push({
      t, ax: offset[0] + pull * 0.6, ay: offset[1] - pull * 0.8, az: 1,
      gx: 0, gy: 0, gz: rpm * RAD_PER_RPM, rpm: flagged ? null : rpm, nearLimit: flagged, imu: null,
    });
  }
  return rows;
}

const within = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("estimated spin recovers a steady 1,000 RPM from the off-centre accelerometer", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 1000 : 0) });
  const spin = estimatedSpin(rows, DEFAULT_RADIUS_MM, restingOffset(rows));
  within(spin[spin.length - 1], 1000, 1);
});

test("estimated spin is null while the in-plane pull is under the sensor's noise floor", () => {
  const rows = capture({ spinAt: () => 60 }); // 60 RPM at 29.1 mm is about 0.12 g
  assert.ok(estimatedSpin(rows, DEFAULT_RADIUS_MM, { ax: 0, ay: 0 }).every((value) => value === null));
});

test("a resting sensor offset is measured before the trigger and removed", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 1000 : 0), offset: [0.4, -0.3] });
  const offset = restingOffset(rows);
  within(offset.ax, 0.4, 1e-9);
  within(offset.ay, -0.3, 1e-9);
  const spin = estimatedSpin(rows, DEFAULT_RADIUS_MM, offset);
  within(spin[spin.length - 1], 1000, 1);
});

test("resting offset is zero when the capture has no still rows before the trigger", () => {
  const rows = capture({ spinAt: () => 500, from: 0 });
  assert.deepEqual(restingOffset(rows), { ax: 0, ay: 0 });
});

test("a larger radius setting lowers the estimate by the square root of the ratio", () => {
  const rows = capture({ spinAt: () => 1000 });
  const offset = { ax: 0, ay: 0 };
  const near = estimatedSpin(rows, DEFAULT_RADIUS_MM, offset)[50];
  const far = estimatedSpin(rows, DEFAULT_RADIUS_MM * 2, offset)[50];
  within(far, near / Math.SQRT2, 0.01);
});

test("radius calibration recovers the true radius from a slow spin the gyro can read", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 200 : 0), radiusMm: 31 });
  const got = calibrateRadius(rows, restingOffset(rows));
  within(got.radiusMm, 31, 0.01);
  assert.equal(got.samples, 201);
});

test("radius calibration ignores rows where the gyro is at its limit", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 900 : 0) });
  assert.equal(calibrateRadius(rows, restingOffset(rows)), null);
});

test("radius calibration needs enough usable samples", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 && t < 50 ? 200 : 0) });
  assert.equal(calibrateRadius(rows, restingOffset(rows)), null);
});

test("analyse reports duration, sample rate and the longest gap from the timestamps", () => {
  const rows = capture({ spinAt: () => 0, from: -300, to: 1000 });
  rows.splice(50, 2); // two missing samples leave a 30 ms gap
  const got = analyse(rows, { radiusMm: DEFAULT_RADIUS_MM });
  within(got.durationS, 1.3, 1e-9);
  assert.equal(got.sampleCount, 129);
  within(got.rateHz, 128 / 1.3, 1e-9);
  within(got.maxGapMs, 30, 1e-9);
});

test("analyse reports peak acceleration as the largest vector magnitude", () => {
  const rows = capture({ spinAt: () => 0 });
  rows[10] = { ...rows[10], ax: 3, ay: 4, az: 12 };
  within(analyse(rows, { radiusMm: DEFAULT_RADIUS_MM }).peakG, 13, 1e-9);
});

test("analyse reports the gyro peak and whether the gyro hit its limit", () => {
  const slow = analyse(capture({ spinAt: (t) => (t >= 0 ? -150 : 0) }), { radiusMm: DEFAULT_RADIUS_MM });
  within(slow.peakGyroRpm, 150, 1e-9);
  assert.equal(slow.gyroLimited, false);
  const fast = analyse(capture({ spinAt: (t) => (t >= 0 ? 1000 : 0) }), { radiusMm: DEFAULT_RADIUS_MM });
  assert.equal(fast.gyroLimited, true);
});

test("peak estimated spin ignores a one-sample impact spike", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 1000 : 0) });
  rows[150] = { ...rows[150], ax: 150, ay: 0 }; // landing-style spike
  within(analyse(rows, { radiusMm: DEFAULT_RADIUS_MM }).peakEstRpm, 1000, 1);
});

test("peak estimated spin is null when nothing rose above the noise floor", () => {
  const got = analyse(capture({ spinAt: () => 0 }), { radiusMm: DEFAULT_RADIUS_MM });
  assert.equal(got.peakEstRpm, null);
});

test("analyse returns chart series aligned with the rows, with time in seconds", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 1000 : 100), from: -100, to: 100 });
  const { series } = analyse(rows, { radiusMm: DEFAULT_RADIUS_MM });
  assert.equal(series.t.length, rows.length);
  within(series.t[0], -0.1, 1e-12);
  within(series.gyroRpm[0], 100, 1e-9);
  assert.equal(series.gyroRpm[rows.length - 1], null);
  within(series.estRpm[rows.length - 1], 1000, 1);
  within(series.accelG[0], Math.hypot(rows[0].ax, rows[0].ay, rows[0].az), 1e-12);
  assert.equal(series.imuG, null);
});

test("analyse includes the IMU accelerometer magnitude for twelve-column captures", () => {
  const rows = capture({ spinAt: () => 0, to: 0 }).map((row) => ({ ...row, imu: { x: 0, y: 0.6, z: 0.8 } }));
  const { series } = analyse(rows, { radiusMm: DEFAULT_RADIUS_MM });
  within(series.imuG[0], 1, 1e-12);
});

test("analyse offers a radius calibration when the capture supports one", () => {
  const rows = capture({ spinAt: (t) => (t >= 0 ? 200 : 0), radiusMm: 31 });
  within(analyse(rows, { radiusMm: DEFAULT_RADIUS_MM }).calibration.radiusMm, 31, 0.01);
});
