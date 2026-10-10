#!/usr/bin/env python3
"""Erzeugt einen winzigen Beispiel-Fahrplan (GTFS-Zip) zum Testen der Pipeline und der App-Logik.

Aufbau (alles Mo-Fr, außer Nachtbus und Bahn):
  Linie 1   Alpha -> Beta -> Gamma           alle 30 min ab 06:00 (Alpha :00/:30)
  Linie 2   Gamma(Steig 2) -> Delta -> Epsilon  alle 30 min ab 06:25 (:25/:55)
  Linie N1  Delta -> Epsilon                 23:50 -> 24:20 (jeden Tag, über Mitternacht)
  RB11      Bahn (muss herausgefiltert werden)
  Linie 99  außerhalb des Gebiets (muss herausgefiltert werden)
  Am 2026-10-14 (Mittwoch) fällt der Werktagsverkehr aus (calendar_dates).
"""
import csv
import io
import sys
import zipfile


def t(sec):
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def table(header, rows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


# Haltestellen-IDs im DHID-Schema (de:<Kreisschlüssel>:...). Mit --plain-ids einfache IDs ohne Kreis.
IDS = {
    "A": "de:08111:1001:0:1", "B": "de:08111:1002:0:1", "C": "de:08111:1003:0:1", "C2": "de:08111:1003:0:2",
    "D": "de:08119:2001:0:1", "E": "de:08119:2002:0:1", "Z": "de:08118:3001:0:1", "R": "de:08111:1999:0:1",
    "F1": "de:09564:1:0:1", "F2": "de:09564:2:0:1",
}
PLAIN = False


def sid(x):
    return x if PLAIN else IDS[x]


def main(out):
    stops = [
        ("A", "Alpha", 48.7800, 9.1800),      # Stuttgart
        ("B", "Beta", 48.7900, 9.1900),       # Stuttgart
        ("C", "Gamma", 48.8000, 9.2000),      # Stuttgart
        ("C2", "Gamma", 48.8001, 9.2001),     # Stuttgart, anderer Steig
        ("D", "Delta", 48.8100, 9.2770),      # Fellbach (Rems-Murr-Kreis)
        ("E", "Epsilon", 48.8310, 9.3170),    # Waiblingen (Rems-Murr-Kreis)
        ("Z", "Zeta", 48.8940, 9.1920),       # Ludwigsburg
        ("R", "Hauptbahnhof", 48.7840, 9.1816),
        ("F1", "Faraway", 50.0000, 11.0000),
        ("F2", "Faraway Ost", 50.0100, 11.0100),
    ]
    stops = [(sid(i), n, la, lo) for i, n, la, lo in stops]
    routes = [
        ("L1", "1", "Alpha - Gamma", 3),
        ("L2", "2", "Gamma - Epsilon", 700),
        ("L3", "3", "Beta - Zeta", 3),
        ("L7S", "7", "Stadtbus Alpha - Beta", 3),
        ("L7R", "7", "Stadtbus Delta - Epsilon", 3),
        ("N1", "N1", "Nachtbus Delta - Epsilon", 3),
        ("RB", "RB11", "Regionalbahn", 2),
        ("FAR", "99", "Faraway", 3),
    ]
    trips, times = [], []

    def add(trip_id, route, service, head, shape, stop_offsets, first):
        trips.append((route, service, trip_id, head, shape))
        for seq, (stop, off) in enumerate(stop_offsets, start=1):
            times.append((trip_id, t(first + off), t(first + off), sid(stop), seq))

    n = 0
    for first in range(6 * 3600, 22 * 3600, 1800):
        n += 1
        add(f"L1_{n}", "L1", "WK", "Gamma", "SH1", [("A", 0), ("B", 600), ("C", 1200)], first)
    n = 0
    for first in range(6 * 3600 + 25 * 60, 22 * 3600, 1800):
        n += 1
        add(f"L2_{n}", "L2", "WK", "Epsilon", "", [("C2", 0), ("D", 600), ("E", 1200)], first)
    add("L3_1", "L3", "WK", "Zeta", "", [("B", 0), ("Z", 1500)], 10 * 3600)
    add("L7S_1", "L7S", "WK", "Beta", "", [("A", 0), ("B", 600)], 9 * 3600)
    add("L7R_1", "L7R", "WK", "Epsilon", "", [("D", 0), ("E", 600)], 9 * 3600)
    add("N1_1", "N1", "ALL", "Epsilon", "", [("D", 0), ("E", 1800)], 23 * 3600 + 50 * 60)
    add("RB_1", "RB", "ALL", "Alpha", "", [("R", 0), ("A", 1200)], 7 * 3600)
    add("FAR_1", "FAR", "WK", "Faraway Ost", "", [("F1", 0), ("F2", 600)], 7 * 3600)

    shapes = [
        ("SH1", 48.7800, 9.1800, 1),
        ("SH1", 48.7850, 9.1850, 2),
        ("SH1", 48.7900, 9.1900, 3),
        ("SH1", 48.8000, 9.2000, 4),
    ]
    cal = [
        ("WK", 1, 1, 1, 1, 1, 0, 0, "20260101", "20261231"),
        ("ALL", 1, 1, 1, 1, 1, 1, 1, "20260101", "20261231"),
    ]
    files = {
        "agency.txt": table(
            ["agency_id", "agency_name", "agency_url", "agency_timezone"],
            [("1", "Testbus", "https://example.org", "Europe/Berlin")],
        ),
        "stops.txt": table(["stop_id", "stop_name", "stop_lat", "stop_lon"], stops),
        "routes.txt": table(["route_id", "route_short_name", "route_long_name", "route_type"], routes),
        "trips.txt": table(["route_id", "service_id", "trip_id", "trip_headsign", "shape_id"], trips),
        "stop_times.txt": table(
            ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], times
        ),
        "calendar.txt": table(
            ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
             "start_date", "end_date"],
            cal,
        ),
        "calendar_dates.txt": table(["service_id", "date", "exception_type"], [("WK", "20261014", 2)]),
        "shapes.txt": table(["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], shapes),
    }
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    print("geschrieben:", out)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--plain-ids"]
    PLAIN = "--plain-ids" in sys.argv
    main(args[0] if args else "sample_gtfs.zip")
