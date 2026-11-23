// Page wiring: the pod panel, tools, saved throws and the throw page.
// The rules live elsewhere (client.js, view.js, protocol.js, metrics.js);
// this file only turns their state into DOM and clicks into calls.

import { PodClient } from "./client.js";
import { SimPod } from "./transport-sim.js";
import { BleTransport } from "./transport-ble.js";
import { ThrowStore, newId } from "./store.js";
import { parseCapturedText } from "./protocol.js";
import { analyse, DEFAULT_RADIUS_MM } from "./metrics.js";
import { lineChart, chartGroup } from "./chart.js";
import { podView } from "./view.js";
import { ConsoleLog, SITE_VERSION, describeTrace, environmentLines, hintFor, stateChanges } from "./diagnostics.js";

const params = new URLSearchParams(location.search);
const SIM_SPEED = Number(params.get("simspeed")) || 3;   // the simulated pod runs a little fast
const GYRO_LIMIT_RPM = 316.7;

const client = new PodClient();
const store = new ThrowStore();
const ui = {
  transport: null,
  throws: [],
  open: null,             // { record, parsed } of the throw on screen
  confirmDiscard: false,
  confirmDelete: false,
  failure: null,          // why the last download failed
  message: null,          // why the last command failed
  busy: false,
  simFirmware: "1.1",
  radiusMm: loadRadius(),
};
window.disctrace = { client, store, ui };   // handle for debugging from the console

const $ = (selector) => document.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

const fmt = (value, digits = 0) =>
  value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function loadRadius() {
  try {
    const stored = Number(localStorage.getItem("disctrace.radiusMm"));
    return stored >= 5 && stored <= 150 ? stored : DEFAULT_RADIUS_MM;
  } catch {
    return DEFAULT_RADIUS_MM;
  }
}

function saveRadius(value) {
  try {
    localStorage.setItem("disctrace.radiusMm", String(value));
  } catch { /* storage unavailable: the setting lasts for this visit only */ }
}

// Diagnostics console ---------------------------------------------------------------
// Everything that happens is written here with a time stamp: the browser
// checks, each Bluetooth step, every packet in both directions, each change of
// state, and a next step when a failure is one the console knows.
const diag = new ConsoleLog();
const KEEP_KEY = "disctrace.console";
let earlierLines = [];      // the end of the previous visit's log, already formatted
let keepTimer = null;
let waitingRows = [];       // lines not on screen yet
let drawTimer = null;

// A download sends thousands of packets. Drawing them in batches keeps the
// page from re-measuring itself once per packet while the pod is talking.
function showLine(text, classes) {
  waitingRows.push(el("div", { class: classes, text }));
  if (drawTimer) return;
  drawTimer = setTimeout(() => {
    drawTimer = null;
    const box = $("#console-log");
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(...waitingRows);
    waitingRows = [];
    while (box.children.length > diag.limit) box.firstChild.remove();
    if (atEnd) box.scrollTop = box.scrollHeight;
  }, 50);
}

function say(kind, text) {
  if (diag.repeats(kind, text)) return;
  showLine(ConsoleLog.format(diag.add(kind, text)), `k-${kind}`);
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEEP_KEY, JSON.stringify(diag.lines.slice(-600).map(ConsoleLog.format)));
    } catch { /* storage unavailable: the log lasts for this visit only */ }
  }, 500);
  const hint = kind === "hint" || kind === "raw" ? null : hintFor(text);
  if (hint) say("hint", hint);
}

function consoleText() {
  const earlier = earlierLines.length
    ? ["---- kept from the previous visit ----", ...earlierLines, "---- this visit ----"] : [];
  const [header, ...lines] = diag.text().split("\n");
  return [header, ...earlier, ...lines].join("\n");
}

function traced(event) {
  if ((event.step === "rx" || event.step === "tx") && !$("#console-raw").checked) return;
  for (const line of describeTrace(event)) say(line.kind, line.text);
}

function newBle() {
  const transport = new BleTransport();
  transport.onTrace = traced;
  return transport;
}

async function runChecks() {
  const hasBluetooth = BleTransport.supported;
  let adapter = null;
  if (hasBluetooth && navigator.bluetooth.getAvailability) {
    try {
      adapter = await navigator.bluetooth.getAvailability();
    } catch (error) {
      adapter = `${error.name}: ${error.message}`;
    }
  }
  const facts = {
    version: SITE_VERSION, url: location.href, userAgent: navigator.userAgent,
    secure: window.isSecureContext, hasBluetooth, adapter,
  };
  for (const line of environmentLines(facts)) say(line.kind, line.text);
}

