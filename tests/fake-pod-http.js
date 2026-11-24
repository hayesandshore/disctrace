// A stand-in for a DGT-1 on Wi-Fi, for testing transport-wifi.js in Node. Its
// fetch() answers /api/hello and /api/cmd the way firmware 2.0.0 does, with
// real Response objects, and can fail the ways a pod on Wi-Fi can. Errors use
// the names and messages Chrome uses, because the page shows them.

const aborted = () => new DOMException("The user aborted a request.", "AbortError");

export class FakeWifiPod {
  constructor() {
    this.reachable = true;      // false: nothing at the address, as on the wrong Wi-Fi network
    this.answers = true;        // false: requests are accepted and never answered
    this.hello = "DGT-1 fw=2.0.0 target_hz=100 window_s=5 pre=30 cols=9\r\n";
    this.helloStatus = 200;
    this.commandStatus = 200;
    this.delayMs = 0;           // how long the pod takes to answer, as when it is recording
    this.pieceBytes = null;     // send each reply in pieces of this many bytes
    this.stallAfter = null;     // the reply stops after this many pieces and never ends
    this.requests = [];         // { method, path, body }
    this.commands = [];         // every command the pod received
    this.open = 0;              // exchanges going on now
    this.mostOpen = 0;
    this.fetch = (url, options = {}) => this.handle(new URL(url), options);
  }

  reply(command) {
    return command === "STATUS" ? "IDLE\r\n" : "State IDLE. Commands: ARM STATUS DUMP CANCEL INFO BENCH\r\n";
  }

  handle(url, { method = "GET", body = "", signal }) {
    this.requests.push({ method, path: url.pathname, body });
    this.open += 1;
    this.mostOpen = Math.max(this.mostOpen, this.open);
    let closed = false;
    const close = () => {
      if (!closed) this.open -= 1;
      closed = true;
    };
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        close();
        reject(error);
      };
      if (signal?.aborted) return fail(aborted());
      signal?.addEventListener("abort", () => fail(aborted()), { once: true });
      if (!this.reachable) return fail(new TypeError("Failed to fetch"));
      if (!this.answers) return undefined;
      return setTimeout(() => {
        if (closed) return;
        const command = method === "POST" && url.pathname.endsWith("/api/cmd");
        let text = this.hello;
        if (command) {
          const lines = String(body).split("\n").map((line) => line.trim().toUpperCase()).filter(Boolean);
          this.commands.push(...lines);
          text = lines.map((line) => this.reply(line)).join("");
        }
        const bytes = new TextEncoder().encode(text);
        const size = this.pieceBytes ?? Math.max(bytes.length, 1);
        const pieces = [];
        for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size));
        let delivered = 0;
        const stream = new ReadableStream({
          start: (controller) => {
            signal?.addEventListener("abort", () => {
              close();
              try {
                controller.error(aborted());
              } catch { /* already closed */ }
            }, { once: true });
          },
          pull: (controller) => {
            if (this.stallAfter !== null && delivered >= this.stallAfter) {
              return new Promise(() => {});      // nothing more ever comes
            }
            if (!pieces.length) {
              close();
              controller.close();
              return undefined;
            }
            controller.enqueue(pieces.shift());
            delivered += 1;
            return undefined;
          },
        }, { highWaterMark: 0 });
        resolve(new Response(stream, { status: command ? this.commandStatus : this.helloStatus }));
      }, this.delayMs);
    });
  }
}
