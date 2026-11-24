"""DGT-1 Prototype 1, firmware 2.1.0: Wi-Fi, with USB as a backup.

Copy code.py and the www folder to CIRCUITPY. Wiring and libraries are as
before; the Bluetooth library is no longer used.

The pod makes its own Wi-Fi network, DGT-1, and serves the DiscTrace page on
it. Join that network on a phone or computer and open http://192.168.4.1 in
any browser. The address is printed on USB at power-up.

Same trigger, capture and CSV as 1.0.2: nine columns, five seconds past the
trigger. The commands are the same text lines. Each is sent as the body of an
HTTP POST to /api/cmd, and the reply lines come back as the response.
- INFO and BENCH are answered, as in 1.1.
- Nothing is sent without being asked. A line that Bluetooth firmware pushed
  (READY ..., IDLE armed timeout, SENSOR_ERROR with a reason) is the answer to
  the next STATUS instead.
- While recording, the pod does nothing but sample. A request sent then is
  answered when the recording ends.
- The network starts before the sensors, so a sensor fault can be read on the
  page.
- Anything unexpected is printed on USB and the program restarts.

New in 2.1: USB as a backup for Wi-Fi.
- The same commands, one per line, are also taken on the USB serial port and
  answered there. Use the website's "Connect over USB" button (Chrome or Edge
  on a computer), or type them in any serial terminal.
- If Wi-Fi does not start, or fails later, the pod no longer restarts. It
  carries on over USB, keeps a throw that has not been downloaded, and tries
  Wi-Fi again every 30 seconds.

Optional, in settings.toml:
- DGT_WIFI_PASSWORD = "..."  8 to 63 characters. Without it the network is open.
If settings.toml also sets up CircuitPython's own web tool on port 80
(CIRCUITPY_WIFI_SSID with CIRCUITPY_WEB_API_PASSWORD), the page is on port
8080 instead: http://192.168.4.1:8080
"""
import gc
import math
import os
import struct
import time
from errno import EAGAIN

import board
import socketpool
import usb_cdc
import wifi
from adafruit_adxl37x import ADXL375
from adafruit_lsm6ds import GyroRange, Rate
from adafruit_lsm6ds.lsm6ds3trc import LSM6DS3TRC

VERSION = "2.1.0"
G = 9.80665
PERIOD_NS = 10_000_000  # Target 100 samples/s.
PRE = 30                 # Up to 0.30 s of history.
WINDOW_NS = 5_000_000_000  # Recording time after the trigger.
ARM_TIMEOUT_NS = 3_600_000_000_000  # Keep elapsed microseconds within uint32.
TRIGGER_G = 3.0
TRIGGER_G_SQ = TRIGGER_G * TRIGGER_G
TRIGGER_RPM = 90.0
WARN_RAD_S = math.radians(1900)
RPM_PER_RAD_S = 30 / math.pi
FORMAT = "<Iffffff"  # time in us, acceleration in g, gyro in rad/s
ROW = struct.calcsize(FORMAT)
CAPACITY = PRE + WINDOW_NS // PERIOD_NS + 2
HEADER = "t_ms,ax_g,ay_g,az_g,gx_rad_s,gy_rad_s,gz_rad_s,z_rpm,z_near_limit"
COLUMNS = 9
COMMANDS = "ARM STATUS DUMP CANCEL INFO BENCH"

SSID = "DGT-1"
WEB_ROOT = "www"            # The page files, in a folder next to this file.
MAX_CLIENTS = 4             # Browser connections open at once. The board has about eight sockets.
REQUEST_LIMIT = 4096        # Bytes. A browser's request is well under 1 kB.
BODY_LIMIT = 256            # Bytes. A command is a few characters.
CHUNK = 1024                # Bytes of a file sent in one step.
SILENT_NS = 5_000_000_000   # A connection that gets nowhere for this long is closed.
LOOK_NS = 20_000_000        # While armed with no browser connected, look for one this often.
RETRY_NS = 30_000_000_000   # While Wi-Fi is down, try to start it again this often.
USB_WRITE_S = 2             # A computer that takes no USB data for this long has stopped reading.
TEXT = "text/plain; charset=utf-8"
TYPES = {
    "html": "text/html; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "js": "text/javascript; charset=utf-8",  # A browser refuses a module with any other type.
    "json": "application/json",
    "svg": "image/svg+xml",
    "png": "image/png",
    "ico": "image/x-icon",
    "txt": TEXT,
}


