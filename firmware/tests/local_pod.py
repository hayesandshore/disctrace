"""Run the Wi-Fi firmware on this computer, to try the page without the board.

    python3 firmware/package_wifi.py
    python3 firmware/tests/local_pod.py

Then open http://localhost:8080/?link=wifi

The firmware file runs unmodified, in real time, on real network connections,
and serves the page files from the packaged CIRCUITPY folder. Only the board is
stood in for: the Wi-Fi radio, and two sensors that lie still until the disc is
"thrown", three seconds after each Arm (half a second at 150 RPM).
"""
import argparse
import math
import os
import runpy
import socket
import sys
import time
import types
from pathlib import Path

G = 9.80665
RADIUS_M = 0.0291           # the high-g sensor's distance from the disc's centre
SPIN = 150 * math.pi / 30   # rad/s


class Disc:
    """Lies still. The firmware only reads the sensors while armed, so the
    first read after a pause means Arm. Three seconds later it spins."""

    def __init__(self):
        self.last = 0.0
        self.armed = None

    def rate(self):
        now = time.monotonic()
        if now - self.last > 0.5:
            self.armed = now
        self.last = now
        return SPIN if 3.0 <= now - self.armed < 3.5 else 0.0


class Sock:
    """A real socket that shows only what a CircuitPython 10.3.2 socket has."""

    def __init__(self, real, where):
        self._real = real
        self._where = where

    def bind(self, address):
        self._real.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._real.bind(self._where)      # the firmware asks for port 80 on every interface

    def listen(self, backlog):
        self._real.listen(backlog)

    def settimeout(self, value):
        self._real.settimeout(value)

    def accept(self):
        connection, peer = self._real.accept()
        return Sock(connection, None), peer

    def recv_into(self, buffer, bufsize=0):
        return self._real.recv_into(buffer, bufsize)

    def send(self, data):
        return self._real.send(data)

    def close(self):
        self._real.close()


def stand_ins(disc, where):
    board = types.ModuleType("board")
    board.STEMMA_I2C = object

    adxl = types.ModuleType("adafruit_adxl37x")

    class ADXL375:
        def __init__(self, i2c):
            pass

        @property
        def acceleration(self):
            rate = disc.rate()
            return (rate * rate * RADIUS_M, 0.0, G)     # the pull towards the centre while spinning

    adxl.ADXL375 = ADXL375

    lsm = types.ModuleType("adafruit_lsm6ds")
    lsm.Rate = types.SimpleNamespace(RATE_104_HZ=4)
    lsm.GyroRange = types.SimpleNamespace(RANGE_2000_DPS=3)
    lsm.AccelRange = types.SimpleNamespace(RANGE_16G=1)
    lsm3 = types.ModuleType("adafruit_lsm6ds.lsm6ds3trc")

    class LSM6DS3TRC:
        def __init__(self, i2c):
            pass

        @property
        def gyro(self):
            return (0.0, 0.0, disc.rate())

        @property
        def acceleration(self):
            return (0.0, 0.0, G)

    lsm3.LSM6DS3TRC = LSM6DS3TRC

    wifi = types.ModuleType("wifi")

    class Radio:
        enabled = False
        ap_active = False
        ipv4_address = None
        ipv4_address_ap = where[0]

        def start_ap(self, ssid, password=b"", *, channel=1, authmode=(), max_connections=4):
            self.ap_active = True

    wifi.radio = Radio()

    socketpool = types.ModuleType("socketpool")

    class SocketPool:
        AF_INET, SOCK_STREAM = 2, 1

        def __init__(self, radio):
            pass

        def socket(self, family=2, type=1):
            return Sock(socket.socket(socket.AF_INET, socket.SOCK_STREAM), where)

    socketpool.SocketPool = SocketPool

    usb_cdc = types.ModuleType("usb_cdc")
    usb_cdc.console = None      # no USB serial here: commands come over the network only

    supervisor = types.ModuleType("supervisor")

    def reload():
        raise SystemExit("The firmware asked to restart. On the board it would start again from the top.")

    supervisor.reload = reload

    return {
        "board": board, "adafruit_adxl37x": adxl, "adafruit_lsm6ds": lsm, "adafruit_lsm6ds.lsm6ds3trc": lsm3,
        "wifi": wifi, "socketpool": socketpool, "usb_cdc": usb_cdc, "supervisor": supervisor,
    }


def main():
    builds = sorted((Path(__file__).resolve().parent.parent / "build").glob("DGT-1_wifi_*/CIRCUITPY"))
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--drive", type=Path, default=builds[-1] if builds else None,
                        help="the CIRCUITPY folder to run (default: the newest package)")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default: this computer only)")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if args.drive is None or not (args.drive / "code.py").exists():
        sys.exit("No packaged firmware found. Run firmware/package_wifi.py first.")
    os.chdir(args.drive)                # the firmware opens www/... beside itself
    sys.modules.update(stand_ins(Disc(), (args.host, args.port)))
    print("Simulated pod. Open http://localhost:%d/?link=wifi  (Ctrl-C stops it)" % args.port, flush=True)
    try:
        runpy.run_path("code.py", run_name="__main__")
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
