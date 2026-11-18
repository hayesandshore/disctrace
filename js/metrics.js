// Numbers derived from a capture's rows. Pure functions, no Bluetooth and no DOM.

export const G = 9.80665;

/** Distance from the disc's centre to the ADXL375 board centre in the
 *  Prototype 1 holder CAD. The real chip-to-axis distance must be measured. */
export const DEFAULT_RADIUS_MM = 29.1;

/** Below this in-plane pull the ±200 g sensor (0.049 g per step) is mostly
 *  noise, so no spin estimate is given. About 96 RPM at 29.1 mm. */
export const MIN_PULL_G = 0.3;

const RPM_PER_RAD_S = 30 / Math.PI;
const STILL_RAD_S = 0.2;

/** Average x/y reading of the high-g accelerometer while the pod sat still
 *  before the trigger. Removes the chip's zero offset and any tilt. */
export function restingOffset(rows) {
  const still = rows.filter((row) => row.t < 0
    && Math.abs(row.gx) < STILL_RAD_S && Math.abs(row.gy) < STILL_RAD_S && Math.abs(row.gz) < STILL_RAD_S);
  if (still.length < 5) return { ax: 0, ay: 0 };
  const sum = still.reduce((acc, row) => ({ ax: acc.ax + row.ax, ay: acc.ay + row.ay }), { ax: 0, ay: 0 });
  return { ax: sum.ax / still.length, ay: sum.ay / still.length };
}

const pullG = (row, offset) => Math.hypot(row.ax - offset.ax, row.ay - offset.ay);

/** Spin in RPM for each row from the off-centre accelerometer: a sensor at
 *  radius r on a disc spinning at w feels an inward pull of w^2 * r. Null where
 *  the pull is under the noise floor. Only meaningful while the disc's centre
 *  is not itself accelerating hard (steady spin or flight, not the throw). */
export function estimatedSpin(rows, radiusMm, offset) {
  const radiusM = radiusMm / 1000;
  return rows.map((row) => {
    const pull = pullG(row, offset);
    return pull < MIN_PULL_G ? null : Math.sqrt((pull * G) / radiusM) * RPM_PER_RAD_S;
  });
}

/** Works out the sensor's real distance from the spin axis from samples where
 *  the gyro can still read the spin directly. Least-squares fit of
 *  pull = w^2 * r. Null unless the capture has enough such samples. */
export function calibrateRadius(rows, offset) {
  let top = 0;
  let bottom = 0;
  let samples = 0;
  for (const row of rows) {
    if (row.rpm === null || Math.abs(row.rpm) < 100) continue;
    const pull = pullG(row, offset);
    if (pull < MIN_PULL_G) continue;
    const w2 = (row.rpm / RPM_PER_RAD_S) ** 2;
    top += pull * G * w2;
    bottom += w2 * w2;
    samples += 1;
  }
  if (samples < 20) return null;
  return { radiusMm: (top / bottom) * 1000, samples };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Largest value after a five-sample median filter, so a single impact spike
// (landing, a knock) cannot set the peak.
function robustPeak(values) {
  let peak = null;
  for (let i = 0; i < values.length; i++) {
    const window = values.slice(Math.max(0, i - 2), i + 3).filter((value) => value !== null);
    if (window.length < 3) continue;
    const mid = median(window);
    if (peak === null || mid > peak) peak = mid;
  }
  return peak;
}

/** Everything the throw page shows, from parsed rows and the radius setting. */
export function analyse(rows, { radiusMm }) {
  const offset = restingOffset(rows);
  const estRpm = estimatedSpin(rows, radiusMm, offset);
  const durationS = (rows[rows.length - 1].t - rows[0].t) / 1000;
  let maxGapMs = 0;
  let peakG = 0;
  let peakGyroRpm = null;
  let gyroLimited = false;
  const accelG = [];
  rows.forEach((row, i) => {
    if (i) maxGapMs = Math.max(maxGapMs, row.t - rows[i - 1].t);
    const magnitude = Math.hypot(row.ax, row.ay, row.az);
    accelG.push(magnitude);
    peakG = Math.max(peakG, magnitude);
    if (row.rpm !== null) peakGyroRpm = Math.max(peakGyroRpm ?? 0, Math.abs(row.rpm));
    gyroLimited ||= row.nearLimit;
  });
  const hasImu = rows[0].imu !== null;
  return {
    sampleCount: rows.length,
    durationS,
    rateHz: durationS > 0 ? (rows.length - 1) / durationS : 0,
    maxGapMs,
    peakG,
    peakGyroRpm,
    gyroLimited,
    peakEstRpm: robustPeak(estRpm),
    offset,
    calibration: calibrateRadius(rows, offset),
    series: {
      t: rows.map((row) => row.t / 1000),
      gyroRpm: rows.map((row) => (row.rpm === null ? null : Math.abs(row.rpm))),
      estRpm,
      accelG,
      ax: rows.map((row) => row.ax),
      ay: rows.map((row) => row.ay),
      az: rows.map((row) => row.az),
      gx: rows.map((row) => row.gx),
      gy: rows.map((row) => row.gy),
      imuG: hasImu ? rows.map((row) => Math.hypot(row.imu.x, row.imu.y, row.imu.z)) : null,
    },
  };
}
