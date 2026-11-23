import { test } from "node:test";
import assert from "node:assert/strict";

import { PodClient } from "../js/client.js";
import { SimPod } from "../js/transport-sim.js";
import { HEADER_9, HEADER_12, LineSplitter, classify } from "../js/protocol.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, what, ms = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

// A fast simulated pod and a client with short timings, already connected.
async function setup({ firmware = "1.1", ...simOptions } = {}) {
  const sim = new SimPod({ firmware, speed: 2000, ...simOptions });
  const client = new PodClient({ busyAfterMs: 15, replyTimeoutMs: 400, pollMs: 10, dumpIdleMs: 300, retryMs: 5 });
  await client.connect(sim);
  return { sim, client };
}

async function armAndThrow(sim, client, kind = "throw") {
  assert.equal(await client.arm(), "armed");
  assert.equal(sim.throwDisc(kind), true);
  await until(() => client.state.pod === "READY", "READY after the throw");
}

// The simulated pod itself -------------------------------------------------------
test("simulated pod sends replies in pieces of at most 20 bytes ending in CRLF", async () => {
  const sim = new SimPod({ speed: 2000 });
  const pieces = [];
  sim.onData = (text) => pieces.push(text);
  await sim.connect();
  await sim.write("ARM\n");
  sim.throwDisc("handspin");
  await until(() => pieces.join("").includes("READY"), "pushed READY");
  await sim.write("DUMP\n");
  await until(() => pieces.join("").includes("END\r\n"), "END");
  assert.ok(pieces.every((piece) => piece.length <= 20));
  assert.ok(pieces.some((piece) => piece.length === 20));
  const lines = new LineSplitter().push(pieces.join(""));
  assert.equal(lines[0], "ARMED");
  assert.equal(lines[2], HEADER_12);
  assert.equal(lines[lines.length - 1], "END");
});

test("simulated 1.1 pod rows match the summary it reports", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  const { rows, summary } = await client.download();
  assert.equal(rows.length, summary.samples);
  assert.equal(summary.nearLimit, true);          // a real throw is far past the gyro limit
  assert.ok(rows[0].t < 0 && rows.some((row) => row.t === 0));
  assert.ok(rows[rows.length - 1].t >= 9990);     // ten-second window
});

test("simulated hand spin stays under the gyro limit", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client, "handspin");
  assert.equal(client.state.summary.nearLimit, false);
  assert.ok(client.state.summary.peakAbsRpm > 150 && client.state.summary.peakAbsRpm < 300);
});

// Connecting ---------------------------------------------------------------------
test("on connect the client asks STATUS first, then INFO", async () => {
  const { sim, client } = await setup();
  assert.deepEqual(sim.received, ["STATUS", "INFO"]);
  assert.equal(client.state.link, "connected");
  assert.equal(client.state.pod, "IDLE");
  assert.equal(client.state.firmware, "1.1");
  assert.equal(client.state.info.cols, 12);
});

test("a pod that does not know INFO is treated as firmware 1.0", async () => {
  const { client } = await setup({ firmware: "1.0" });
  assert.equal(client.state.firmware, "1.0");
  assert.equal(client.state.info, null);
  assert.equal(client.state.pod, "IDLE");
});

test("connecting to a pod that already holds a capture shows it as READY and unsaved", async () => {
  const sim = new SimPod({ speed: 2000 });
  const first = new PodClient({ pollMs: 10 });
  await first.connect(sim);
  await armAndThrow(sim, first);
  await first.disconnect();
  const { client } = { client: new PodClient({ pollMs: 10 }) };
  await client.connect(sim);
  assert.equal(client.state.pod, "READY");
  assert.equal(client.needsDiscardConfirm, true);
});

test("the Drive version of firmware 1.0 pushes READY, warns about unsaved captures, and sends nine columns", async () => {
  const { sim, client } = await setup({ firmware: "1.0-drive" });
  assert.equal(client.state.firmware, "1.0");
  await client.arm();
  sim.received.length = 0;
  sim.throwDisc("throw");
  await until(() => client.state.pod === "READY", "pushed READY");
  assert.equal(await client.arm(), "unsaved");
  const got = await client.download();
  assert.equal(got.columns, 9);
  assert.ok(got.rows.length > 500 && got.rows.length < 540);
});

