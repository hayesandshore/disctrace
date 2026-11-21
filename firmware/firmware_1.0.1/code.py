"""DGT-1 Prototype 1, firmware 1.0.1. Copy to CIRCUITPY/code.py.

Same commands, capture and CSV as 1.0. New in 1.0.1: a sensor or radio fault
no longer stops the pod.
- Bluetooth starts before the sensors. If a sensor does not answer, the pod
  still advertises, STATUS replies SENSOR_ERROR with the part that did not
  start, and ARM tries the sensors again.
- A sensor read or a Bluetooth call that fails in an unexpected way is
  handled instead of ending the program.
- Anything else unexpected is printed on USB and the program restarts.
"""
import gc
import math
import struct
import time

import board
from adafruit_adxl37x import ADXL375
from adafruit_ble import BLERadio
from adafruit_ble.advertising.standard import ProvideServicesAdvertisement
from adafruit_ble.services.nordic import UARTService
from adafruit_lsm6ds import GyroRange, Rate
from adafruit_lsm6ds.lsm6ds3trc import LSM6DS3TRC

G = 9.80665
PERIOD_NS = 10_000_000  # Target 100 samples/s.
PRE = 30                 # Up to 0.30 s of history.
WINDOW_NS = 5_000_000_000
ARM_TIMEOUT_NS = 3_600_000_000_000  # Keep elapsed microseconds within uint32.
TRIGGER_G = 3.0
TRIGGER_G_SQ = TRIGGER_G * TRIGGER_G
TRIGGER_RPM = 90.0
WARN_RAD_S = math.radians(1900)
RPM_PER_RAD_S = 30 / math.pi
FORMAT = "<Iffffff"  # time in us, acceleration in g, gyro in rad/s
ROW = struct.calcsize(FORMAT)
CAPACITY = PRE + WINDOW_NS // PERIOD_NS + 2
VERSION = "1.0.1"
COMMANDS = "ARM STATUS DUMP CANCEL"

class Capture:
    def __init__(self):
        self.data = bytearray(ROW * CAPACITY)
        self.state = "IDLE"
        self.count = 0
        self.partial = False  # Recording was cut short by a sensor error.
        self.dumped = False   # A DUMP of this capture reached END.
        self.confirm = False  # User was warned that ARM discards this capture.

    def arm(self, now):
        self.start = now
        self.head = self.count = 0
        self.partial = self.dumped = self.confirm = False
        self.state = "ARMED"

    def sample(self, now, accel, gyro):
        # Plain divisions: no generator object to allocate on every sample.
        ax = accel[0] / G
        ay = accel[1] / G
        az = accel[2] / G
        gx, gy, gz = gyro
        if self.state == "ARMED":
            if ax*ax + ay*ay + az*az >= TRIGGER_G_SQ or abs(gz)*RPM_PER_RAD_S >= TRIGGER_RPM:
                self.trigger_us = (now - self.start) // 1000
                self.end = now + WINDOW_NS
                self.state = "RECORDING"
            elif self.count == PRE:
                self.head = (self.head + 1) % CAPACITY
                self.count -= 1
        slot = (self.head + self.count) % CAPACITY
        struct.pack_into(FORMAT, self.data, ROW * slot, (now-self.start)//1000,
                         ax, ay, az, gx, gy, gz)
        self.count += 1
        if self.state == "RECORDING" and (now >= self.end or self.count == CAPACITY):
            self.state = "READY"

    def rows(self):
        for i in range(self.count):
            offset = ROW * ((self.head + i) % CAPACITY)
            yield struct.unpack_from(FORMAT, self.data, offset)

    def summary(self):
        peak_g = peak_rpm = 0.0
        limited = False
        largest_gap = 0
        previous = None
        for t, ax, ay, az, gx, gy, gz in self.rows():
            peak_g = max(peak_g, math.sqrt(ax*ax + ay*ay + az*az))
            peak_rpm = max(peak_rpm, abs(gz)*RPM_PER_RAD_S)
            limited |= abs(gz) >= WARN_RAD_S
            if previous is not None:
                largest_gap = max(largest_gap, t - previous)
            previous = t
        spin = "NEAR_LIMIT" if limited else "%.1f" % peak_rpm
        return "READY samples=%d peak_g=%.2f peak_abs_rpm=%s max_gap_ms=%.1f%s" % (
            self.count, peak_g, spin, largest_gap / 1000,
            " partial=1" if self.partial else "")

