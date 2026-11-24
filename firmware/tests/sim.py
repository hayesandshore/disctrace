"""Run DGT-1 firmware off-device with a simulated clock, sensors and radio link.

The firmware file is executed unmodified. Its imports of `time`, `board` and the
Adafruit libraries are satisfied by the stand-ins below, all driven by one World.
Every scenario input is a function of simulated seconds since power-on.

A Bluetooth firmware gets the phone's commands as writes to its UART service. A
Wi-Fi firmware gets the same commands as HTTP requests (POST /api/cmd), and the
reply lines are read out of the responses, so `world.lines` means the same for
both. The Wi-Fi stand-ins offer only what CircuitPython 10.3.2 offers.
"""
import contextlib
import errno
import io
import pkgutil  # noqa: F401 - runpy loads it late; load it now, while `os` is still the real one
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
                 advertise_stuck=None, write_fail=None, read_fail=None, connected_error=None,
                 subscribe_delay=0.15, sensor_start_hang=None, lose_settings=False,
                 http=(), files=None, settings=None, station_ip=None, ap_fail=None,
                 accept_error=None, recv_chunk=None, send_chunk=1000, spare=(),
                 response_cut=None, net_cost_ns=50_000,
                 usb=(), usb_console=True, usb_stall=None, usb_error=None):
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
        # A phone subscribes to notifications a moment after it connects. Until
        # then the radio drops what the pod writes, without reporting an error.
        self.subscribe_delay = subscribe_delay          # seconds
        self.connected_since = 0.0
        self.dropped_writes = 0
        self.sensor_start_hang = sensor_start_hang or (lambda t: ())   # parts whose driver never returns
        # A sensor that loses power comes back switched off and reads zeros
        # until its driver is constructed again. With lose_settings, any failed
        # read counts as such a power loss.
        self.lose_settings = lose_settings
        self.standby = set()                            # parts reading zeros: "adxl", "imu"
        # Wi-Fi. Commands above reach a Wi-Fi firmware as POST /api/cmd requests.
        self.http = sorted(http)                        # other requests: [(seconds, method, path, body)]
        self.spare = sorted(spare)                      # seconds at which a browser opens a connection and says nothing
        self.files = dict(files or {})                  # the CIRCUITPY drive: {"www/index.html": bytes}
        self.settings = dict(settings or {})            # settings.toml, as os.getenv sees it
        self.station_ip = station_ip                    # address on a network the board joined by itself, if any
        self.ap_fail = ap_fail or never                 # start_ap raises
        self.accept_error = accept_error or never       # accept raises something nobody expected
        self.recv_chunk = recv_chunk                    # most bytes one recv_into hands over (None: all there is)
        self.send_chunk = send_chunk                    # most bytes one send takes, so partial sends happen
        self.response_cut = response_cut                # the phone vanishes after receiving this many bytes of a response
        self.net_cost_ns = net_cost_ns
        self.backlog = []                               # connections the firmware has not accepted yet
        self.exchanges = []                             # every finished connection, as a dict
        self.ap = None                                  # the access point the firmware started
        self.ap_starts = 0
        self.listen_port = None
        self.open_connections = 0
        self.most_open_connections = 0
        # USB serial. What a terminal or the website sends on the pod's serial port.
        self.usb = sorted(usb)                          # [(seconds, bytes)]
        self.usb_console = usb_console                  # False: the console was switched off in boot.py
        self.usb_stall = usb_stall or never             # the computer has stopped reading
        self.usb_error = usb_error or never             # the USB stack raises something nobody expected
        self.usb_writes = []                            # [(ns, bytes)] the pod wrote on USB

    @property
    def t(self):
        return self.now / 1e9

    def advance(self, ns):
        self.now += int(ns)
        while self.jumps and self.t >= self.jumps[0][0]:
            self.now += int(self.jumps.pop(0)[1] * 1e9)

    def read(self, source, part=None):
        self.advance(self.read_cost_ns)
        if self.sensor_fail(self.t):
            if self.lose_settings:
                self.standby.update(("adxl", "imu"))
            raise self.sensor_error or OSError("[Errno 5] simulated I2C failure")
        if part in self.standby:
            return (0.0, 0.0, 0.0)
        return source(self.t)

    def start(self, part):
        """Called when the firmware starts a part. Raises if the part is not
        answering now, never returns if its driver hangs, and otherwise leaves
        the part switched on with fresh settings."""
        if part in self.sensor_start_hang(self.t):
            while True:                                 # like a driver waiting on a bit that never clears
                self.advance(1_000_000)
                if self.now >= self.end_ns:
                    raise SimEnd
        if part in self.sensor_start_fail(self.t):
            raise START_ERRORS[part]
        self.standby.discard(part)

    def deliver(self):
        while self.pending and self.pending[0][0] <= self.t:
            _, data = self.pending.pop(0)
            if self.connected(self.t):                  # out of range: the phone's write is lost
                self.rx.extend(data)

    # Wi-Fi: requests on their way to the pod --------------------------------
    def deliver_http(self):
        """Moves every request that is due into the backlog, as a connection."""
        while self.pending and self.pending[0][0] <= self.t:
            _, data = self.pending.pop(0)
            if self.connected(self.t):                  # out of range: the request never arrives
                self.backlog.append(Connection(self, http_request("POST", "/api/cmd", data), command=True))
        while self.http and self.http[0][0] <= self.t:
            _, method, path, body = self.http.pop(0)
            if self.connected(self.t):
                # "RAW" sends the body as it is, for requests no browser would make.
                raw = body if method == "RAW" else http_request(method, path, body)
                self.backlog.append(Connection(self, raw))
        while self.spare and self.spare[0] <= self.t:
            self.spare.pop(0)
            self.backlog.append(Connection(self, b""))

    def finish(self, connection):
        """Called when the firmware closes a connection: files what the phone got."""
        head, _, body = bytes(connection.got).partition(b"\r\n\r\n")
        lines = head.decode().split("\r\n")
        headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
        status = int(lines[0].split(" ")[1]) if lines[0].startswith("HTTP/1.1 ") else None
        declared = headers.get("Content-Length")
        self.exchanges.append({
            "request": connection.raw, "asked": connection.opened, "answered": connection.last / 1e9,
            "status": status, "headers": headers, "body": body,
            "complete": declared is not None and int(declared) == len(body),
        })
        if connection.command and body:
            self.writes.append((connection.last, "http-%d" % len(self.exchanges), body))

    def open_file(self, path, mode="r"):
        """The firmware's open(): reads from the simulated CIRCUITPY drive."""
        assert mode == "rb", "the firmware should open page files as bytes"
        if path not in self.files:
            raise OSError(errno.ENOENT, "No such file/directory")
        return io.BytesIO(self.files[path])

    def response(self, path, which=-1):
        """The finished exchange for the which-th request for a path."""
        found = [item for item in self.exchanges if item["request"].split(b" ")[1].decode() == path]
        return found[which]

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

    @property
    def usb_timed_lines(self):
        """[(seconds, line)] of complete lines the pod wrote on USB."""
        out, buffer = [], b""
        for ns, data in self.usb_writes:
            buffer += data
            while b"\r\n" in buffer:
                line, buffer = buffer.split(b"\r\n", 1)
                out.append((ns / 1e9, line.decode()))
        return out

    @property
    def usb_lines(self):
        return [line for _, line in self.usb_timed_lines]


