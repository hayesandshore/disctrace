// Drives a DGT-1 pod over any transport (Web Bluetooth, Wi-Fi or the simulated pod):
// connect, STATUS, ARM, CANCEL, DUMP, INFO, BENCH. Keeps what is known about
// the pod separate from the state of the link, and never sends ARM on its own.

import { LineSplitter, classify, DumpCollector } from "./protocol.js";

const DEFAULTS = {
  busyAfterMs: 1500,     // a STATUS unanswered this long means the pod is busy recording
  replyTimeoutMs: 20000, // the pod answers nothing for the whole ten-second capture
  pollMs: 2000,          // modest STATUS polling while waiting for a throw
  dumpIdleMs: 6000,      // a download with no data for this long has stalled
  retryMs: 2000,         // pause between reconnection attempts
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The polling interval must not keep a Node test process alive; browsers ignore this.
const unref = (timer) => {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
};

export class PodClient {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.listeners = { change: [], log: [] };
    this.splitter = new LineSplitter();
    this.transport = null;
    this.pending = null;       // the single request waiting for its reply
    this.dump = null;          // the download in progress
    this.queue = Promise.resolve();
    this.intentional = false;  // true once the user asked to disconnect
    this.pollTimer = null;
    this.polling = false;
    this.state = {
      link: "disconnected",    // disconnected | connecting | connected | reconnecting
      pod: "UNKNOWN",          // UNKNOWN | IDLE | ARMED | RECORDING | READY | SENSOR_ERROR
      summary: null,           // parsed READY line of the capture the pod holds
      saved: false,            // this app has saved that capture
      firmware: null,          // "1.1", or "1.0" for a pod that does not know INFO
      info: null,
      bench: null,
      download: null,          // { received, expected } while downloading
      notice: null,            // last message the pod pushed on its own
      error: null,
    };
  }

  // Events ------------------------------------------------------------------------
  on(event, listener) {
    this.listeners[event].push(listener);
  }

  emit(event, data) {
    for (const listener of this.listeners[event]) listener(data);
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit("change");
  }

  log(dir, text) {
    this.emit("log", { dir, text, at: Date.now() });
  }

  /** True when arming now would throw away a capture nobody has saved. */
  get needsDiscardConfirm() {
    return this.state.pod === "READY" && !this.state.saved;
  }

  // Link ----------------------------------------------------------------------------
  async connect(transport) {
    this.transport = transport;
    this.intentional = false;
    transport.onData = (text) => this.receive(text);
    transport.onDisconnect = () => this.linkLost();
    this.set({ link: "connecting", error: null, firmware: null, info: null, bench: null });
    try {
      await transport.connect();
    } catch (error) {
      if (this.intentional) {
        // The user pressed Stop while this attempt was in flight: not a failure.
        this.set({ link: "disconnected" });
        return;
      }
      this.log("info", error.message);
      this.set({ link: "disconnected" });
      throw error;
    }
    if (this.intentional || this.transport !== transport) {
      // Stop was pressed and the attempt succeeded anyway: hang up again.
      await transport.disconnect();
      if (this.transport === transport) this.set({ link: "disconnected" });
      return;
    }
    await this.afterConnect();
  }

  async afterConnect() {
    this.splitter.reset();
    this.set({ link: "connected", error: null });
    this.log("info", `Connected to ${this.transport.name}.`);
    this.startPolling();                        // first, so a pod that is slow to answer is still followed up
    await this.check();
  }

  /** Asks the pod where it stands: STATUS, then INFO if its firmware is not
   *  known yet. Also the way back from a pod that did not answer. */
  async check() {
    await this.refresh();                       // always ask STATUS first
    if (this.state.firmware === null) await this.identify();
  }

  async disconnect() {
    this.intentional = true;
    this.stopPolling();
    if (this.transport) await this.transport.disconnect();
    this.set({ link: "disconnected" });
  }

  linkLost() {
    this.splitter.reset();                      // drop unfinished text
    this.stopPolling();
    if (this.pending) this.settle(this.pending).reject(new Error("Disconnected from the pod."));
    if (this.dump) this.dump.fail(new Error("Disconnected during the download."));
    if (this.intentional) {
      this.set({ link: "disconnected" });
      return;
    }
    this.log("info", "Link lost. The pod keeps its state. Trying to reconnect.");
    this.set({ link: "reconnecting" });
    this.reconnectLoop(this.transport);
  }

  async reconnectLoop(transport) {
    let reported = null;
    while (!this.intentional && this.transport === transport && this.state.link === "reconnecting") {
      try {
        await transport.connect();
      } catch (error) {
        if (error.message !== reported) {       // once per reason, not once per attempt
          reported = error.message;
          this.log("info", reported);
        }
        await sleep(this.options.retryMs);
        continue;
      }
      if (this.intentional || this.transport !== transport) {
        // The user pressed Stop while this attempt was in flight: hang up again.
        transport.disconnect().catch(() => {});
        return;
      }
      try {
        await this.afterConnect();              // refresh STATUS; never re-send ARM
      } catch (error) {
        this.set({ error: error.message });
      }
      return;
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = unref(setInterval(() => {
      // Waiting for a throw, or for a pod that has not answered yet.
      const { pod } = this.state;
      const waiting = pod === "ARMED" || pod === "RECORDING" || pod === "UNKNOWN";
      if (this.state.link !== "connected" || !waiting || this.pending || this.dump || this.polling) return;
      this.polling = true;                      // at most one STATUS outstanding
      this.check().catch(() => {}).finally(() => {
        this.polling = false;
      });
    }, this.options.pollMs));
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // Requests ------------------------------------------------------------------------
  settle(pending) {
    clearTimeout(pending.timer);
    clearTimeout(pending.busyTimer);
    if (this.pending === pending) this.pending = null;
    return pending;
  }

  /** Sends one command and resolves with the first reply line `accept` approves.
   *  Requests run one at a time, in order. */
  request(command, accept, { watchBusy = false } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (this.state.link !== "connected") {
        reject(new Error("Not connected to the pod."));
        return;
      }
      const pending = { command, accept, resolve, reject };
      pending.timer = setTimeout(() => {
        const error = new Error(`The pod did not answer ${command}.`);
        this.log("info", error.message);
        // Silence this long outlasts any recording, so stop guessing what the pod is doing.
        if (watchBusy) this.set({ pod: "UNKNOWN", error: error.message });
        this.settle(pending).reject(error);
      }, this.options.replyTimeoutMs);
      if (watchBusy) {
        pending.busyTimer = setTimeout(() => {
          // An armed pod that goes quiet has started recording. A pod whose state
          // was never known could be silent for any reason, so it stays unknown.
          if (this.pending === pending && this.state.pod === "ARMED") this.set({ pod: "RECORDING" });
        }, this.options.busyAfterMs);
      }
      this.pending = pending;
      this.log("tx", command);
      this.transport.write(`${command}\n`).catch((error) => {
        if (this.pending === pending) this.settle(pending).reject(error);
      });
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Writes a line typed by hand in the diagnostics console. It does not
   *  wait for an answer: whatever comes back is handled like any other line. */
  async send(text) {
    if (this.state.link !== "connected") throw new Error("Not connected to the pod.");
    if (text.trim().toUpperCase() === "DUMP") {
      // The pod counts a DUMP that reaches END as downloaded and stops
      // protecting the throw, but only the Download button saves it.
      throw new Error("DUMP is not sent from here: the pod would count the throw as downloaded "
        + "without it being saved. Use Download and save.");
    }
    this.log("tx", text);
    await this.transport.write(`${text}\n`);
  }

  refresh() {
    return this.request("STATUS",
      (kind) => kind.type === "state" || kind.type === "ready" || kind.type === "notice",
      { watchBusy: true });
  }

  async identify() {
    const kind = await this.request("INFO", (k) => k.type === "info" || k.type === "refused");
    if (kind.type === "refused") this.set({ firmware: "1.0", info: null });
  }

  /** Resolves "armed", or "unsaved" when the pod wants ARM repeated to discard
   *  a capture. Call arm() again only after the user has agreed to discard. */
  async arm() {
    const kind = await this.request("ARM",
      (k) => (k.type === "state" && k.state === "ARMED") || k.type === "unsaved" || k.type === "refused");
    if (kind.type === "unsaved") return "unsaved";
    if (kind.type === "refused") throw new Error(`The pod refused to arm (state ${kind.state}).`);
    this.set({ notice: null });
    return "armed";
  }

  async cancel() {
    await this.request("CANCEL", (k) => (k.type === "state" && k.state === "IDLE") || k.type === "refused");
  }

  async bench() {
    const kind = await this.request("BENCH",
      (k) => k.type === "bench" || k.type === "refused" || (k.type === "notice" && k.kind === "sensor_error"));
    if (kind.type === "bench") return kind.readsPerS;
    if (kind.type === "refused") {
      throw new Error("BENCH is not supported by this firmware, or the pod is armed.");
    }
    throw new Error(`Sensor error during BENCH: ${kind.detail}`);
  }

  markSaved() {
    this.set({ saved: true });
  }

  /** Downloads the capture the pod holds. Resolves only with a complete,
   *  validated capture; any problem rejects and returns nothing to save. */
  async download() {
    if (this.state.link !== "connected") throw new Error("Not connected to the pod.");
    await this.refresh();                       // fresh summary gives the expected row count
    const { summary } = this.state;
    if (this.state.pod !== "READY" || !summary) throw new Error("The pod has no capture to download.");
    try {
      return await this.runDump(summary);
    } catch (error) {
      if (this.state.link === "connected") this.refresh().catch(() => {});
      throw error;
    }
  }

  runDump(summary) {
    const run = () => new Promise((resolve, reject) => {
      const dump = { collector: null, received: 0, summary, resolve };
      const finish = () => {
        clearTimeout(dump.timer);
        if (this.dump === dump) this.dump = null;
        this.set({ download: null });
      };
      dump.fail = (error) => {
        finish();
        this.log("info", `Download failed: ${error.message}`);
        reject(error);
      };
      dump.done = (result) => {
        finish();
        resolve(result);
      };
      dump.touch = () => {
        clearTimeout(dump.timer);
        dump.timer = setTimeout(() => dump.fail(new Error("The download stalled.")), this.options.dumpIdleMs);
      };
      this.dump = dump;
      this.set({ download: { received: 0, expected: summary.samples } });
      dump.touch();
      this.log("tx", "DUMP");
      this.transport.write("DUMP\n").catch((error) => dump.fail(error));
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  // Incoming text ---------------------------------------------------------------------
  receive(text) {
    for (const line of this.splitter.push(text)) this.handleLine(line);
  }

  handleLine(line) {
    const kind = classify(line);
    if (this.dump && (this.dump.collector || kind.type === "header" || kind.type === "refused")) {
      this.handleDumpLine(line, kind);
      return;
    }
    if (kind.type !== "row") this.log("rx", line);   // stray rows after a failed download are not logged
    this.apply(kind);
    if (this.pending && this.pending.accept(kind)) this.settle(this.pending).resolve(kind);
  }

  handleDumpLine(line, kind) {
    const { dump } = this;
    dump.touch();
    if (!dump.collector) {
      if (kind.type === "refused") {
        this.log("rx", line);
        dump.fail(new Error(`The pod refused DUMP (state ${kind.state}).`));
        return;
      }
      this.log("rx", line);
      dump.collector = new DumpCollector(dump.summary.samples);
    }
    try {
      if (dump.collector.push(line)) {
        const { rows, csv, columns } = dump.collector;
        this.log("rx", `END (${rows.length} rows)`);
        dump.done({ rows, csv, columns, summary: dump.summary });
      } else if (kind.type === "row") {
        dump.received += 1;
        if (dump.received % 16 === 0) this.set({ download: { received: dump.received, expected: dump.summary.samples } });
      }
    } catch (error) {
      dump.fail(error);
    }
  }

  apply(kind) {
    switch (kind.type) {
      case "state":
      case "refused":
        this.applyPod(kind.state);
        break;
      case "ready": {
        const previous = this.state.summary;
        const sameCapture = previous && previous.raw === kind.summary.raw;
        this.set({ pod: "READY", summary: kind.summary, saved: sameCapture ? this.state.saved : false, error: null });
        break;
      }
      case "notice":
        this.applyPod(kind.state);
        this.set({
          notice: kind.kind === "armed_timeout"
            ? "Arming timed out after an hour with no throw."
            : `Sensor error: ${kind.detail}`,
        });
        break;
      case "info":
        this.set({ info: kind.info, firmware: kind.info.fw });
        break;
      case "bench":
        this.set({ bench: kind.readsPerS });
        break;
      default:
        break;
    }
  }

  applyPod(pod) {
    if (pod === "READY") this.set({ pod, error: null });
    else this.set({ pod, summary: null, saved: false, error: null });
  }
}
