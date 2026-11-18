// A simulated DGT-1 pod. It speaks the same text protocol as the firmware, in
// pieces of at most 20 bytes, so every screen can be used and tested without
// the disc. Nothing here touches Bluetooth.

import { HEADER_9, HEADER_12 } from "./protocol.js";

const G = 9.80665;
const RPM_PER_RAD_S = 30 / Math.PI;
const WARN_RAD_S = (1900 * Math.PI) / 180;       // firmware flags the gyro here (316.7 RPM)
const GYRO_FULL_SCALE = (2000 * Math.PI) / 180;  // gyro cannot read past this (333.3 RPM)

const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

// Small repeatable noise source so simulated captures look like sensor data.
function noiseSource(seed) {
  let state = seed >>> 0;
  return (amplitude) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 2 * amplitude;
  };
}

// True motion of the disc at time t (seconds from the trigger).
function motion(kind, t) {
  if (kind === "handspin") {
    // Spun flat on a table by hand: quick ramp to 240 RPM, then friction.
    let rpm = 0;
    if (t >= -0.08 && t < 0.1333) rpm = (t + 0.08) * 1125;
    else if (t >= 0.1333) rpm = 240 * Math.exp(-(t - 0.1333) / 1.8);
    return { rpm: rpm < 3 ? 0 : rpm, push: 0, wobble: 0, lift: 1, impact: 0 };
  }
  // A backhand throw: pull, release at 0.12 s, about 3.5 s of flight, landing.
  const release = 0.12;
  const landing = 3.6;
  if (t < 0) return { rpm: t > -0.05 ? (t + 0.05) * 1800 : 0, push: 0, wobble: 0, lift: 1, impact: 0 };
  if (t < release) {
    const phase = t / release;
    return { rpm: 90 + 1060 * phase, push: 22 * Math.sin(Math.PI * phase), wobble: 0, lift: 1, impact: 0 };
  }
  if (t < landing) {
    const flight = t - release;
    return { rpm: 1150 * Math.exp(-flight / 14), push: 0, wobble: 1.2 * Math.exp(-flight / 0.8), lift: 0.9, impact: 0 };
  }
  const after = t - landing;
  const atLanding = 1150 * Math.exp(-(landing - release) / 14);
  return {
    rpm: after < 0.25 ? atLanding * (1 - after / 0.25) : 0,
    push: 0, wobble: 0, lift: 1,
    impact: after < 0.005 ? 1 : after < 0.015 ? 0.5 : 0,
  };
}

/** Builds the CSV rows and READY summary a pod would hold after a capture. */
export function simulateCapture(kind, { windowMs, columns, trueRadiusMm, seed = 1 }) {
  const noise = noiseSource(seed);
  const radiusM = trueRadiusMm / 1000;
  const rows = [];
  let peakG = 0;
  let peakRpm = 0;
  let limited = false;
  for (let ms = -300; ms <= windowMs; ms += 10) {
    const t = ms / 1000;
    const { rpm, push, wobble, lift, impact } = motion(kind, t);
    const spin = rpm / RPM_PER_RAD_S;
    const pull = (spin * spin * radiusM) / G;       // inward pull at the sensor, in g
    // ADXL375: +/-200 g, 0.049 g steps, with a resting offset on each axis.
    const step = (value) => clamp(Math.round(value / 0.049) * 0.049, 200);
    const ax = step(0.35 - 0.6 * pull + push + 35 * impact + noise(0.03));
    const ay = step(-0.2 + 0.8 * pull - 50 * impact + noise(0.03));
    const az = step(0.1 + lift + 60 * impact + noise(0.03));
    // LSM6DS3TR-C: gyro saturates at 2000 dps, accelerometer at +/-16 g.
    const gz = clamp(spin, GYRO_FULL_SCALE) + noise(0.002);
    const gx = wobble * Math.sin(2 * Math.PI * 7 * t) + noise(0.002);
    const gy = wobble * Math.cos(2 * Math.PI * 7 * t) + noise(0.002);
    const flag = Math.abs(gz) >= WARN_RAD_S;
    const fields = [
      ms.toFixed(3), ax.toFixed(3), ay.toFixed(3), az.toFixed(3),
      gx.toFixed(4), gy.toFixed(4), gz.toFixed(4),
      flag ? "" : (gz * RPM_PER_RAD_S).toFixed(2), flag ? "1" : "0",
    ];
    if (columns === 12) {
      fields.push(
        clamp(0.02 + 0.6 * pull + push + noise(0.005), 16).toFixed(3),
        clamp(-0.01 + 0.8 * pull + noise(0.005), 16).toFixed(3),
        clamp(lift + noise(0.005), 16).toFixed(3),
      );
    }
    rows.push(fields.join(","));
    peakG = Math.max(peakG, Math.hypot(ax, ay, az));
    peakRpm = Math.max(peakRpm, Math.abs(gz) * RPM_PER_RAD_S);
    limited ||= flag;
  }
  let summary = `READY samples=${rows.length} peak_g=${peakG.toFixed(2)} `
    + `peak_abs_rpm=${limited ? "NEAR_LIMIT" : peakRpm.toFixed(1)} max_gap_ms=10.0`;
  if (columns === 12) summary += " rate_hz=100.0";
  return { rows, summary };
}

