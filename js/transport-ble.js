// Web Bluetooth link to a real DGT-1 over the Nordic UART Service.
// Works in Chrome and Edge on a computer and Chrome on Android, on an HTTPS
// page or localhost. Not yet tested against the physical pod.

import { NUS_SERVICE, NUS_RX, NUS_TX } from "./protocol.js";

// Runs one stage of connecting. If it fails, says which stage it was and keeps
// the browser's own reason, which is the only clue when the cause is the pod.
async function step(problem, work) {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${problem}: ${error.message}`, { cause: error });
  }
}

export class BleTransport {
  constructor() {
    this.kind = "ble";
    this.name = "DGT-1";
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.connected = false;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.decoder = null;
    this.handleValue = (event) => {
      const view = event.target.value;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      // stream:true keeps a multi-byte character split across notifications intact
      this.onData(this.decoder.decode(bytes, { stream: true }));
    };
  }

  static get supported() {
    return typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
  }

  /** Opens the browser's device chooser. Must be called from a click. */
  async choose() {
    try {
      this.device = await navigator.bluetooth.requestDevice({
        // The pod advertises the UART service; the name filter is a second way in.
        filters: [{ services: [NUS_SERVICE] }, { namePrefix: "DGT-1" }],
        optionalServices: [NUS_SERVICE],
      });
    } catch (error) {
      // The browser reports a closed list and a missing Bluetooth adapter the
      // same way, so keep its reason unless the list was simply closed.
      const closed = error.name === "NotFoundError" && /cancel/i.test(error.message);
      throw new Error(closed ? "No pod was chosen." : `No pod was chosen: ${error.message}`, { cause: error });
    }
    this.name = this.device.name || "DGT-1";
    this.device.addEventListener("gattserverdisconnected", () => {
      // The browser hands every transport the same device object, and a failed
      // attempt hangs up too. Only a link this transport had fully up is lost.
      if (!this.connected) return;
      this.connected = false;
      this.onDisconnect();
    });
  }

  /** Connects, finds both characteristics and subscribes before resolving.
   *  Also used to reconnect to the device chosen earlier. */
  async connect() {
    if (!this.device) await this.choose();
    const { gatt } = this.device;
    try {
      const server = await step(`Could not connect to ${this.name}`, () => gatt.connect());
      await step(`Connected to ${this.name}, but could not find its UART service`, async () => {
        const service = await server.getPrimaryService(NUS_SERVICE);
        this.rx = await service.getCharacteristic(NUS_RX);
        this.tx = await service.getCharacteristic(NUS_TX);
      });
      this.decoder = new TextDecoder();
      this.tx.addEventListener("characteristicvaluechanged", this.handleValue);
      await step(`Connected to ${this.name}, but could not subscribe to its replies`,
        () => this.tx.startNotifications());
    } catch (error) {
      // Never keep a half-open link. The pod has one connection and stops
      // advertising while anything holds it, so nothing could find it again.
      if (gatt.connected) gatt.disconnect();
      throw error;
    }
    this.connected = true;
  }

  async disconnect() {
    const wasConnected = this.connected;
    this.connected = false;   // so the browser's own event is not reported a second time
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    if (wasConnected) this.onDisconnect();
  }

  /** A successful write only means the bytes were sent; the caller waits for
   *  the pod's text reply before changing any state. */
  async write(text) {
    const bytes = new TextEncoder().encode(text);
    if (this.rx.properties.writeWithoutResponse) await this.rx.writeValueWithoutResponse(bytes);
    else await this.rx.writeValueWithResponse(bytes);
  }
}