def http_request(method, path, body=b""):
    """The bytes a browser sends for one request."""
    head = "%s %s HTTP/1.1\r\nHost: 192.168.4.1\r\nUser-Agent: sim\r\nAccept: */*\r\n" % (method, path)
    if method == "POST":
        head += "Content-Type: text/plain;charset=UTF-8\r\nContent-Length: %d\r\n" % len(body)
    return (head + "\r\n").encode() + body


SEND_BUFFER = 5744      # bytes the board's TCP stack holds for a peer that has stopped acknowledging


class Connection:
    """The pod's end of one browser connection. Has the methods a CircuitPython
    10.3.2 socket has and no others, and never waits: every socket on the board
    is non-blocking underneath, and one left in blocking mode would stall the
    sampling loop."""

    def __init__(self, world, raw, command=False):
        self.world = world
        self.raw = raw
        self.command = command
        self.opened = world.t
        self.last = world.now
        self.taken = 0              # request bytes the firmware has read
        self.got = bytearray()      # response bytes that reached the phone
        self.lost = 0               # response bytes sent after the phone had gone
        self.timeout = None
        self.closed = False

    def _never_waits(self, what):
        assert self.timeout == 0, "%s on a socket without settimeout(0) can wait for ever on the board" % what
        if self.closed:
            raise OSError(errno.EBADF, "Bad file descriptor")

    def settimeout(self, value):
        self.timeout = value

    def recv_into(self, buffer, bufsize=0):
        self._never_waits("recv_into")
        world = self.world
        world.advance(world.net_cost_ns)
        if world.read_fail(world.t):
            raise OSError(errno.ECONNRESET, "Connection reset by peer")
        limit = bufsize if 0 < bufsize < len(buffer) else len(buffer)
        if world.recv_chunk:
            limit = min(limit, world.recv_chunk)
        piece = self.raw[self.taken:self.taken + limit]
        if not piece:
            raise OSError(errno.EAGAIN, "Resource temporarily unavailable")   # the browser is waiting for its answer
        buffer[:len(piece)] = piece
        self.taken += len(piece)
        return len(piece)

    def send(self, data):
        self._never_waits("send")
        world = self.world
        world.advance(world.write_cost_ns)
        if world.write_fail(world.t):
            raise OSError(errno.ECONNRESET, "Connection reset by peer")
        data = bytes(data)
        cut = world.response_cut
        if not world.connected(world.t) or (cut is not None and len(self.got) >= cut):
            # Nobody acknowledges any more. The board's buffer takes what it has
            # room for, then every send says "try again", for ever.
            room = SEND_BUFFER - self.lost
            if room <= 0:
                raise OSError(errno.EAGAIN, "Resource temporarily unavailable")
            self.lost += min(len(data), room)
            return min(len(data), room)
        take = min(len(data), world.send_chunk)
        if cut is not None:
            take = min(take, cut - len(self.got))
        self.got += data[:take]
        self.last = world.now
        return take

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.world.open_connections -= 1
        self.world.finish(self)


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
            return world.read(world.high_g, "adxl")

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
            return world.read(world.imu_accel, "imu")

        @property
        def gyro(self):
            return world.read(world.gyro, "imu")

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
                world.connected_since = world.t
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
            if world.t - world.connected_since < world.subscribe_delay:
                world.dropped_writes += 1               # nobody is subscribed yet
            else:
                world.writes.append((world.now, world.connection, bytes(data)))
            world.advance(world.write_cost_ns)

    nordic.UARTService = UARTService

    supervisor = types.ModuleType("supervisor")

    def reload():
        # On the board this restarts code.py from the top. Here it ends the scenario.
        world.reloads += 1
        raise SimEnd

    supervisor.reload = reload

    # Wi-Fi ---------------------------------------------------------------------
    wifi = types.ModuleType("wifi")

    class Address:
        def __init__(self, text):
            self.text = text

        def __str__(self):
            return self.text

    class Radio:
        def __init__(self):
            self.enabled = False        # as after a failed attempt to join the network in settings.toml
            self._ap = False

        def start_ap(self, ssid, password=b"", *, channel=1, authmode=(), max_connections=4):
            if not self.enabled:
                raise RuntimeError("the Wi-Fi radio is switched off")
            if world.ap_fail(world.t):
                raise RuntimeError("Unknown failure 12")
            if isinstance(password, str):
                password = password.encode()
            if password and not 8 <= len(password) <= 64:
                raise ValueError("password length must be 8-64")
            world.ap = {"ssid": ssid, "password": password, "at": world.t}
            world.ap_starts += 1
            self._ap = True

        @property
        def ap_active(self):
            return self._ap

        @property
        def ipv4_address_ap(self):
            return Address("192.168.4.1") if self._ap else None

        @property
        def ipv4_address(self):
            return Address(world.station_ip) if world.station_ip else None

    wifi.radio = Radio()

    socketpool = types.ModuleType("socketpool")

    class Listener:
        def __init__(self):
            self.timeout = None

        def bind(self, address):
            host, port = address
            assert host == "", "bind to every interface, so the page is served on any network the board is on"
            if world.listen_port is not None:
                raise OSError(errno.EADDRINUSE, "Address already in use")     # an earlier listener still holds it
            world.listen_port = port
            self.bound = True

        def listen(self, backlog):
            self.listening = True

        def settimeout(self, value):
            self.timeout = value

        def setsockopt(self, level, optname, value):
            pass

        def accept(self):
            assert self.timeout == 0, "accept on a socket without settimeout(0) waits for ever on the board"
            world.advance(world.net_cost_ns)
            if world.accept_error(world.t):
                raise RuntimeError("accept failed in a way nobody expected")
            world.deliver_http()
            if not world.backlog:
                raise OSError(errno.EAGAIN, "Resource temporarily unavailable")
            world.open_connections += 1
            world.most_open_connections = max(world.most_open_connections, world.open_connections)
            return world.backlog.pop(0), ("192.168.4.2", 51000)

        def close(self):
            if getattr(self, "bound", False):
                self.bound = False
                world.last_port, world.listen_port = world.listen_port, None

    class SocketPool:
        AF_INET, SOCK_STREAM, SOL_SOCKET, SO_REUSEADDR = 2, 1, 0xfff, 4

        def __init__(self, radio):
            assert radio is wifi.radio

        def socket(self, family=2, type=1):
            assert world.ap is not None, "the network must be up before a socket is made"
            return Listener()

    socketpool.SocketPool = SocketPool

    # USB serial ---------------------------------------------------------------
    usb_cdc = types.ModuleType("usb_cdc")
    USB_FIFO = 256      # bytes the board holds for a computer that is not reading

    class Serial:
        """The console serial port, as CircuitPython 10.3.2 offers it. By
        default its reads and writes wait for ever, as on the board."""

        def __init__(self):
            self.timeout = -1.0
            self.write_timeout = -1.0
            self.connected = True
            self._rx = bytearray()
            self._held = 0

        @property
        def in_waiting(self):
            if world.usb_error(world.t):
                raise RuntimeError("the USB stack failed in a way nobody expected")
            while world.usb and world.usb[0][0] <= world.t:
                self._rx.extend(world.usb.pop(0)[1])
            return len(self._rx)

        def read(self, size=-1):
            assert 0 < size <= len(self._rx), "read() of more than in_waiting waits for ever on the board"
            data = bytes(self._rx[:size])
            del self._rx[:size]
            return data

        def write(self, data):
            data = bytes(data)
            if world.usb_stall(world.t):
                assert self.write_timeout >= 0, "write() with no write_timeout waits for ever once the computer stops reading"
                taken = min(len(data), max(0, USB_FIFO - self._held))
                self._held += taken
                if taken < len(data):
                    world.advance(self.write_timeout * 1e9)     # it waits this long for room, then gives up
                else:
                    world.advance(world.write_cost_ns)
                return taken
            world.advance(world.write_cost_ns)
            world.usb_writes.append((world.now, data))
            return len(data)

    usb_cdc.console = Serial() if world.usb_console else None

    # settings.toml and the files on the drive. Only what the firmware may use.
    os_mod = types.ModuleType("os")

    def getenv(key, default=None):
        return world.settings.get(key, default)

    def stat(path):
        if path in world.files:
            return (0x8000, 0, 0, 0, 0, 0, len(world.files[path]), 0, 0, 0)
        if any(name.startswith(path.rstrip("/") + "/") for name in world.files):
            return (0x4000, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        raise OSError(errno.ENOENT, "No such file/directory")

    os_mod.getenv, os_mod.stat = getenv, stat

    return {
        "wifi": wifi,
        "usb_cdc": usb_cdc,
        "socketpool": socketpool,
        "os": os_mod,
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
            # open() is a builtin, so it is handed over as a global of the firmware's module.
            runpy.run_path(str(firmware_path), init_globals={"open": world.open_file}, run_name="__main__")
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
