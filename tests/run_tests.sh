#!/usr/bin/env bash
# Baut aus einem winzigen Beispiel-Fahrplan die App-Daten und prüft Pipeline + Kernlogik.
# Aufruf: bash tests/run_tests.sh   (benötigt Python 3 und Node.js)
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 tests/make_sample_gtfs.py "$TMP/sample.zip" >/dev/null
python3 tests/make_sample_gtfs.py "$TMP/plain.zip" --plain-ids >/dev/null
python3 scripts/build_data.py --zip "$TMP/sample.zip" --out "$TMP/data" --base-date 2026-10-12 --days 14
python3 scripts/build_data.py --zip "$TMP/plain.zip" --out "$TMP/data_nokreis" --base-date 2026-10-12 --days 14
node tests/test_core.js "$TMP/data" "$TMP/data_nokreis"
