import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HEADER_9, HEADER_12, LineSplitter, classify, parseRow, DumpCollector, parseCapturedText,
} from "../js/protocol.js";

// The original handoff fixtures were saved with CRLF; normalise so tests choose the line ending.
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

// Feed text through a splitter in pieces of the given sizes (cycled).
function linesFromPieces(text, sizes) {
  const splitter = new LineSplitter();
  const lines = [];
  for (let i = 0, k = 0; i < text.length; k++) {
    const size = sizes[k % sizes.length];
    lines.push(...splitter.push(text.slice(i, i + size)));
    i += size;
  }
  return lines;
}

// LineSplitter -----------------------------------------------------------------
test("splitter returns nothing until a line is complete", () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push("REA"), []);
  assert.deepEqual(splitter.push("DY\r\n"), ["READY"]);
});

test("splitter strips one trailing CR and accepts bare LF", () => {
  assert.deepEqual(new LineSplitter().push("IDLE\r\nARMED\n"), ["IDLE", "ARMED"]);
});

test("splitter handles a CRLF split across two notifications", () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push("IDLE\r"), []);
  assert.deepEqual(splitter.push("\nARMED\r\n"), ["IDLE", "ARMED"]);
});

test("splitter gives the same lines whatever the notification sizes", () => {
  const text = crlf(fixture("fw11/dump.txt"));
  const whole = new LineSplitter().push(text);
  for (const sizes of [[1], [20], [7, 3, 20, 1, 13], [19, 2]]) {
    assert.deepEqual(linesFromPieces(text, sizes), whole);
  }
});

test("splitter reset drops an unfinished line", () => {
  const splitter = new LineSplitter();
  splitter.push("READY samp");
  splitter.reset();
  assert.deepEqual(splitter.push("IDLE\r\n"), ["IDLE"]);
});

// classify ---------------------------------------------------------------------
test("classify recognises the plain state replies", () => {
  for (const state of ["IDLE", "ARMED", "SENSOR_ERROR"]) {
    assert.deepEqual(classify(state), { type: "state", state });
  }
});

test("classify parses the original READY summary", () => {
  const got = classify(fixture("fw10/status.txt").trim());
  assert.equal(got.type, "ready");
  assert.deepEqual(got.summary, {
    samples: 3, peakG: 1.0, peakAbsRpm: null, nearLimit: true, maxGapMs: 10.0,
    rateHz: null, partial: false, raw: "READY samples=3 peak_g=1.00 peak_abs_rpm=NEAR_LIMIT max_gap_ms=10.0",
  });
});

test("classify parses a 1.1 READY summary with rate and partial flag", () => {
  const got = classify("READY samples=231 peak_g=12.35 peak_abs_rpm=150.0 max_gap_ms=10.6 rate_hz=99.8 partial=1");
  assert.equal(got.summary.samples, 231);
  assert.equal(got.summary.peakAbsRpm, 150.0);
  assert.equal(got.summary.nearLimit, false);
  assert.equal(got.summary.rateHz, 99.8);
  assert.equal(got.summary.partial, true);
});

test("classify recognises the unsaved-capture warning", () => {
  assert.deepEqual(classify("UNSAVED capture not dumped. Send ARM again to discard."), { type: "unsaved" });
});

test("classify reads the pod state out of a refusal", () => {
  assert.deepEqual(classify("State ARMED. Commands: ARM STATUS DUMP CANCEL"),
    { type: "refused", state: "ARMED" });
});

test("classify parses INFO", () => {
  assert.deepEqual(classify("DGT-1 fw=1.1 target_hz=100 window_s=10 pre=30 cols=12"),
    { type: "info", info: { fw: "1.1", targetHz: 100, windowS: 10, pre: 30, cols: 12 } });
});

test("classify parses BENCH", () => {
  assert.deepEqual(classify("BENCH reads_per_s=412"), { type: "bench", readsPerS: 412 });
});

test("classify recognises the pushed notices", () => {
  assert.deepEqual(classify("IDLE armed timeout"), { type: "notice", kind: "armed_timeout", state: "IDLE" });
  assert.deepEqual(classify("SENSOR_ERROR [Errno 5] Input/output error"),
    { type: "notice", kind: "sensor_error", state: "SENSOR_ERROR", detail: "[Errno 5] Input/output error" });
});

test("classify recognises both CSV headers, END and data rows", () => {
  assert.deepEqual(classify(HEADER_9), { type: "header", columns: 9 });
  assert.deepEqual(classify(HEADER_12), { type: "header", columns: 12 });
  assert.deepEqual(classify("END"), { type: "end" });
  assert.equal(classify("-10.000,0.000,0.000,1.000,0.0000,0.0000,0.0000,0.00,0").type, "row");
});

test("classify marks anything else unknown", () => {
  assert.deepEqual(classify("hello there"), { type: "unknown" });
});

// parseRow ---------------------------------------------------------------------
test("parseRow reads a nine-column row", () => {
  assert.deepEqual(parseRow("0.000,0.100,-0.200,1.000,0.0100,-0.0200,12.5664,120.00,0", 9), {
    t: 0, ax: 0.1, ay: -0.2, az: 1, gx: 0.01, gy: -0.02, gz: 12.5664, rpm: 120, nearLimit: false, imu: null,
  });
});