def run():
    # Bluetooth first. A sensor that does not answer must not keep the pod
    # from advertising: the fault is reported over Bluetooth instead.
    radio = BLERadio()
    radio.name = "DGT-1"
    uart = UARTService()
    advertisement = ProvideServicesAdvertisement(uart)
    advertisement.complete_name = radio.name
    capture = Capture()
    high_g = imu = None  # Both stay None until both sensors have started.
    fault = None         # Why they have not started, as text for SENSOR_ERROR.
    command = bytearray()
    connected = False
    discard = False
    due = 0
    notice = None  # Unsolicited status line waiting to be sent over BLE.
    adv_error = None  # Last advertising error printed, so it is printed once.
    torn = False      # A reply was cut off mid-line; the next must start a new line.

    def start_sensors():
        """Start both sensors. Returns True when they are ready. Otherwise
        fault names each part that did not start, and why."""
        nonlocal high_g, imu, fault
        high_g = imu = None
        try:
            i2c = board.STEMMA_I2C()
        except Exception as error:
            fault = "I2C bus did not start: %s" % error
            return False
        problems = []
        new_high_g = new_imu = None
        try:
            new_high_g = ADXL375(i2c)
        except Exception as error:
            problems.append("ADXL375 did not start: %s" % error)
        try:
            new_imu = LSM6DS3TRC(i2c)
            new_imu.gyro_range = GyroRange.RANGE_2000_DPS
            new_imu.gyro_data_rate = Rate.RATE_104_HZ
        except Exception as error:
            problems.append("LSM6DS3TR-C did not start: %s" % error)
        if problems:
            fault = "; ".join(problems)
            return False
        high_g, imu, fault = new_high_g, new_imu, None
        return True

    def reply(line):
        nonlocal torn
        payload = (line + "\r\n").encode()
        if torn:
            payload = b"\r\n" + payload  # End the cut-off line first.
        sent = False
        try:
            for i in range(0, len(payload), 20):
                if not radio.connected:
                    return False
                uart.write(payload[i:i+20])
                sent = True
            torn = False
            return True
        except Exception:  # Bluetooth errors are not OSErrors.
            if sent:
                torn = True
            return False

    def dispatch(cmd):
        nonlocal notice
        if cmd == b"ARM" and capture.state != "RECORDING":
            if capture.state == "READY" and not (capture.dumped or capture.confirm):
                capture.confirm = True
                reply("UNSAVED capture not dumped. Send ARM again to discard.")
                return
            if high_g is None and not start_sensors():
                # Still no sensors. Say why, then refuse in the usual words.
                capture.state = "SENSOR_ERROR"
                reply("SENSOR_ERROR " + fault)
                reply("State SENSOR_ERROR. Commands: " + COMMANDS)
                return
            notice = None
            gc.collect()
            capture.arm(time.monotonic_ns())
            reply("ARMED")
        elif cmd == b"CANCEL" and capture.state == "ARMED":
            capture.state = "IDLE"
            reply("IDLE")
        elif cmd == b"STATUS":
            if capture.state == "READY":
                reply(capture.summary())
            elif high_g is None:
                reply("SENSOR_ERROR " + fault)  # Names the part that did not start.
            else:
                reply(capture.state)
        elif cmd == b"DUMP" and capture.state == "READY":
            reply("t_ms,ax_g,ay_g,az_g,gx_rad_s,gy_rad_s,gz_rad_s,z_rpm,z_near_limit")
            for t, ax, ay, az, gx, gy, gz in capture.rows():
                flag = abs(gz) >= WARN_RAD_S
                rpm = "" if flag else "%.2f" % (gz*RPM_PER_RAD_S)
                if not reply("%.3f,%.3f,%.3f,%.3f,%.4f,%.4f,%.4f,%s,%d" %
                             ((t-capture.trigger_us)/1000, ax, ay, az, gx, gy, gz, rpm, flag)):
                    return
            capture.dumped = reply("END")
        else:
            reply("State " + capture.state + ". Commands: " + COMMANDS)

    print("DGT-1 firmware " + VERSION)
    if start_sensors():
        print("DGT-1 ready. Connect in Bluefruit Connect > UART.")
    else:
        capture.state = "SENSOR_ERROR"
        notice = "SENSOR_ERROR " + fault
        print("DGT-1 " + notice)
        print("Bluetooth is on. STATUS reports this fault; ARM tries the sensors again.")
    while True:
        now = time.monotonic_ns()
        if capture.state in ("ARMED", "RECORDING") and now >= due:
            # Stay on a fixed 10 ms grid so loop lateness does not stretch the
            # period; resync if more than one period behind (or just armed).
            due = now + PERIOD_NS if now - due > PERIOD_NS else due + PERIOD_NS
            if capture.state == "ARMED" and now-capture.start >= ARM_TIMEOUT_NS:
                capture.state = "IDLE"
                notice = "IDLE armed timeout"
            else:
                try:
                    accel = high_g.acceleration
                    gyro = imu.gyro
                except Exception as error:  # An I2C error, or anything else a driver raises.
                    print(error)
                    if capture.state == "RECORDING":
                        # Keep what was recorded so far instead of losing it.
                        capture.partial = True
                        capture.state = "READY"
                    else:
                        capture.state = "SENSOR_ERROR"
                        notice = "SENSOR_ERROR %s" % error
                else:
                    capture.sample(now, accel, gyro)
                if capture.state == "READY":
                    notice = capture.summary()
        # Keep BLE traffic and formatting out of the recording loop.
        if capture.state == "RECORDING":
            time.sleep(0.001)
            continue
        if radio.connected:
            connected = True
            if notice and reply(notice):
                notice = None
            try:
                incoming = uart.read(min(64, uart.in_waiting)) if uart.in_waiting else None
            except Exception:  # Bluetooth errors are not OSErrors.
                incoming = None
            for char in incoming or b"":
                if char in (10, 13):
                    if command and not discard:
                        dispatch(bytes(command).strip().upper())
                    command = bytearray()
                    discard = False
                elif len(command) < 32:
                    command.append(char)
                else:
                    discard = True
        else:
            if connected:
                command = bytearray()
                discard = connected = torn = False
            if not radio.advertising:
                try:
                    radio.start_advertising(advertisement)
                    adv_error = None
                except Exception as error:  # Bluetooth errors are not OSErrors.
                    if str(error) != adv_error:
                        adv_error = str(error)
                        print("Advertising did not start:", adv_error)
                    try:
                        # Clears a stale "already advertising" state before the next try.
                        radio.stop_advertising()
                    except Exception:
                        pass
        time.sleep(0.001 if capture.state == "ARMED" else 0.02)


try:
    run()
except Exception as error:
    # Nothing above expected this. Say what it was on USB, then start again:
    # a pod sealed inside a disc cannot be reset by hand.
    print("DGT-1 stopped on an unexpected error. Restarting in 5 seconds.")
    try:
        import traceback
        traceback.print_exception(error)
    except Exception:
        print(repr(error))
    time.sleep(5)
    import supervisor
    supervisor.reload()
