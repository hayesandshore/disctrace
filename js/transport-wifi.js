// Wi-Fi link to a DGT-1 running firmware 2.0 or later. The pod makes its own Wi-Fi
// network and serves this page; commands go back to the address the page came
// from, as HTTP requests. That works in any browser, with no Bluetooth.
// Tested against a stand-in for the pod and against the firmware running in
// its simulator. Not yet tested against the physical pod.

const THIS_COMPUTER = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when this page was served by the pod itself, so the pod is reached
 *  over Wi-Fi at the page's own address. A browser only allows Bluetooth on
 *  https or on this computer, so plain http from anywhere else can only be
 *  the pod. ?link=wifi or ?link=ble in the address decides it by hand. */
export function servedByPod({ protocol, hostname, search = "" }) {
  const asked = new URLSearchParams(search).get("link");
  if (asked === "wifi") return true;
  if (asked === "ble") return false;
  return protocol === "http:" && !THIS_COMPUTER.has(hostname);
}

export class WifiTransport {
  constructor({ base, fetch, helloTimeoutMs = 6000, quietMs = 15000 } = {}) {
    // The folder the page is in: the pod answers at api/ beside it.
    this.base = new URL(".", base ?? globalThis.location.href);
    this.fetch = fetch ?? ((...args) => globalThis.fetch(...args));
    // How long the pod may say nothing before the page stops waiting. While it
    // records a throw it answers nothing, so quietMs must outlast a recording.
    this.helloTimeoutMs = helloTimeoutMs;
    this.quietMs = quietMs;
    this.kind = "wifi";
    this.name = "DGT-1";
    this.connected = false;
    this.session = 0;                 // goes up whenever the link opens or ends, to tell a late reply from a live one
    this.inFlight = new Set();        // requests the pod has not finished answering
    this.writes = Promise.resolve();  // commands go out one at a time
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.onTrace = () => {};          // every step, command and piece of reply, for the diagnostics console
  }

  /** Tells the console what just happened. A console that fails must never
   *  take the link down with it. */
  trace(stepName, detail = {}) {
    try {
      this.onTrace({ step: stepName, ...detail });
    } catch { /* the console is broken; the link carries on */ }
  }

  /** One request to the pod. Each piece of the reply goes to onPiece as it
   *  arrives. Fails if the pod is silent for longer than `ms` at any point,
   *  and ends at once if disconnect() is called. */
  async exchange(path, options, ms, onPiece) {
    const controller = new AbortController();
    const request = { controller, ended: null };
    this.inFlight.add(request);
    let timer;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        request.ended = "silent";
        controller.abort();
      }, ms);
    };
    touch();
    try {
      const response = await this.fetch(new URL(path, this.base), { ...options, cache: "no-store", signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`it answered with error ${response.status}.`), { status: response.status });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        // stream:true keeps a multi-byte character split across pieces intact
        onPiece(value, decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (request.ended === "stopped") {
        throw Object.assign(new Error("Stopped before the pod answered."), { stopped: true });
      }
      if (request.ended === "silent") throw new Error(`no answer for ${ms / 1000} seconds.`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(request);
    }
  }

  /** Asks the pod who it is. There is nothing to hold open: the link is up
   *  once the pod has answered. Also used to reconnect. */
  async connect() {
    const url = new URL("api/hello", this.base);
    const started = Date.now();
    let hello = "";
    this.trace("wifi-connecting", { url: url.href });
    try {
      try {
        await this.exchange("api/hello", { method: "GET" }, this.helloTimeoutMs, (bytes, text) => {
          hello += text;
        });
      } catch (error) {
        if (error.stopped) throw error;
        if (error.status) throw new Error(`Something at ${this.base.origin} answered, but not like a DGT-1 pod.`, { cause: error });
        throw new Error(`Could not reach the pod at ${this.base.origin}: ${error.message}`, { cause: error });
      }
      if (!hello.startsWith("DGT-1")) throw new Error(`Something at ${this.base.origin} answered, but not like a DGT-1 pod.`);
    } catch (error) {
      this.trace(error.stopped ? "connect-stopped" : "connect-failed", { message: error.message });
      throw error;
    }
    this.writes = Promise.resolve();   // nothing from an earlier link may hold up this one
    this.session += 1;
    this.connected = true;
    this.trace("wifi-connected", { ms: Date.now() - started, hello: hello.trim() });
  }

  /** The link has gone: the pod is out of range, off, or this device has left
   *  its network. Reported once. */
  lose(session, message) {
    if (!this.connected || this.session !== session) return;
    this.connected = false;
    this.session += 1;
    this.trace("link-lost", { message });
    this.onDisconnect();
  }

  async disconnect() {
    const wasConnected = this.connected;
    this.connected = false;
    this.session += 1;            // a reply still on its way is not passed on
    this.trace("disconnect-requested");
    for (const request of this.inFlight) {
      request.ended = "stopped";
      request.controller.abort();
    }
    if (wasConnected) this.onDisconnect();
  }

  /** Sends one line and passes the pod's reply to onData as it arrives. The
   *  promise settles when the exchange is over. A pod that cannot be reached
   *  or stops answering is a lost link (onDisconnect), not a rejection: the
   *  caller is waiting for the pod's text reply, not for this. */
  write(text) {
    if (!this.connected) return Promise.reject(new Error("Not connected to the pod."));
    const session = this.session;
    const send = async () => {
      if (this.session !== session) return;   // the link went while this write waited its turn
      this.trace("tx", { text, length: new TextEncoder().encode(text).length });
      try {
        await this.exchange("api/cmd", { method: "POST", body: text }, this.quietMs, (bytes, piece) => {
          if (this.session !== session) return;
          this.trace("rx", { bytes });
          this.onData(piece);
        });
      } catch (error) {
        if (!error.stopped) this.lose(session, error.status ? `The pod ${error.message.slice(3)}` : error.message);
      }
    };
    // One at a time: the pod answers one request before it reads the next.
    this.writes = this.writes.then(send, send);
    return this.writes;
  }
}