// Arming and capturing -------------------------------------------------------------
test("arm resolves once the pod replies ARMED", async () => {
  const { sim, client } = await setup();
  assert.equal(await client.arm(), "armed");
  assert.equal(client.state.pod, "ARMED");
  assert.equal(sim.received.filter((command) => command === "ARM").length, 1);
});

test("cancel returns an armed pod to IDLE", async () => {
  const { client } = await setup();
  await client.arm();
  await client.cancel();
  assert.equal(client.state.pod, "IDLE");
});

test("a 1.1 pod's pushed READY is picked up without polling", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  assert.ok(client.state.summary.samples > 1000);
  assert.equal(client.state.saved, false);
});

test("a 1.0 pod's READY is found by polling, showing RECORDING while it is silent", async () => {
  const { sim, client } = await setup({ firmware: "1.0", speed: 100 }); // 5 s window -> 50 ms
  const seen = new Set();
  client.on("change", () => seen.add(client.state.pod));
  await armAndThrow(sim, client);
  assert.ok(seen.has("RECORDING"));
  assert.ok(client.state.summary.samples > 500 && client.state.summary.samples < 540);
});

test("the client never sends ARM on its own", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  sim.setOutOfRange(true);
  await until(() => client.state.link !== "connected", "link down");
  sim.setOutOfRange(false);
  await until(() => client.state.link === "connected", "reconnect");
  await client.refresh();
  assert.equal(sim.received.filter((command) => command === "ARM").length, 1);
});

// Protecting an unsaved throw -------------------------------------------------------
test("arming over an unsaved capture reports unsaved and leaves it in place", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  assert.equal(client.needsDiscardConfirm, true);
  assert.equal(await client.arm(), "unsaved");
  assert.equal(client.state.pod, "READY");
});

test("arming again after the warning discards and arms", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  await client.arm();
  assert.equal(await client.arm(), "armed");
  assert.equal(client.state.pod, "ARMED");
  assert.equal(client.state.summary, null);
});

test("a capture marked saved no longer needs a discard confirmation", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  await client.download();
  client.markSaved();
  assert.equal(client.needsDiscardConfirm, false);
  assert.equal(await client.arm(), "armed");
});

test("a new capture after a saved one needs confirmation again", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  await client.download();
  client.markSaved();
  await armAndThrow(sim, client, "handspin");
  assert.equal(client.needsDiscardConfirm, true);
});

// Downloading ------------------------------------------------------------------------
test("download returns validated rows, the CSV text and the fresh summary", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  const got = await client.download();
  assert.equal(got.columns, 12);
  assert.ok(got.csv.startsWith(`${HEADER_12}\n`));
  assert.equal(got.csv.trim().split("\n").length, got.rows.length + 1);
  assert.equal(got.summary.samples, got.rows.length);
  assert.equal(client.state.download, null);
});

test("download asks for a fresh STATUS before DUMP", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  sim.received.length = 0;
  await client.download();
  assert.deepEqual(sim.received, ["STATUS", "DUMP"]);
});

test("download reports progress as rows arrive", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  const progress = [];
  client.on("change", () => client.state.download && progress.push(client.state.download.received));
  await client.download();
  assert.ok(progress.length > 3);
  assert.ok(progress[progress.length - 1] > 1000);
});

test("download from a 1.0 pod gives nine-column rows", async () => {
  const { sim, client } = await setup({ firmware: "1.0" });
  await armAndThrow(sim, client);
  const got = await client.download();
  assert.equal(got.columns, 9);
  assert.ok(got.csv.startsWith(`${HEADER_9}\n`));
  assert.equal(got.rows[0].imu, null);
});

test("download is refused when the pod has no capture", async () => {
  const { client } = await setup();
  await assert.rejects(client.download(), /no capture/i);
});

test("a download missing a row is rejected and nothing is returned", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  sim.faultNextDump = "drop-row";
  await assert.rejects(client.download(), /expected \d+ rows, got \d+/);
  assert.equal(client.state.download, null);
  assert.equal(client.state.pod, "READY");
});

test("a download cut off by range loss is rejected, and a retry after reconnect succeeds", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  sim.faultNextDump = "drop-link";
  await assert.rejects(client.download(), /disconnect/i);
  await until(() => client.state.link === "connected", "reconnect");
  await until(() => client.state.pod === "READY", "READY after reconnect");
  const got = await client.download();
  assert.equal(got.rows.length, got.summary.samples);
});

test("a download that stalls is rejected", async () => {
  const { sim, client } = await setup();
  await armAndThrow(sim, client);
  sim.faultNextDump = "stall";
  await assert.rejects(client.download(), /stalled/i);
});