class Capture:
    def __init__(self):
        self.data = bytearray(ROW * CAPACITY)
        self.state = "IDLE"
        self.count = 0
        self.partial = False  # Recording was cut short by a sensor error.
        self.dumped = False   # A DUMP of this capture reached the browser's connection whole.
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


def parse_request(data):
    """(method, path, body) once a whole HTTP request has arrived, else None.
    Raises ValueError for anything a browser would not send."""
    end = data.find(b"\r\n\r\n")
    if end < 0:
        if len(data) > REQUEST_LIMIT:
            raise ValueError("request too long")
        return None
    lines = data[:end].split(b"\r\n")
    parts = lines[0].split(b" ")
    if len(parts) != 3 or not parts[2].startswith(b"HTTP/"):
        raise ValueError("not HTTP")
    length = 0
    for line in lines[1:]:
        if line[:15].lower() == b"content-length:":
            length = int(str(line[15:], "utf-8"))
    if not 0 <= length <= BODY_LIMIT:
        raise ValueError("body too long")
    body = data[end + 4:]
    if len(body) < length:
        return None
    return parts[0], str(parts[1], "utf-8"), body[:length]


def page_file(path):
    """The response for one file of the page: (status, type, body, file, size, done)."""
    if path == "/":
        path = "/index.html"
    name = WEB_ROOT + path
    try:
        if ".." in path or not path.startswith("/"):
            raise OSError  # Only what is inside the page folder is served.
        info = os.stat(name)
        if info[0] & 0x4000:
            raise OSError  # A folder.
        source = open(name, "rb")
    except OSError:
        message = "Not found."
        if path == "/index.html":
            message = "The page files are not on the pod. Copy the www folder next to code.py on CIRCUITPY."
        return "404 Not Found", TEXT, (message + "\r\n").encode(), None, 0, None
    kind = TYPES.get(name[name.rfind(".") + 1:], "application/octet-stream")
    return "200 OK", kind, b"", source, info[6], None


class Client:
    """One browser connection: a request coming in, then its response going out."""

    def __init__(self, sock, now):
        self.sock = sock
        self.active = now  # When it last got anywhere.
        self.inbox = b""   # The request so far.
        self.out = None    # The rest of the piece being sent. None until there is a response.
        self.file = None   # An open file the following pieces come from.
        self.done = None   # Called once the whole response has been handed to the radio.


class Server:
    """A small web server that never waits. Every socket is non-blocking, so
    a slow or silent browser cannot hold up the sampling loop or another
    browser. Each connection carries one request and is then closed."""

    def __init__(self, pool, port, respond):
        self.respond = respond
        self.clients = []
        self.scratch = bytearray(512)
        self.listener = pool.socket(pool.AF_INET, pool.SOCK_STREAM)
        self.listener.bind(("", port))  # Every network the board is on.
        self.listener.listen(MAX_CLIENTS)
        self.listener.settimeout(0)

    def poll(self, everyone):
        """One pass. Returns True if anything moved. With everyone, each
        connection takes a step. Without, the pass ends at the first step
        that got somewhere, so that a sample is never kept waiting."""
        now = time.monotonic_ns()
        moved = self.accept(now)
        for client in tuple(self.clients):
            if self.step(client, now):
                moved = True
                if not everyone:
                    if client in self.clients:  # The others go first next time.
                        self.clients.remove(client)
                        self.clients.append(client)
                    break
        return moved

    def accept(self, now):
        if len(self.clients) >= MAX_CLIENTS:
            return False
        try:
            sock, _ = self.listener.accept()
        except OSError as error:
            if error.errno != EAGAIN:
                raise
            return False  # Nobody is waiting.
        sock.settimeout(0)
        self.clients.append(Client(sock, now))
        return True

    def step(self, client, now):
        """Moves one connection forward without waiting. True if it moved."""
        try:
            moved = self.read(client) if client.out is None else self.write(client)
        except OSError as error:
            if error.errno != EAGAIN:
                self.drop(client)  # The browser has gone.
                return True
            moved = False  # Nothing has arrived yet, or the radio's buffer is full.
        if moved:
            client.active = now
        elif now - client.active > SILENT_NS:
            self.drop(client)
        return moved

    def read(self, client):
        count = client.sock.recv_into(self.scratch, len(self.scratch))
        if not count:
            self.drop(client)  # Closed by the browser.
            return True
        client.inbox += bytes(self.scratch[:count])
        try:
            request = parse_request(client.inbox)
        except ValueError:
            self.reply(client, "400 Bad Request", TEXT, b"Not a request this pod understands.\r\n")
            return True
        if request is not None:
            # The whole request has been read, so closing after the response
            # cannot cut the connection short and lose the response.
            self.reply(client, *self.respond(*request))
        return True

    def reply(self, client, status, kind, body, source=None, size=0, done=None):
        head = ("HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
                "Cache-Control: no-store\r\nConnection: close\r\n\r\n") % (
                    status, kind, len(body) if source is None else size)
        client.out = memoryview(head.encode() + body)
        client.file = source
        client.done = done

    def write(self, client):
        if len(client.out) == 0 and client.file is not None:
            piece = client.file.read(CHUNK)
            if piece:
                client.out = memoryview(piece)
            else:
                client.file.close()
                client.file = None
        if len(client.out):
            sent = client.sock.send(client.out)  # Takes what the radio's buffer has room for.
            client.out = client.out[sent:]
            if len(client.out) or client.file is not None:
                return sent > 0
        # Everything has been handed to the radio. Closing sends what is queued.
        done = client.done
        self.drop(client)
        if done:
            done()
        return True

    def drop(self, client):
        if client in self.clients:
            self.clients.remove(client)
        try:
            if client.file is not None:
                client.file.close()
            client.sock.close()
        except OSError:
            pass

    def close(self):
        """Lets go of every socket, so that a new server can take the port."""
        for client in tuple(self.clients):
            self.drop(client)
        try:
            self.listener.close()
        except OSError:
            pass


