"""Behaviour of the DGT-1 firmware as the phone sees it over Bluetooth.

Every test runs the real firmware file in the simulator (sim.py) and checks the
text the phone would receive. Set DGT1_FIRMWARE to test a different code.py.
"""
import math
import os
import re
from pathlib import Path

import sim
from sim import G, STILL, World

FIRMWARE = Path(os.environ.get(
    "DGT1_FIRMWARE", Path(__file__).resolve().parent.parent / "firmware" / "code.py"))

HEADER = ("t_ms,ax_g,ay_g,az_g,gx_rad_s,gy_rad_s,gz_rad_s,z_rpm,z_near_limit,"
          "imu_ax_g,imu_ay_g,imu_az_g")
UNSAVED = "UNSAVED capture not dumped. Send ARM again to discard."
COMMANDS = "Commands: ARM STATUS DUMP CANCEL INFO BENCH"


# Helpers ---------------------------------------------------------------------
def spin(rpm, start, stop):
    rate = rpm * math.pi / 30
    return lambda t: (0.0, 0.0, rate) if start <= t < stop else STILL


def run(end_s, commands=(), **scenario):
    return sim.run(FIRMWARE, World(end_s, commands, **scenario))


def hand_spin(commands=(), end_s=16.0, **scenario):
    """Power on, ARM at 1.0 s, spin at 150 RPM from 2.0 to 2.5 s, then lie still.
    With a ten-second window the capture is READY just after 12.0 s."""
    scenario.setdefault("gyro", spin(150, 2.0, 2.5))
    return run(end_s, [(1.0, b"ARM\n"), *commands], **scenario)


def lines_after(world, seconds):
    return [line for t, line in world.timed_lines if t >= seconds]


def ready_fields(world):
    line = next(line for line in world.lines if line.startswith("READY "))
    return dict(part.split("=", 1) for part in line.split()[1:])


def dump(world, which=0):
    """(header, rows as lists of strings, reached END) for the which-th DUMP."""
    lines = world.lines
    start = [i for i, line in enumerate(lines) if line.startswith("t_ms,")][which]
    rows = []
    for line in lines[start + 1:]:
        if line == "END":
            return lines[start], rows, True
        if not re.match(r"-?\d", line):
            break
        rows.append(line.split(","))
    return lines[start], rows, False


# Connecting and arming ---------------------------------------------------------
def test_fresh_boot_reports_idle():
    assert run(1.0, [(0.5, b"STATUS\n")]).lines == ["IDLE"]


def test_startup_prints_ready_on_the_usb_console():
    assert "DGT-1 ready." in run(0.5).console


def test_pod_advertises_while_nobody_is_connected():
    assert run(1.0, connected=lambda t: False).advertise_calls >= 1


def test_arm_replies_armed():
    assert run(2.0, [(1.0, b"ARM\n")]).lines == ["ARMED"]


def test_status_while_waiting_for_motion_is_armed():
    assert run(3.0, [(1.0, b"ARM\n"), (2.0, b"STATUS\n")]).lines == ["ARMED", "ARMED"]


def test_cancel_returns_an_armed_pod_to_idle():
    world = run(3.0, [(1.0, b"ARM\n"), (2.0, b"CANCEL\n"), (2.5, b"STATUS\n")])
    assert world.lines == ["ARMED", "IDLE", "IDLE"]


def test_unused_arm_expires_after_an_hour():
    world = run(3606.0, [(1.0, b"ARM\n"), (3604.0, b"STATUS\n")], jumps=[(2.0, 3600.0)])
    assert lines_after(world, 3604.0) == ["IDLE"]


def test_arm_timeout_is_pushed_without_being_asked():
    world = run(3606.0, [(1.0, b"ARM\n")], jumps=[(2.0, 3600.0)])
    assert "IDLE armed timeout" in world.lines


# Command parsing ---------------------------------------------------------------
def test_commands_ignore_case_spaces_and_line_ending_style():
    world = run(2.0, [(0.5, b"status\r"), (0.8, b"Status\r\n"), (1.1, b" STATUS \n")])
    assert world.lines == ["IDLE", "IDLE", "IDLE"]


def test_command_split_across_two_writes_is_reassembled():
    assert run(1.5, [(0.5, b"STA"), (0.8, b"TUS\n")]).lines == ["IDLE"]


def test_overlong_line_is_dropped_without_a_reply():
    world = run(2.0, [(0.5, b"X" * 40 + b"\n"), (1.0, b"STATUS\n")])
    assert world.lines == ["IDLE"]


def test_unknown_command_lists_the_commands():
    assert run(1.0, [(0.5, b"HELLO\n")]).lines == ["State IDLE. " + COMMANDS]


def test_dump_without_a_capture_is_refused():
    assert run(1.0, [(0.5, b"DUMP\n")]).lines == ["State IDLE. " + COMMANDS]


