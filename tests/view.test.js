import { test } from "node:test";
import assert from "node:assert/strict";

import { podView } from "../js/view.js";

const base = {
  link: "connected", pod: "IDLE", summary: null, saved: false, firmware: "1.1", info: null,
  bench: null, download: null, notice: null, error: null,
};
const summary = {
  samples: 1031, peakG: 62.4, peakAbsRpm: null, nearLimit: true, maxGapMs: 10, rateHz: 100, partial: false, raw: "READY x",
};
const view = (state = {}, extra = {}) =>
  podView({ state: { ...base, ...state }, sim: false, bluetooth: true, confirmDiscard: false, failure: null, ...extra });
const ids = (v) => [v.primary?.id, ...v.secondary.map((action) => action.id)].filter(Boolean);

test("disconnected offers both ways to connect", () => {
  assert.deepEqual(ids(view({ link: "disconnected", pod: "UNKNOWN" })), ["connect-ble", "connect-sim"]);
});

test("without Web Bluetooth only the simulated pod is offered, with the reason", () => {
  const v = view({ link: "disconnected", pod: "UNKNOWN" }, { bluetooth: false });
  assert.deepEqual(ids(v), ["connect-sim"]);
  assert.match(v.detail, /Chrome or Edge/);
});

test("connecting points at the browser's list only until a pod is picked", () => {
  const choosing = view({ link: "connecting", pod: "UNKNOWN" }, { choosing: true });
  const picked = view({ link: "connecting", pod: "UNKNOWN" }, { choosing: false });
  assert.match(choosing.detail, /Bluetooth list/);
  assert.doesNotMatch(picked.detail, /list/);
  assert.match(picked.detail, /Opening the link/);
});

test("connecting offers Stop", () => {
  assert.deepEqual(ids(view({ link: "connecting", pod: "UNKNOWN" })), ["disconnect"]);
});

test("idle offers Arm and nothing else", () => {
  const v = view();
  assert.equal(v.primary.label, "Arm");
  assert.deepEqual(ids(v), ["arm"]);
});

test("armed says ready to throw and offers Cancel", () => {
  const v = view({ pod: "ARMED" });
  assert.match(v.title, /ready to throw/i);
  assert.deepEqual(ids(v), ["cancel"]);
});

test("armed on the simulated pod also offers a simulated throw and hand spin", () => {
  assert.deepEqual(ids(view({ pod: "ARMED" }, { sim: true })), ["sim-throw", "sim-handspin", "cancel"]);
});

test("recording offers no actions", () => {
  assert.deepEqual(ids(view({ pod: "RECORDING" })), []);
});

test("recording says how long this firmware records for", () => {
  const info = { fw: "1.1.2", targetHz: 100, windowS: 10, pre: 30, cols: 12 };
  assert.match(view({ pod: "RECORDING", firmware: "1.0" }).detail, /about five seconds/);
  assert.match(view({ pod: "RECORDING", firmware: "1.1.2", info }).detail, /about ten seconds/);
  assert.doesNotMatch(view({ pod: "RECORDING", firmware: null }).detail, /seconds/);   // not known yet
});

test("an unsaved capture leads with Download and save, never Arm", () => {
  const v = view({ pod: "READY", summary });
  assert.equal(v.primary.id, "download");
  assert.ok(!ids(v).includes("arm"));
  assert.ok(ids(v).includes("discard"));
});

test("a capture past the gyro limit says so instead of showing a number", () => {
  const v = view({ pod: "READY", summary });
  assert.ok(v.facts.some((fact) => /exceeded reliable range/i.test(fact.value)));
  assert.ok(v.facts.some((fact) => fact.label === "Peak acceleration during capture"));
});

test("a partial capture is flagged", () => {
  const v = view({ pod: "READY", summary: { ...summary, partial: true } });
  assert.match(v.detail, /cut short/i);
});

test("a saved capture leads with Arm next throw", () => {
  const v = view({ pod: "READY", summary, saved: true });
  assert.deepEqual(ids(v), ["arm"]);
  assert.equal(v.primary.label, "Arm next throw");
});

test("a saved capture drops the summary facts, which the throw page now shows", () => {
  assert.deepEqual(view({ pod: "READY", summary, saved: true }).facts, []);
  assert.ok(view({ pod: "READY", summary }).facts.length > 0);
});

test("asking to discard shows the confirmation instead of the normal actions", () => {
  const v = view({ pod: "READY", summary }, { confirmDiscard: true });
  assert.deepEqual(ids(v), ["discard-confirm", "discard-keep"]);
  assert.match(v.detail, /erases/i);
});

test("a download in progress shows progress and no actions", () => {
  const v = view({ pod: "READY", summary, download: { received: 512, expected: 1031 } });
  assert.deepEqual(v.progress, { received: 512, expected: 1031 });
  assert.deepEqual(ids(v), []);
});

