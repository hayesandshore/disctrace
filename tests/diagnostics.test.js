import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ConsoleLog, describeTrace, environmentLines, hintFor, serviceLabel, showText, stateChanges,
} from "../js/diagnostics.js";

const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const FILE_TRANSFER = "0000febb-0000-1000-8000-00805f9b34fb";
const healthy = {
  version: "test", url: "https://example.test/disctrace/", userAgent: "Chrome/999 (Windows)",
  secure: true, hasBluetooth: true, adapter: true,
};
const text = (lines) => lines.map((line) => line.text).join("\n");

// Making invisible characters visible ---------------------------------------------------
test("line endings and control bytes are shown, not hidden", () => {
  assert.equal(showText("IDLE\r\n"), "IDLE\\r\\n");
  assert.equal(showText("a\u0007b"), "a\\x07b");
  assert.equal(showText("plain text"), "plain text");
});

// The browser and Bluetooth checks --------------------------------------------------------
test("a healthy browser passes every check", () => {
  const lines = environmentLines(healthy);
  assert.ok(lines.length >= 4);
  assert.ok(lines.every((line) => line.kind === "check"));
  assert.match(text(lines), /Chrome\/999/);
  assert.match(text(lines), /Bluetooth adapter: on/);
});

test("a browser without Web Bluetooth is called out with what to use instead", () => {
  const lines = environmentLines({ ...healthy, hasBluetooth: false, adapter: null });
  const problem = lines.find((line) => line.kind === "error");
  assert.match(problem.text, /no Web Bluetooth/i);
  assert.match(problem.text, /Chrome or Edge/);
});

test("a page that is not on https is called out", () => {
  const problem = environmentLines({ ...healthy, secure: false }).find((line) => line.kind === "error");
  assert.match(problem.text, /https/);
});

test("a Bluetooth adapter that is off or missing is called out", () => {
  const problem = environmentLines({ ...healthy, adapter: false }).find((line) => line.kind === "error");
  assert.match(problem.text, /Bluetooth is off or missing/);
});

test("a failed adapter check keeps the browser's reason", () => {
  const lines = environmentLines({ ...healthy, adapter: "SecurityError: blocked by policy" });
  assert.match(text(lines), /blocked by policy/);
});

// Bluetooth steps in words ------------------------------------------------------------------
test("opening the device list says which devices it will show", () => {
  assert.match(describeTrace({ step: "chooser-open", all: false })[0].text, /DGT-1/);
  assert.match(describeTrace({ step: "chooser-open", all: true })[0].text, /every Bluetooth device/i);
});

test("a picked device is named with its id", () => {
  const [line] = describeTrace({ step: "chooser-picked", name: "DGT-1", id: "abc123" });
  assert.match(line.text, /DGT-1/);
  assert.match(line.text, /abc123/);
});

test("a device with no name is still described", () => {
  assert.match(describeTrace({ step: "chooser-picked", name: null, id: "abc123" })[0].text, /no name/i);
});

test("packets from the pod show their bytes, length and line endings", () => {
  const bytes = new TextEncoder().encode("IDLE\r\n");
  const [line] = describeTrace({ step: "rx", bytes });
  assert.equal(line.kind, "raw");
  assert.match(line.text, /6 bytes/);
  assert.ok(line.text.includes("IDLE\\r\\n"));
});

test("a write shows the text and how it was sent", () => {
  const [line] = describeTrace({ step: "tx", text: "STATUS\n", length: 7, withResponse: false });
  assert.ok(line.text.includes("STATUS\\n"));
  assert.match(line.text, /7 bytes/);
  assert.match(line.text, /without response/);
});

test("the services a device offers are named", () => {
  assert.match(serviceLabel(NUS), /UART/);
  assert.match(serviceLabel(FILE_TRANSFER), /CircuitPython/);
  assert.equal(serviceLabel("12345678-0000-1000-8000-00805f9b34fb"), "unknown service");
});