function renderConsoleStatus() {
  const { state } = client;
  $("#console-status").textContent = `link: ${state.link} | pod: ${state.pod} | firmware: ${state.firmware ?? "unknown"}`
    + ` | transport: ${ui.transport?.kind ?? "none"} | site: ${SITE_VERSION}`;
}

function startConsole() {
  try {
    earlierLines = JSON.parse(localStorage.getItem(KEEP_KEY) ?? "[]");
  } catch {
    earlierLines = [];
  }
  if (earlierLines.length) {
    showLine("---- kept from the previous visit ----", "earlier");
    for (const line of earlierLines) showLine(line, "earlier");
    showLine("---- this visit ----", "earlier");
  }
  say("note", "Console started. Everything this page does with the pod is written here.");
  window.addEventListener("error", (event) => {
    say("error", `Page error: ${event.message} (${String(event.filename).split("/").pop()}:${event.lineno})`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    say("error", `Page error: ${event.reason?.message ?? event.reason}`);
  });
  document.addEventListener("visibilitychange", () => {
    say("note", document.hidden ? "This page went to the background." : "This page is in front again.");
  });
  if (BleTransport.supported && navigator.bluetooth.addEventListener) {
    navigator.bluetooth.addEventListener("availabilitychanged", (event) => {
      say(event.value ? "check" : "error", `Bluetooth adapter is now ${event.value ? "on" : "off"}.`);
    });
  }

  $("#console-checks").addEventListener("click", () => runChecks());
  $("#console-scan").addEventListener("click", () => scanAll());
  $("#console-copy").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(consoleText());
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy not allowed here";
    }
    setTimeout(() => {
      event.target.textContent = "Copy all";
    }, 1500);
  });
  $("#console-save").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([`${consoleText()}\n`], { type: "text/plain" }));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const link = el("a", { href: url, download: `disctrace-console-${stamp}.txt` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("#console-clear").addEventListener("click", () => {
    diag.clear();
    earlierLines = [];
    waitingRows = [];
    $("#console-log").replaceChildren();
    try {
      localStorage.removeItem(KEEP_KEY);
    } catch { /* nothing was stored */ }
    say("note", "Console cleared.");
  });
  $("#console-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#console-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await client.send(text);
    } catch (error) {
      say("error", `Could not send "${text}": ${error.message}`);
    }
  });
  runChecks().catch((error) => say("error", `Checks failed: ${error.message}`));
}

/** Shows every Bluetooth device nearby, then connects to the one picked. Tells
 *  apart a pod that is not broadcasting from a browser that is not scanning. */
async function scanAll() {
  if (!BleTransport.supported) {
    say("error", "This browser has no Web Bluetooth, so it cannot scan.");
    return;
  }
  if (client.state.link !== "disconnected") {
    say("note", "Disconnect first, then scan.");
    return;
  }
  const transport = newBle();
  ui.transport = transport;
  ui.confirmDiscard = false;
  ui.failure = null;
  await run(async () => {
    try {
      await transport.choose({ all: true });
    } catch (error) {
      say("note", error.message);
      throw error;
    }
    await client.connect(transport);
  });
}

// Pod panel -----------------------------------------------------------------------
const DISC = '<svg class="pod-disc" viewBox="0 0 76 76" aria-hidden="true">'
  + '<circle class="plate" cx="38" cy="38" r="33"/><g class="spin"><circle class="rim" cx="38" cy="38" r="33"/></g>'
  + '<circle class="puck" cx="38" cy="38" r="15"/><circle class="sensor" cx="45" cy="46" r="3.2"/></svg>';

async function run(task) {
  ui.busy = true;
  ui.message = null;
  renderPod();
  try {
    await task();
  } catch (error) {
    // A pod that is not answering is already explained by the panel itself.
    ui.message = error.message === client.state.error ? null : error.message;
  }
  ui.busy = false;
  renderPod();
}

async function connect(transport) {
  ui.transport = transport;
  ui.confirmDiscard = false;
  ui.failure = null;
  await run(() => client.connect(transport));
}

async function arm(confirmed) {
  if (!confirmed && client.needsDiscardConfirm) {
    ui.confirmDiscard = true;
    renderPod();
    return;
  }
  ui.failure = null;
  await run(async () => {
    let result = await client.arm();
    if (result === "unsaved" && confirmed) result = await client.arm();   // the user already agreed
    ui.confirmDiscard = result === "unsaved";
  });
}