test("a failed download explains why and offers Retry download", () => {
  const v = view({ pod: "READY", summary }, { failure: "expected 1031 rows, got 1030" });
  assert.equal(v.primary.id, "download");
  assert.equal(v.primary.label, "Retry download");
  assert.match(v.detail, /expected 1031 rows/);
});

test("sensor error shows the pod's message and offers to arm again", () => {
  const v = view({ pod: "SENSOR_ERROR", notice: "Sensor error: [Errno 5] Input/output error" });
  assert.match(v.detail, /Errno 5/);
  assert.deepEqual(ids(v), ["arm"]);
});

test("reconnecting keeps the last pod state visible and offers Stop", () => {
  const v = view({ link: "reconnecting", pod: "ARMED" });
  assert.match(v.title, /out of range/i);
  assert.match(v.detail, /armed/i);
  assert.deepEqual(ids(v), ["disconnect"]);
});

test("reconnecting on the simulated pod offers to come back in range", () => {
  assert.deepEqual(ids(view({ link: "reconnecting", pod: "ARMED" }, { sim: true })), ["sim-in-range", "disconnect"]);
});

test("an unknown pod state while connected shows a checking message", () => {
  assert.match(view({ pod: "UNKNOWN" }).title, /checking/i);
});

test("a connected pod that does not answer says so and offers Try again and Disconnect", () => {
  const v = view({ pod: "UNKNOWN", error: "The pod did not answer STATUS." });
  assert.match(v.title, /not answering/i);
  assert.match(v.detail, /did not answer STATUS/);
  assert.deepEqual(ids(v), ["check", "disconnect"]);
});

// A page served by the pod itself, over its Wi-Fi network ------------------------------------
const onWifi = { bluetooth: false, wifi: true };

test("on the pod's own page, disconnected offers the Wi-Fi link and never blames the browser", () => {
  const v = view({ link: "disconnected", pod: "UNKNOWN" }, onWifi);
  assert.deepEqual(ids(v), ["connect-wifi", "connect-sim"]);
  assert.equal(v.primary.label, "Connect to DGT-1");
  assert.match(v.detail, /Wi-Fi/);
  assert.doesNotMatch(v.detail, /Bluetooth|Chrome/);
});

test("on the pod's own page, connecting never points at a Bluetooth list", () => {
  const v = view({ link: "connecting", pod: "UNKNOWN" }, onWifi);
  assert.doesNotMatch(v.detail, /Bluetooth/);
  assert.deepEqual(ids(v), ["disconnect"]);
});

test("on the pod's own page, a lost link says to check the Wi-Fi network", () => {
  const wifi = view({ link: "reconnecting", pod: "ARMED" }, onWifi);
  assert.match(wifi.detail, /armed and waiting for a throw/);
  assert.match(wifi.detail, /pod's Wi-Fi network/);
  assert.doesNotMatch(view({ link: "reconnecting", pod: "ARMED" }).detail, /Wi-Fi/);   // Bluetooth has no network to check
});

// A pod on a USB cable, as a backup for Wi-Fi ------------------------------------------------
test("where the browser can use USB serial, it is offered beside Bluetooth", () => {
  const v = view({ link: "disconnected", pod: "UNKNOWN" }, { usb: true });
  assert.deepEqual(ids(v), ["connect-ble", "connect-usb", "connect-sim"]);
  assert.equal(v.secondary[0].label, "Connect over USB");
  assert.match(v.detail, /USB/);
});

test("with USB serial but no Bluetooth, USB is the way to connect", () => {
  const v = view({ link: "disconnected", pod: "UNKNOWN" }, { bluetooth: false, usb: true });
  assert.deepEqual(ids(v), ["connect-usb", "connect-sim"]);
  assert.match(v.detail, /USB cable/);
});

test("the pod's own page never offers USB, which a browser only allows on https", () => {
  assert.deepEqual(ids(view({ link: "disconnected", pod: "UNKNOWN" }, { ...onWifi, usb: false })), ["connect-wifi", "connect-sim"]);
});

test("connecting over USB points at the browser's list of ports until one is picked", () => {
  const choosing = view({ link: "connecting", pod: "UNKNOWN" }, { choosing: "usb" });
  assert.match(choosing.detail, /list of USB ports/);
  assert.doesNotMatch(choosing.detail, /Bluetooth/);
});

test("a lost USB link says to check the cable, not that the pod is out of range", () => {
  const v = view({ link: "reconnecting", pod: "READY" }, { via: "usb" });
  assert.match(v.title, /USB/);
  assert.match(v.detail, /holding a capture/);
  assert.match(v.detail, /cable/);
  assert.doesNotMatch(`${v.title} ${v.detail}`, /range/);
  assert.deepEqual(ids(v), ["disconnect"]);
});
