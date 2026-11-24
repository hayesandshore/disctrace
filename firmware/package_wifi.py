"""Collect what goes on the board for the Wi-Fi firmware: code.py and the page.

    python3 firmware/package_wifi.py

Writes firmware/build/DGT-1_wifi_<version>/ and a zip of it. Inside, the
CIRCUITPY folder holds exactly what to copy onto the board, and INSTALL.md
says how.
"""
import re
import shutil
from pathlib import Path

FIRMWARE = Path(__file__).resolve().parent
REPO = FIRMWARE.parent
SOURCE = FIRMWARE / "firmware_2.1.0" / "code.py"


def main():
    version = re.search(r'^VERSION = "([^"]+)"', SOURCE.read_text(), re.M).group(1)
    out = FIRMWARE / "build" / ("DGT-1_wifi_" + version)
    if out.exists():
        shutil.rmtree(out)                      # only ever the folder this script made
    drive = out / "CIRCUITPY"
    (drive / "www" / "js").mkdir(parents=True)
    shutil.copy(SOURCE, drive / "code.py")
    for name in ("index.html", "style.css"):
        shutil.copy(REPO / name, drive / "www" / name)
    for script in sorted((REPO / "js").glob("*.js")):
        shutil.copy(script, drive / "www" / "js" / script.name)
    shutil.copy(FIRMWARE / "WIFI.md", out / "INSTALL.md")
    archive = shutil.make_archive(str(out), "zip", out.parent, out.name)
    size = sum(item.stat().st_size for item in drive.rglob("*") if item.is_file())
    print("Wrote %s" % out)
    print("Wrote %s" % archive)
    print("The CIRCUITPY folder holds %d files, %d kB." % (
        sum(1 for item in drive.rglob("*") if item.is_file()), round(size / 1000)))


if __name__ == "__main__":
    main()