export class SimPod {
  /** firmware: "1.1"; "1.0" for the firmware in the handoff ZIP (nine columns,
   *  five-second window, no INFO/BENCH, no pushed lines, no unsaved warning);
   *  or "1.0-drive" for the Drive copy of 1.0, which adds the pushed lines and
   *  the unsaved warning. speed: how many times faster than real time it runs. */
  constructor({ firmware = "1.1", speed = 1, trueRadiusMm = 31 } = {}) {
    this.kind = "sim";
    this.name = "Simulated DGT-1";
    this.firmware = firmware;
    this.speed = speed;
    this.trueRadiusMm = trueRadiusMm;
    this.connected = false;
    this.outOfRange = false;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.state = "IDLE";
    this.rows = [];
    this.summary = "";
    this.dumped = false;
    this.confirm = false;
    this.notice = null;
    this.received = [];        // every command the pod has been sent
    this.queued = [];          // commands that arrived while it was busy recording
    this.inbox = "";
    this.chain = Promise.resolve();
    this.captures = 0;
    this.faultNextDump = null; // test hooks: "drop-row", "drop-link", "stall"
    this.mute = false;         // test hook: the pod receives but never answers
    this.connectDelayMs = 0;   // test hook: how long a connection attempt takes
  }

  get modern() {
    return this.firmware === "1.1";
  }