test("a device offering only CircuitPython's own services means the pod program is not running", () => {
  const lines = describeTrace({ step: "services", uuids: [FILE_TRANSFER] });
  assert.match(text(lines), /0000febb/);
  assert.match(lines.find((line) => line.kind === "hint").text, /code\.py is not running/);
});

test("a device offering the UART service gets no such hint", () => {
  assert.equal(describeTrace({ step: "services", uuids: [NUS] }).some((line) => line.kind === "hint"), false);
});

test("a failed step is an error line with the reason", () => {
  const [line] = describeTrace({ step: "connect-failed", message: "Could not connect to DGT-1: Connection attempt failed." });
  assert.equal(line.kind, "error");
  assert.match(line.text, /Connection attempt failed/);
});

test("the subscription request is announced in words before its answer is known", () => {
  const [line] = describeTrace({ step: "subscribing" });
  assert.match(line.text, /^Subscribing to the pod's replies/);
  assert.doesNotMatch(line.text, /[{}]/);   // not the raw form an unknown step is printed in
});

test("an attempt stopped on request is a plain line, not an error", () => {
  const [line] = describeTrace({ step: "connect-stopped", message: "Stopped before the connection was ready." });
  assert.notEqual(line.kind, "error");
  assert.match(line.text, /^Stopped/);
});

test("an unknown step is still printed rather than dropped", () => {
  assert.match(describeTrace({ step: "something-new", detail: 5 })[0].text, /something-new/);
});

// What to try next ---------------------------------------------------------------------------
test("each known failure gets a next step, and unknown text gets none", () => {
  assert.match(hintFor("No pod was chosen."), /Scan for all/);
  assert.match(hintFor("Connected to DGT-1, but could not find its UART service: x"), /not running/);
  assert.match(hintFor("Could not connect to DGT-1: Connection attempt failed."), /another/i);
  assert.match(hintFor("The pod did not answer STATUS."), /USB/);
  assert.equal(hintFor("Connected to DGT-1."), null);
});

test("a refused subscription and an unanswered one get different next steps", () => {
  const stage = "Connected to DGT-1, but could not subscribe to its replies";
  assert.match(hintFor(`${stage}: GATT operation not permitted.`), /refused/);
  assert.match(hintFor(`${stage}: no answer after 15 seconds.`), /never answered/);
});

test("a missing UART service and an unanswered request for it get different next steps", () => {
  const stage = "Connected to DGT-1, but could not find its UART service";
  assert.match(hintFor(`${stage}: No Services matching UUID x found in Device.`), /not running/);
  assert.match(hintFor(`${stage}: no answer after 15 seconds.`), /stopped answering/);
});

test("a requested stop gets no next step", () => {
  assert.equal(hintFor("Stopped before the connection was ready."), null);
});

// State changes ----------------------------------------------------------------------------------
test("only the fields that changed are reported", () => {
  const before = { link: "connecting", pod: "UNKNOWN", firmware: null, notice: null, error: null };
  const after = { ...before, link: "connected", pod: "IDLE" };
  assert.deepEqual(stateChanges(before, after), ["link: connecting -> connected", "pod: UNKNOWN -> IDLE"]);
  assert.deepEqual(stateChanges(after, after), []);
});

// The log itself -----------------------------------------------------------------------------------
test("lines are stamped with the time and kept in order", () => {
  let now = new Date(2026, 10, 23, 9, 5, 7, 42).getTime();
  const log = new ConsoleLog({ now: () => now });
  log.add("note", "first");
  now += 1500;
  log.add("error", "second");
  assert.deepEqual(log.lines.map((line) => line.stamp), ["09:05:07.042", "09:05:08.542"]);
  assert.deepEqual(log.lines.map((line) => line.text), ["first", "second"]);
});

test("the oldest lines are dropped once the limit is reached", () => {
  const log = new ConsoleLog({ limit: 3 });
  for (const n of [1, 2, 3, 4, 5]) log.add("note", `line ${n}`);
  assert.deepEqual(log.lines.map((line) => line.text), ["line 3", "line 4", "line 5"]);
});

test("the exported text has one line per entry with its time and kind", () => {
  const log = new ConsoleLog({ now: () => new Date(2026, 10, 23, 9, 5, 7, 42).getTime() });
  log.add("send", "STATUS");
  const exported = log.text();
  assert.match(exported, /^DiscTrace diagnostics console/);
  assert.ok(exported.includes("09:05:07.042  send   STATUS"));
});

test("clearing empties the log", () => {
  const log = new ConsoleLog();
  log.add("note", "x");
  log.clear();
  assert.deepEqual(log.lines, []);
});

// Not saying the same thing twice ---------------------------------------------------------------
test("a failure reported by the link and again by the client is printed once", () => {
  const log = new ConsoleLog();
  log.add("error", "Connected to DGT-1, but could not find its UART service: x");
  log.add("ble", "Hung up, so the pod can advertise again.");
  assert.equal(log.repeats("note", "Connected to DGT-1, but could not find its UART service: x"), true);
  assert.equal(log.repeats("hint", "something new"), false);
});

test("the same failure in a new connection attempt is printed again", () => {
  const log = new ConsoleLog();
  const closed = "The device list closed without a device. NotFoundError: User cancelled the requestDevice() chooser.";
  log.add("error", closed);
  log.startAttempt();
  assert.equal(log.repeats("error", closed), false);     // or the second attempt looks as if nothing happened
  log.add("error", closed);
  assert.equal(log.repeats("error", closed), true);      // still printed once within the attempt
});

test("commands and replies are never treated as repeats", () => {
  const log = new ConsoleLog();
  log.add("send", "STATUS");
  log.add("recv", "ARMED");
  assert.equal(log.repeats("send", "STATUS"), false);     // polling sends the same command again and again
  assert.equal(log.repeats("recv", "ARMED"), false);
  assert.equal(log.repeats("raw", "<< 6 bytes  IDLE\\r\\n"), false);
});

test("an old failure can be printed again once it has scrolled well past", () => {
  const log = new ConsoleLog();
  log.add("error", "The Bluetooth link dropped.");
  for (let n = 0; n < 12; n += 1) log.add("send", "STATUS");
  assert.equal(log.repeats("error", "The Bluetooth link dropped."), false);
});

// A page served by the pod over Wi-Fi ------------------------------------------------------------
const servedByPod = {
  link: "wifi", version: "test", url: "http://192.168.4.1/", origin: "http://192.168.4.1",
  userAgent: "Mobile Safari (iPhone)", secure: false, hasBluetooth: false, adapter: null,
};

test("on the pod's own page nothing about Bluetooth or https is called a problem", () => {
  const lines = environmentLines(servedByPod);
  assert.ok(lines.every((line) => line.kind === "check"));
  assert.match(text(lines), /Mobile Safari/);
  assert.match(text(lines), /served by the pod.*http:\/\/192\.168\.4\.1/i);
  assert.doesNotMatch(text(lines), /no Web Bluetooth|https address/);
});

test("asking the pod who it is, and its answer, are said in words", () => {
  const [asking] = describeTrace({ step: "wifi-connecting", url: "http://192.168.4.1/api/hello" });
  assert.match(asking.text, /http:\/\/192\.168\.4\.1\/api\/hello/);
  const [answer] = describeTrace({ step: "wifi-connected", ms: 42, hello: "DGT-1 fw=2.0.0 target_hz=100" });
  assert.match(answer.text, /42 ms/);
  assert.match(answer.text, /DGT-1 fw=2\.0\.0/);
  for (const line of [asking, answer]) assert.doesNotMatch(line.text, /[{}]/);   // not the raw form an unknown step gets
});

test("a lost Wi-Fi link is an error with its reason, and a lost Bluetooth link reads as before", () => {
  const [wifi] = describeTrace({ step: "link-lost", message: "no answer for 15 seconds." });
  assert.equal(wifi.kind, "error");
  assert.match(wifi.text, /no answer for 15 seconds/);
  assert.doesNotMatch(wifi.text, /Bluetooth/);
  assert.equal(describeTrace({ step: "link-lost" })[0].text, "The Bluetooth link dropped.");
});

test("a command sent over Wi-Fi is shown without Bluetooth's write mode", () => {
  const [line] = describeTrace({ step: "tx", text: "STATUS\n", length: 7 });
  assert.ok(line.text.includes("STATUS\\n"));
  assert.match(line.text, /7 bytes/);
  assert.doesNotMatch(line.text, /response/);
});

test("the Wi-Fi failures get next steps about the network, not about Bluetooth", () => {
  const away = hintFor("Could not reach the pod at http://192.168.4.1: Failed to fetch");
  assert.match(away, /Wi-Fi network/);
  assert.match(away, /DGT-1/);
  const other = hintFor("Something at http://192.168.4.1 answered, but not like a DGT-1 pod.");
  assert.match(other, /different network/);
  for (const hint of [away, other]) assert.doesNotMatch(hint, /Bluetooth/);
});

test("the link's own lines are labelled with the link in use", () => {
  const asking = { step: "wifi-connecting", url: "http://192.168.4.1/api/hello" };
  assert.equal(describeTrace(asking, "wifi")[0].kind, "wifi");
  assert.equal(describeTrace({ step: "disconnect-requested" }, "wifi")[0].kind, "wifi");
  assert.equal(describeTrace({ step: "disconnect-requested" })[0].kind, "ble");                  // Bluetooth, as before
  assert.equal(describeTrace({ step: "link-lost", message: "x" }, "wifi")[0].kind, "error");     // a failure stays a failure
  assert.equal(describeTrace({ step: "tx", text: "STATUS\n", length: 7 }, "wifi")[0].kind, "raw");
});

// A pod on a USB cable ------------------------------------------------------------------------------
test("the checks say whether this browser can reach a pod on a USB cable", () => {
  assert.match(text(environmentLines({ ...healthy, hasSerial: true })), /USB serial.*: yes/);
  const without = environmentLines({ ...healthy, hasSerial: false });
  assert.match(text(without), /USB serial.*: no/);
  assert.ok(without.every((line) => line.kind === "check"));       // a backup that is missing is not a fault
});

test("each USB step is said in words", () => {
  const lines = [
    describeTrace({ step: "usb-chooser-open" }, "usb"),
    describeTrace({ step: "usb-picked", vendor: 0x239a, product: 0x811c }, "usb"),
    describeTrace({ step: "usb-opening" }, "usb"),
    describeTrace({ step: "usb-ready", hello: "DGT-1 fw=2.1.0 target_hz=100" }, "usb"),
  ].flat();
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.equal(line.kind, "usb");
    assert.doesNotMatch(line.text, /[{}]/);      // not the raw form an unknown step gets
  }
  assert.match(lines[1].text, /239a/i);
  assert.match(lines[1].text, /811c/i);
  assert.match(lines[3].text, /DGT-1 fw=2\.1\.0/);
});

test("a list of USB ports closed without a pick is an error with the browser's reason", () => {
  const [line] = describeTrace({ step: "usb-chooser-failed", name: "NotFoundError", message: "No port selected by the user." }, "usb");
  assert.equal(line.kind, "error");
  assert.match(line.text, /No port selected/);
});

test("the USB failures get next steps about the cable, other programs and the firmware", () => {
  assert.match(hintFor("No USB port was chosen."), /cable/);
  assert.match(hintFor("Could not open the pod's USB port: Failed to open serial port."), /another program/);
  assert.match(hintFor("The USB port opened, but nothing on it answered like a DGT-1 pod."), /firmware 2\.1/);
});

test("the Wi-Fi advice about another network is not given for a silent USB port", () => {
  assert.doesNotMatch(hintFor("The USB port opened, but nothing on it answered like a DGT-1 pod."), /network/);
});