def test_no_bluetooth_write_exceeds_20_bytes():
    world = hand_spin([(12.5, b"DUMP\n")])
    assert max(len(data) for _, _, data in world.writes) <= 20
    assert any(len(line) > 20 for line in world.lines)


# Sensor setup ------------------------------------------------------------------
def test_gyro_range_is_2000_dps():
    assert run(0.5).imu_config["gyro_range"] == 3


def test_imu_accelerometer_range_is_16_g():
    assert run(0.5).imu_config["accelerometer_range"] == 1


# Triggering --------------------------------------------------------------------
def test_spin_over_90_rpm_triggers_a_capture():
    world = hand_spin([(12.5, b"STATUS\n")])
    assert lines_after(world, 12.5)[0].startswith("READY samples=")


def test_acceleration_over_3_g_triggers_a_capture():
    jolt = lambda t: (0.0, 0.0, 4 * G) if 2.0 <= t < 2.05 else (0.0, 0.0, G)
    world = hand_spin([(12.5, b"STATUS\n")], gyro=lambda t: STILL, high_g=jolt)
    assert ready_fields(world)["peak_g"] == "4.00"


def test_imu_accelerometer_alone_does_not_trigger():
    world = run(4.0, [(1.0, b"ARM\n"), (3.0, b"STATUS\n")],
                imu_accel=lambda t: (5 * G, 0.0, G))
    assert world.lines == ["ARMED", "ARMED"]


# What a capture contains ---------------------------------------------------------
def test_recording_runs_ten_seconds_past_the_trigger():
    _, rows, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    assert 9990 <= float(rows[-1][0]) <= 10020


def test_capture_keeps_300_ms_before_the_trigger():
    _, rows, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    times = [float(row[0]) for row in rows]
    assert -305 <= times[0] <= -290
    assert 0.0 in times


def test_dump_header_lists_twelve_columns():
    header, _, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    assert header == HEADER


def test_every_row_has_twelve_fields():
    _, rows, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    assert {len(row) for row in rows} == {12}


def test_dump_row_count_matches_the_summary_and_ends_with_END():
    world = hand_spin([(12.5, b"DUMP\n")])
    _, rows, ended = dump(world)
    assert ended
    assert len(rows) == int(ready_fields(world)["samples"])


def test_first_nine_columns_keep_the_original_format():
    _, rows, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    assert re.fullmatch(r"-\d+\.\d{3}", rows[0][0])
    assert rows[0][1:9] == ["0.000", "0.000", "1.000", "0.0000", "0.0000", "0.0000", "0.00", "0"]


def test_spin_columns_show_rad_per_s_and_rpm():
    _, rows, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    trigger = next(row for row in rows if float(row[0]) == 0.0)
    assert trigger[6:9] == ["15.7080", "150.00", "0"]


def test_imu_accelerometer_fills_the_last_three_columns():
    world = hand_spin([(12.5, b"DUMP\n")], imu_accel=lambda t: (1.5 * G, -2.5 * G, 0.5 * G))
    _, rows, _ = dump(world)
    assert rows[0][9:] == ["1.500", "-2.500", "0.500"]
    assert rows[0][1:4] == ["0.000", "0.000", "1.000"]


def test_dump_can_be_repeated():
    world = hand_spin([(12.5, b"DUMP\n"), (14.5, b"DUMP\n")], end_s=18.0)
    first, second = dump(world, 0), dump(world, 1)
    assert first == second and first[2]


# The READY summary ---------------------------------------------------------------
def test_summary_keeps_the_original_fields_in_order():
    line = lines_after(hand_spin([(12.5, b"STATUS\n")]), 12.5)[0]
    assert re.match(r"READY samples=\d+ peak_g=\d+\.\d\d peak_abs_rpm=\d+\.\d "
                    r"max_gap_ms=\d+\.\d( |$)", line)


def test_summary_reports_peak_spin_in_rpm():
    assert ready_fields(hand_spin())["peak_abs_rpm"] == "150.0"


def test_summary_reports_the_achieved_sample_rate():
    assert 99.0 <= float(ready_fields(hand_spin())["rate_hz"]) <= 101.0


def test_sampling_stays_on_the_10_ms_grid():
    assert float(ready_fields(hand_spin())["max_gap_ms"]) <= 12.0


def test_spin_at_the_gyro_limit_blanks_rpm_and_sets_the_flag():
    fast = lambda t: (0.0, 0.0, 34.0) if 2.0 <= t < 2.5 else STILL
    world = hand_spin([(12.5, b"DUMP\n")], gyro=fast)
    _, rows, _ = dump(world)
    flagged = [row for row in rows if row[6] == "34.0000"]
    assert flagged and all(row[7] == "" and row[8] == "1" for row in flagged)
    assert ready_fields(world)["peak_abs_rpm"] == "NEAR_LIMIT"


