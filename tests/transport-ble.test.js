import { test } from "node:test";
import assert from "node:assert/strict";

import { BleTransport } from "../js/transport-ble.js";
import { FakePod } from "./fake-bluetooth.js";

// Connects a fresh transport to the pod and counts the link losses it reports.
function open(pod) {
  pod.install();
  const transport = new BleTransport();
  const seen = { text: "", lost: 0, trace: [] };
  transport.onTrace = (event) => seen.trace.push(event);
  transport.onData = (piece) => {
    seen.text += piece;
  };
  transport.onDisconnect = () => {
    seen.lost += 1;
  };
  return { transport, seen };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected the connection attempt to fail");
}

// The healthy path -----------------------------------------------------------------
test("a healthy pod connects and a long reply arrives as one piece of text", async () => {
  const pod = new FakePod();
  const { transport, seen } = open(pod);
  await transport.connect();
  await transport.write("HELLO\n");
  assert.deepEqual(pod.commands, ["HELLO"]);
  assert.equal(seen.text, "State IDLE. Commands: ARM STATUS DUMP CANCEL\r\n");   // three notifications
  assert.equal(transport.name, "DGT-1");
});

test("disconnecting on request hangs up and reports the loss once", async () => {
  const pod = new FakePod();
  const { transport, seen } = open(pod);
  await transport.connect();
  await transport.disconnect();
  assert.equal(pod.device.gatt.connected, false);
  assert.equal(seen.lost, 1);
});

// Saying what actually went wrong ------------------------------------------------------
test("closing the browser's list without picking says no pod was chosen", async () => {
  const pod = new FakePod();
  pod.chooser = "cancelled";
  const error = await failure(open(pod).transport.connect());
  assert.equal(error.message, "No pod was chosen.");
});

test("a chosen pod without the UART service is reported as that, not as nothing chosen", async () => {
  const pod = new FakePod();
  pod.uart = false;
  const error = await failure(open(pod).transport.connect());
  assert.match(error.message, /UART service/);
  assert.match(error.message, /No Services matching UUID/);   // the browser's own reason is kept
  assert.doesNotMatch(error.message, /No pod was chosen/);
  assert.notEqual(error.name, "NotFoundError");                // nothing may mistake it for a closed list
});

test("a pod that cannot be reached is reported with the browser's reason", async () => {
  const pod = new FakePod();
  pod.inRange = false;
  const error = await failure(open(pod).transport.connect());
  assert.match(error.message, /Could not connect to DGT-1/);
  assert.match(error.message, /Connection attempt failed/);
});

test("a pod that refuses the reply subscription is reported as that", async () => {
  const pod = new FakePod();
  pod.notifiable = false;
  const error = await failure(open(pod).transport.connect());
  assert.match(error.message, /subscribe/);
  assert.match(error.message, /GATT operation not permitted/);
});

// Never holding a half-open link ---------------------------------------------------------
test("a connection that fails after the radio link opens hangs up again", async () => {
  const pod = new FakePod();
  pod.uart = false;
  await failure(open(pod).transport.connect());
  assert.equal(pod.device.gatt.connected, false);   // or the pod stops advertising and nothing can find it
});

test("a failed subscription also hangs up again", async () => {
  const pod = new FakePod();
  pod.notifiable = false;
  await failure(open(pod).transport.connect());
  assert.equal(pod.device.gatt.connected, false);
});

// Reporting a lost link only when one was up ------------------------------------------------
test("hanging up a failed attempt is not reported as a lost link", async () => {
  const pod = new FakePod();
  pod.uart = false;
  const { transport, seen } = open(pod);
  await failure(transport.connect());
  assert.equal(seen.lost, 0);   // a reported loss would start the reconnect loop for a link that never existed
});

test("after several connections in one visit, one drop is reported once", async () => {
  const pod = new FakePod();
  const sessions = [];
  for (let i = 0; i < 3; i += 1) {
    const session = open(pod);
    await session.transport.connect();
    await session.transport.disconnect();
    sessions.push(session);
  }
  const live = open(pod);
  await live.transport.connect();
  const before = sessions.map((session) => session.seen.lost);
  pod.drop();
  assert.equal(live.seen.lost, 1);
  assert.deepEqual(sessions.map((session) => session.seen.lost), before);   // finished sessions stay quiet
});

