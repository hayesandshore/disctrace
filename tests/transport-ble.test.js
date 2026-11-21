import { test } from "node:test";
import assert from "node:assert/strict";

import { BleTransport } from "../js/transport-ble.js";
import { FakePod } from "./fake-bluetooth.js";

// Connects a fresh transport to the pod and counts the link losses it reports.
function open(pod) {
  pod.install();
  const transport = new BleTransport();
  const seen = { text: "", lost: 0 };
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