// Range loss ---------------------------------------------------------------------------
test("losing the link while armed keeps the last known pod state and reconnects", async () => {
  const { sim, client } = await setup();
  await client.arm();
  sim.setOutOfRange(true);
  await until(() => client.state.link === "reconnecting", "reconnecting");
  assert.equal(client.state.pod, "ARMED");
  sim.throwDisc("throw");
  await sleep(20);
  sim.setOutOfRange(false);
  await until(() => client.state.link === "connected" && client.state.pod === "READY", "READY after reconnect");
});

test("disconnect on request does not try to reconnect", async () => {
  const { client } = await setup();
  await client.disconnect();
  await sleep(20);
  assert.equal(client.state.link, "disconnected");
});

test("stopping a reconnect leaves the link down even if an attempt then succeeds", async () => {
  const { sim, client } = await setup();
  sim.connectDelayMs = 40000;               // 20 ms of real time at this speed
  sim.setOutOfRange(true);
  await until(() => client.state.link === "reconnecting", "reconnecting");
  sim.setOutOfRange(false);                 // an attempt already in flight will now succeed
  await sleep(10);
  await client.disconnect();                // the user presses Stop
  await sleep(60);
  assert.equal(client.state.link, "disconnected");
  assert.equal(sim.connected, false);
});

// A pod that does not answer -----------------------------------------------------------------
// The link comes up, the pod receives commands, and nothing comes back.
// Cleanup is registered up front so a failed assertion cannot leave timers running.
async function connectSilent(t, { pollMs = 10, ...simOptions } = {}) {
  const sim = new SimPod({ speed: 2000, ...simOptions });
  sim.mute = true;
  const client = new PodClient({ busyAfterMs: 10, replyTimeoutMs: 60, pollMs, retryMs: 5 });
  t.after(() => client.disconnect());
  const seen = new Set();
  const notes = [];
  client.on("change", () => seen.add(client.state.pod));
  client.on("log", (entry) => notes.push(entry.text));
  await assert.rejects(client.connect(sim), /did not answer STATUS/);
  return { sim, client, seen, notes };
}

test("a pod that connects but never answers is not shown as recording", async (t) => {
  const { client, seen } = await connectSilent(t);
  assert.equal(client.state.link, "connected");
  assert.equal(client.state.pod, "UNKNOWN");
  assert.ok(!seen.has("RECORDING"));    // nothing says it is recording: its state was never known
});

test("a pod that never answers leaves the reason in the state", async (t) => {
  const { client } = await connectSilent(t);
  assert.equal(client.state.error, "The pod did not answer STATUS.");
});

test("an unanswered command is noted in the log", async (t) => {
  const { client, notes } = await connectSilent(t);
  assert.ok(notes.includes("The pod did not answer STATUS."));
});

test("checking again on request recovers a pod that was silent", async (t) => {
  const { sim, client } = await connectSilent(t, { pollMs: 60000 });   // no polling: only the request can do it
  sim.mute = false;
  await client.check();
  assert.equal(client.state.pod, "IDLE");
  assert.equal(client.state.firmware, "1.1");
  assert.equal(client.state.error, null);
});

test("a silent pod that starts answering is picked up without pressing anything", async (t) => {
  const { sim, client } = await connectSilent(t);
  sim.mute = false;
  await until(() => client.state.pod === "IDLE" && client.state.firmware === "1.1", "the pod's state and firmware");
  assert.equal(client.state.error, null);
});

test("a 1.0 pod that was silent on connect is still polled for its capture", async (t) => {
  const { sim, client } = await connectSilent(t, { firmware: "1.0", speed: 100 });   // 5 s window -> 50 ms
  client.options.replyTimeoutMs = 400;
  sim.mute = false;
  await until(() => client.state.pod === "IDLE", "IDLE once the pod answers");
  await armAndThrow(sim, client);       // 1.0 never pushes READY, so only polling can find it
  assert.ok(client.state.summary.samples > 500);
});

test("an armed pod that stays silent past the reply timeout is shown as not answering", async (t) => {
  const sim = new SimPod({ speed: 2000 });
  const client = new PodClient({ busyAfterMs: 10, replyTimeoutMs: 60, pollMs: 10 });
  t.after(() => client.disconnect());
  await client.connect(sim);
  await client.arm();
  sim.mute = true;
  await until(() => client.state.pod === "UNKNOWN", "the pod to be marked as not answering");
  assert.equal(client.state.error, "The pod did not answer STATUS.");
});

