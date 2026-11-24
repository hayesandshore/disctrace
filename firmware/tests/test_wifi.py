"""Behaviour of the Wi-Fi firmware as a browser sees it over HTTP, and over USB.

The tests shared with the Bluetooth firmwares (test_firmware.py and
test_hardening.py) already cover the commands, the capture and the sensor
faults: the simulator hands a Wi-Fi firmware each command as a POST to
/api/cmd. This file covers what only the Wi-Fi firmware does: its network,
the web server, the page files, a waiting line riding on the next STATUS, and
the same commands on the USB serial port as a backup for Wi-Fi.
"""
import re

from test_firmware import dump, hand_spin, lines_after, ready_fields, run

COMMANDS = "Commands: ARM STATUS DUMP CANCEL INFO BENCH"
UNSAVED = "UNSAVED capture not dumped. Send ARM again to discard."
PAGE = {
    "www/index.html": b"<!DOCTYPE html><title>DiscTrace bench</title>",
    "www/style.css": b"body { margin: 0 }",
    "www/js/app.js": b"// app\n" + b"x" * 5000,
}
# Not a real password: it only has to be long enough for WPA2.
WIFI_PASSWORD = "test-only-pass"
OWN_WEB_TOOL = {"CIRCUITPY_WIFI_SSID": "bench", "CIRCUITPY_WEB_API_PASSWORD": "test-only"}


def get(path, at=0.5):
    return (at, "GET", path, b"")


def throw(commands=(), end_s=16.0, **scenario):
    """A hand spin, then STATUS at 12.0 s, as the page would ask."""
    return hand_spin([(12.0, b"STATUS\n"), *commands], end_s, **scenario)


# The pod's own network --------------------------------------------------------------
def test_pod_starts_an_open_network_called_dgt_1():
    world = run(0.5)
    assert world.ap["ssid"] == "DGT-1" and world.ap["password"] == b""


def test_network_is_up_even_if_a_sensor_driver_hangs_at_power_up():
    world = run(5.0, sensor_start_hang=lambda t: ("imu",))
    assert world.ap is not None and world.listen_port is not None


def test_network_is_up_when_a_sensor_is_missing_at_power_up():
    for part in ("adxl", "imu", "bus"):
        world = run(1.0, sensor_start_fail=lambda t, part=part: (part,))
        assert world.ap is not None and world.listen_port is not None, part


def test_password_in_settings_protects_the_network():
    world = run(0.5, settings={"DGT_WIFI_PASSWORD": WIFI_PASSWORD})
    assert world.ap["password"] == WIFI_PASSWORD.encode()


def test_password_too_short_for_wifi_gives_an_open_network_and_says_so_on_usb():
    world = run(0.5, settings={"DGT_WIFI_PASSWORD": "short"})
    assert world.ap["password"] == b""
    assert "DGT_WIFI_PASSWORD" in world.console


def test_page_is_served_on_port_80():
    assert run(0.5).listen_port == 80


def test_port_8080_when_circuitpythons_own_web_tool_holds_port_80():
    assert run(0.5, settings=OWN_WEB_TOOL).listen_port == 8080            # its default is 80
    assert run(0.5, settings={**OWN_WEB_TOOL, "CIRCUITPY_WEB_API_PORT": 80}).listen_port == 8080


def test_port_80_when_circuitpythons_own_web_tool_is_on_another_port():
    assert run(0.5, settings={**OWN_WEB_TOOL, "CIRCUITPY_WEB_API_PORT": 8000}).listen_port == 80


def test_usb_console_gives_the_address_to_open():
    assert "http://192.168.4.1\n" in run(0.5).console + "\n"
    assert "http://192.168.4.1:8080" in run(0.5, settings=OWN_WEB_TOOL).console


def test_usb_console_also_gives_the_address_on_a_network_the_board_joined():
    console = run(0.5, settings=OWN_WEB_TOOL, station_ip="10.0.0.7").console
    assert "http://10.0.0.7:8080" in console


def test_an_unexpected_error_restarts_the_program_and_says_why_on_usb():
    world = run(20.0, usb_error=lambda t: 1.0 <= t < 1.1)
    assert world.reloads == 1
    assert "RuntimeError" in world.console