async function downloadAndSave() {
  ui.failure = null;
  ui.message = null;
  ui.busy = true;
  renderPod();
  try {
    const capture = await client.download();
    const record = {
      id: newId(),
      savedAt: new Date().toISOString(),
      label: nextLabel(),
      source: ui.transport.kind === "sim" ? "Simulated pod" : "DGT-1",
      firmware: client.state.firmware,
      columns: capture.columns,
      samples: capture.rows.length,
      summaryRaw: capture.summary.raw,
      csv: capture.csv,
      incomplete: false,
    };
    await store.put(record);      // only a saved throw unlocks the next ARM
    client.markSaved();
    await loadHistory();
    openThrow(record.id, true);
  } catch (error) {
    ui.failure = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  }
  ui.busy = false;
  renderPod();
}

function simulate(kind) {
  if (ui.transport.throwDisc(kind)) client.refresh().catch(() => {});
}

const ACTIONS = {
  "connect-ble": () => connect(newBle()),
  "connect-sim": () => connect(new SimPod({ firmware: ui.simFirmware, speed: SIM_SPEED })),
  arm: () => arm(false),
  cancel: () => run(() => client.cancel()),
  check: () => run(() => client.check()),
  download: () => downloadAndSave(),
  discard: () => {
    ui.confirmDiscard = true;
    renderPod();
  },
  "discard-confirm": () => arm(true),
  "discard-keep": () => {
    ui.confirmDiscard = false;
    renderPod();
  },
  disconnect: () => client.disconnect(),
  "sim-throw": () => simulate("throw"),
  "sim-handspin": () => simulate("handspin"),
  "sim-in-range": () => ui.transport.setOutOfRange(false),
};

function renderPod() {
  const { state } = client;
  const view = podView({
    state,
    sim: ui.transport?.kind === "sim",
    bluetooth: BleTransport.supported && window.isSecureContext,
    confirmDiscard: ui.confirmDiscard,
    failure: ui.failure,
  });
  const pod = $("#pod");
  pod.className = `pod tone-${view.tone}`;

  const head = el("div", { class: "pod-head" });
  head.innerHTML = DISC;
  head.append(el("h2", { class: "pod-title", text: view.title }));
  const parts = [head, el("p", { class: "pod-detail", text: view.detail })];

  if (view.facts.length) {
    parts.push(el("dl", { class: "pod-facts" },
      ...view.facts.map((fact) => el("div", {}, el("dt", { text: fact.label }), el("dd", { text: fact.value })))));
  }
  if (view.progress) {
    const { received, expected } = view.progress;
    const fill = el("div", { class: "progress-fill" });
    fill.style.width = `${Math.min(100, (received / expected) * 100)}%`;
    parts.push(el("div", { class: "progress" },
      el("div", { class: "progress-track" }, fill),
      el("p", { class: "progress-text", text: `${fmt(received)} of ${fmt(expected)} rows` })));
  }
  if (ui.message) parts.push(el("p", { class: "problem pod-problem", text: ui.message }));

  const buttons = [];
  if (view.primary) {
    buttons.push(el("button", {
      type: "button", class: "primary", "data-action": view.primary.id, text: view.primary.label,
      disabled: ui.busy, onclick: ACTIONS[view.primary.id],
    }));
  }
  for (const action of view.secondary) {
    buttons.push(el("button", {
      type: "button", class: "secondary", "data-action": action.id, text: action.label,
      disabled: ui.busy && !action.id.startsWith("sim-") && action.id !== "disconnect",
      onclick: ACTIONS[action.id],
    }));
  }
  if (buttons.length) parts.push(el("div", { class: "pod-actions" }, ...buttons));
  pod.replaceChildren(...parts);

  const status = $("#pod-status");
  if (status.textContent !== view.title) status.textContent = view.title;

  const name = ui.transport?.name ?? "the pod";
  $("#link-text").textContent = {
    disconnected: "Not connected",
    connecting: "Connecting",
    connected: `Connected to ${name}${state.firmware ? `, firmware ${state.firmware}` : ""}`,
    reconnecting: `Reconnecting to ${name}`,
  }[state.link];
  $("#link-disconnect").hidden = state.link !== "connected";
}

// Tools and log ---------------------------------------------------------------------
let toolsKey = "";

