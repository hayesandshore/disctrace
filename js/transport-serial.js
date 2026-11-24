// USB link to a DGT-1 running firmware 2.1 or later, as a backup for Wi-Fi.
// The pod takes the same commands as lines of text on its USB serial port;
// this reaches that port through the browser's Web Serial API. Chrome and
// Edge on a computer, on an https page or localhost.
// Tested against a stand-in for the browser's serial API and against the
// firmware in its simulator. Not yet tested against the physical pod.

const ADAFRUIT = 0x239a;   // the USB vendor number of every Adafruit board running CircuitPython

export class SerialTransport {
  constructor({ serial, answerTimeoutMs = 4000 } = {}) {
    this.serial = serial ?? globalThis.navigator?.serial;
    this.answerTimeoutMs = answerTimeoutMs;   // how long the pod gets to say who it is
    this.kind = "usb";
    this.name = "DGT-1 on USB";
    this.port = null;
    this.connected = false;
    this.session = 0;                 // goes up whenever the port opens or the link ends, to tell old text from live
    this.reader = null;
    this.pumping = null;              // the loop reading the port, while there is one
    this.closing = null;              // the port being closed, while it is
    this.hello = null;                // set while connect() waits for the pod to say who it is
    this.writes = Promise.resolve();  // writes go out one at a time
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.onTrace = () => {};          // every step, write and piece of reply, for the diagnostics console
  }

  static get supported() {
    return typeof navigator !== "undefined" && Boolean(navigator.serial);
  }

  /** Tells the console what just happened. A console that fails must never
   *  take the link down with it. */
  trace(stepName, detail = {}) {
    try {
      this.onTrace({ step: stepName, ...detail });
    } catch { /* the console is broken; the link carries on */ }
  }

  /** Opens the browser's list of serial ports. Must be called from a click. */
  async choose() {
    this.trace("usb-chooser-open");
    try {
      this.port = await this.serial.requestPort({ filters: [{ usbVendorId: ADAFRUIT }] });
    } catch (error) {
      this.trace("usb-chooser-failed", { name: error.name, message: error.message });
      const closed = error.name === "NotFoundError";
      throw new Error(closed ? "No USB port was chosen." : `No USB port was chosen: ${error.message}`, { cause: error });
    }
    const info = this.port.getInfo();
    this.trace("usb-picked", { vendor: info.usbVendorId, product: info.usbProductId });
  }

  /** After the cable was pulled and put back, the browser may know the pod
   *  under a new port object. Permission was given for the board, so it can
   *  be found again without asking. */
  async findAgain() {
    try {
      const ports = await this.serial.getPorts();
      if (ports.includes(this.port)) return;
      const mine = this.port.getInfo();
      const same = ports.find((port) => {
        const info = port.getInfo();
        return info.usbVendorId === mine.usbVendorId && info.usbProductId === mine.usbProductId;
      });
      if (same) this.port = same;
    } catch { /* keep the port object there is */ }
  }

  /** Opens the port and waits for the pod to say who it is. Also used to
   *  reconnect to the board chosen earlier. */
  async connect() {
    await this.closing;               // an earlier link may still be letting go of the port
    if (!this.port) await this.choose();
    else await this.findAgain();
    const { port } = this;
    let opened = false;
    try {
      this.trace("usb-opening");
      try {
        await port.open({ baudRate: 115200 });
        opened = true;
      } catch (error) {
        throw new Error(`Could not open the pod's USB port: ${error.message}`, { cause: error });
      }
      // Data Terminal Ready tells the pod a program is listening. Not every
      // system lets a page set it, and the pod answers without it.
      try {
        await port.setSignals({ dataTerminalReady: true });
      } catch { /* carry on without */ }
      this.session += 1;
      this.pumping = this.pump(port, this.session);
      const hello = await this.whoIsThere(port);
      this.writes = Promise.resolve();   // nothing from an earlier link may hold up this one
      this.connected = true;
      this.trace("usb-ready", { hello });
    } catch (error) {
      this.trace(error.stopped ? "connect-stopped" : "connect-failed", { message: error.message });
      this.session += 1;                 // whatever is still read is not passed on
      // Never keep a half-open port: nothing else, and no later try, could open it.
      if (opened) await this.closePort(port);
      throw error;
    }
  }

