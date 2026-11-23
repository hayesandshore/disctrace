// Words and checks for the diagnostics console. Pure: no DOM and no Bluetooth
// calls, so every line the console can print is testable.

export const SITE_VERSION = "2026-11-23 console";

const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CIRCUITPYTHON_SERVICES = [
  "0000febb-0000-1000-8000-00805f9b34fb",
  "adaf0001-4369-7263-7569-74507974686e",
];
const KNOWN_SERVICES = {
  [NUS]: "Nordic UART, the pod's program",
  [CIRCUITPYTHON_SERVICES[0]]: "CircuitPython file transfer",
  [CIRCUITPYTHON_SERVICES[1]]: "CircuitPython serial",
  "0000180a-0000-1000-8000-00805f9b34fb": "device information",
  "0000180f-0000-1000-8000-00805f9b34fb": "battery",
};

/** Services to ask the browser for, besides UART, when looking at any device. */
export const EXTRA_SERVICES = Object.keys(KNOWN_SERVICES).filter((uuid) => uuid !== NUS);

/** Makes line endings and other invisible bytes visible. */
export function showText(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, (char) => {
    if (char === "\r") return "\\r";
    if (char === "\n") return "\\n";
    if (char === "\t") return "\\t";
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

export function serviceLabel(uuid) {
  return KNOWN_SERVICES[String(uuid).toLowerCase()] ?? "unknown service";
}

/** The start-up checks, from facts the page gathered about the browser.
 *  adapter is true, false, null when the browser cannot say, or the text of
 *  the error the check raised. */
export function environmentLines({ version, url, userAgent, secure, hasBluetooth, adapter }) {
  const lines = [
    { kind: "check", text: `Site version ${version}, page ${url}` },
    { kind: "check", text: `Browser: ${userAgent}` },
  ];
  lines.push(secure
    ? { kind: "check", text: "Secure page (https or localhost): yes" }
    : { kind: "error", text: "This page is not on https or localhost, so the browser refuses Bluetooth. Open the https address." });
  if (!hasBluetooth) {
    lines.push({
      kind: "error",
      text: "This browser has no Web Bluetooth. Use Chrome or Edge on a computer, or Chrome on Android. "
        + "Safari, Firefox and every iPhone browser cannot connect.",
    });
    return lines;
  }
  lines.push({ kind: "check", text: "Web Bluetooth in this browser: yes" });
  if (adapter === true) lines.push({ kind: "check", text: "Bluetooth adapter: on" });
  else if (adapter === false) {
    lines.push({
      kind: "error",
      text: "Bluetooth is off or missing on this device. Turn it on in the system settings, then press Run checks.",
    });
  } else if (adapter === null) lines.push({ kind: "check", text: "Bluetooth adapter: this browser cannot say" });
  else lines.push({ kind: "error", text: `Bluetooth adapter check failed: ${adapter}` });
  return lines;
}

/** Turns one event from the Bluetooth transport into console lines. */
export function describeTrace(event) {
  const { step, ...detail } = event;
  switch (step) {
    case "chooser-open":
      return [{
        kind: "ble",
        text: detail.all
          ? "Opening the browser's list of every Bluetooth device nearby."
          : "Opening the browser's device list, limited to DGT-1 (the UART service or the name DGT-1).",
      }];
    case "chooser-picked":
      return [{ kind: "ble", text: `Picked ${detail.name ?? "a device with no name"} (id ${detail.id}).` }];
    case "chooser-failed":
      return [{ kind: "error", text: `The device list closed without a device. ${detail.name}: ${detail.message}` }];
    case "gatt-connecting":
      return [{ kind: "ble", text: "Opening the Bluetooth link." }];
    case "gatt-connected":
      return [{ kind: "ble", text: `Bluetooth link open after ${detail.ms} ms.` }];
    case "uart-found":
      return [{
        kind: "ble",
        text: `UART service found. Write characteristic: ${detail.rx}. Reply characteristic: ${detail.tx}.`,
      }];
    case "subscribed":
      return [{ kind: "ble", text: "Subscribed to the pod's replies. The link is ready." }];
    case "services": {
      const uuids = detail.uuids ?? [];
      if (!uuids.length) {
        return [{
          kind: "ble",
          text: `This page can see no services on the device${detail.message ? ` (${detail.message})` : ""}.`,
        }];
      }
      const lines = [{
        kind: "ble",
        text: `Services this page can see: ${uuids.map((uuid) => `${uuid} (${serviceLabel(uuid)})`).join("; ")}`,
      }];
      if (!uuids.includes(NUS) && uuids.some((uuid) => CIRCUITPYTHON_SERVICES.includes(uuid))) {
        lines.push({
          kind: "hint",
          text: "The device offers CircuitPython's own Bluetooth but not the pod's UART service: "
            + "code.py is not running. Look at the USB console for the reason.",
        });
      }
      return lines;
    }
    case "connect-failed":
      return [{ kind: "error", text: detail.message }];
    case "hung-up":
      return [{ kind: "ble", text: "Hung up, so the pod can advertise again." }];
    case "link-lost":
      return [{ kind: "error", text: "The Bluetooth link dropped." }];
    case "disconnect-requested":
      return [{ kind: "ble", text: "Disconnecting on request." }];
    case "rx":
      return [{
        kind: "raw",
        text: `<< ${detail.bytes.length} bytes  ${showText(new TextDecoder().decode(detail.bytes))}`,
      }];
    case "tx":
      return [{
        kind: "raw",
        text: `>> ${detail.length} bytes ${detail.withResponse ? "with" : "without"} response  ${showText(detail.text)}`,
      }];
    default:
      return [{ kind: "ble", text: `${step} ${JSON.stringify(detail)}` }];
  }
}

const HINTS = [
  [/No pod was chosen/, "If DGT-1 was not in the list, press \"Scan for all Bluetooth devices\". An empty list there "
    + "means this browser or computer is not scanning. Other devices but no DGT-1 means the pod is not "
    + "broadcasting: check its power and its USB console."],
  [/could not find its UART service/, "The device answered, but the pod's program is not running on it. Look at the "
    + "USB console for an error, and check that code.py is at the top of the CIRCUITPY drive."],
  [/could not subscribe/, "The link opened but the pod refused the reply subscription. Disconnect, reset the pod and "
    + "try again; if it repeats, send this log."],
  [/Could not connect to/, "The pod was seen but the link did not open. Move closer, and make sure another phone, "
    + "tab or app is not already connected to it."],
  [/did not answer/, "The link is up but the pod is silent. Its program may be stuck: look at the USB console. A last "
    + "line of \"Starting sensors.\" means a sensor cable is marginal."],
  [/link dropped|Link lost/, "The pod went out of range, lost power or restarted. A drop every few seconds points to "
    + "the pod's program failing and restarting: look at the USB console."],
  [/SENSOR_ERROR/, "The pod reports a sensor fault. With the power off, check the cable to the sensor it names."],
];

/** A next step for a failure the console knows about, or null. */
export function hintFor(text) {
  const match = HINTS.find(([pattern]) => pattern.test(text));
  return match ? match[1] : null;
}

const STATE_KEYS = ["link", "pod", "firmware", "notice", "error"];

/** The fields of the client's state that differ, as "name: old -> new". */
export function stateChanges(before, after) {
  return STATE_KEYS
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${before[key] ?? "none"} -> ${after[key] ?? "none"}`);
}

/** The console's lines: time-stamped, capped, and exportable as text. */
export class ConsoleLog {
  constructor({ limit = 4000, now = Date.now } = {}) {
    this.limit = limit;
    this.now = now;
    this.lines = [];
  }

  add(kind, text) {
    const at = new Date(this.now());
    const two = (value) => String(value).padStart(2, "0");
    const stamp = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.`
      + String(at.getMilliseconds()).padStart(3, "0");
    const line = { stamp, kind, text };
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    return line;
  }

  clear() {
    this.lines = [];
  }

  /** True when this failure, note or hint was printed a moment ago. The link
   *  and the client often report the same failure. Commands, replies and
   *  packets are never repeats: polling sends the same line many times. */
  repeats(kind, text) {
    if (kind !== "error" && kind !== "note" && kind !== "hint") return false;
    return this.lines.slice(-8).some((line) => line.text === text);
  }

  static format(line) {
    return `${line.stamp}  ${line.kind.padEnd(5)}  ${line.text}`;
  }

  text() {
    return [
      `DiscTrace diagnostics console, exported ${new Date(this.now()).toISOString()}`,
      ...this.lines.map(ConsoleLog.format),
    ].join("\n");
  }
}
