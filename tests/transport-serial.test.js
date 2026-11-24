import { test } from "node:test";
import assert from "node:assert/strict";

import { SerialTransport } from "../js/transport-serial.js";
import { hintFor } from "../js/diagnostics.js";
import { FakeUsbPod } from "./fake-serial.js";

// A fresh transport on the pod's port, recording what it reports.
function open(pod, options = {}) {
  const transport = new SerialTransport({ serial: pod.serial, ...options });
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

// Fails a test that is still waiting, instead of letting it wait for ever.
function within(ms, promise) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const QUICK = { answerTimeoutMs: 30 };   // a short limit, so a silent port is given up on within a test
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = (seen) => seen.trace.map((event) => event.step).filter((step) => step !== "rx" && step !== "tx");

// The healthy path -------------------------------------------------------------------
test("connecting asks for an Adafruit board, opens its port and asks the pod who it is", async () => {
  const pod = new FakeUsbPod();
  const { transport } = open(pod);
  await transport.connect();
  assert.deepEqual(pod.requests, [{ filters: [{ usbVendorId: 0x239a }] }]);
  assert.equal(pod.opens[0].baudRate, 115200);
  assert.deepEqual(pod.signals, [{ dataTerminalReady: true }]);   // tells the pod a program is listening
  assert.deepEqual(pod.commands, ["INFO"]);
  assert.equal(transport.connected, true);
  assert.equal(transport.kind, "usb");
});

test("a command is written as a line of text and its reply arrives as text", async () => {
  const pod = new FakeUsbPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  seen.text = "";
  await transport.write("STATUS\n");
  await sleep(1);
  assert.deepEqual(pod.commands, ["INFO", "STATUS"]);
  assert.equal(seen.text, "IDLE\r\n");
});

test("what the pod says about itself while connecting is passed on, so it is not asked twice", async () => {
  const { transport, seen } = open(new FakeUsbPod());
  await transport.connect();
  assert.match(seen.text, /DGT-1 fw=2\.1\.0 /);
});

test("text the pod prints by itself does not confuse the connection", async () => {
  const pod = new FakeUsbPod();
  pod.banner = "Starting sensors.\r\nDGT-1 ready. Wi-Fi is down: connect over USB.\r\n";
  const { transport, seen } = open(pod);
  await transport.connect();
  assert.equal(transport.connected, true);
  assert.match(seen.text, /^Starting sensors\./);
});

test("two writes sent together reach the pod one after the other", async () => {
  const pod = new FakeUsbPod();
  const { transport } = open(pod);
  await transport.connect();
  await Promise.all([transport.write("STATUS\n"), transport.write("ARM\n")]);
  assert.deepEqual(pod.commands, ["INFO", "STATUS", "ARM"]);
});

test("writing without a link is refused", async () => {
  const error = await failure(open(new FakeUsbPod()).transport.write("STATUS\n"));
  assert.equal(error.message, "Not connected to the pod.");
});

// Saying what actually went wrong --------------------------------------------------------
test("closing the browser's list without picking says no port was chosen", async () => {
  const pod = new FakeUsbPod();
  pod.chooser = "cancelled";
  const error = await failure(open(pod).transport.connect());
  assert.equal(error.message, "No USB port was chosen.");
});

test("a port another program holds is reported with the browser's reason", async () => {
  const pod = new FakeUsbPod();
  pod.busy = true;
  const error = await failure(open(pod).transport.connect());
  assert.match(error.message, /Could not open the pod's USB port/);
  assert.match(error.message, /Failed to open serial port/);
});

test("a port that opens but answers nothing is given up on, and let go of", async () => {
  const pod = new FakeUsbPod();
  pod.answers = false;            // Bluetooth-only firmware, or a program that has stopped
  const { transport, seen } = open(pod, QUICK);
  const error = await within(1000, failure(transport.connect()));
  assert.match(error.message, /nothing on it answered like a DGT-1 pod/);
  assert.equal(transport.connected, false);
  assert.equal(pod.port.opened, false);   // or nothing else could open it, and neither could the next try
  assert.equal(seen.lost, 0);             // there was no link to lose
});

test("each way of not connecting over USB gets its own next step", async () => {
  const closed = new FakeUsbPod();
  closed.chooser = "cancelled";
  assert.match(hintFor((await failure(open(closed).transport.connect())).message), /cable/);
  const held = new FakeUsbPod();
  held.busy = true;
  assert.match(hintFor((await failure(open(held).transport.connect())).message), /another program/);
  const silent = new FakeUsbPod();
  silent.answers = false;
  assert.match(hintFor((await failure(open(silent, QUICK).transport.connect())).message), /firmware 2\.1/);
});

// Losing the link -----------------------------------------------------------------------------
test("pulling the cable is a lost link, reported once, and the port is let go of", async () => {
  const pod = new FakeUsbPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  const port = pod.port;
  pod.unplug();
  await sleep(5);
  assert.equal(seen.lost, 1);
  assert.equal(transport.connected, false);
  assert.equal(port.opened, false);
});

test("while the cable is out, connecting again fails with the reason instead of waiting", async () => {
  const pod = new FakeUsbPod();
  const { transport } = open(pod);
  await transport.connect();
  pod.unplug();
  await sleep(5);
  const error = await within(1000, failure(transport.connect()));
  assert.match(error.message, /Could not open the pod's USB port/);
  assert.equal(pod.requests.length, 1);   // and the browser's list is not opened again by itself
});

test("when the cable is back the same transport connects again without asking", async () => {
  const pod = new FakeUsbPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.unplug();
  await sleep(5);
  pod.replug();                           // the browser now knows the pod under a new port object
  await transport.connect();              // the reconnect loop calls connect() on the same transport
  seen.text = "";
  await transport.write("STATUS\n");
  await sleep(1);
  assert.equal(seen.text, "IDLE\r\n");
  assert.equal(pod.requests.length, 1);
  assert.equal(seen.lost, 1);
});

test("a write that fails is a lost link", async () => {
  const pod = new FakeUsbPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.writeFails = true;
  await transport.write("STATUS\n");
  await sleep(5);
  assert.equal(seen.lost, 1);
  assert.equal(transport.connected, false);
});

// Stopping on request ----------------------------------------------------------------------------
test("disconnecting on request closes the port and reports the loss once", async () => {
  const pod = new FakeUsbPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  await transport.disconnect();
  assert.equal(pod.port.opened, false);
  assert.equal(seen.lost, 1);
  assert.equal(steps(seen).at(-1), "disconnect-requested");   // not also reported as a dropped link
});

test("after disconnecting, the same transport connects again", async () => {
  const pod = new FakeUsbPod();
  const { transport } = open(pod);
  await transport.connect();
  await transport.disconnect();
  await transport.connect();
  assert.equal(transport.connected, true);
  assert.equal(pod.requests.length, 1);
});

test("stopping while the pod is being asked ends the attempt at once, and not as a failure", async () => {
  const pod = new FakeUsbPod();
  pod.answers = false;
  const { transport, seen } = open(pod);      // the normal, long limit: only the stop can end it in time
  const attempt = failure(transport.connect());
  await sleep(5);
  await transport.disconnect();
  const error = await within(1000, attempt);
  assert.equal(error.stopped, true);
  assert.ok(steps(seen).includes("connect-stopped"));
  assert.ok(!steps(seen).includes("connect-failed"));
  assert.equal(pod.port.opened, false);
  assert.equal(seen.lost, 0);
});

// Telling the console what happened ---------------------------------------------------------------
test("a healthy connection is traced step by step, in order", async () => {
  const { transport, seen } = open(new FakeUsbPod());
  await transport.connect();
  assert.deepEqual(steps(seen), ["usb-chooser-open", "usb-picked", "usb-opening", "usb-ready"]);
  assert.deepEqual(seen.trace[1], { step: "usb-picked", vendor: 0x239a, product: 0x811c });
  assert.match(seen.trace.at(-1).hello, /^DGT-1 fw=2\.1\.0/);
});

test("every write and every piece of reply is traced", async () => {
  const { transport, seen } = open(new FakeUsbPod());
  await transport.connect();
  seen.trace.length = 0;
  await transport.write("STATUS\n");
  await sleep(1);
  assert.deepEqual(seen.trace.map((event) => event.step), ["tx", "rx"]);
  assert.equal(seen.trace[0].text, "STATUS\n");
  assert.equal(new TextDecoder().decode(seen.trace[1].bytes), "IDLE\r\n");
});

test("a pulled cable is traced as a lost link with the browser's reason", async () => {
  const pod = new FakeUsbPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.unplug();
  await sleep(5);
  const dropped = seen.trace.find((event) => event.step === "link-lost");
  assert.match(dropped.message, /device has been lost/);
});

test("a console that throws cannot break the link", async () => {
  const { transport, seen } = open(new FakeUsbPod());
  transport.onTrace = () => {
    throw new Error("console broke");
  };
  await transport.connect();
  seen.text = "";
  await transport.write("STATUS\n");
  await sleep(1);
  assert.equal(seen.text, "IDLE\r\n");
});
