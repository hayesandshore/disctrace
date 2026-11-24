"""Run every test against one firmware file. Needs only Python 3, not pytest.

    python3 tests/run_tests.py firmware_1.0.2/code.py
    python3 tests/run_tests.py firmware_1.1.2/code.py
    python3 tests/run_tests.py firmware_2.1.0/code.py

Tests that do not apply to the file under test are reported as "not
applicable": features only firmware 1.1 has, when the file is a 1.0 firmware
or the Wi-Fi firmware (which keeps the 1.0 capture); what only a Bluetooth
link does, when the file is the Wi-Fi firmware; and the Wi-Fi tests, when
the file is a Bluetooth firmware.
"""
import importlib
import os
import sys
import traceback

MODULES = ("test_firmware", "test_fixtures", "test_hardening")
WIFI_MODULE = "test_wifi"
# What only a Bluetooth link does: advertising, 20-byte packets, commands split
# across writes, and lines pushed without being asked. Over Wi-Fi nothing is
# pushed: a waiting line is the answer to the next STATUS. test_wifi.py has the
# Wi-Fi form of each of these.
ONLY_BLUETOOTH = {
    "test_pod_advertises_while_nobody_is_connected",
    "test_unused_arm_expires_after_an_hour",
    "test_arm_timeout_is_pushed_without_being_asked",
    "test_command_split_across_two_writes_is_reassembled",
    "test_no_bluetooth_write_exceeds_20_bytes",
    "test_dump_row_count_matches_the_summary_and_ends_with_END",
    "test_summary_reports_peak_spin_in_rpm",
    "test_sampling_stays_on_the_10_ms_grid",
    "test_spin_at_the_gyro_limit_blanks_rpm_and_sets_the_flag",
    "test_ready_summary_arrives_without_being_asked",
    "test_interrupted_dump_leaves_the_capture_unsaved",
    "test_ready_summary_waiting_at_reconnect_arrives_once_the_phone_speaks",
    "test_sensor_error_while_recording_keeps_the_partial_capture",
    "test_sensor_error_while_armed_is_reported_on_status",
    "test_sensor_error_is_pushed_without_being_asked",
    "test_bench_leaves_a_ready_capture_alone",
    "test_pod_advertises_when_a_sensor_is_missing_at_power_up",
    "test_fault_waiting_at_power_up_arrives_once_the_phone_speaks",
    "test_pod_advertises_even_if_a_sensor_driver_hangs_at_power_up",
    "test_arm_timeout_while_out_of_range_is_reported_after_reconnect",
    "test_sensor_fault_reason_while_out_of_range_is_reported_after_reconnect",
    "test_unexpected_sensor_read_error_while_armed_is_reported",
    "test_failed_advertising_restart_is_tried_again",
    "test_stale_already_advertising_state_is_cleared",
    "test_failed_write_during_a_download_leaves_the_capture_unsaved",
    "test_an_unexpected_error_restarts_the_program_and_says_why_on_usb",
}
ONLY_IN_1_1 = {
    "test_bench_counts_three_sensor_reads_for_one_second",
    "test_bench_is_refused_while_armed",
    "test_bench_reports_a_sensor_fault",
    "test_arm_after_a_sensor_fault_during_bench_restarts_the_sensors",
    "test_dump_header_lists_twelve_columns",
    "test_dump_without_a_capture_is_refused",          # checks the 1.1 command list
    "test_every_row_has_twelve_fields",
    "test_imu_accelerometer_fills_the_last_three_columns",
    "test_imu_accelerometer_range_is_16_g",
    "test_info_reports_version_and_capture_layout",
    "test_recording_runs_ten_seconds_past_the_trigger",
    "test_summary_reports_the_achieved_sample_rate",
    "test_unknown_command_lists_the_commands",         # checks the 1.1 command list
    "test_fixture_header_is_the_header_the_firmware_sends",
    "test_fixture_rows_have_the_same_shape_as_real_rows",
    "test_fixture_status_has_the_same_fields_as_a_real_summary",
}


def main(firmware):
    tests_dir = os.path.dirname(os.path.abspath(__file__))
    os.environ["DGT1_FIRMWARE"] = os.path.abspath(firmware)    # read by test_firmware.py at import
    sys.path.insert(0, tests_dir)
    with open(firmware) as handle:
        source = handle.read()
    is_wifi = "import wifi" in source
    is_1_1 = "imu_ax_g" in source          # the twelve-column, ten-second capture
    passed, skipped, failed = [], [], []
    for module_name in MODULES + ((WIFI_MODULE,) if is_wifi else ()):
        module = importlib.import_module(module_name)
        for name in sorted(vars(module)):
            test = getattr(module, name)
            if not name.startswith("test_") or getattr(test, "__module__", None) != module_name:
                continue
            if (name in ONLY_IN_1_1 and not is_1_1) or (name in ONLY_BLUETOOTH and is_wifi):
                skipped.append(name)
                continue
            try:
                test()
                passed.append(name)
            except BaseException as error:          # noqa: BLE001 - report every kind of failure
                if isinstance(error, KeyboardInterrupt):
                    raise
                last = traceback.extract_tb(error.__traceback__)[-1]
                text = str(error).strip()
                reason = text.splitlines()[0][:120] if text else "(no message)"
                failed.append((name, type(error).__name__, reason, last.name, last.lineno))
    for name, kind, reason, where, line in failed:
        print("FAIL  %s\n        %s: %s  (in %s, line %d)" % (name, kind, reason, where, line))
    summary = "%d passed, %d failed" % (len(passed), len(failed))
    if skipped:
        summary += ", %d not applicable to %s" % (len(skipped), "the Wi-Fi firmware" if is_wifi else "a 1.0 firmware")
    print(summary)
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
