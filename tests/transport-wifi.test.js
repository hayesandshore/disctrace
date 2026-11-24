import { test } from "node:test";
import assert from "node:assert/strict";

import { WifiTransport, servedByPod } from "../js/transport-wifi.js";
import { hintFor } from "../js/diagnostics.js";
import { FakeWifiPod } from "./fake-pod-http.js";

const BASE = "http://192.168.4.1/";

// A fresh transport on the pod, recording what it reports.
function open(pod, options = {}) {
  const transport = new WifiTransport({ base: BASE, fetch: pod.fetch, ...options });
  const seen = { text: "", pieces: [], lost: 0, trace: [] };
  transport.onTrace = (event) => seen.trace.push(event);
  transport.onData = (piece) => {
    seen.text += piece;
    seen.pieces.push(piece);
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

const QUICK = { helloTimeoutMs: 30, quietMs: 30 };   // short limits, so a silent pod is given up on within a test
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = (seen) => seen.trace.map((event) => event.step).filter((step) => step !== "rx" && step !== "tx");

// Which link this page should use -----------------------------------------------------
test("a page served over plain http from a device on the network came from the pod", () => {
  assert.equal(servedByPod({ protocol: "http:", hostname: "192.168.4.1", search: "" }), true);
  assert.equal(servedByPod({ protocol: "http:", hostname: "10.0.0.7", search: "" }), true);
});

test("the website and a copy on this computer keep Bluetooth", () => {
  assert.equal(servedByPod({ protocol: "https:", hostname: "hayesandshore.github.io", search: "" }), false);
  assert.equal(servedByPod({ protocol: "http:", hostname: "localhost", search: "" }), false);
  assert.equal(servedByPod({ protocol: "http:", hostname: "127.0.0.1", search: "" }), false);
  assert.equal(servedByPod({ protocol: "file:", hostname: "", search: "" }), false);
});

test("the address can ask for either link, for trying a pod running on this computer", () => {
  assert.equal(servedByPod({ protocol: "http:", hostname: "localhost", search: "?link=wifi" }), true);
  assert.equal(servedByPod({ protocol: "http:", hostname: "192.168.4.1", search: "?link=ble" }), false);
});

// The healthy path -------------------------------------------------------------------
test("connecting asks the pod who it is, at the address the page came from", async () => {
  const pod = new FakeWifiPod();
  const { transport } = open(pod);
  await transport.connect();
  assert.deepEqual(pod.requests, [{ method: "GET", path: "/api/hello", body: "" }]);
  assert.equal(transport.connected, true);
  assert.equal(transport.name, "DGT-1");
  assert.equal(transport.kind, "wifi");
});

test("a page in a folder talks to the pod in that folder", async () => {
  const pod = new FakeWifiPod();
  const transport = new WifiTransport({ base: "http://bench.test:8080/pod/index.html?link=wifi", fetch: pod.fetch });
  await transport.connect();
  assert.equal(pod.requests[0].path, "/pod/api/hello");
});

test("a command is posted to the pod and its reply arrives as text", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  await transport.write("STATUS\n");
  assert.deepEqual(pod.requests[1], { method: "POST", path: "/api/cmd", body: "STATUS\n" });
  assert.equal(seen.text, "IDLE\r\n");
});

test("a reply that arrives in pieces is passed on piece by piece, in order", async () => {
  const pod = new FakeWifiPod();
  pod.pieceBytes = 20;
  const { transport, seen } = open(pod);
  await transport.connect();
  await transport.write("HELLO\n");
  assert.equal(seen.pieces.length, 3);
  assert.equal(seen.text, "State IDLE. Commands: ARM STATUS DUMP CANCEL INFO BENCH\r\n");
});

test("two writes sent together reach the pod one after the other", async () => {
  const pod = new FakeWifiPod();
  pod.delayMs = 5;
  const { transport } = open(pod);
  await transport.connect();
  await Promise.all([transport.write("STATUS\n"), transport.write("INFO\n")]);
  assert.deepEqual(pod.commands, ["STATUS", "INFO"]);
  assert.equal(pod.mostOpen, 1);     // the pod is asked one thing at a time
});

test("a pod that takes its time, as when it is recording, is waited for", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod, { helloTimeoutMs: 30, quietMs: 200 });
  await transport.connect();
  pod.delayMs = 60;
  await transport.write("STATUS\n");
  assert.equal(seen.text, "IDLE\r\n");
  assert.equal(seen.lost, 0);
});

