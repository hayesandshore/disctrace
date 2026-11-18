// Web Bluetooth link to a real DGT-1 over the Nordic UART Service.
// Works in Chrome and Edge on a computer and Chrome on Android, on an HTTPS
// page or localhost. Not yet tested against the physical pod.

import { NUS_SERVICE, NUS_RX, NUS_TX } from "./protocol.js";

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
    this.device = await navigator.bluetooth.requestDevice({
      // The pod advertises the UART service; the name filter is a second way in.
      filters: [{ services: [NUS_SERVICE] }, { namePrefix: "DGT-1" }],
      optionalServices: [NUS_SERVICE],
    });
    this.name = this.device.name || "DGT-1";
    this.device.addEventListener("gattserverdisconnected", () => {
      this.connected = false;
      this.onDisconnect();
    });
  }

  /** Connects, finds both characteristics and subscribes before resolving.
   *  Also used to reconnect to the device chosen earlier. */
  async connect() {
    if (!this.device) await this.choose();
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx = await service.getCharacteristic(NUS_TX);
    this.decoder = new TextDecoder();
    this.tx.addEventListener("characteristicvaluechanged", this.handleValue);
    await this.tx.startNotifications();
    this.connected = true;
  }

  async disconnect() {
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.connected = false;
  }

  /** A successful write only means the bytes were sent; the caller waits for
   *  the pod's text reply before changing any state. */
  async write(text) {
    const bytes = new TextEncoder().encode(text);
    if (this.rx.properties.writeWithoutResponse) await this.rx.writeValueWithoutResponse(bytes);
    else await this.rx.writeValueWithResponse(bytes);
  }
}
