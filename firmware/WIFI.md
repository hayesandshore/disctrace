# DGT-1 firmware 2.1.0: Wi-Fi, with USB as a backup

**This has not run on the board yet.** It was tested off-device: 90 checks in the simulator, and the real page driving the firmware on a computer over real network connections. The USB link was tested against stand-ins only, on both sides. The first flash is the real test.

## What it does

The pod makes its own Wi-Fi network, **DGT-1**, and serves the DiscTrace page on it. Join that network and open the pod's address in any browser. Bluetooth is not used, so iPhones, Safari and Firefox work too.

The same commands also work over a USB cable, as a backup: see "If Wi-Fi does not work: USB" below.

The trigger, the capture and the CSV are the same as 1.0.2: nine columns, five seconds past the trigger. Wiring and libraries are unchanged.

## Install

1. Back up the `code.py` currently on CIRCUITPY.
2. Copy `code.py` and the `www` folder to the root of CIRCUITPY. In the package they are inside the `CIRCUITPY` folder. Leave `lib` and `settings.toml` as they are.
3. Open the USB serial console. A healthy start prints:

       DGT-1 firmware 2.1.0
       Wi-Fi network DGT-1 is up, with no password.
       Page: http://192.168.4.1:8080
       Starting sensors.
       DGT-1 ready. Join the Wi-Fi network DGT-1 and open http://192.168.4.1:8080

## The address

**On the board as it is set up today the address is `http://192.168.4.1:8080`.** Its `settings.toml` turns on CircuitPython's own web tool on port 80, so the page uses port 8080.

To get the short address, `http://192.168.4.1`, remove the `CIRCUITPY_WEB_API_PASSWORD` line from `settings.toml`. That turns CircuitPython's web tool off. Removing the `CIRCUITPY_WIFI_SSID` line as well stops the board from spending several seconds at each power-up looking for that network.

The console always prints the address to use. If the board has joined the Wi-Fi named in `settings.toml`, it prints a second address on that network too, and the page works there without leaving your normal Wi-Fi.

## Use

1. Power the pod. On the phone or computer, join the Wi-Fi network **DGT-1**. It has no password and no internet. If the phone asks, choose to stay connected.
2. Open the address. The page connects by itself and should read **Idle**.
3. Press **Arm**, throw, then **Download and save**, as before.

## If Wi-Fi does not work: USB

The pod takes the same commands on its USB serial port, whether or not Wi-Fi is working.

**From the website.** Plug the pod into a computer. Open <https://hayesandshore.github.io/disctrace/> in Chrome or Edge and press **Connect over USB**. Pick the pod in the browser's list: it shows as a Feather ESP32-S3 or a CircuitPython port. Arm, throw and download as usual. This needs Chrome or Edge on a computer; phones, Safari and Firefox cannot do it. Close any serial terminal first, because only one program can use the port at a time.

**From a serial terminal.** Type `STATUS`, `ARM`, `CANCEL`, `DUMP`, `INFO` or `BENCH` and press Enter. To keep a throw this way, copy the `DUMP` output and paste it into the website under **Import a capture**. Do not press Ctrl-C: that stops the pod's program.

**If Wi-Fi fails on the pod itself**, the pod no longer restarts. The console prints `Wi-Fi did not start:` or `Wi-Fi stopped on an unexpected error:` with the reason. The pod carries on over USB, keeps a throw that has not been downloaded, and tries Wi-Fi again every 30 seconds.

## Things to know

- **No internet while on DGT-1.** A phone may drop a network with no internet or send traffic over mobile data instead. If the page says it cannot reach the pod, check the phone is still on DGT-1, and turn mobile data off if it keeps happening.
- **The pod is silent while it records**, for five seconds. The page shows Recording and picks up the result when the pod answers again.
- **Saved throws belong to the address.** Throws saved on the pod's page are kept in that browser for that address. They are separate from throws saved on the github.io site. Export the ones you want to move.
- **The network is open** unless you add `DGT_WIFI_PASSWORD = "..."` (8 to 63 characters) to `settings.toml`. Anyone nearby can otherwise join and arm or download.
- **Wi-Fi draws much more power than Bluetooth.** Expect shorter battery life.
- **One pod at a time.** Two pods with this firmware would both be DGT-1 at the same address.
- **The github.io site cannot reach a pod on Wi-Fi.** Browsers stop a secure site from talking to a device on the local network. It reaches this firmware over USB, and the Bluetooth firmware over Bluetooth.
- **The pod's own page has no USB button.** Browsers only allow USB serial on a secure site, so USB goes through the github.io site.

## If something goes wrong

- **No DGT-1 network.** Look at the USB console. `Wi-Fi did not start:` and `DGT-1 stopped on an unexpected error` are each followed by the reason; copy those lines and send them. The pod can still be used over USB.
- **The network is there but the page does not open.** Check the address, including `:8080`. If the browser shows "The page files are not on the pod", the `www` folder is missing from CIRCUITPY.
- **The page opens but shows a sensor error.** Same meaning as before: see "When a sensor is not answering" in `CHANGES.md`.
- **A restart erases a throw that has not been downloaded**, as with the Bluetooth firmware.
- **To go back:** copy your backup `code.py` onto CIRCUITPY. The `www` folder can stay.

## For the app

- `POST /api/cmd` with the command as the body (`STATUS`, `ARM`, `CANCEL`, `DUMP`, `INFO`, `BENCH`). The reply lines are the response body, each ending CRLF.
- `GET /api/hello` returns the `INFO` line. The page uses it to check that the address is a pod.
- Nothing is pushed. A line the Bluetooth firmware sent without being asked (`READY ...`, `IDLE armed timeout`, `SENSOR_ERROR <reason>`) is the answer to the next `STATUS`, once.
- A `DUMP` counts as downloaded only when the whole response has been handed to the connection. If the connection breaks first, the throw stays protected.
- Any other `GET` serves a file from `www`.
- On USB the commands are lines of text on the console serial port (115200 baud, any line ending), and the replies are lines on the same port. The pod's own console messages share that port; the page ignores lines it does not know.

## Tests and tools

From the `firmware` folder, with Python 3 and nothing else installed:

    python3 tests/run_tests.py firmware_2.1.0/code.py

To build the package (`code.py`, the page files and this note) from the repository:

    python3 package_wifi.py

To try the page against the firmware without the board, run the firmware on your computer and open <http://localhost:8080/?link=wifi>. The sensors are simulated: the disc is "thrown" three seconds after each Arm.

    python3 tests/local_pod.py