test("writing without a link is refused", async () => {
  const error = await failure(open(new FakeWifiPod()).transport.write("STATUS\n"));
  assert.equal(error.message, "Not connected to the pod.");
});

// Saying what actually went wrong --------------------------------------------------------
test("nothing at the address is reported with the address and the browser's reason", async () => {
  const pod = new FakeWifiPod();
  pod.reachable = false;
  const error = await failure(open(pod).transport.connect());
  assert.match(error.message, /Could not reach the pod at http:\/\/192\.168\.4\.1/);
  assert.match(error.message, /Failed to fetch/);
});

test("an address that answers, but not as a pod, is reported as that", async () => {
  const other = new FakeWifiPod();
  other.hello = "<html>Router login</html>";
  const wrong = await failure(open(other).transport.connect());
  assert.match(wrong.message, /not like a DGT-1 pod/);
  const missing = new FakeWifiPod();
  missing.helloStatus = 404;
  assert.match((await failure(open(missing).transport.connect())).message, /not like a DGT-1 pod/);
});

test("each way of not connecting gets its own next step", async () => {
  const away = new FakeWifiPod();
  away.reachable = false;
  assert.match(hintFor((await failure(open(away).transport.connect())).message), /Wi-Fi network/);
  const other = new FakeWifiPod();
  other.hello = "hello";
  assert.match(hintFor((await failure(open(other).transport.connect())).message), /different network/);
});

// Never waiting for ever ---------------------------------------------------------------------
test("a pod that never answers the first request is given up on", async () => {
  const pod = new FakeWifiPod();
  pod.answers = false;
  const { transport, seen } = open(pod, QUICK);
  const error = await within(1000, failure(transport.connect()));
  assert.match(error.message, /Could not reach the pod/);
  assert.match(error.message, /no answer for 0\.03 seconds/);
  assert.equal(transport.connected, false);
  assert.equal(seen.lost, 0);            // there was no link to lose
  assert.equal(pod.open, 0);             // the request was dropped, not left hanging
});

test("a command the pod never answers is a lost link, reported once", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod, QUICK);
  await transport.connect();
  pod.answers = false;
  await within(1000, transport.write("STATUS\n"));
  assert.equal(seen.lost, 1);
  assert.equal(transport.connected, false);
  assert.equal(pod.open, 0);
});

test("a reply that stops part-way is a lost link, and what came before it is kept", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod, QUICK);
  await transport.connect();
  pod.pieceBytes = 20;
  pod.stallAfter = 2;
  await within(1000, transport.write("HELLO\n"));
  assert.equal(seen.text, "State IDLE. Commands: ARM STATUS DUMP CA");
  assert.equal(seen.lost, 1);
});

test("a pod that cannot be reached any more is a lost link", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.reachable = false;                 // the phone walked off the pod's network
  await transport.write("STATUS\n");
  assert.equal(seen.lost, 1);
  assert.equal(transport.connected, false);
});

test("an error from the pod is a lost link, not a reply", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.commandStatus = 500;
  await transport.write("STATUS\n");
  assert.equal(seen.text, "");
  assert.equal(seen.lost, 1);
});

test("writes queued behind a lost link are not sent", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.reachable = false;
  await Promise.all([transport.write("STATUS\n"), transport.write("INFO\n")]);
  assert.equal(pod.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(seen.lost, 1);
});

