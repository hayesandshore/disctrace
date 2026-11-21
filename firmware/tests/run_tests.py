"""Run every test against one firmware file. Needs only Python 3, not pytest.

    python3 tests/run_tests.py firmware_1.0.2/code.py
    python3 tests/run_tests.py firmware_1.1.2/code.py

Tests of features that only firmware 1.1 has are reported as "not applicable"
when the file under test is a 1.0 firmware.
"""
import importlib
import os
import sys
import traceback

MODULES = ("test_firmware", "test_fixtures", "test_hardening")
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
        is_1_1 = 'b"INFO"' in handle.read()
    passed, skipped, failed = [], [], []
    for module_name in MODULES:
        module = importlib.import_module(module_name)
        for name in sorted(vars(module)):
            test = getattr(module, name)
            if not name.startswith("test_") or getattr(test, "__module__", None) != module_name:
                continue
            if name in ONLY_IN_1_1 and not is_1_1:
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
        summary += ", %d not applicable to a 1.0 firmware" % len(skipped)
    print(summary)
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
