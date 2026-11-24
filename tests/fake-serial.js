// A stand-in for the browser's Web Serial API with one DGT-1 on a USB cable,
// for testing transport-serial.js in Node. The pod answers the way firmware
// 2.1.0 does on its USB serial port. Errors use the names and messages Chrome
// uses, because the page shows them.

const lost = () => new DOMException("The device has been lost.", "NetworkError");

class Port {
  constructor(pod) {
    this.pod = pod;
    this.opened = false;
    this.readable = null;
    this.writable = null;
    this.source = null;
  }

  getInfo() {
    return { usbVendorId: 0x239a, usbProductId: 0x811c };
  }

  async open(options) {
    this.pod.opens.push(options);
    if (this.opened) throw new DOMException("The port is already open.", "InvalidStateError");
    // Unplugged, a port object from before the cable was pulled, or held by another program.
    if (!this.pod.plugged || this !== this.pod.port || this.pod.busy) {
      throw new DOMException("Failed to open serial port.", "NetworkError");
    }
    this.opened = true;
    this.readable = new ReadableStream({
      start: (controller) => {
        this.source = controller;
      },
    });
    this.writable = new WritableStream({
      write: (bytes) => {
        if (this.pod.writeFails) throw lost();
        this.pod.receive(bytes);
      },
    });
    if (this.pod.banner) this.pod.say(this.pod.banner);
  }

  async setSignals(signals) {
    this.pod.signals.push(signals);
  }

  async close() {
    if (!this.opened) throw new DOMException("The port is already closed.", "InvalidStateError");
    // As in Chrome: a port cannot be closed while something still holds its streams.
    if (this.readable.locked || this.writable.locked) throw new TypeError("Cannot cancel a locked stream");
    this.opened = false;
    this.pod.closes += 1;
  }
}

export class FakeUsbPod {
  constructor() {
    this.chooser = "picked";   // "cancelled": the person closes the browser's list of ports
    this.plugged = true;       // false: the cable is out
    this.busy = false;         // true: another program has the port open
    this.answers = true;       // false: nothing answers, as with Bluetooth-only firmware or a stopped program
    this.writeFails = false;   // true: writing to the port fails
    this.banner = "";          // text the pod prints by itself when the port opens
    this.requests = [];        // what the page asked the browser's list of ports for
    this.opens = [];           // the options of every attempt to open a port
    this.signals = [];
    this.commands = [];        // every complete command the pod received
    this.closes = 0;
    this.inbox = "";
    this.port = new Port(this);
    this.serial = {
      requestPort: async (options) => {
        this.requests.push(options);
        if (this.chooser === "cancelled") throw new DOMException("No port selected by the user.", "NotFoundError");
        return this.port;
      },
      getPorts: async () => (this.plugged ? [this.port] : []),
    };
  }

  /** The pod writes text on its serial port. */
  say(text) {
    this.port.source?.enqueue(new TextEncoder().encode(text));
  }

  reply(command) {
    if (command === "STATUS") return "IDLE";
    if (command === "INFO") return "DGT-1 fw=2.1.0 target_hz=100 window_s=5 pre=30 cols=9";
    return "State IDLE. Commands: ARM STATUS DUMP CANCEL INFO BENCH";
  }

  receive(bytes) {
    for (const char of new TextDecoder().decode(bytes)) {
      if (char !== "\n" && char !== "\r") {
        this.inbox += char;
        continue;
      }
      const command = this.inbox.trim().toUpperCase();
      this.inbox = "";
      if (!command) continue;
      this.commands.push(command);
      if (this.answers) this.say(`${this.reply(command)}\r\n`);
    }
  }

  /** The cable is pulled. Whatever is reading the port gets Chrome's error. */
  unplug() {
    this.plugged = false;
    try {
      this.port.source?.error(lost());
    } catch { /* nothing was reading */ }
  }

  /** Plugged back in. The browser knows the pod under a new port object. */
  replug() {
    this.plugged = true;
    this.port = new Port(this);
  }
}