# Commands over HTTP -----------------------------------------------------------------
def test_reply_is_the_body_of_a_complete_plain_text_response():
    reply = run(1.0, [(0.5, b"STATUS\n")]).response("/api/cmd")
    assert reply["status"] == 200 and reply["body"] == b"IDLE\r\n"
    assert reply["headers"]["Content-Type"].startswith("text/plain")
    assert reply["headers"]["Connection"] == "close"
    assert reply["complete"]


def test_request_arriving_a_few_bytes_at_a_time_is_put_together():
    assert run(1.0, [(0.5, b"STATUS\n")], recv_chunk=7).lines == ["IDLE"]


def test_reply_taken_a_few_bytes_at_a_time_still_arrives_whole():
    world = run(1.0, [(0.5, b"STATUS\n")], send_chunk=5)
    assert world.lines == ["IDLE"] and world.response("/api/cmd")["complete"]


def test_command_without_a_line_ending_is_accepted():
    assert run(1.0, [(0.5, b"STATUS")]).lines == ["IDLE"]


def test_two_commands_in_one_request_are_both_answered():
    assert run(1.0, [(0.5, b"STATUS\nSTATUS\n")]).lines == ["IDLE", "IDLE"]


def test_hello_says_which_pod_and_firmware_this_is():
    reply = run(1.0, http=[get("/api/hello")]).response("/api/hello")
    assert reply["status"] == 200 and reply["body"].startswith(b"DGT-1 fw=2.1.0 ")


def test_get_to_the_command_address_is_refused():
    assert run(1.0, http=[get("/api/cmd")]).response("/api/cmd")["status"] == 405


def test_request_that_is_not_http_is_refused_and_the_pod_carries_on():
    world = run(2.0, [(1.0, b"STATUS\n")], http=[(0.5, "RAW", "", b"hello there\r\n\r\n")])
    assert world.exchanges[0]["status"] == 400
    assert world.lines == ["IDLE"]


def test_request_that_never_ends_is_refused_and_the_pod_carries_on():
    world = run(2.0, [(1.0, b"STATUS\n")], http=[(0.5, "RAW", "", b"GET / HTTP/1.1\r\n" + b"X: y\r\n" * 900)])
    assert world.exchanges[0]["status"] == 400
    assert world.lines == ["IDLE"]


def test_info_reports_version_and_capture_layout():
    assert run(1.0, [(0.5, b"INFO\n")]).lines == ["DGT-1 fw=2.1.0 target_hz=100 window_s=5 pre=30 cols=9"]


def test_unknown_command_lists_the_commands():
    assert run(1.0, [(0.5, b"HELLO\n")]).lines == ["State IDLE. " + COMMANDS]


def test_bench_counts_two_sensor_reads_for_one_second():
    # The simulator charges 0.8 ms per sensor read, so about 615 passes fit in a second.
    line = run(3.0, [(0.5, b"BENCH\n")]).lines[0]
    assert 570 <= int(re.fullmatch(r"BENCH reads_per_s=(\d+)", line).group(1)) <= 630


def test_bench_is_refused_while_armed():
    world = run(3.0, [(1.0, b"ARM\n"), (2.0, b"BENCH\n")])
    assert world.lines[1] == "State ARMED. " + COMMANDS


def test_bench_reports_a_sensor_fault():
    world = run(3.0, [(0.5, b"BENCH\n")], sensor_fail=lambda t: 0.8 <= t < 0.85)
    assert world.lines[0].startswith("SENSOR_ERROR ")


# The page files -------------------------------------------------------------------------
def test_root_address_serves_the_page():
    reply = run(1.0, http=[get("/")], files=PAGE).response("/")
    assert reply["status"] == 200 and reply["body"] == PAGE["www/index.html"]
    assert reply["headers"]["Content-Type"].startswith("text/html")


def test_scripts_are_served_whole_and_as_javascript():
    reply = run(1.0, http=[get("/js/app.js")], files=PAGE).response("/js/app.js")
    assert reply["headers"]["Content-Type"].startswith("text/javascript")   # a browser refuses a module otherwise
    assert reply["body"] == PAGE["www/js/app.js"] and reply["complete"]


def test_text_after_a_question_mark_is_ignored():
    reply = run(1.0, http=[get("/style.css?v=2")], files=PAGE).response("/style.css?v=2")
    assert reply["status"] == 200 and reply["body"] == PAGE["www/style.css"]


