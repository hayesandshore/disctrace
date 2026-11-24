// Decides what the pod panel says and which buttons it shows, from the
// client's state. Pure: no DOM, so the rules can be tested directly.

const number = (value, digits = 0) =>
  value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const POD_WORDS = {
  IDLE: "idle", ARMED: "armed and waiting for a throw", RECORDING: "recording",
  READY: "holding a capture", SENSOR_ERROR: "reporting a sensor error", UNKNOWN: "in an unknown state",
};

const SECONDS = { 5: "five", 10: "ten" };

function summaryFacts(summary) {
  return [
    { label: "Samples", value: number(summary.samples) },
    { label: "Peak acceleration during capture", value: `${number(summary.peakG, 1)} g` },
    {
      label: "Gyro spin",
      value: summary.nearLimit ? "Spin exceeded reliable range" : `${number(summary.peakAbsRpm, 0)} RPM peak`,
    },
    ...(summary.rateHz ? [{ label: "Sample rate", value: `${number(summary.rateHz, 1)} per second` }] : []),
    { label: "Longest gap", value: `${number(summary.maxGapMs, 1)} ms` },
  ];
}

/** Returns { tone, title, detail, facts, progress, primary, secondary }. */
export function podView({
  state, sim, bluetooth, wifi = false, usb = false, via = null, confirmDiscard, failure, choosing = false,
}) {
  const view = { tone: "offline", title: "", detail: "", facts: [], progress: null, primary: null, secondary: [] };

  if (state.link === "disconnected" || state.link === "connecting") {
    view.title = state.link === "connecting" ? "Connecting" : "Not connected";
    if (state.link === "connecting") {
      // choosing: the browser's list is open and nothing is picked yet. "usb" for its list of ports.
      view.detail = choosing === "usb"
        ? "Choose the pod in the browser's list of USB ports. It is listed as a Feather ESP32-S3 or a CircuitPython port."
        : choosing
          ? "Choose DGT-1 in the browser's Bluetooth list."
          : "Opening the link to the pod. This can take a few seconds.";
      view.secondary.push({ id: "disconnect", label: "Stop" });
      return view;
    }
    if (wifi) {
      // The pod served this page itself, so it is reached at the page's own address.
      view.detail = "This page comes from the pod, over its Wi-Fi network. Keep this device on that network. "
        + "Saved throws stay on this device either way.";
      view.primary = { id: "connect-wifi", label: "Connect to DGT-1" };
      view.secondary.push({ id: "connect-sim", label: "Use simulated pod" });
    } else if (bluetooth) {
      view.detail = "Power the pod, keep it close, then connect. Saved throws stay on this device either way.";
      view.primary = { id: "connect-ble", label: "Connect to DGT-1" };
      if (usb) {
        // usb: this browser can reach a pod's serial port, the backup for a pod on Wi-Fi firmware.
        view.detail += " A pod with Wi-Fi firmware can be plugged in and reached over USB instead.";
        view.secondary.push({ id: "connect-usb", label: "Connect over USB" });
      }
      view.secondary.push({ id: "connect-sim", label: "Use simulated pod" });
    } else if (usb) {
      view.detail = "This browser can't use Bluetooth, but it can reach a pod on a USB cable (Wi-Fi firmware 2.1 or later). "
        + "Plug the pod in, then connect. Saved throws stay on this device either way.";
      view.primary = { id: "connect-usb", label: "Connect over USB" };
      view.secondary.push({ id: "connect-sim", label: "Use simulated pod" });
    } else {
      view.detail = "This browser can't use Bluetooth. Open this page in Chrome or Edge on a computer, "
        + "or Chrome on Android, over HTTPS or localhost. The simulated pod and saved throws work here.";
      view.primary = { id: "connect-sim", label: "Use simulated pod" };
    }
    return view;
  }

  if (state.link === "reconnecting") {
    view.tone = "warning";
    view.title = "Out of range. Reconnecting";
    view.detail = `The pod was last ${POD_WORDS[state.pod]}. It keeps going on its own, `
      + "and this page will pick it up again when it is back in range.";
    if (via === "usb") {
      // via: the kind of link in use. A cable has no range to be out of.
      view.title = "USB link lost. Reconnecting";
      view.detail = `The pod was last ${POD_WORDS[state.pod]}. Check the USB cable at both ends. `
        + "This page will pick the pod up again when its port is back.";
    }
    if (wifi && !sim) {
      // A phone drops a network with no internet by itself, which looks the same from here.
      view.detail += " If it does not, check that this device is still on the pod's Wi-Fi network.";
    }
    if (sim) view.secondary.push({ id: "sim-in-range", label: "Bring simulated pod back in range" });
    view.secondary.push({ id: "disconnect", label: "Stop" });
    return view;
  }

  switch (state.pod) {
    case "IDLE":
      view.tone = "idle";
      view.title = "Idle";
      view.detail = state.notice || "Keep the disc still, then arm it.";
      view.primary = { id: "arm", label: "Arm" };
      break;
    case "ARMED":
      view.tone = "armed";
      view.title = "Armed. Ready to throw";
      view.detail = "Recording starts when the pod feels the throw, and carries on if this device goes out of range.";
      if (sim) {
        view.secondary.push({ id: "sim-throw", label: "Simulate a throw" }, { id: "sim-handspin", label: "Simulate a hand spin" });
      }
      view.secondary.push({ id: "cancel", label: "Cancel" });
      break;
    case "RECORDING": {
      view.tone = "recording";
      view.title = "Recording";
      // Firmware 1.1 reports its window in INFO; firmware 1.0 records for five seconds.
      const seconds = state.info?.windowS ?? (state.firmware === "1.0" ? 5 : null);
      view.detail = "The pod is busy capturing and answers nothing until it finishes"
        + (seconds ? `, about ${SECONDS[seconds] ?? seconds} seconds.` : ".");
      break;
    }
    case "READY":
      view.facts = state.summary ? summaryFacts(state.summary) : [];
      if (state.download) {
        view.tone = "ready";
        view.title = "Downloading";
        view.detail = "Keep the pod in range until the download finishes.";
        view.progress = state.download;
      } else if (confirmDiscard) {
        view.tone = "warning";
        view.title = "Discard this throw?";
        view.detail = "It has not been saved. Arming erases it from the pod, and it cannot be recovered.";
        view.primary = { id: "discard-confirm", label: "Discard and arm" };
        view.secondary.push({ id: "discard-keep", label: "Keep it" });
      } else if (state.saved) {
        view.facts = [];
        view.tone = "saved";
        view.title = "Saved";
        view.detail = "This throw is in your history. The pod can take the next one.";
        view.primary = { id: "arm", label: "Arm next throw" };
      } else {
        view.tone = failure ? "warning" : "ready";
        view.title = failure ? "Download failed" : "Throw captured";
        view.detail = failure
          ? `${failure} Nothing was saved. The throw is still on the pod.`
          : "The pod holds one throw. Download it before arming again.";
        if (state.summary?.partial) view.detail += " This recording was cut short by a sensor error.";
        view.primary = { id: "download", label: failure ? "Retry download" : "Download and save" };
        view.secondary.push({ id: "discard", label: "Discard and arm" });
      }
      break;
    case "SENSOR_ERROR":
      view.tone = "error";
      view.title = "Sensor error";
      view.detail = `${state.notice || "A sensor read failed."} Check both sensor cables with the power off, then arm again.`;
      view.primary = { id: "arm", label: "Arm again" };
      break;
    default:
      if (state.error) {
        view.tone = "warning";
        view.title = "The pod is not answering";
        view.detail = `${state.error} The link is up and this page keeps asking. `
          + "Try again now, or disconnect and restart the pod.";
        view.primary = { id: "check", label: "Try again" };
        view.secondary.push({ id: "disconnect", label: "Disconnect" });
      } else {
        view.tone = "idle";
        view.title = "Checking the pod";
        view.detail = "Waiting for the pod to answer.";
      }
      break;
  }
  return view;
}
