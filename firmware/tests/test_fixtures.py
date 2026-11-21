"""The sample responses in fixtures/ must match what firmware 1.1 actually sends."""
import re
from pathlib import Path

import sim
from sim import World
from test_firmware import FIRMWARE, dump, hand_spin

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def test_fixture_header_is_the_header_the_firmware_sends():
    header, _, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    assert (FIXTURES / "dump.txt").read_text().splitlines()[0] == header


def test_fixture_rows_have_the_same_shape_as_real_rows():
    _, rows, _ = dump(hand_spin([(12.5, b"DUMP\n")]))
    shape = lambda row: [re.sub(r"\d+", "9", field) for field in row]
    lines = (FIXTURES / "dump.txt").read_text().splitlines()
    assert lines[-1] == "END"
    fixture_rows = [line.split(",") for line in lines[1:-1]]
    # First fixture row is a resting pre-trigger sample, like the first real row.
    assert shape(fixture_rows[0]) == shape(rows[0])
    assert {len(row) for row in fixture_rows} == {12}


def test_fixture_status_has_the_same_fields_as_a_real_summary():
    world = sim.run(FIRMWARE, World(16.0, [(1.0, b"ARM\n")],
                                    gyro=lambda t: (0.0, 0.0, 34.0) if 2.0 <= t < 2.5 else (0.0, 0.0, 0.0)))
    real = next(line for line in world.lines if line.startswith("READY "))
    keys = lambda line: [part.split("=")[0] for part in line.split()]
    assert keys((FIXTURES / "status.txt").read_text().strip()) == keys(real)