def web_port():
    """Port 80, unless CircuitPython's own web tool is set up in settings.toml
    and has it. That tool listens whenever the board manages to join the
    Wi-Fi named there, so the page moves to 8080 for good, not only then."""
    if os.getenv("CIRCUITPY_WIFI_SSID") and os.getenv("CIRCUITPY_WEB_API_PASSWORD"):
        if str(os.getenv("CIRCUITPY_WEB_API_PORT") or 80) == "80":
            return 8080
    return 80


def start_network():
    """Starts the pod's own Wi-Fi network. Returns the socket pool."""
    wifi.radio.enabled = True  # Off if the board tried and failed to join the Wi-Fi in settings.toml.
    password = str(os.getenv("DGT_WIFI_PASSWORD") or "")
    if password and not 8 <= len(password) <= 63:
        print("DGT_WIFI_PASSWORD must be 8 to 63 characters. Starting the network without a password.")
        password = ""
    wifi.radio.start_ap(SSID, password)
    for _ in range(60):
        if wifi.radio.ap_active:
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("The Wi-Fi network did not start.")
    print("Wi-Fi network %s is up, %s." % (SSID, "with a password" if password else "with no password"))
    return socketpool.SocketPool(wifi.radio)


def explain(error):
    """Prints an error nobody expected, with where it came from if possible."""
    try:
        import traceback
        traceback.print_exception(error)
    except Exception:
        print(repr(error))


