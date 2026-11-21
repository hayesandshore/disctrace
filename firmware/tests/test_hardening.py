"""What the pod does when a sensor or the radio misbehaves.

Works for both firmware files (set DGT1_FIRMWARE). Each test makes one part
fail the way it can on the real board and checks what the phone would see.
"""
from test_firmware import hand_spin, lines_after, ready_fields, run, spin

OFFLINE = dict(connected=lambda t: False)
UNSAVED = "UNSAVED capture not dumped. Send ARM again to discard."
MISSING = {             # part that does not answer -> the name the pod must report
    "adxl": "ADXL375",
    "imu": "LSM6DS3TR-C",
    "bus": "I2C bus",
}


def missing(*parts, until=None):
    """A sensor_start_fail scenario: these parts do not answer (until a given second, if set)."""
    return lambda t: parts if until is None or t < until else ()


# A sensor that does not answer at power-up -----------------------------------------
def test_pod_advertises_when_a_sensor_is_missing_at_power_up():
    for part in MISSING:
        world = run(1.0, sensor_start_fail=missing(part), **OFFLINE)
        assert world.advertise_calls >= 1, part


def test_status_names_the_part_that_did_not_start():
    for part, name in MISSING.items():
        replies = lines_after(run(1.0, [(0.5, b"STATUS\n")], sensor_start_fail=missing(part)), 0.5)
        assert len(replies) == 1 and replies[0].startswith("SENSOR_ERROR "), (part, replies)
        assert name in replies[0], (part, replies)


def test_status_keeps_the_drivers_own_reason():
    world = run(1.0, [(0.5, b"STATUS\n")], sensor_start_fail=missing("adxl"))
    assert "No I2C device at address: 0x53" in lines_after(world, 0.5)[0]


def test_both_sensors_missing_names_both():
    # The cable from the Feather to the first sensor is out: neither sensor answers.
    world = run(1.0, [(0.5, b"STATUS\n")], sensor_start_fail=missing("adxl", "imu"))
    reply = lines_after(world, 0.5)[0]
    assert "ADXL375" in reply and "LSM6DS3TR-C" in reply


def test_one_sensor_missing_does_not_blame_the_other():
    world = run(1.0, [(0.5, b"STATUS\n")], sensor_start_fail=missing("imu"))
    reply = lines_after(world, 0.5)[0]
    assert "LSM6DS3TR-C" in reply and "ADXL375" not in reply


def test_fault_is_sent_when_a_phone_connects_without_being_asked():
    world = run(1.0, sensor_start_fail=missing("adxl"))
    assert world.lines and world.lines[0].startswith("SENSOR_ERROR ")


def test_usb_console_names_the_fault_and_does_not_say_ready():
    console = run(0.5, sensor_start_fail=missing("imu"), **OFFLINE).console
    assert "SENSOR_ERROR" in console and "LSM6DS3TR-C" in console
    assert "DGT-1 ready." not in console    # "ready" stays the sign of a healthy start


def test_arm_with_a_missing_sensor_is_refused_with_the_reason():
    world = run(2.0, [(1.0, b"ARM\n")], sensor_start_fail=missing("adxl"))
    replies = lines_after(world, 1.0)
    assert "ARMED" not in replies
    assert replies[0].startswith("SENSOR_ERROR ") and "ADXL375" in replies[0]
    assert replies[-1].startswith("State SENSOR_ERROR. Commands: ")   # the line the app treats as a refusal


def test_arm_starts_the_sensors_once_they_answer_and_a_capture_works():
    # The sensor comes back at 2 s without a reset: the next ARM must bring it up.
    world = run(17.0, [(1.0, b"ARM\n"), (3.0, b"ARM\n"), (16.0, b"STATUS\n")],
                gyro=spin(150, 4.0, 4.5), sensor_start_fail=missing("adxl", until=2.0))
    assert lines_after(world, 3.0)[0] == "ARMED"
    assert lines_after(world, 16.0)[0].startswith("READY samples=")