def test_ready_summary_arrives_without_being_asked():
    assert any(line.startswith("READY samples=") for line in hand_spin().lines)


# Protecting an unsaved throw -------------------------------------------------------
def test_arm_with_an_unsaved_capture_asks_first():
    assert lines_after(hand_spin([(12.5, b"ARM\n")]), 12.5) == [UNSAVED]


def test_unsaved_capture_survives_the_warning():
    world = hand_spin([(12.5, b"ARM\n"), (13.0, b"STATUS\n")])
    assert lines_after(world, 13.0)[0].startswith("READY samples=")


def test_second_arm_discards_the_capture_and_arms():
    world = hand_spin([(12.5, b"ARM\n"), (13.0, b"ARM\n"), (13.5, b"STATUS\n")])
    assert lines_after(world, 13.0) == ["ARMED", "ARMED"]


def test_arm_after_a_complete_dump_needs_no_warning():
    world = hand_spin([(12.5, b"DUMP\n"), (14.5, b"ARM\n")])
    assert lines_after(world, 14.5) == ["ARMED"]


def test_interrupted_dump_leaves_the_capture_unsaved():
    world = hand_spin([(12.5, b"DUMP\n"), (15.0, b"ARM\n")],
                      connected=lambda t: not 12.8 <= t < 14.5)
    assert "END" not in world.lines
    assert lines_after(world, 15.0) == [UNSAVED]


# Range loss ----------------------------------------------------------------------
def test_capture_finishes_while_the_phone_is_out_of_range():
    world = hand_spin([(13.5, b"STATUS\n")], connected=lambda t: not 1.5 <= t < 13.0)
    assert lines_after(world, 13.5)[0].startswith("READY samples=")


def test_ready_summary_is_delivered_on_reconnect():
    world = hand_spin(connected=lambda t: not 1.5 <= t < 13.0)
    assert any(line.startswith("READY samples=") for line in lines_after(world, 13.0))


# Sensor faults ---------------------------------------------------------------------
def test_sensor_error_while_recording_keeps_the_partial_capture():
    world = hand_spin([(5.0, b"DUMP\n")], sensor_fail=lambda t: 4.0 <= t < 4.05, end_s=8.0)
    fields = ready_fields(world)
    assert fields.get("partial") == "1"
    assert 225 <= int(fields["samples"]) <= 240
    _, rows, ended = dump(world)
    assert ended and len(rows) == int(fields["samples"])


def test_sensor_error_while_armed_is_reported_on_status():
    world = run(4.0, [(1.0, b"ARM\n"), (3.0, b"STATUS\n")], sensor_fail=lambda t: 1.5 <= t < 1.55)
    assert lines_after(world, 3.0) == ["SENSOR_ERROR"]


def test_sensor_error_is_pushed_without_being_asked():
    world = run(3.0, [(1.0, b"ARM\n")], sensor_fail=lambda t: 1.5 <= t < 1.55)
    assert any(line.startswith("SENSOR_ERROR ") for line in world.lines)


def test_arm_recovers_after_a_sensor_error():
    world = run(4.0, [(1.0, b"ARM\n"), (3.0, b"ARM\n")], sensor_fail=lambda t: 1.5 <= t < 1.55)
    assert lines_after(world, 3.0) == ["ARMED"]


# New in 1.1: INFO and BENCH ----------------------------------------------------------
def test_info_reports_version_and_capture_layout():
    world = run(1.0, [(0.5, b"INFO\n")])
    assert world.lines == ["DGT-1 fw=1.1.1 target_hz=100 window_s=10 pre=30 cols=12"]


def test_bench_counts_three_sensor_reads_for_one_second():
    # The simulator charges 0.8 ms per sensor read, so about 415 passes fit in a second.
    line = run(3.0, [(0.5, b"BENCH\n")]).lines[0]
    assert 380 <= int(re.fullmatch(r"BENCH reads_per_s=(\d+)", line).group(1)) <= 420


def test_bench_is_refused_while_armed():
    world = run(3.0, [(1.0, b"ARM\n"), (2.0, b"BENCH\n")])
    assert world.lines[1] == "State ARMED. " + COMMANDS


def test_bench_leaves_a_ready_capture_alone():
    world = hand_spin([(12.5, b"BENCH\n"), (14.0, b"STATUS\n")])
    ready = [line for line in world.lines if line.startswith("READY ")]
    assert len(ready) == 2 and ready[0] == ready[1]


def test_bench_reports_a_sensor_fault():
    world = run(3.0, [(0.5, b"BENCH\n")], sensor_fail=lambda t: 0.8 <= t < 0.85)
    assert world.lines[0].startswith("SENSOR_ERROR ")