  /** Asks the pod for its INFO line and waits for it. Anything else on the
   *  port (other firmware, a stopped program) never sends one. */
  async whoIsThere(port) {
    let seen = "";
    let timer;
    const answer = new Promise((resolve, reject) => {
      this.hello = {
        feed: (text) => {
          seen += text;
          const line = /^DGT-1 fw=[^\r\n]*(?=\r?\n)/m.exec(seen);
          if (line) resolve(line[0]);
        },
        fail: reject,
      };
      timer = setTimeout(() => {
        reject(new Error("The USB port opened, but nothing on it answered like a DGT-1 pod."));
      }, this.answerTimeoutMs);
    });
    answer.catch(() => {});   // it may fail while the question is still being written
    try {
      // The empty line first ends anything half-typed on the pod's side.
      await this.send(port, "\nINFO\n");
      return await answer;
    } finally {
      clearTimeout(timer);
      this.hello = null;
    }
  }

  /** Reads the port until it closes, passing every piece of text on. */
  async pump(port, session) {
    let reader = null;
    let reason = "the port closed.";
    try {
      reader = port.readable.getReader();
      this.reader = reader;
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.session !== session) continue;
        this.trace("rx", { bytes: value });
        // stream:true keeps a multi-byte character split across reads intact
        const text = decoder.decode(value, { stream: true });
        this.hello?.feed(text);
        this.onData(text);
      }
    } catch (error) {
      reason = error.message;
    } finally {
      try {
        reader?.releaseLock();
      } catch { /* already released */ }
      if (this.reader === reader) this.reader = null;
    }
    if (this.session !== session) return;   // ended on request
    // The cable was pulled, or the port failed.
    if (this.hello) this.hello.fail(new Error(`The pod's USB port closed: ${reason}`));
    else this.lose(session, reason);
  }

  /** Lets go of the port, so that it can be opened again. */
  async closePort(port) {
    try {
      await this.reader?.cancel();
    } catch { /* the port has already gone */ }
    try {
      await this.pumping;
    } catch { /* the loop reports its own end */ }
    try {
      await port.close();
    } catch { /* already closed, or gone with the cable */ }
  }

  /** The link has gone: the cable was pulled or the port failed. Reported once. */
  lose(session, message) {
    if (!this.connected || this.session !== session) return;
    this.connected = false;
    this.session += 1;
    this.trace("link-lost", { message });
    this.closing = this.closePort(this.port);
    this.onDisconnect();
  }

  async disconnect() {
    const wasConnected = this.connected;
    this.connected = false;
    this.trace("disconnect-requested");
    if (this.hello) {
      // An attempt is waiting for the pod: end it as stopped. connect() lets go of the port.
      this.hello.fail(Object.assign(new Error("Stopped before the pod answered."), { stopped: true }));
      return;
    }
    this.session += 1;                  // text still on its way is not passed on
    if (this.port) {
      this.closing = this.closePort(this.port);
      await this.closing;
    }
    if (wasConnected) this.onDisconnect();
  }

  async send(port, text) {
    const bytes = new TextEncoder().encode(text);
    this.trace("tx", { text, length: bytes.length });
    const writer = port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  /** A successful write only means the bytes were sent; the caller waits for
   *  the pod's text reply. A write that fails is a lost link. */
  write(text) {
    if (!this.connected) return Promise.reject(new Error("Not connected to the pod."));
    const { session, port } = this;
    const run = async () => {
      if (this.session !== session) return;   // the link went while this write waited its turn
      try {
        await this.send(port, text);
      } catch (error) {
        this.lose(session, error.message);
      }
    };
    this.writes = this.writes.then(run, run);
    return this.writes;
  }
}