def test_other_commands_with_a_missing_sensor_keep_the_pod_answering():
    # BENCH reads the sensors in 1.1 and does not exist in 1.0; neither may stop the pod.
    world = run(4.0, [(0.5, b"DUMP\n"), (1.0, b"CANCEL\n"), (1.5, b"BENCH\n"), (3.5, b"STATUS\n")],
                sensor_start_fail=missing("adxl"))
    bench_reply = lines_after(world, 1.5)[0]
    assert "ADXL375" in bench_reply or bench_reply.startswith("State SENSOR_ERROR.")
    assert lines_after(world, 3.5)[0].startswith("SENSOR_ERROR ")


# A sensor read that fails in an unexpected way ---------------------------------------
def test_unexpected_sensor_read_error_while_armed_is_reported():
    world = run(4.0, [(1.0, b"ARM\n"), (3.0, b"STATUS\n")],
                sensor_fail=lambda t: 1.5 <= t < 1.55, sensor_error=RuntimeError("short read"))
    assert "SENSOR_ERROR short read" in world.lines
    assert lines_after(world, 3.0) == ["SENSOR_ERROR"]


def test_unexpected_sensor_read_error_while_recording_keeps_the_partial_capture():
    world = hand_spin([(5.0, b"STATUS\n")], sensor_fail=lambda t: 4.0 <= t < 4.05,
                      sensor_error=RuntimeError("short read"), end_s=8.0)
    assert ready_fields(world).get("partial") == "1"


# The radio misbehaving -----------------------------------------------------------------
def test_failed_advertising_restart_is_tried_again():
    # The phone leaves at 2 s and the radio refuses to advertise until 3 s.
    world = run(6.0, [(1.0, b"STATUS\n"), (5.0, b"STATUS\n")],
                connected=lambda t: 0.5 <= t < 2.0 or t >= 4.0,
                advertise_fail=lambda t: 2.0 <= t < 3.0)
    assert world.advertise_failures >= 1    # the fault really happened
    assert world.advertise_calls >= 2       # power-up, then a restart that worked
    assert lines_after(world, 5.0) == ["IDLE"]


def test_stale_already_advertising_state_is_cleared():
    # The radio keeps saying "Already advertising." until it is told to stop.
    world = run(6.0, [(5.0, b"STATUS\n")],
                connected=lambda t: 0.5 <= t < 2.0 or t >= 4.0,
                advertise_stuck=lambda t: t >= 2.0)
    assert world.advertise_failures >= 1
    assert world.advertise_calls >= 2
    assert lines_after(world, 5.0) == ["IDLE"]


def test_failed_bluetooth_write_does_not_stop_the_pod():
    world = run(4.0, [(1.0, b"STATUS\n"), (3.0, b"STATUS\n")], write_fail=lambda t: 0.9 <= t < 1.5)
    assert lines_after(world, 3.0) == ["IDLE"]


def test_failed_write_during_a_download_leaves_the_capture_unsaved():
    world = hand_spin([(12.5, b"DUMP\n"), (15.0, b"ARM\n")], write_fail=lambda t: 12.6 <= t < 12.7)
    assert "END" not in world.lines
    # The warning must be a line of its own, not glued onto the row that was cut off.
    assert lines_after(world, 15.0)[-1] == UNSAVED


def test_failed_bluetooth_read_does_not_stop_the_pod():
    world = run(4.0, [(1.0, b"STATUS\n"), (3.0, b"STATUS\n")], read_fail=lambda t: 0.9 <= t < 1.5)
    assert lines_after(world, 3.0) == ["IDLE"]


# Anything nobody expected ------------------------------------------------------------------
def test_an_unexpected_error_restarts_the_program_and_says_why_on_usb():
    world = run(20.0, connected_error=lambda t: 1.0 <= t < 1.1)
    assert world.reloads == 1
    assert "BluetoothError" in world.console