def test_files_outside_the_page_folder_are_not_served():
    files = {**PAGE, "settings.toml": b"SECRET", "www/../settings.toml": b"SECRET"}
    for path in ("/../settings.toml", "/js/../../settings.toml"):
        reply = run(1.0, http=[get(path)], files=files).response(path)
        assert reply["status"] == 404 and b"SECRET" not in reply["body"], path


def test_folder_is_not_served_as_a_file():
    assert run(1.0, http=[get("/js")], files=PAGE).response("/js")["status"] == 404


def test_missing_page_files_are_explained_in_the_browser_and_on_usb():
    world = run(1.0, http=[get("/")])
    reply = world.response("/")
    assert reply["status"] == 404 and b"www" in reply["body"]
    assert "www" in world.console


# A waiting line is the answer to the next STATUS ----------------------------------------------
def test_arm_timeout_is_the_answer_to_the_next_status_once():
    world = run(3607.0, [(1.0, b"ARM\n"), (3604.0, b"STATUS\n"), (3605.0, b"STATUS\n")], jumps=[(2.0, 3600.0)])
    assert lines_after(world, 3604.0) == ["IDLE armed timeout", "IDLE"]


def test_sensor_fault_reason_is_the_answer_to_the_next_status_once():
    world = run(5.0, [(1.0, b"ARM\n"), (3.0, b"STATUS\n"), (4.0, b"STATUS\n")], sensor_fail=lambda t: 1.5 <= t < 1.55)
    first, second = lines_after(world, 3.0)
    assert first.startswith("SENSOR_ERROR [Errno 5]") and second == "SENSOR_ERROR"


def test_unexpected_sensor_read_error_while_armed_is_reported():
    world = run(4.0, [(1.0, b"ARM\n"), (3.0, b"STATUS\n")],
                sensor_fail=lambda t: 1.5 <= t < 1.55, sensor_error=RuntimeError("short read"))
    assert lines_after(world, 3.0) == ["SENSOR_ERROR short read"]


def test_waiting_line_is_kept_until_a_status_reply_gets_through():
    world = run(3608.0, [(1.0, b"ARM\n"), (3604.0, b"STATUS\n"), (3606.0, b"STATUS\n")], jumps=[(2.0, 3600.0)],
                write_fail=lambda t: 3603.5 <= t < 3605.0)
    assert lines_after(world, 3606.0) == ["IDLE armed timeout"]


def test_ready_summary_is_the_status_answer_after_a_throw():
    assert lines_after(throw(), 12.0)[0].startswith("READY samples=")


def test_arm_with_a_waiting_line_arms_and_says_only_armed():
    world = run(4.0, [(1.0, b"ARM\n"), (3.0, b"ARM\n")], sensor_fail=lambda t: 1.5 <= t < 1.55)
    assert lines_after(world, 3.0) == ["ARMED"]


# Recording is never interrupted ---------------------------------------------------------------
def test_status_sent_during_the_recording_is_answered_when_it_ends():
    world = hand_spin([(3.0, b"STATUS\n")], end_s=9.0)
    (answered, line), = [(t, line) for t, line in world.timed_lines if t >= 3.0]
    assert line.startswith("READY samples=") and 7.0 <= answered <= 7.2    # five seconds after the trigger at 2.0


def test_sampling_stays_on_the_10_ms_grid_while_the_page_polls():
    polls = [(1.2 + 0.4 * n, b"STATUS\n") for n in range(15)]
    assert float(ready_fields(throw(polls))["max_gap_ms"]) <= 12.0


def test_sampling_stays_on_the_grid_while_the_page_is_loaded_with_the_pod_armed():
    # The capture keeps the 0.3 s before the trigger at 2.0 s, so a page load
    # starting at 1.75 s falls inside what is kept and any gap it made shows.
    files = {**PAGE, "www/js/app.js": b"y" * 50000}
    world = throw(http=[get("/", 1.75), get("/style.css", 1.75), get("/js/app.js", 1.75)], files=files)
    script = world.response("/js/app.js")
    assert script["complete"] and script["answered"] < 2.0     # sent whole while the pod was still sampling
    assert float(ready_fields(world)["max_gap_ms"]) <= 12.0