def run():
    print("DGT-1 firmware " + VERSION)
    port = web_port()
    capture = Capture()
    high_g = imu = None  # Both stay None until both sensors have started.
    fault = None         # Why they have not started, as text for SENSOR_ERROR.
    due = 0
    look = 0             # When to look for a waiting browser next, while armed.
    notice = None        # A line the pod has to say. It is the answer to the next STATUS.
    suspect = False      # A sensor read failed, so the sensors' settings cannot be trusted.
    server = None        # The web server. None while Wi-Fi is down.
    page = None          # The page's address, once Wi-Fi is up.
    retry = 0            # When to try Wi-Fi again, while it is down.
    wifi_error = None    # Last Wi-Fi failure printed, so that it is printed once.
    usb = usb_cdc.console  # The USB serial port. None if it was switched off in boot.py.
    command = bytearray()  # The line arriving on USB.
    discard = False        # That line is too long to be a command.
    if usb is not None:
        usb.write_timeout = USB_WRITE_S  # The default is to wait for ever.

    def start_sensors():
        """Start both sensors. Returns True when they are ready. Otherwise
        fault names each part that did not start, and why."""
        nonlocal high_g, imu, fault, suspect
        high_g = imu = None
        print("Starting sensors.")  # If this is the last line on USB, a driver hung.
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
        suspect = False
        return True

    def dispatch(cmd, out, after):
        """Handles one command. The reply lines go on out. Anything to do once
        the reply has reached the browser's connection goes on after."""
        nonlocal notice, suspect
        if cmd == b"ARM" and capture.state != "RECORDING":
            if capture.state == "READY" and not (capture.dumped or capture.confirm):
                capture.confirm = True
                out.append("UNSAVED capture not dumped. Send ARM again to discard.")
                return
            # After any sensor fault the sensors are started again. One that lost
            # power comes back switched off and would read zeros for ever.
            if (high_g is None or suspect) and not start_sensors():
                # Still no sensors. Say why, then refuse in the usual words.
                capture.state = "SENSOR_ERROR"
                notice = None  # The reason is in this reply.
                out.append("SENSOR_ERROR " + fault)
                out.append("State SENSOR_ERROR. Commands: " + COMMANDS)
                return
            notice = None
            gc.collect()
            capture.arm(time.monotonic_ns())
            out.append("ARMED")
        elif cmd == b"CANCEL" and capture.state == "ARMED":
            capture.state = "IDLE"
            out.append("IDLE")
        elif cmd == b"STATUS":
            if notice is not None:
                # The waiting line starts with the state, so it is the answer.
                # It stops waiting once this reply has got through.
                told = notice

                def heard():
                    nonlocal notice
                    if notice is told:
                        notice = None

                after.append(heard)
                out.append(told)
            elif capture.state == "READY":
                out.append(capture.summary())
            elif high_g is None:
                out.append("SENSOR_ERROR " + fault)  # Names the part that did not start.
            else:
                out.append(capture.state)
        elif cmd == b"DUMP" and capture.state == "READY":
            out.append(HEADER)
            for t, ax, ay, az, gx, gy, gz in capture.rows():
                flag = abs(gz) >= WARN_RAD_S
                rpm = "" if flag else "%.2f" % (gz*RPM_PER_RAD_S)
                out.append("%.3f,%.3f,%.3f,%.3f,%.4f,%.4f,%.4f,%s,%d" %
                           ((t-capture.trigger_us)/1000, ax, ay, az, gx, gy, gz, rpm, flag))
            out.append("END")
            sent = capture.start

            def downloaded():
                # Only if the capture that was sent is still the one held.
                if capture.state == "READY" and capture.start == sent:
                    capture.dumped = True

            after.append(downloaded)
        elif cmd == b"INFO":
            out.append(info())
        elif cmd == b"BENCH" and capture.state not in ("ARMED", "RECORDING"):
            # How many full two-sensor reads fit in one second, with nothing
            # else running. Shows how far the sample rate could be raised.
            if high_g is None:
                out.append("SENSOR_ERROR " + fault)
                return
            reads = 0
            stop = time.monotonic_ns() + 1000000000
            try:
                while time.monotonic_ns() < stop:
                    high_g.acceleration
                    imu.gyro
                    reads += 1
                out.append("BENCH reads_per_s=%d" % reads)
            except Exception as error:  # An I2C error, or anything else a driver raises.
                suspect = True
                out.append("SENSOR_ERROR %s" % error)
        else:
            out.append("State " + capture.state + ". Commands: " + COMMANDS)

    def info():
        return "DGT-1 fw=%s target_hz=%d window_s=%d pre=%d cols=%d" % (
            VERSION, 1000000000 // PERIOD_NS, WINDOW_NS // 1000000000, PRE, COLUMNS)

    def respond(method, path, body):
        """What to send back for one request: (status, type, body, file, size, done)."""
        path = path.split("?")[0]
        if path == "/api/cmd":
            if method != b"POST":
                return "405 Method Not Allowed", TEXT, b"Send commands with POST.\r\n", None, 0, None
            out = []
            after = []
            for raw in body.replace(b"\r", b"\n").split(b"\n"):
                cmd = raw.strip().upper()
                if cmd and len(raw) <= 32:  # A longer line is dropped without a reply.
                    dispatch(cmd, out, after)

            def done():
                for act in after:
                    act()

            return "200 OK", TEXT, "".join([line + "\r\n" for line in out]).encode(), None, 0, done
        if method != b"GET":
            return "405 Method Not Allowed", TEXT, b"Only GET here.\r\n", None, 0, None
        if path == "/api/hello":
            return "200 OK", TEXT, (info() + "\r\n").encode(), None, 0, None
        return page_file(path)

    def address(ip):
        return "http://%s%s" % (ip, "" if port == 80 else ":%d" % port)

    def start_wifi(now):
        """Brings up the pod's network and its web server. If that fails, the
        reason is printed once, the pod carries on over USB, and this is tried
        again later."""
        nonlocal server, page, retry, wifi_error
        try:
            server = Server(start_network(), port, respond)
        except Exception as error:  # Whatever the radio raises. USB does not depend on it.
            if str(error) != wifi_error:
                wifi_error = str(error)
                print("Wi-Fi did not start: %s" % wifi_error)
                print("USB still works. Trying Wi-Fi again every %d seconds." % (RETRY_NS // 1000000000))
            retry = now + RETRY_NS
            return
        wifi_error = None
        page = address(wifi.radio.ipv4_address_ap)
        print("Page: " + page)
        if wifi.radio.ipv4_address:
            print("Also on the Wi-Fi this board joined: " + address(wifi.radio.ipv4_address))

    def stop_wifi(error, now):
        """The web server failed in a way nobody expected. Restarting the
        program would erase a throw that has not been downloaded, so only the
        server is given up; USB carries on, and Wi-Fi is tried again later."""
        nonlocal server, retry
        print("Wi-Fi stopped on an unexpected error:")
        explain(error)
        print("USB still works. Trying Wi-Fi again in %d seconds." % (RETRY_NS // 1000000000))
        server.close()
        server = None
        retry = now + RETRY_NS

    def serve_usb():
        """Takes commands arriving on the USB serial port, one per line, and
        answers them there. Never waits: it reads only what has arrived."""
        nonlocal command, discard
        if usb is None:
            return
        waiting = usb.in_waiting
        if not waiting:
            return
        for char in usb.read(min(64, waiting)):
            if char in (10, 13):
                if command and not discard:
                    out = []
                    after = []
                    dispatch(bytes(command).strip().upper(), out, after)
                    for line in out:
                        data = (line + "\r\n").encode()
                        if usb.write(data) != len(data):
                            break  # The computer has stopped reading. Nothing counts as delivered.
                    else:
                        for act in after:
                            act()
                command = bytearray()
                discard = False
            elif len(command) < 32:
                command.append(char)
            else:
                discard = True

    # The network before the sensors, so the pod can be reached even if a
    # sensor driver never returns. A sensor fault is then reported on the page.
    start_wifi(time.monotonic_ns())
    try:
        os.stat(WEB_ROOT + "/index.html")
    except OSError:
        print("The page files are missing. Copy the www folder next to code.py on CIRCUITPY.")
    if start_sensors():
        if server is None:
            print("DGT-1 ready. Wi-Fi is down: connect over USB.")
        else:
            print("DGT-1 ready. Join the Wi-Fi network %s and open %s" % (SSID, page))
    else:
        capture.state = "SENSOR_ERROR"
        notice = "SENSOR_ERROR " + fault
        print("DGT-1 " + notice)
        print("STATUS reports this fault; ARM tries the sensors again.")
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
                    suspect = True
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
        # Keep network and USB traffic and formatting out of the recording
        # loop. A request sent now waits and is answered afterwards.
        if capture.state == "RECORDING":
            time.sleep(0.001)
            continue
        armed = capture.state == "ARMED"
        looking = now >= look
        if looking:
            look = now + LOOK_NS
        if looking or not armed:
            serve_usb()
        try:
            if server is None:
                if not armed and now >= retry:
                    start_wifi(now)
            elif armed:
                # Between samples: one small step that never waits.
                if server.clients or looking:
                    server.poll(False)
            else:
                # Not sampling: serve for as long as anything moves.
                while server.poll(True) and capture.state != "ARMED":
                    pass
        except Exception as error:
            stop_wifi(error, now)
        time.sleep(0.001 if capture.state == "ARMED" else 0.01)


try:
    run()
except Exception as error:
    # Nothing above expected this. Say what it was on USB, then start again:
    # a pod sealed inside a disc cannot be reset by hand.
    print("DGT-1 stopped on an unexpected error. Restarting in 5 seconds.")
    explain(error)
    time.sleep(5)
    import supervisor
    supervisor.reload()