test("after a lost link the same transport connects and works again", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.reachable = false;
  await transport.write("STATUS\n");
  pod.reachable = true;
  await transport.connect();             // the reconnect loop calls connect() on the same transport
  await transport.write("STATUS\n");
  assert.equal(seen.text, "IDLE\r\n");
  assert.equal(seen.lost, 1);
});

// Stopping on request ------------------------------------------------------------------------------
test("stopping while the pod is being asked ends the attempt at once, and not as a failure", async () => {
  const pod = new FakeWifiPod();
  pod.answers = false;
  const { transport, seen } = open(pod);      // the normal, long limits: only the stop can end it in time
  const attempt = failure(transport.connect());
  await sleep(5);
  await transport.disconnect();
  const error = await within(1000, attempt);
  assert.equal(error.stopped, true);
  assert.ok(steps(seen).includes("connect-stopped"));
  assert.ok(!steps(seen).includes("connect-failed"));
  assert.equal(seen.lost, 0);
  assert.equal(pod.open, 0);
});

test("disconnecting on request reports the loss once and drops what was in flight", async () => {
  const pod = new FakeWifiPod();
  const { transport, seen } = open(pod);
  await transport.connect();
  pod.answers = false;
  const waiting = transport.write("STATUS\n");
  await sleep(5);
  await transport.disconnect();
  await within(1000, waiting);
  assert.equal(seen.lost, 1);
  assert.equal(pod.open, 0);
});

test("a reply still arriving after a disconnect is not passed on", async () => {
  const pod = new FakeWifiPod();
  pod.delayMs = 20;
  const { transport, seen } = open(pod);
  await transport.connect();
  const waiting = transport.write("STATUS\n");
  await sleep(5);
  await transport.disconnect();
  await waiting;
  await sleep(40);
  assert.equal(seen.text, "");
});

// Telling the console what happened ---------------------------------------------------------------
test("a healthy connection is traced, with what the pod said it is", async () => {
  const { transport, seen } = open(new FakeWifiPod());
  await transport.connect();
  assert.deepEqual(steps(seen), ["wifi-connecting", "wifi-connected"]);
  assert.equal(seen.trace[0].url, "http://192.168.4.1/api/hello");
  assert.match(seen.trace[1].hello, /^DGT-1 fw=2\.0\.0/);
});

test("every command and every piece of reply is traced", async () => {
  const pod = new FakeWifiPod();
  pod.pieceBytes = 20;
  const { transport, seen } = open(pod);
  await transport.connect();
  await transport.write("HELLO\n");
  const sent = seen.trace.find((event) => event.step === "tx");
  assert.equal(sent.text, "HELLO\n");
  assert.equal(sent.length, 6);
  const got = seen.trace.filter((event) => event.step === "rx");
  assert.equal(got.length, 3);
  assert.equal(new TextDecoder().decode(got[0].bytes), "State IDLE. Commands");
});

test("a failed attempt and a lost link are traced with the reason", async () => {
  const pod = new FakeWifiPod();
  pod.reachable = false;
  const first = open(pod);
  await failure(first.transport.connect());
  assert.match(first.seen.trace.at(-1).message, /Failed to fetch/);
  assert.equal(first.seen.trace.at(-1).step, "connect-failed");
  pod.reachable = true;
  const second = open(pod, QUICK);
  await second.transport.connect();
  pod.answers = false;
  await second.transport.write("STATUS\n");
  assert.equal(second.seen.trace.at(-1).step, "link-lost");
  assert.match(second.seen.trace.at(-1).message, /no answer for 0\.03 seconds/);
});

test("a console that throws cannot break the link", async () => {
  const { transport, seen } = open(new FakeWifiPod());
  transport.onTrace = () => {
    throw new Error("console broke");
  };
  await transport.connect();
  await transport.write("STATUS\n");
  assert.equal(seen.text, "IDLE\r\n");
});
