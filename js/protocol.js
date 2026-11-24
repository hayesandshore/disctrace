// DGT-1 text protocol: pure parsing and validation, no Bluetooth and no DOM.
// Shared by the web app, the simulated pod and the tests, so a native build
// could reuse the same field definitions.

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // app writes commands here
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // pod notifies replies here

export const HEADER_9 = "t_ms,ax_g,ay_g,az_g,gx_rad_s,gy_rad_s,gz_rad_s,z_rpm,z_near_limit";
export const HEADER_12 = `${HEADER_9},imu_ax_g,imu_ay_g,imu_az_g`;

/** Turns a stream of notification text into complete lines. A notification
 *  boundary means nothing: split only on LF and strip one trailing CR. */
export class LineSplitter {
  constructor() {
    this.tail = "";
  }

  push(text) {
    const parts = (this.tail + text).split("\n");
    this.tail = parts.pop();
    return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  }

  reset() {
    this.tail = "";
  }
}

function keyValues(parts) {
  const out = {};
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

function parseReady(line) {
  const kv = keyValues(line.split(" ").slice(1));
  const samples = Number(kv.samples);
  const peakG = Number(kv.peak_g);
  const maxGapMs = Number(kv.max_gap_ms);
  const nearLimit = kv.peak_abs_rpm === "NEAR_LIMIT";
  const peakAbsRpm = nearLimit ? null : Number(kv.peak_abs_rpm);
  if (![samples, peakG, maxGapMs].every(Number.isFinite)) return null;
  if (!nearLimit && !Number.isFinite(peakAbsRpm)) return null;
  const rateHz = kv.rate_hz === undefined ? null : Number(kv.rate_hz);
  return {
    samples, peakG, peakAbsRpm, nearLimit, maxGapMs,
    rateHz: Number.isFinite(rateHz) ? rateHz : null,
    partial: kv.partial === "1",
    raw: line,
  };
}

/** Says what one complete line from the pod is. */
export function classify(line) {
  if (line === "IDLE" || line === "ARMED" || line === "SENSOR_ERROR") {
    return { type: "state", state: line };
  }
  if (line.startsWith("READY ")) {
    const summary = parseReady(line);
    if (summary) return { type: "ready", summary };
  }
  if (line.startsWith("UNSAVED")) return { type: "unsaved" };
  let match = /^State (\w+)\. Commands:/.exec(line);
  if (match) return { type: "refused", state: match[1] };
  if (line.startsWith("DGT-1 fw=")) {
    const kv = keyValues(line.split(" ").slice(1));
    return {
      type: "info",
      info: {
        fw: kv.fw, targetHz: Number(kv.target_hz), windowS: Number(kv.window_s),
        pre: Number(kv.pre), cols: Number(kv.cols),
      },
    };
  }
  match = /^BENCH reads_per_s=(\d+)$/.exec(line);
  if (match) return { type: "bench", readsPerS: Number(match[1]) };
  if (line === "IDLE armed timeout") return { type: "notice", kind: "armed_timeout", state: "IDLE" };
  if (line.startsWith("SENSOR_ERROR ")) {
    return { type: "notice", kind: "sensor_error", state: "SENSOR_ERROR", detail: line.slice(13) };
  }
  if (line.startsWith("t_ms,")) {
    return { type: "header", columns: line === HEADER_9 ? 9 : line === HEADER_12 ? 12 : null };
  }
  if (line === "END") return { type: "end" };
  if (/^-?\d/.test(line) && line.includes(",")) return { type: "row", text: line };
  return { type: "unknown" };
}

/** Parses one CSV row. Throws with a readable reason if it is not valid. */
export function parseRow(text, columns) {
  const fields = text.split(",").map((field) => field.trim());
  if (fields.length !== columns) {
    throw new Error(`expected ${columns} columns, got ${fields.length}`);
  }
  if (fields[8] !== "0" && fields[8] !== "1") {
    throw new Error(`near-limit flag must be 0 or 1, got "${fields[8]}"`);
  }
  const nearLimit = fields[8] === "1";
  if ((fields[7] === "") !== nearLimit) {
    throw new Error("near-limit flag and empty RPM field disagree");
  }
  const number = (index) => {
    const value = fields[index] === "" ? NaN : Number(fields[index]);
    if (!Number.isFinite(value)) {
      throw new Error(`column ${index + 1} is not a number: "${fields[index]}"`);
    }
    return value;
  };
  return {
    t: number(0),
    ax: number(1), ay: number(2), az: number(3),
    gx: number(4), gy: number(5), gz: number(6),
    // An empty RPM means "above the gyro's reliable range". It must stay null:
    // zero would make a fast throw look like it stopped spinning.
    rpm: nearLimit ? null : number(7),
    nearLimit,
    imu: columns === 12 ? { x: number(9), y: number(10), z: number(11) } : null,
  };
}

/** Collects one DUMP. push() each line starting with the header; it returns
 *  true once END arrives with exactly the expected number of valid rows, and
 *  throws if anything is wrong. Until it returns true nothing may be saved. */
export class DumpCollector {
  constructor(expectedRows) {
    this.expected = expectedRows;
    this.columns = null;
    this.rows = [];
    this.lines = [];
  }

  push(line) {
    const kind = classify(line);
    if (this.columns === null) {
      if (kind.type !== "header" || !kind.columns) {
        throw new Error(`unrecognised CSV header: "${line}"`);
      }
      this.columns = kind.columns;
      this.lines.push(line);
      return false;
    }
    if (kind.type === "end") {
      if (this.rows.length !== this.expected) {
        throw new Error(`expected ${this.expected} rows, got ${this.rows.length}`);
      }
      return true;
    }
    if (kind.type !== "row") throw new Error(`unexpected line in download: "${line}"`);
    const row = parseRow(line, this.columns);
    if (this.rows.length && row.t <= this.rows[this.rows.length - 1].t) {
      throw new Error(`row time did not increase at row ${this.rows.length + 1}`);
    }
    this.rows.push(row);
    this.lines.push(line);
    return false;
  }

  /** The original CSV text, header first, without END. */
  get csv() {
    return `${this.lines.join("\n")}\n`;
  }
}

/** The text a saved throw is exported as: what the pod sent, header first. END
 *  is added only when the whole capture is known to be there, so a capture
 *  that was imported without it is still marked incomplete when read back. */
export function exportedCsv(record) {
  return record.incomplete ? record.csv : `${record.csv}END\n`;
}

/** Finds and parses a capture in saved or pasted text (a CSV file, or a
 *  terminal log that contains one). */
export function parseCapturedText(text) {
  const lines = new LineSplitter().push(`${text}\n`).map((line) => line.trim());
  const start = lines.findIndex((line) => classify(line).type === "header" && classify(line).columns);
  if (start < 0) throw new Error("No DGT-1 CSV header found in this text.");
  const columns = classify(lines[start]).columns;
  const rows = [];
  const kept = [lines[start]];
  let complete = false;
  for (const line of lines.slice(start + 1)) {
    if (line === "") continue;
    const kind = classify(line);
    if (kind.type === "end") {
      complete = true;
      break;
    }
    if (kind.type !== "row") break;
    const row = parseRow(line, columns);
    if (rows.length && row.t <= rows[rows.length - 1].t) {
      throw new Error(`row time did not increase at row ${rows.length + 1}`);
    }
    rows.push(row);
    kept.push(line);
  }
  if (!rows.length) throw new Error("The capture has a header but no rows.");
  // Prefer the READY line just before the capture; otherwise any one in the text.
  const ready = (candidates) => candidates.map(classify).filter((kind) => kind.type === "ready");
  const before = ready(lines.slice(0, start));
  const anywhere = ready(lines);
  const summary = before.length ? before[before.length - 1].summary
    : anywhere.length ? anywhere[0].summary : null;
  return { columns, rows, csv: `${kept.join("\n")}\n`, complete, summary };
}