test("a pod that drops out is reported once and can be connected again", async () => {
  const pod = new FakePod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.drop();
  assert.equal(seen.lost, 1);
  assert.equal(transport.connected, false);
  await transport.connect();    // the reconnect loop calls connect() on the same transport
  await transport.write("STATUS\n");
  assert.equal(seen.text, "IDLE\r\n");
});

// Telling the console what happened -----------------------------------------------------------
const steps = (seen) => seen.trace.map((event) => event.step).filter((step) => step !== "rx" && step !== "tx");

test("a healthy connection is traced step by step, in order", async () => {
  const { transport, seen } = open(new FakePod());
  await transport.connect();
  assert.deepEqual(steps(seen),
    ["chooser-open", "chooser-picked", "gatt-connecting", "gatt-connected", "uart-found", "subscribed"]);
  const picked = seen.trace.find((event) => event.step === "chooser-picked");
  assert.equal(picked.name, "DGT-1");
  assert.equal(picked.id, "fake-dgt-1");
});

test("a closed device list is traced with the browser's reason", async () => {
  const pod = new FakePod();
  pod.chooser = "cancelled";
  const { transport, seen } = open(pod);
  await failure(transport.connect());
  const failed = seen.trace.find((event) => event.step === "chooser-failed");
  assert.equal(failed.name, "NotFoundError");
  assert.match(failed.message, /cancelled/);
});

test("a failed connection traces the failure, what the device offers instead, and the hang-up", async () => {
  const pod = new FakePod();
  pod.uart = false;
  pod.otherServices = ["0000febb-0000-1000-8000-00805f9b34fb"];
  const { transport, seen } = open(pod);
  await failure(transport.connect());
  assert.deepEqual(steps(seen).slice(-3), ["connect-failed", "services", "hung-up"]);
  assert.deepEqual(seen.trace.find((event) => event.step === "services").uuids,
    ["0000febb-0000-1000-8000-00805f9b34fb"]);
});

test("every packet from the pod is traced as raw bytes", async () => {
  const { transport, seen } = open(new FakePod());
  await transport.connect();
  await transport.write("HELLO\n");
  const packets = seen.trace.filter((event) => event.step === "rx");
  assert.equal(packets.length, 3);                      // 47 bytes in pieces of at most 20
  const joined = packets.map((event) => new TextDecoder().decode(event.bytes)).join("");
  assert.equal(joined, "State IDLE. Commands: ARM STATUS DUMP CANCEL\r\n");
});

test("every write to the pod is traced", async () => {
  const { transport, seen } = open(new FakePod());
  await transport.connect();
  await transport.write("STATUS\n");
  const sent = seen.trace.find((event) => event.step === "tx");
  assert.equal(sent.text, "STATUS\n");
  assert.equal(sent.length, 7);
  assert.equal(sent.withResponse, false);
});

test("a pod that drops out is traced as a lost link", async () => {
  const pod = new FakePod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.drop();
  assert.equal(steps(seen).at(-1), "link-lost");
});

test("scanning for all devices asks the browser for every device and can still reach the UART service", async () => {
  const pod = new FakePod();
  const { transport, seen } = open(pod);
  await transport.choose({ all: true });
  const [options] = pod.requests;
  assert.equal(options.acceptAllDevices, true);
  assert.equal(options.filters, undefined);             // the browser rejects filters together with acceptAllDevices
  assert.ok(options.optionalServices.includes("6e400001-b5a3-f393-e0a9-e50e24dcca9e"));
  assert.equal(seen.trace[0].all, true);
  await transport.connect();                            // the picked device is used without asking again
  assert.equal(pod.requests.length, 1);
  assert.equal(transport.connected, true);
});

test("the normal device list is still limited to the pod", async () => {
  const pod = new FakePod();
  await open(pod).transport.connect();
  const [options] = pod.requests;
  assert.equal(options.acceptAllDevices, undefined);
  assert.deepEqual(options.optionalServices, ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"]);
  assert.equal(options.filters.length, 2);
});

test("a console that throws cannot break the link", async () => {
  const { transport } = open(new FakePod());
  transport.onTrace = () => {
    throw new Error("console broke");
  };
  await transport.connect();
  assert.equal(transport.connected, true);
});
