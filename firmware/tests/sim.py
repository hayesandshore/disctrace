"""Run DGT-1 firmware off-device with a simulated clock, sensors and Bluetooth link.

The firmware file is executed unmodified. Its imports of `time`, `board` and the
Adafruit libraries are satisfied by the stand-ins below, all driven by one World.
Every scenario input is a function of simulated seconds since power-on.
"""
import contextlib
import io
import runpy
import sys
import types

G = 9.80665
REST = (0.0, 0.0, G)        # accelerometer lying flat and still, in m/s^2
STILL = (0.0, 0.0, 0.0)     # gyro not rotating, in rad/s


class SimEnd(BaseException):
    """Raised from the fake time.sleep once the scenario's end time is reached.
    Not an Exception, so firmware that catches Exception cannot swallow it."""


class BluetoothError(Exception):
    """Like CircuitPython's _bleio.BluetoothError: a plain Exception, not an OSError."""


# What each part raises on the real board when it does not answer at start-up.
START_ERRORS = {
    "bus": RuntimeError("No pull up found on SDA or SCL; check your wiring"),
    "adxl": ValueError("No I2C device at address: 0x53"),
    "imu": ValueError("No I2C device at address: 0x6a"),
}


class World:
    def __init__(self, end_s, commands=(), high_g=None, gyro=None, imu_accel=None,
                 connected=None, sensor_fail=None, jumps=(),
                 read_cost_ns=800_000, write_cost_ns=200_000,
                 sensor_start_fail=None, sensor_error=None, advertise_fail=None,
                 advertise_stuck=None, write_fail=None, read_fail=None, connected_error=None):
        self.now = 0
        self.end_ns = int(end_s * 1e9)
        self.pending = sorted(commands)                 # [(seconds, bytes)] from the phone
        self.high_g = high_g or (lambda t: REST)
        self.gyro = gyro or (lambda t: STILL)
        self.imu_accel = imu_accel or (lambda t: REST)
        self.connected = connected or (lambda t: True)
        self.sensor_fail = sensor_fail or (lambda t: False)
        self.jumps = sorted(jumps)                      # [(seconds, extra_seconds)]
        self.read_cost_ns = read_cost_ns
        self.write_cost_ns = write_cost_ns
        self.rx = bytearray()
        self.writes = []                                # [(ns, connection_number, bytes)]
        self.connection = 0
        self.imu_config = {}
        self.advertise_calls = 0                        # successful starts
        self.console = ""
        # Faults. Each is a function of simulated seconds unless noted.
        never = lambda t: False
        self.sensor_start_fail = sensor_start_fail or (lambda t: ())   # parts not answering: "bus", "adxl", "imu"
        self.sensor_error = sensor_error                # exception a failing read raises (default OSError)
        self.advertise_fail = advertise_fail or never   # start_advertising raises
        self.advertise_stuck = advertise_stuck or never # "Already advertising." until stop_advertising is called
        self.write_fail = write_fail or never           # a Bluetooth write raises
        self.read_fail = read_fail or never             # a Bluetooth read raises
        self.connected_error = connected_error or never # asking the radio whether it is connected raises
        self.advertise_failures = 0
        self.advertise_stops = 0
        self.reloads = 0                                # supervisor.reload() calls

    @property
    def t(self):
        return self.now / 1e9

    def advance(self, ns):
        self.now += int(ns)
        while self.jumps and self.t >= self.jumps[0][0]:
            self.now += int(self.jumps.pop(0)[1] * 1e9)

    def read(self, source):
        self.advance(self.read_cost_ns)
        if self.sensor_fail(self.t):
            raise self.sensor_error or OSError("[Errno 5] simulated I2C failure")
        return source(self.t)

    def start(self, part):
        """Called when the firmware starts a part; raises if it is not answering now."""
        if part in self.sensor_start_fail(self.t):
            raise START_ERRORS[part]

    def deliver(self):
        while self.pending and self.pending[0][0] <= self.t:
            _, data = self.pending.pop(0)
            if self.connected(self.t):                  # out of range: the phone's write is lost
                self.rx.extend(data)

    # What the phone received -------------------------------------------------
    @property
    def timed_lines(self):
        """[(seconds, line)] of complete CRLF-terminated lines. Text left unfinished
        when a connection dropped is discarded, as the app is told to do."""
        out, buffer, current = [], b"", None
        for ns, connection, data in self.writes:
            if connection != current:
                buffer, current = b"", connection
            buffer += data
            while b"\r\n" in buffer:
                line, buffer = buffer.split(b"\r\n", 1)
                out.append((ns / 1e9, line.decode()))
        return out

    @property
    def lines(self):
        return [line for _, line in self.timed_lines]


