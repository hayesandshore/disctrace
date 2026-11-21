# DGT-1 firmware 1.0.2 and 1.1.2: a sensor or radio fault no longer stops the pod

**This has not run on the board yet.** It was tested off-device in the simulator (63 checks for 1.0.2, 79 for 1.1.2) and against the website's own code. The first flash is the real test.

Versions 1.0.1 and 1.1.1 were the first hardened versions. A review found gaps in them, listed under "Fixed since 1.0.1 and 1.1.1" below. Use 1.0.2 or 1.1.2 instead.

## Which file to use

| File | What it is | When |
| --- | --- | --- |
| `firmware_1.0.2/code.py` | The firmware that was on the board (the Drive copy of 1.0) plus the fixes below. Same commands, same nine-column CSV, same five-second recording. | Flash this one now. |
| `firmware_1.1.2/code.py` | Firmware 1.1 plus the same fixes. | When you move to 1.1. |

## Why

Firmware 1.0 and 1.1 start the two sensors before Bluetooth. If either sensor does not answer at power-up, the program stops right there. The pod never advertises, so no phone or browser can find it, and the only clue is on the USB serial console. Power-cycling does not help while the wiring fault is still there.

## What changed from 1.0 and 1.1

| Before | Now |
| --- | --- |
| A sensor that does not answer at power-up stops the program before Bluetooth starts. | The pod advertises first, then starts the sensors. `STATUS` replies `SENSOR_ERROR` with the part that did not start. |
| The fault could only be seen on the USB console. | The website shows it in the pod panel. Bluefruit Connect shows it as the reply to `STATUS`. |
| After a sensor fault, `ARM` reused the sensors as they were. A sensor that had lost power came back switched off and read zeros, so the pod armed and never triggered. | After any sensor fault, `ARM` starts both sensors again before arming. This adds about a second to that one `ARM`. |
| A sensor read that failed in an unexpected way stopped the program. | It is reported as `SENSOR_ERROR`, or kept as a partial capture if it happens while recording. |
| A Bluetooth error while advertising, sending or receiving stopped the program. | The pod carries on and tries again. |
| A line waiting for the phone was sent the instant it connected, before it was listening, and was lost. | The pod keeps the line until the phone has sent something. |
| Any other unexpected error stopped the program until someone pressed reset. | The error is printed on USB and the program restarts after five seconds. |

Unchanged: wiring, libraries, the trigger, the capture, the CSV columns, the `READY` summary, the unsaved-throw protection, and every reply a healthy pod sends.

## Fixed since 1.0.1 and 1.1.1

- **Advertising now starts before the sensors are touched.** In 1.0.1 it started after, so a sensor driver that hung, rather than failed, still left the pod invisible.
- **`ARM` restarts the sensors after any sensor fault**, including one that cut a recording short. Before, only sensors that had never started were retried.
- **Lines waiting for the phone are held until it has sent something.** This covers the sensor-fault reason and `IDLE armed timeout` after the phone was out of range.

## Install

1. Back up the `code.py` currently on CIRCUITPY.
2. Copy `firmware_1.0.2/code.py` from this folder to the root of CIRCUITPY, named `code.py`.
3. Open the USB serial console. A healthy start prints:

       DGT-1 firmware 1.0.2
       Starting sensors.
       DGT-1 ready. Connect in Bluefruit Connect > UART.

## When a sensor is not answering

The console prints the fault instead of `DGT-1 ready.`, for example:

    DGT-1 firmware 1.0.2
    Starting sensors.
    DGT-1 SENSOR_ERROR ADXL375 did not start: No I2C device at address: 0x53
    Bluetooth is on. STATUS reports this fault; ARM tries the sensors again.

The website shows **Sensor error** with the same text. How to read it:

- **Both sensors named:** the cable from the Feather to the first sensor is loose or pinched, or the sensors have no power.
- **One sensor named:** that sensor, or the cable leading to it. `0x53` is the ADXL375 and `0x6a` is the LSM6DS3TR-C.
- **`I2C bus did not start`:** the data lines are shorted or have no pull-ups. Check the first cable.
- **The console stops at `Starting sensors.`:** a sensor answered but its driver is stuck, which points to a marginal connection. The pod still advertises and connects, but it does not answer commands, and the website says the pod is not answering.

Fix the wiring with the power off, then power on again.

## Bench test

1. **Normal run.** Connect, send `STATUS` and expect `IDLE`. Arm, spin the disc by hand, download. This should behave exactly as before.
2. **Fault run.** Power off and unplug the cable to the far sensor. Power on. The pod should still appear as DGT-1, and `STATUS` should name the missing sensor. Power off, plug the cable back in, power on, and expect `IDLE`.

Please send back the console text from both runs.

## If something goes wrong

- **`DGT-1 stopped on an unexpected error. Restarting in 5 seconds.`** Copy the lines printed after it and send them. Press Ctrl-C in the serial console to stop the restart loop. **A restart erases a throw that has not been downloaded**, because the capture is held in memory only. The original firmware lost it too, since it stopped for good.
- **To go back:** copy your backup `code.py` onto CIRCUITPY.

## Notes for the app

The website already handles all of these; they were checked against its code.

- `STATUS` can reply `SENSOR_ERROR <reason>` when the sensors did not start. After a read fault on a running pod it still replies plain `SENSOR_ERROR`, as before.
- `ARM` with the sensors still missing replies two lines: `SENSOR_ERROR <reason>`, then `State SENSOR_ERROR. Commands: ...`.
- A line the pod sends without being asked (`READY ...`, `IDLE armed timeout`, `SENSOR_ERROR <reason>`) that was waiting when the phone connected now arrives just after the phone's first command, not at the moment of connection. If `STATUS` already gave the same line, it is not sent twice.
- If a reply is cut off by a Bluetooth error, the next reply starts on a new line.
- `INFO` in 1.1.2 reports `fw=1.1.2`. Firmware 1.0.2 has no `INFO`, like 1.0, so the website shows it as firmware 1.0. The console line `DGT-1 firmware 1.0.2` is how to confirm the flash.

## Tests

From this folder, with Python 3 and nothing else installed:

    python3 tests/run_tests.py firmware_1.0.2/code.py
    python3 tests/run_tests.py firmware_1.1.2/code.py

`tests/test_hardening.py` holds the fault checks. `tests/sim.py` is the simulator from the 1.1 package, extended so that sensors and the radio can fail, a sensor driver can hang, a sensor can lose its settings, and anything the pod writes before the phone has subscribed is dropped, as on the real radio.