function renderTools() {
  const { state } = client;
  const sim = ui.transport?.kind === "sim";
  const key = [state.link, state.firmware, state.bench, state.pod, sim, ui.simFirmware].join("|");
  if (key === toolsKey) return;
  toolsKey = key;
  const body = $("#tools-body");
  const parts = [];

  if (state.link === "connected") {
    const info = state.info
      ? `Firmware ${state.info.fw}: ${state.info.cols} columns, ${state.info.windowS} second recording, `
        + `${state.info.targetHz} samples per second.`
      : state.firmware === "1.0"
        ? "Firmware 1.0 (it does not answer INFO): nine columns, five second recording."
        : "Checking the firmware.";
    parts.push(el("p", { class: "note", text: info }));
    const benchable = state.firmware !== "1.0" && state.pod !== "ARMED" && state.pod !== "RECORDING";
    parts.push(el("div", { class: "tool-row" },
      el("button", { type: "button", class: "quiet", text: "Refresh status", onclick: () => run(() => client.refresh()) }),
      el("button", {
        type: "button", class: "quiet", "data-action": "bench", text: "Run sensor speed test", disabled: !benchable,
        onclick: () => run(() => client.bench()),
      })));
    if (state.bench) {
      parts.push(el("p", { class: "note", id: "bench-result", text: `${fmt(state.bench)} full sensor reads per second.` }));
    }
    if (sim) {
      parts.push(el("div", { class: "tool-row" }, el("button", {
        type: "button", class: "quiet", "data-action": "sim-out", text: "Take simulated pod out of range",
        onclick: () => ui.transport.setOutOfRange(true),
      })));
    }
  } else {
    parts.push(el("p", { class: "note", text: "Connect to a pod to see its firmware and run tests." }));
  }

  const select = el("select", { id: "sim-firmware", onchange: (event) => {
    ui.simFirmware = event.target.value;
  } },
  el("option", { value: "1.1", text: "1.1" }),
  el("option", { value: "1.0-drive", text: "1.0, Drive copy" }),
  el("option", { value: "1.0", text: "1.0, handoff ZIP copy" }));
  select.value = ui.simFirmware;
  parts.push(el("div", { class: "tool-row" },
    el("label", { for: "sim-firmware", class: "note", text: "Simulated pod firmware, next connection" }), select));
  body.replaceChildren(...parts);
}