  get pushes() {
    return this.firmware !== "1.0";
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms / this.speed));
  }

  // Transport interface ---------------------------------------------------------
  async connect() {
    if (this.connectDelayMs) await this.sleep(this.connectDelayMs);
    if (this.outOfRange) throw new Error("The simulated pod is out of range.");
    this.connected = true;
    this.inbox = "";
    this.flushNotice();
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.onDisconnect();
  }

  async write(text) {
    if (!this.connected) throw new Error("Not connected.");
    for (const char of text) {
      if (char === "\n" || char === "\r") {
        const command = this.inbox.trim().toUpperCase();
        const tooLong = this.inbox.length > 32;
        this.inbox = "";
        if (command && !tooLong) {
          this.received.push(command);
          this.chain = this.chain.then(() => this.dispatch(command));
        }
      } else {
        this.inbox += char;
      }
    }
  }

  // Controls for the demo screen and tests ----------------------------------------
  /** Starts a capture as if the armed disc had just been thrown or spun. */
  throwDisc(kind = "throw") {
    if (this.state !== "ARMED") return false;
    this.captures += 1;
    const capture = simulateCapture(kind, {
      windowMs: this.modern ? 10000 : 5000,
      columns: this.modern ? 12 : 9,
      trueRadiusMm: this.trueRadiusMm,
      seed: this.captures,
    });
    this.state = "RECORDING";
    this.sleep(this.modern ? 10000 : 5000).then(() => {
      this.rows = capture.rows;
      this.summary = capture.summary;
      this.dumped = false;
      this.confirm = false;
      this.state = "READY";
      if (this.pushes) this.notice = this.summary;
      this.flushNotice();
      const waiting = this.queued.splice(0);
      for (const command of waiting) this.chain = this.chain.then(() => this.dispatch(command));
    });
    return true;
  }

  /** Moves the pod out of Bluetooth range (true) or back in range (false). */
  setOutOfRange(out) {
    this.outOfRange = out;
    if (out && this.connected) {
      this.connected = false;
      this.inbox = "";
      this.onDisconnect();
    }
  }

  expireArm() {
    if (this.state !== "ARMED") return;
    this.state = "IDLE";
    if (this.pushes) this.notice = "IDLE armed timeout";
    this.flushNotice();
  }

  raiseSensorError() {
    if (this.state !== "ARMED") return;
    this.state = "SENSOR_ERROR";
    if (this.pushes) this.notice = "SENSOR_ERROR [Errno 5] Input/output error";
    this.flushNotice();
  }

  // Firmware behaviour --------------------------------------------------------------
  emit(line) {
    if (!this.connected) return false;
    if (this.mute) return true;
    const payload = `${line}\r\n`;
    for (let i = 0; i < payload.length; i += 20) {
      if (!this.connected) return false;
      this.onData(payload.slice(i, i + 20));
    }
    return true;
  }

  flushNotice() {
    if (this.notice && this.connected && this.emit(this.notice)) this.notice = null;
  }

  refusal() {
    const commands = this.modern ? "ARM STATUS DUMP CANCEL INFO BENCH" : "ARM STATUS DUMP CANCEL";
    return `State ${this.state}. Commands: ${commands}`;
  }

  async dispatch(command) {
    if (this.state === "RECORDING") {
      this.queued.push(command);   // the real pod reads no commands while recording
      return;
    }
    if (command === "ARM") {
      if (this.pushes && this.state === "READY" && !(this.dumped || this.confirm)) {
        this.confirm = true;
        this.emit("UNSAVED capture not dumped. Send ARM again to discard.");
        return;
      }
      this.notice = null;
      this.rows = [];
      this.state = "ARMED";
      this.emit("ARMED");
    } else if (command === "CANCEL" && this.state === "ARMED") {
      this.state = "IDLE";
      this.emit("IDLE");
    } else if (command === "STATUS") {
      this.emit(this.state === "READY" ? this.summary : this.state);
    } else if (command === "DUMP" && this.state === "READY") {
      await this.dump();
    } else if (command === "INFO" && this.modern) {
      this.emit("DGT-1 fw=1.1 target_hz=100 window_s=10 pre=30 cols=12");
    } else if (command === "BENCH" && this.modern && this.state !== "ARMED") {
      await this.sleep(1000);
      this.emit("BENCH reads_per_s=318");
    } else {
      this.emit(this.refusal());
    }
  }

  async dump() {
    const fault = this.faultNextDump;
    this.faultNextDump = null;
    const rows = fault === "drop-row" ? this.rows.filter((_, index) => index !== 100) : this.rows;
    if (!this.emit(this.modern ? HEADER_12 : HEADER_9)) return;
    for (let i = 0; i < rows.length; i++) {
      if (i === 300 && fault === "stall") return;
      if (i === 300 && fault === "drop-link") {
        this.setOutOfRange(true);
        setTimeout(() => this.setOutOfRange(false), 30);
      }
      if (!this.emit(rows[i])) return;
      if (i % 8 === 7) await this.sleep(16);
    }
    this.dumped = this.emit("END");
  }
}