def test_summary_reports_peak_spin_in_rpm():
    assert ready_fields(throw())["peak_abs_rpm"] == "150.0"


def test_spin_at_the_gyro_limit_blanks_rpm_and_sets_the_flag():
    fast = lambda t: (0.0, 0.0, 34.0) if 2.0 <= t < 2.5 else (0.0, 0.0, 0.0)
    world = throw([(12.5, b"DUMP\n")], gyro=fast)
    _, rows, _ = dump(world)
    flagged = [row for row in rows if row[6] == "34.0000"]
    assert flagged and all(row[7] == "" and row[8] == "1" for row in flagged)
    assert ready_fields(world)["peak_abs_rpm"] == "NEAR_LIMIT"


def test_sensor_error_while_recording_keeps_the_partial_capture():
    world = hand_spin([(5.0, b"STATUS\n"), (5.5, b"DUMP\n")], sensor_fail=lambda t: 4.0 <= t < 4.05, end_s=8.0)
    fields = ready_fields(world)
    assert fields.get("partial") == "1" and 225 <= int(fields["samples"]) <= 240
    _, rows, ended = dump(world)
    assert ended and len(rows) == int(fields["samples"])


# Downloading ------------------------------------------------------------------------------------
def test_download_is_one_complete_response_with_every_row():
    world = throw([(12.5, b"DUMP\n")])
    _, rows, ended = dump(world)
    assert ended and len(rows) == int(ready_fields(world)["samples"])
    assert world.response("/api/cmd")["complete"]


def test_phone_that_vanishes_during_a_download_leaves_the_capture_unsaved():
    world = throw([(12.5, b"DUMP\n"), (19.0, b"ARM\n")], end_s=20.0, response_cut=2000)
    assert "END" not in world.lines
    assert lines_after(world, 19.0) == [UNSAVED]


def test_phone_that_vanishes_does_not_hold_up_the_next_request():
    world = throw([(12.5, b"DUMP\n"), (13.0, b"STATUS\n")], response_cut=2000)
    (answered, line), = [(t, line) for t, line in world.timed_lines if t >= 13.0]
    assert line.startswith("READY samples=") and answered < 13.2


# Browsers that open connections and say nothing ----------------------------------------------------
def test_silent_connection_does_not_hold_up_a_request():
    world = run(1.0, [(0.5, b"STATUS\n")], spare=[0.4])
    (answered, line), = world.timed_lines
    assert line == "IDLE" and answered < 0.6


def test_silent_connections_are_dropped_so_later_requests_get_in():
    world = run(8.0, [(0.5, b"STATUS\n")], spare=[0.4] * 6)
    assert world.lines == ["IDLE"]
    assert world.most_open_connections <= 4      # the board has few sockets; the web server takes at most four


# USB serial: the same commands, as a backup for Wi-Fi -----------------------------------------------
def usb_throw(commands=(), end_s=16.0, **scenario):
    """A hand spin armed over USB, with STATUS at 12.0 s. Nothing is sent over Wi-Fi."""
    scenario.setdefault("gyro", lambda t: (0.0, 0.0, 150 * 3.141592653589793 / 30) if 2.0 <= t < 2.5 else (0.0, 0.0, 0.0))
    return run(end_s, usb=[(1.0, b"ARM\n"), (12.0, b"STATUS\n"), *commands], **scenario)


def usb_after(world, seconds):
    return [line for t, line in world.usb_timed_lines if t >= seconds]


def usb_dump(world):
    """(rows, reached END) of the download in what the pod wrote on USB."""
    lines = world.usb_lines
    start = next(i for i, line in enumerate(lines) if line.startswith("t_ms,"))
    rows = []
    for line in lines[start + 1:]:
        if line == "END":
            return rows, True
        rows.append(line.split(","))
    return rows, False


def test_command_on_usb_is_answered_on_usb():
    world = run(1.0, usb=[(0.5, b"STATUS\n")])
    assert world.usb_lines == ["IDLE"]
    assert world.lines == []                    # nothing went out over Wi-Fi


def test_usb_command_typed_a_few_characters_at_a_time_is_put_together():
    assert run(1.5, usb=[(0.5, b"sta"), (0.8, b"tus\r")]).usb_lines == ["IDLE"]