function appendLog({ dir, text }) {
  const list = $("#log");
  const word = { tx: "sent", rx: "got", info: "note" }[dir];
  list.append(el("li", {}, el("span", { class: "dir", text: word }), text));
  while (list.children.length > 400) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

// Saved throws ------------------------------------------------------------------------
function nextLabel() {
  const taken = new Set(ui.throws.map((record) => record.label));
  let n = ui.throws.length + 1;
  while (taken.has(`Throw ${n}`)) n += 1;
  return `Throw ${n}`;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function loadHistory() {
  ui.throws = await store.list();
  renderHistory();
}

function renderHistory() {
  const note = $("#history-note");
  note.hidden = store.persistent;
  note.textContent = "This browser is not keeping throws between visits. Export the ones you want to keep.";
  const list = $("#history-list");
  if (!ui.throws.length) {
    list.replaceChildren(el("li", { class: "history-empty", text: "No saved throws yet. Download one from the pod, or import a capture." }));
    return;
  }
  list.replaceChildren(...ui.throws.map((record) => el("li", {}, el("button", {
    type: "button", class: "history-item", "aria-current": ui.open?.record.id === record.id ? "true" : false,
    onclick: () => openThrow(record.id, true),
  },
  el("span", { class: "history-label", text: record.label }),
  el("span", { class: "history-meta", text: `${when(record.savedAt)}, ${fmt(record.samples)} samples, ${record.source}` })))));
}

function openThrow(id, scroll = false) {
  const record = ui.throws.find((item) => item.id === id);
  if (!record) return;
  ui.open = { record, parsed: parseCapturedText(record.csv) };
  ui.confirmDelete = false;
  renderThrow();
  renderHistory();
  if (scroll && window.matchMedia("(max-width: 820px)").matches) {
    $("#throw").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function importText(text, name) {
  const problem = $("#import-error");
  problem.hidden = true;
  try {
    const parsed = parseCapturedText(text);
    const record = {
      id: newId(),
      savedAt: new Date().toISOString(),
      label: name ? name.replace(/\.[^.]+$/, "") : nextLabel(),
      source: "Imported",
      firmware: parsed.columns === 12 ? "1.1" : "1.0",
      columns: parsed.columns,
      samples: parsed.rows.length,
      summaryRaw: parsed.summary?.raw ?? null,
      csv: parsed.csv,
      incomplete: !parsed.complete,
    };
    await store.put(record);
    await loadHistory();
    openThrow(record.id, true);
    $("#import-text").value = "";
  } catch (error) {
    problem.textContent = `Could not import: ${error.message}`;
    problem.hidden = false;
  }
}

function exportCsv(record) {
  // Same text the pod sent: header, rows, END.
  const url = URL.createObjectURL(new Blob([`${record.csv}END\n`], { type: "text/csv" }));
  const slug = record.label.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "throw";
  const saved = new Date(record.savedAt);   // local date, so the file name matches what the page shows
  const day = [saved.getFullYear(), saved.getMonth() + 1, saved.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
  const link = el("a", { href: url, download: `${slug}-${day}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Throw page ---------------------------------------------------------------------------
function renderThrow() {
  const main = $("#throw");
  if (!ui.open) {
    main.replaceChildren(el("div", { class: "empty" },
      el("h2", { text: "No throw open" }),
      el("p", { text: "Connect to the pod, arm it, throw, then download. The throw opens here with its spin and "
        + "acceleration charts. Saved throws stay on this device and open without Bluetooth." })));
    return;
  }
  const { record, parsed } = ui.open;
  const result = analyse(parsed.rows, { radiusMm: ui.radiusMm });

  const label = el("input", {
    class: "throw-label", type: "text", value: record.label, "aria-label": "Throw name",
    onchange: async (event) => {
      record.label = event.target.value.trim() || "Untitled throw";
      event.target.value = record.label;
      await store.put(record);
      renderHistory();
    },
  });
  const actions = ui.confirmDelete
    ? el("div", { class: "throw-actions" },
      el("span", { class: "note", text: "Delete this throw from this device?" }),
      el("button", { type: "button", class: "quiet", "data-action": "delete-confirm", text: "Delete", onclick: async () => {
        await store.remove(record.id);
        ui.open = null;
        await loadHistory();
        renderThrow();
      } }),
      el("button", { type: "button", class: "quiet", text: "Keep", onclick: () => {
        ui.confirmDelete = false;
        renderThrow();
      } }))
    : el("div", { class: "throw-actions" },
      el("button", { type: "button", class: "quiet", "data-action": "export", text: "Export CSV", onclick: () => exportCsv(record) }),
      el("button", { type: "button", class: "quiet", "data-action": "delete", text: "Delete", onclick: () => {
        ui.confirmDelete = true;
        renderThrow();
      } }));

  let meta = `${when(record.savedAt)}. ${record.source}, firmware ${record.firmware}, ${record.columns} columns.`;
  if (record.incomplete) meta += " No END marker was found, so this capture may be incomplete.";

  const stat = (name, value, small) => el("div", {}, el("dt", { text: name }),
    el("dd", { text: value }, small ? el("small", { text: small }) : null));
  const stats = el("dl", { class: "stats" },
    stat("Peak spin, estimated",
      result.peakEstRpm === null ? "Too slow to estimate" : `${fmt(result.peakEstRpm)} RPM`,
      "from the high-g sensor"),
    stat("Gyro spin",
      result.gyroLimited ? "Exceeded reliable range" : `${fmt(result.peakGyroRpm ?? 0)} RPM peak`,
      result.gyroLimited ? "the gyro stops at 317 RPM" : "within the gyro's range"),
    stat("Peak acceleration during capture", `${fmt(result.peakG, 1)} g`, "can come from the landing"),
    stat("Capture length", `${fmt(result.durationS, 2)} s`,
      `${fmt(result.sampleCount)} samples at ${fmt(result.rateHz, 1)} per second, longest gap ${fmt(result.maxGapMs, 1)} ms`));

  const radiusInput = el("input", {
    id: "radius", type: "number", min: "5", max: "150", step: "0.1", value: String(ui.radiusMm),
    onchange: (event) => setRadius(Number(event.target.value)),
  });
  const radius = el("div", { class: "radius" },
    el("label", { for: "radius", text: "Distance from the disc's centre to the high-g sensor" }), radiusInput, el("span", { text: "mm" }));
  if (result.calibration) {
    const suggested = Math.round(result.calibration.radiusMm * 10) / 10;
    if (Math.abs(suggested - ui.radiusMm) < 0.05) {
      radius.append(el("span", { class: "note", text: "Matches this capture's slow spin." }));
    } else {
      radius.append(el("button", {
        type: "button", class: "quiet", "data-action": "use-radius", text: `Use ${fmt(suggested, 1)} mm`,
        onclick: () => setRadius(suggested),
      }), el("span", { class: "note", text: `This capture's slow spin suggests ${fmt(suggested, 1)} mm `
        + `(${fmt(result.calibration.samples)} samples the gyro could read).` }));
    }
  }
  radius.append(el("p", { class: "radius-note", text: "The spin estimate assumes the disc's centre is not being pushed. "
    + "It holds in flight and in a steady spin, and reads high during the throw itself and at landing." }));

  const charts = el("div", { class: "charts" }, el("div"), el("div"), el("div"));
  const table = el("details", { class: "data-details", ontoggle: (event) => {
    if (event.target.open && !event.target.querySelector("table")) event.target.append(dataTable(record));
  } }, el("summary", { text: "Data table" }),
  record.summaryRaw ? el("p", { class: "note", text: `Pod summary: ${record.summaryRaw}` }) : null);

  main.replaceChildren(el("div", { class: "throw-head" }, label, actions),
    el("p", { class: "throw-meta", text: meta }), stats, radius, charts, table);

  const { series } = result;
  const group = chartGroup();
  const [spinBox, accelBox, gyroBox] = charts.children;
  lineChart(spinBox, {
    title: "Spin", unit: "RPM", x: series.t, group,
    series: [
      { name: "Gyro", color: "var(--series-1)", values: series.gyroRpm },
      { name: "Estimated from acceleration", color: "var(--series-2)", values: series.estRpm },
    ],
    marks: [{ y: GYRO_LIMIT_RPM, label: "Gyro limit, 317 RPM" }],
  });
  lineChart(accelBox, {
    title: "Acceleration at the sensor", unit: "g", x: series.t, group,
    series: [
      { name: "High-g sensor", color: "var(--series-1)", values: series.accelG },
      ...(series.imuG ? [{ name: "IMU, clips at 16 g per axis", color: "var(--series-2)", values: series.imuG }] : []),
    ],
  });
  lineChart(gyroBox, {
    title: "Gyro X and Y", unit: "rad/s", x: series.t, group,
    series: [
      { name: "X", color: "var(--series-1)", values: series.gx },
      { name: "Y", color: "var(--series-2)", values: series.gy },
    ],
  });
}

function setRadius(value) {
  if (!(value >= 5 && value <= 150)) return;
  ui.radiusMm = Math.round(value * 10) / 10;
  saveRadius(ui.radiusMm);
  renderThrow();
}

function dataTable(record) {
  const [header, ...rows] = record.csv.trim().split("\n");
  const head = el("tr", {}, ...header.split(",").map((name) => el("th", { scope: "col", text: name })));
  const body = rows.map((row) => el("tr", {}, ...row.split(",").map((cell) => el("td", { text: cell === "" ? "none" : cell }))));
  return el("div", { class: "table-wrap", tabindex: "0" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...body)));
}

// Start ------------------------------------------------------------------------------------
let lastState = { ...client.state };
client.on("change", () => {
  if (client.state.pod !== "READY") {
    ui.confirmDiscard = false;
    ui.failure = null;
  }
  for (const change of stateChanges(lastState, client.state)) say("state", change);
  lastState = { ...client.state };
  renderConsoleStatus();
  renderPod();
  renderTools();
});
client.on("log", appendLog);
client.on("log", ({ dir, text }) => say({ tx: "send", rx: "recv", info: "note" }[dir], text));

$("#link-disconnect").addEventListener("click", () => client.disconnect());
$("#log-copy").addEventListener("click", async (event) => {
  const text = [...$("#log").children].map((item) => item.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    event.target.textContent = "Copied";
  } catch {
    event.target.textContent = "Copy not allowed here";
  }
  setTimeout(() => {
    event.target.textContent = "Copy log";
  }, 1500);
});
$("#import-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (file) await importText(await file.text(), file.name);
  event.target.value = "";
});
$("#import-go").addEventListener("click", () => importText($("#import-text").value));

startConsole();       // first, so it can report anything that goes wrong below
renderConsoleStatus();
await store.open();
say("check", store.persistent
  ? "Saved throws: kept in this browser between visits."
  : "Saved throws: this browser is not keeping them between visits.");
await loadHistory();
renderPod();
renderTools();
renderThrow();
