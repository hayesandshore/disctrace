// A stand-in for the browser's Bluetooth API, for testing transport-ble.js in
// Node. It models one DGT-1: the chooser, the GATT link, the Nordic UART
// Service and a pod that answers STATUS. Errors use the names and messages
// Chrome uses, because the page shows them to the person at the bench.

// Written out here rather than imported, so a wrong UUID in the app fails a test.
const SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// A request the device never answers. As in Chrome, it only ends, with an
// error, once the link is hung up.
function unanswered(device) {
  return new Promise((resolve, reject) => {
    device.addEventListener("gattserverdisconnected", () => {
      reject(new DOMException("GATT Server is disconnected. Cannot perform GATT operations. "
        + "(Re)connect first with `device.gatt.connect`.", "NetworkError"));
    }, { once: true });
  });
}

class Gatt {
  constructor(pod, device) {
    this.pod = pod;
    this.device = device;
    this.connected = false;
  }

  async connect() {
    if (!this.pod.inRange) throw new DOMException("Connection attempt failed.", "NetworkError");
    this.connected = true;
    return this;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event("gattserverdisconnected"));
  }

  async getPrimaryServices() {
    if (!this.connected) {
      throw new DOMException("GATT Server is disconnected. Cannot retrieve services.", "NetworkError");
    }
    if (!this.pod.listable) return unanswered(this.device);
    const uuids = [...(this.pod.uart ? [SERVICE] : []), ...this.pod.otherServices];
    if (!uuids.length) throw new DOMException("No Services found in device.", "NotFoundError");
    return uuids.map((uuid) => ({ uuid }));
  }

  async getPrimaryService(uuid) {
    if (!this.connected) {
      throw new DOMException("GATT Server is disconnected. Cannot retrieve services.", "NetworkError");
    }
    if (!this.pod.uart || uuid !== SERVICE) {
      throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, "NotFoundError");
    }
    return {
      uuid,
      getCharacteristic: async (id) => {
        if (id === RX) return this.pod.rx;
        if (id === TX) return this.pod.tx;
        throw new DOMException(`No Characteristics matching UUID ${id} found in Service.`, "NotFoundError");
      },
    };
  }
}

class Device extends EventTarget {
  constructor(pod) {
    super();
    this.id = "fake-dgt-1";
    this.name = "DGT-1";
    this.gatt = new Gatt(pod, this);
  }
}

class TxCharacteristic extends EventTarget {
  constructor(pod) {
    super();
    this.pod = pod;
    this.uuid = TX;
    this.properties = { notify: true };
    this.notifying = false;
    this.value = null;
  }

  async startNotifications() {
    if (!this.pod.notifiable) throw new DOMException("GATT operation not permitted.", "NotSupportedError");
    if (!this.pod.confirms) return unanswered(this.pod.device);
    this.notifying = true;
    return this;
  }
}

export class FakePod {
  constructor() {
    this.chooser = "picked";   // "cancelled": the person closes the browser's list
    this.inRange = true;       // false: the radio link cannot be opened
    this.uart = true;          // false: the pod's program is not running, so no UART service
    this.notifiable = true;    // false: the pod refuses the subscription
    this.confirms = true;      // false: the subscription request is never answered
    this.listable = true;      // false: asking which services the device offers is never answered
    this.answers = true;       // false: commands arrive but nothing comes back
    this.otherServices = [];   // UUIDs of other services the device offers
    this.requests = [];        // what the page asked the browser's device list for
    this.commands = [];        // every complete command the pod received
    this.inbox = "";
    this.device = new Device(this);
    this.tx = new TxCharacteristic(this);
    const write = async (bytes) => this.receive(bytes);
    this.rx = {
      uuid: RX,
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithoutResponse: write,
      writeValueWithResponse: write,
    };
  }

  /** Makes this pod the one the browser's Bluetooth chooser returns. */
  install() {
    const bluetooth = {
      requestDevice: async (options) => {
        this.requests.push(options);
        if (this.chooser === "cancelled") {
          throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError");
        }
        return this.device;      // the browser hands back the same object for the same device
      },
    };
    Object.defineProperty(globalThis, "navigator", { value: { bluetooth }, configurable: true });
    return this;
  }

  /** The pod goes away: power off, out of range, or it hangs up. */
  drop() {
    this.device.gatt.disconnect();
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
      if (this.answers) {
        this.notify(command === "STATUS" ? "IDLE" : "State IDLE. Commands: ARM STATUS DUMP CANCEL");
      }
    }
  }

  // Like the firmware: CRLF line ending, at most 20 bytes per notification.
  notify(line) {
    const payload = new TextEncoder().encode(`${line}\r\n`);
    for (let i = 0; i < payload.length; i += 20) {
      if (!this.tx.notifying || !this.device.gatt.connected) return;
      const piece = payload.subarray(i, i + 20);
      this.tx.value = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
      this.tx.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  }
}