def test_overlong_usb_line_is_dropped_without_a_reply():
    world = run(2.0, usb=[(0.5, b"X" * 40 + b"\n"), (1.0, b"STATUS\n")])
    assert world.usb_lines == ["IDLE"]


def test_a_throw_can_be_armed_and_downloaded_over_usb_alone():
    world = usb_throw([(12.5, b"DUMP\n"), (14.5, b"ARM\n")])
    ready = next(line for line in world.usb_lines if line.startswith("READY "))
    rows, ended = usb_dump(world)
    assert ended and len(rows) == int(dict(part.split("=") for part in ready.split()[1:])["samples"])
    assert usb_after(world, 14.5) == ["ARMED"]      # the download counted, so no warning


def test_usb_and_wifi_talk_to_the_same_pod():
    world = run(3.0, [(1.0, b"ARM\n")], usb=[(2.0, b"STATUS\n")])
    assert world.lines == ["ARMED"] and world.usb_lines == ["ARMED"]


def test_waiting_line_is_the_answer_to_the_next_status_on_usb_too():
    world = run(3607.0, usb=[(1.0, b"ARM\n"), (3604.0, b"STATUS\n"), (3605.0, b"STATUS\n")], jumps=[(2.0, 3600.0)])
    assert usb_after(world, 3604.0) == ["IDLE armed timeout", "IDLE"]


def test_usb_command_sent_during_the_recording_is_answered_when_it_ends():
    world = usb_throw([(3.0, b"STATUS\n")], end_s=9.0)
    (answered, line), = [(t, line) for t, line in world.usb_timed_lines if 3.0 <= t < 9.0]
    assert line.startswith("READY samples=") and 7.0 <= answered <= 7.2


def test_sampling_stays_on_the_10_ms_grid_while_usb_polls():
    world = usb_throw([(1.2 + 0.4 * n, b"STATUS\n") for n in range(15)])
    ready = next(line for line in usb_after(world, 12.0) if line.startswith("READY "))
    assert float(dict(part.split("=") for part in ready.split()[1:])["max_gap_ms"]) <= 12.0


def test_computer_that_stops_reading_during_a_usb_download_leaves_the_capture_unsaved():
    # The serial program is closed part-way through the download, then opened again.
    world = usb_throw([(12.5, b"DUMP\n"), (19.0, b"ARM\n")], end_s=20.0, usb_stall=lambda t: 12.5 <= t < 18.0)
    assert "END" not in world.usb_lines
    assert usb_after(world, 19.0) == ["UNSAVED capture not dumped. Send ARM again to discard."]


def test_pod_runs_without_a_usb_console():
    assert run(1.0, [(0.5, b"STATUS\n")], usb_console=False).lines == ["IDLE"]


# Wi-Fi failing must not take the pod down --------------------------------------------------------------
def test_usb_works_when_wifi_does_not_start():
    world = run(2.0, usb=[(1.0, b"STATUS\n")], ap_fail=lambda t: True)
    assert world.usb_lines == ["IDLE"]
    assert world.reloads == 0
    assert "Unknown failure 12" in world.console and "USB" in world.console


def test_wifi_that_did_not_start_is_tried_again_and_its_failure_is_printed_once():
    world = run(75.0, [(70.0, b"STATUS\n")], ap_fail=lambda t: t < 40.0)
    assert world.lines == ["IDLE"]              # the network came up on a later try
    assert world.console.count("Unknown failure 12") == 1
    assert "http://192.168.4.1" in world.console


def test_wifi_fault_while_running_leaves_usb_working_and_wifi_comes_back():
    world = run(45.0, [(40.0, b"STATUS\n")], usb=[(2.0, b"STATUS\n")], accept_error=lambda t: 1.0 <= t < 1.1)
    assert world.reloads == 0
    assert world.usb_lines == ["IDLE"]
    assert world.lines == ["IDLE"]
    assert "accept failed" in world.console


def test_wifi_fault_keeps_a_throw_that_has_not_been_downloaded():
    world = usb_throw([(13.0, b"STATUS\n")], accept_error=lambda t: 12.2 <= t < 12.3)
    assert usb_after(world, 13.0)[0].startswith("READY samples=")