test("parseRow reads the IMU accelerometer from a twelve-column row", () => {
  const row = parseRow("0.000,0.000,0.000,1.000,0.0000,0.0000,0.0000,0.00,0,1.500,-2.500,0.500", 12);
  assert.deepEqual(row.imu, { x: 1.5, y: -2.5, z: 0.5 });
});

test("parseRow turns an empty RPM on a flagged row into null, never zero", () => {
  const row = parseRow("10.000,0.000,0.000,1.000,0.0000,0.0000,34.0000,,1", 9);
  assert.equal(row.rpm, null);
  assert.equal(row.nearLimit, true);
});

test("parseRow rejects a row whose flag and empty RPM disagree", () => {
  assert.throws(() => parseRow("10.000,0.000,0.000,1.000,0.0000,0.0000,34.0000,,0", 9), /flag/);
  assert.throws(() => parseRow("10.000,0.000,0.000,1.000,0.0000,0.0000,34.0000,324.68,1", 9), /flag/);
});

test("parseRow rejects the wrong number of columns", () => {
  assert.throws(() => parseRow("0.000,0.000,0.000,1.000,0.0000,0.0000,0.0000,0.00,0", 12), /columns/);
});

test("parseRow rejects values that are not finite numbers", () => {
  assert.throws(() => parseRow("0.000,nan,0.000,1.000,0.0000,0.0000,0.0000,0.00,0", 9), /number/);
  assert.throws(() => parseRow("0.000,,0.000,1.000,0.0000,0.0000,0.0000,0.00,0", 9), /number/);
  assert.throws(() => parseRow("0.000,0.000,0.000,1.000,0.0000,0.0000,0.0000,0.00,2", 9), /flag/);
});

// DumpCollector ------------------------------------------------------------------
function collect(text, expected, sizes = [20]) {
  const collector = new DumpCollector(expected);
  let done = false;
  for (const line of linesFromPieces(crlf(text), sizes)) done = collector.push(line);
  return { collector, done };
}

for (const [fw, columns] of [["fw10", 9], ["fw11", 12]]) {
  test(`${fw} fixture in arbitrary pieces gives three rows, a negative time and a null RPM`, () => {
    for (const sizes of [[1], [20], [3, 17, 1, 9], [19, 2]]) {
      const { collector, done } = collect(fixture(`${fw}/dump.txt`), 3, sizes);
      assert.equal(done, true);
      assert.equal(collector.columns, columns);
      assert.equal(collector.rows.length, 3);
      assert.ok(collector.rows[0].t < 0);
      assert.equal(collector.rows[2].rpm, null);
      assert.equal(collector.rows[2].nearLimit, true);
    }
  });

  test(`${fw} fixture keeps the original CSV text for saving`, () => {
    const { collector } = collect(fixture(`${fw}/dump.txt`), 3);
    assert.equal(collector.csv, fixture(`${fw}/dump.txt`).replace(/END\r?\n?$/, ""));
  });
}

test("a dump without END never completes", () => {
  const { done } = collect(fixture("fw10/dump.txt").replace("END\n", ""), 3);
  assert.equal(done, false);
});

test("a dump missing one row is rejected at END", () => {
  const lines = fixture("fw10/dump.txt").split("\n");
  lines.splice(2, 1);
  assert.throws(() => collect(lines.join("\n"), 3), /expected 3 rows, got 2/);
});

test("a dump with an unknown header is rejected", () => {
  assert.throws(() => collect("t_ms,ax_g\n0,0\nEND\n", 1), /header/);
});

test("a dump whose times do not increase is rejected", () => {
  const text = `${HEADER_9}\n0.000,0,0,1,0,0,0,0.00,0\n0.000,0,0,1,0,0,0,0.00,0\nEND\n`;
  assert.throws(() => collect(text, 2), /time/);
});

test("a state line in the middle of a dump is rejected", () => {
  const text = `${HEADER_9}\n0.000,0,0,1,0,0,0,0.00,0\nIDLE\nEND\n`;
  assert.throws(() => collect(text, 1), /unexpected/i);
});

// parseCapturedText (CSV import) ---------------------------------------------------
test("import finds the capture inside pasted terminal output", () => {
  const pasted = "IDLE\r\nARMED\r\nREADY samples=3 peak_g=1.00 peak_abs_rpm=NEAR_LIMIT max_gap_ms=10.0\r\n"
    + crlf(fixture("fw10/dump.txt")) + "IDLE\r\n";
  const got = parseCapturedText(pasted);
  assert.equal(got.rows.length, 3);
  assert.equal(got.columns, 9);
  assert.equal(got.complete, true);
  assert.equal(got.summary.samples, 3);
});

test("import accepts a saved CSV without END but marks it incomplete", () => {
  const got = parseCapturedText(fixture("fw11/dump.txt").replace("END\n", ""));
  assert.equal(got.rows.length, 3);
  assert.equal(got.complete, false);
  assert.equal(got.summary, null);
});

test("import rejects text with no capture in it", () => {
  assert.throws(() => parseCapturedText("hello\nworld\n"), /header/i);
});