def _stand_ins(world):
    time_mod = types.ModuleType("time")

    def monotonic_ns():
        world.advance(10_000)
        return world.now

    def sleep(seconds):
        world.advance(seconds * 1e9)
        if world.now >= world.end_ns:
            raise SimEnd

    time_mod.monotonic_ns = monotonic_ns
    time_mod.sleep = sleep

    board = types.ModuleType("board")

    def stemma_i2c():
        world.start("bus")
        return object()

    board.STEMMA_I2C = stemma_i2c

    adxl = types.ModuleType("adafruit_adxl37x")

    class ADXL375:
        def __init__(self, i2c):
            world.start("adxl")

        @property
        def acceleration(self):
            return world.read(world.high_g)

    adxl.ADXL375 = ADXL375

    lsm = types.ModuleType("adafruit_lsm6ds")

    class Rate:                     # defined at import time in the real library
        RATE_104_HZ = 4
        RATE_208_HZ = 5

    class GyroRange:                # the real library fills these in when an IMU is constructed
        pass

    class AccelRange:
        pass

    lsm.Rate, lsm.GyroRange, lsm.AccelRange = Rate, GyroRange, AccelRange
    lsm3 = types.ModuleType("adafruit_lsm6ds.lsm6ds3trc")
    settable = ("gyro_range", "gyro_data_rate", "accelerometer_range", "accelerometer_data_rate")

    class LSM6DS3TRC:
        def __init__(self, i2c):
            world.start("imu")
            GyroRange.RANGE_250_DPS, GyroRange.RANGE_2000_DPS = 0, 3
            AccelRange.RANGE_2G, AccelRange.RANGE_16G = 0, 1
            AccelRange.RANGE_4G, AccelRange.RANGE_8G = 2, 3
            world.imu_config.update(gyro_range=0, gyro_data_rate=4,
                                    accelerometer_range=2, accelerometer_data_rate=4)

        def __setattr__(self, name, value):
            # The real class would silently accept a misspelt setting; be strict here.
            if name not in settable:
                raise AttributeError("LSM6DS3TRC has no setting %r" % name)
            world.imu_config[name] = value

        @property
        def acceleration(self):
            return world.read(world.imu_accel)

        @property
        def gyro(self):
            return world.read(world.gyro)

    lsm3.LSM6DS3TRC = LSM6DS3TRC

    ble = types.ModuleType("adafruit_ble")

    class BLERadio:
        def __init__(self):
            self.name = ""
            self._advertising = False
            self._was_connected = False
            self._cleared = False               # stop_advertising has been called

        @property
        def connected(self):
            if world.connected_error(world.t):
                raise BluetoothError("Unknown BLE error: 0x0006")
            now_connected = bool(world.connected(world.t))
            if now_connected and not self._was_connected:
                world.connection += 1
                self._advertising = False
            self._was_connected = now_connected
            return now_connected

        @property
        def advertising(self):
            return self._advertising

        def start_advertising(self, advertisement):
            if world.advertise_fail(world.t):
                world.advertise_failures += 1
                raise BluetoothError("Unknown BLE error: 0x0006")
            if world.advertise_stuck(world.t) and not self._cleared:
                world.advertise_failures += 1
                raise BluetoothError("Already advertising.")
            self._advertising = True
            world.advertise_calls += 1

        def stop_advertising(self):
            self._advertising = False
            self._cleared = True
            world.advertise_stops += 1

    ble.BLERadio = BLERadio
    adv_pkg = types.ModuleType("adafruit_ble.advertising")
    adv_std = types.ModuleType("adafruit_ble.advertising.standard")

    class ProvideServicesAdvertisement:
        def __init__(self, *services):
            self.complete_name = None

    adv_std.ProvideServicesAdvertisement = ProvideServicesAdvertisement
    svc_pkg = types.ModuleType("adafruit_ble.services")
    nordic = types.ModuleType("adafruit_ble.services.nordic")

    class UARTService:
        @property
        def in_waiting(self):
            world.deliver()
            return len(world.rx)

        def read(self, count):
            if world.read_fail(world.t):
                raise BluetoothError("Unknown BLE error: 0x0006")
            world.deliver()
            data = bytes(world.rx[:count])
            del world.rx[:count]
            return data

        def write(self, data):
            if world.write_fail(world.t):
                raise BluetoothError("Unknown BLE error: 0x0006")
            assert world.connected(world.t), "firmware wrote while disconnected"
            world.writes.append((world.now, world.connection, bytes(data)))
            world.advance(world.write_cost_ns)

    nordic.UARTService = UARTService

    supervisor = types.ModuleType("supervisor")

    def reload():
        # On the board this restarts code.py from the top. Here it ends the scenario.
        world.reloads += 1
        raise SimEnd

    supervisor.reload = reload

    return {
        "supervisor": supervisor,
        "time": time_mod,
        "board": board,
        "adafruit_adxl37x": adxl,
        "adafruit_lsm6ds": lsm,
        "adafruit_lsm6ds.lsm6ds3trc": lsm3,
        "adafruit_ble": ble,
        "adafruit_ble.advertising": adv_pkg,
        "adafruit_ble.advertising.standard": adv_std,
        "adafruit_ble.services": svc_pkg,
        "adafruit_ble.services.nordic": nordic,
    }


def run(firmware_path, world):
    """Execute the firmware until the world's end time, then return the world."""
    stand_ins = _stand_ins(world)
    saved = {name: sys.modules.get(name) for name in stand_ins}
    console = io.StringIO()
    sys.modules.update(stand_ins)
    try:
        with contextlib.redirect_stdout(console), contextlib.redirect_stderr(console):
            runpy.run_path(str(firmware_path), run_name="__main__")
    except SimEnd:
        pass
    else:
        raise AssertionError("firmware main loop returned")
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        world.console = console.getvalue()
    return world