// What the Bluetooth log records about a failed link ---------------------------------------
test("a failed connection attempt is written to the log", async (t) => {
  const sim = new SimPod({ speed: 2000 });
  sim.outOfRange = true;
  const client = new PodClient();
  const notes = [];
  client.on("log", (entry) => notes.push(entry.text));
  await assert.rejects(client.connect(sim), /out of range/);
  assert.ok(notes.includes("The simulated pod is out of range."));
});

test("a reconnect that keeps failing is written to the log once, not on every attempt", async (t) => {
  const { sim, client } = await setup();
  t.after(() => client.disconnect());
  const notes = [];
  client.on("log", (entry) => notes.push(entry.text));
  sim.setOutOfRange(true);
  await until(() => client.state.link === "reconnecting", "reconnecting");
  await sleep(60);                       // a dozen attempts at this retry pace
  assert.equal(notes.filter((text) => text === "The simulated pod is out of range.").length, 1);
});

// Commands typed by hand ---------------------------------------------------------------------
test("a typed command is written to the pod and both directions are logged", async () => {
  const { sim, client } = await setup();
  const log = [];
  client.on("log", (entry) => log.push(`${entry.dir} ${entry.text}`));
  await client.send("hello");
  await until(() => log.some((line) => line.startsWith("rx State IDLE")), "the pod's reply");
  assert.equal(sim.received.at(-1), "HELLO");
  assert.equal(log[0], "tx hello");
});

test("a typed command that changes the pod is reflected in the state", async () => {
  const { client } = await setup();
  await client.send("ARM");
  await until(() => client.state.pod === "ARMED", "ARMED");
});

test("a typed command is refused when nothing is connected", async () => {
  const client = new PodClient();
  await assert.rejects(client.send("STATUS"), /not connected/i);
});

// Pushed notices and tools ---------------------------------------------------------------
test("an armed-timeout notice returns the pod to IDLE and is kept for display", async () => {
  const { sim, client } = await setup();
  await client.arm();
  sim.expireArm();
  await until(() => client.state.pod === "IDLE", "IDLE after timeout");
  assert.match(client.state.notice, /timed out/i);
});

test("a sensor error notice is shown with its detail", async () => {
  const { sim, client } = await setup();
  await client.arm();
  sim.raiseSensorError();
  await until(() => client.state.pod === "SENSOR_ERROR", "SENSOR_ERROR");
  assert.match(client.state.notice, /Errno 5/);
});

test("bench returns the pod's reads per second", async () => {
  const { client } = await setup();
  const reads = await client.bench();
  assert.ok(reads > 100);
  assert.equal(client.state.bench, reads);
});

test("bench on a 1.0 pod says the firmware does not support it", async () => {
  const { client } = await setup({ firmware: "1.0" });
  await assert.rejects(client.bench(), /not supported/i);
});

test("every command and reply line is logged", async () => {
  const sim = new SimPod({ speed: 2000 });
  const client = new PodClient();
  const log = [];
  client.on("log", (entry) => log.push(`${entry.dir} ${entry.text}`));
  await client.connect(sim);
  assert.deepEqual(log.filter((line) => /^(tx|rx) /.test(line)), [
    "tx STATUS", "rx IDLE", "tx INFO", "rx DGT-1 fw=1.1 target_hz=100 window_s=10 pre=30 cols=12",
  ]);
});

test("a pod that never answers makes the request time out", async () => {
  const sim = new SimPod({ speed: 2000 });
  sim.mute = true;
  const client = new PodClient({ replyTimeoutMs: 30, busyAfterMs: 10 });
  await assert.rejects(client.connect(sim), /did not answer/i);
});

test("classify agrees with what the simulated pod sends for every reply type", async () => {
  const sim = new SimPod({ speed: 2000 });
  const lines = [];
  const splitter = new LineSplitter();
  sim.onData = (text) => lines.push(...splitter.push(text));
  await sim.connect();
  for (const command of ["STATUS", "HELLO", "INFO", "BENCH", "ARM", "CANCEL", "DUMP"]) {
    await sim.write(`${command}\n`);
    await sleep(5);
  }
  assert.deepEqual(lines.map((line) => classify(line).type),
    ["state", "refused", "info", "bench", "state", "state", "refused"]);
});
