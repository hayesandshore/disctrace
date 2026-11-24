# DiscTrace bench

A web page for the DGT-1 disc pod. It connects over Bluetooth, Wi-Fi or a USB cable, arms the pod, downloads the capture after a throw, saves it on the device, and shows spin and acceleration charts. Over Bluetooth it works with firmware 1.0 (both the handoff ZIP version and the Drive version) and firmware 1.1. Over Wi-Fi and USB it works with firmware 2.1.0, which serves this page from the pod itself.

**Status.** Everything here was tested against a simulated pod: the Bluetooth and USB code against stand-ins for the browser's Bluetooth and serial APIs, and the Wi-Fi code against the Wi-Fi firmware running on a computer. It has not yet talked to the real pod.

## What you need

- **Chrome or Edge on a computer, or Chrome on Android.** Safari, Firefox and any iPhone browser cannot use Bluetooth from a web page.
- **An HTTPS address or localhost.** Browsers refuse Bluetooth on a plain `http://` site or a file opened from disk.
- The simulated pod and saved throws work in any modern browser.

## Run it on your own computer

In a terminal, from this folder:

    python3 -m http.server 8000

On Windows use `py -m http.server 8000`. Then open <http://localhost:8000> in Chrome. Press **Use simulated pod** to try every screen without the disc.

## Put it online

Anything that serves static files over HTTPS works. With GitHub Pages:

1. Create a new **public** repository on GitHub.
2. Upload everything in this folder to it (**Add file → Upload files**, then drag the contents in and commit).
3. In the repository, open **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the `main` branch and `/ (root)`, and press **Save**.
4. After a minute or two the site is at `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`.

There is no build step. To update the site, upload the changed files again.

## First test with the real pod

1. Power the pod and keep it close. Close Bluefruit Connect or any other app connected to it.
2. Open the site and press **Connect to DGT-1**. Pick DGT-1 in the browser's list.
3. The panel should read **Idle**. Press **Arm**, wait for **Armed. Ready to throw**, and leave the disc still for a second.
4. Spin the disc by hand. After the recording window the panel reads **Throw captured**.
5. Press **Download and save**. The throw opens with its charts and appears under **Saved throws**.
6. Repeat with the pod carried out of range after arming. The page should reconnect on its own when the pod is back, without arming again.
7. Reload the page with Bluetooth off. The saved throws should still open.

If something goes wrong, the **Diagnostics console** on the right shows every step, with a suggested next step in blue. Press **Copy all** or **Download log** and send the text along with what you saw.

- **Run checks** repeats the browser and Bluetooth checks.
- **Scan for all Bluetooth devices** lists every device nearby, not only DGT-1. An empty list means this browser or computer is not scanning. Other devices but no DGT-1 means the pod is not broadcasting.
- The box at the bottom sends any command to a connected pod and shows the raw reply.

## A pod on Wi-Fi

Firmware 2.1.0 makes the pod its own Wi-Fi network, **DGT-1**, and the pod serves this page itself. Join that network and open the pod's address, `http://192.168.4.1` (or `http://192.168.4.1:8080`, see the firmware notes). The page connects by itself. No Bluetooth is involved, so any browser works, including on an iPhone.

The copy of this page on GitHub Pages cannot reach a pod on Wi-Fi: browsers stop a secure site from talking to a device on the local network. It keeps working over Bluetooth, and it is the way in over USB.

**USB as a backup.** With firmware 2.1.0 the pod takes the same commands on its USB serial port. Plug it into a computer, open this page over https or localhost in Chrome or Edge, and press **Connect over USB**. Close any serial terminal first: only one program can use the port.

`firmware/WIFI.md` has the install steps and what to expect. `python3 firmware/package_wifi.py` collects the files that go on the board, and `python3 firmware/tests/local_pod.py` runs the Wi-Fi firmware on your computer so the page can be tried without the board.

## The spin estimate

Above about 317 RPM the gyro cannot read spin, so the page estimates it from the high-g accelerometer: a sensor at distance r from the spin axis feels an inward pull of spin² × r. The distance is a setting on the throw page and defaults to 29.1 mm, the board centre in the holder CAD. A slow hand spin lets the page work out the real distance, and it offers that value as a button. The estimate holds in flight and in a steady spin. It reads high during the throw itself and at landing.

## Files

| File | What it holds |
| --- | --- |
| `index.html`, `style.css` | The page and its styles. |
| `js/protocol.js` | The pod's text protocol: splitting lines, reading replies, validating a download. |
| `js/client.js` | Connect, STATUS, ARM, CANCEL, DUMP, INFO, BENCH, reconnecting. Never sends ARM on its own. |
| `js/transport-ble.js` | Web Bluetooth link (Nordic UART Service). |
| `js/transport-wifi.js` | Wi-Fi link to a pod that serves this page (firmware 2.1.0). |
| `js/transport-serial.js` | USB link to the same firmware, through the browser's Web Serial API. |
| `js/transport-sim.js` | The simulated pod. |
| `js/metrics.js` | Spin estimate, distance calibration, capture numbers. |
| `js/view.js` | Which message and buttons the pod panel shows in each state. |
| `js/diagnostics.js` | The diagnostics console's checks and wording. |
| `js/chart.js`, `js/store.js`, `js/app.js` | Charts, saved throws (IndexedDB), page wiring. |
| `tests/` | Tests for the logic above. Run `npm test` (needs Node 22 or later, nothing to install). |
| `firmware/` | The pod's CircuitPython firmware (1.0.2 and 1.1.2 for Bluetooth, 2.1.0 for Wi-Fi and USB), its simulator tests and install notes. Start with `firmware/CHANGES.md`, or `firmware/WIFI.md` for Wi-Fi. |

`protocol.js`, `client.js`, `metrics.js` and `view.js` use no browser features, so a native iPhone app could reuse their rules.
