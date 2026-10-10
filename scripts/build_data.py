#!/usr/bin/env python3
"""Baut aus einem GTFS-Zip kompakte JSON-Dateien für die VVS-Bus-App.

Beispiele:
  python3 scripts/build_data.py                  # lädt den BW-Gesamtfeed, filtert auf Region Stuttgart
  python3 scripts/build_data.py --zip feed.zip   # lokale GTFS-Datei verwenden
  python3 scripts/build_data.py --url <URL>      # anderer GTFS-Feed (z. B. reiner VVS-Feed)

Ausgabe (Standard: web/data/):
  meta.json, stops.json, routes.json, patterns.json, trips.json
"""
import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import sys
import tempfile
import urllib.request
import zipfile
from collections import defaultdict

DEFAULT_URL = (
    "https://www.nvbw.de/fileadmin/user_upload/service/open_data/"
    "fahrplandaten_mit_liniennetz/bwgesamt.zip"
)
# lat_min,lon_min,lat_max,lon_max – grobes Rechteck um das VVS-Gebiet
DEFAULT_BBOX = "48.39,8.54,49.53,10.16"
BUS_TYPES = {3} | set(range(700, 717))
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

# Amtliche Kreisschlüssel Baden-Württemberg (5 Stellen). Deutschlandweite Haltestellen-IDs (DHID)
# beginnen mit "de:<Kreisschlüssel>:", z. B. "de:08119:..." = Rems-Murr-Kreis.
KREIS_NAMES = {
    "08111": "Stuttgart (Stadt)", "08115": "Landkreis Böblingen", "08116": "Landkreis Esslingen",
    "08117": "Landkreis Göppingen", "08118": "Landkreis Ludwigsburg", "08119": "Rems-Murr-Kreis",
    "08121": "Heilbronn (Stadt)", "08125": "Landkreis Heilbronn", "08126": "Hohenlohekreis",
    "08127": "Landkreis Schwäbisch Hall", "08128": "Main-Tauber-Kreis", "08135": "Landkreis Heidenheim",
    "08136": "Ostalbkreis", "08211": "Baden-Baden", "08212": "Karlsruhe (Stadt)",
    "08215": "Landkreis Karlsruhe", "08216": "Landkreis Rastatt", "08221": "Heidelberg",
    "08222": "Mannheim", "08225": "Neckar-Odenwald-Kreis", "08226": "Rhein-Neckar-Kreis",
    "08231": "Pforzheim", "08235": "Landkreis Calw", "08236": "Enzkreis",
    "08237": "Landkreis Freudenstadt", "08311": "Freiburg im Breisgau", "08315": "Landkreis Breisgau-Hochschwarzwald",
    "08316": "Landkreis Emmendingen", "08317": "Ortenaukreis", "08325": "Landkreis Rottweil",
    "08326": "Schwarzwald-Baar-Kreis", "08327": "Landkreis Tuttlingen", "08335": "Landkreis Konstanz",
    "08336": "Landkreis Lörrach", "08337": "Landkreis Waldshut", "08415": "Landkreis Reutlingen",
    "08416": "Landkreis Tübingen", "08417": "Zollernalbkreis", "08421": "Ulm",
    "08425": "Alb-Donau-Kreis", "08426": "Landkreis Biberach", "08435": "Bodenseekreis",
    "08436": "Landkreis Ravensburg", "08437": "Landkreis Sigmaringen",
}
DHID_RE = re.compile(r"^de:(\d{5})(?::|$)")

csv.field_size_limit(10**7)


def open_csv(z, name):
    return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline=""))


def hms(value):
    value = (value or "").strip()
    if not value:
        return None
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def ymd(value):
    return dt.date(int(value[:4]), int(value[4:6]), int(value[6:8]))


def dist_m(a, b):
    dla = (a[0] - b[0]) * 111320.0
    dlo = (a[1] - b[1]) * 111320.0 * math.cos(math.radians(a[0]))
    return math.hypot(dla, dlo)


def code_from_id(value):
    m = DHID_RE.match(value or "")
    return m.group(1) if m else None


def _pip(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def load_regions(path):
    """Optional: Landkreis-Grenzen aus einer GeoJSON-Datei (z. B. BKG VG250), wenn die Haltestellen-IDs nichts hergeben."""
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    regions = []
    for ft in gj.get("features", []):
        pr = ft.get("properties") or {}
        name = pr.get("GEN") or pr.get("NAME_3") or pr.get("name") or pr.get("NAME")
        geom = ft.get("geometry") or {}
        if geom.get("type") == "Polygon":
            polys = [geom["coordinates"]]
        elif geom.get("type") == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        for poly in polys:
            xs = [p[0] for p in poly[0]]
            ys = [p[1] for p in poly[0]]
            regions.append((min(xs), min(ys), max(xs), max(ys), name, poly))
    return regions


def region_of(regions, lat, lon):
    for x0, y0, x1, y1, name, poly in regions:
        if x0 <= lon <= x1 and y0 <= lat <= y1 and _pip(lon, lat, poly[0]) and not any(_pip(lon, lat, h) for h in poly[1:]):
            return name
    return None


def thin(points, min_m=12.0):
    """Dünnt eine Linie aus, damit die Dateien klein bleiben."""
    out = [points[0]]
    for p in points[1:-1]:
        if dist_m(out[-1], p) >= min_m:
            out.append(p)
    if len(points) > 1:
        out.append(points[-1])
    return [[round(la, 5), round(lo, 5)] for la, lo in out]


def download(url, target):
    req = urllib.request.Request(url, headers={"User-Agent": "vvs-bus-app/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(target, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:.0f}/{total / 1e6:.0f} MB", end="", file=sys.stderr)
    print(file=sys.stderr)


def complete_times(rows):
    """rows: [(stop_id, arr, dep)] -> (arr, dep) ohne Lücken oder None."""
    n = len(rows)
    base = [(r[1] if r[1] is not None else r[2]) for r in rows]
    if base[0] is None or base[-1] is None:
        return None
    i = 0
    while i < n:
        if base[i] is None:
            j = i
            while base[j] is None:
                j += 1
            a, b = base[i - 1], base[j]
            for k in range(i, j):
                base[k] = a + (b - a) * (k - i + 1) // (j - i + 1)
            i = j
        i += 1
    arr = [r[1] if r[1] is not None else base[k] for k, r in enumerate(rows)]
    dep = [r[2] if r[2] is not None else base[k] for k, r in enumerate(rows)]
    prev = arr[0]
    for k in range(n):
        if arr[k] < prev:
            arr[k] = prev
        if dep[k] < arr[k]:
            dep[k] = arr[k]
        prev = dep[k]
    return arr, dep


def load_services(z, names, wanted, base, days):
    cal = {}
    if "calendar.txt" in names:
        for r in open_csv(z, "calendar.txt"):
            if r["service_id"] in wanted:
                cal[r["service_id"]] = (
                    ymd(r["start_date"]),
                    ymd(r["end_date"]),
                    [int(r[d]) for d in WEEKDAYS],
                )
    add, rem = defaultdict(set), defaultdict(set)
    if "calendar_dates.txt" in names:
        for r in open_csv(z, "calendar_dates.txt"):
            sid = r["service_id"]
            if sid not in wanted:
                continue
            (add if r["exception_type"].strip() == "1" else rem)[sid].add(ymd(r["date"]))
    out = {}
    for sid in wanted:
        bits = []
        for i in range(days):
            d = base + dt.timedelta(days=i)
            active = False
            if sid in cal:
                s, e, wd = cal[sid]
                active = s <= d <= e and wd[d.weekday()] == 1
            if d in add[sid]:
                active = True
            if d in rem[sid]:
                active = False
            bits.append("1" if active else "0")
        out[sid] = "".join(bits)
    return out


def read_shapes(z, names, needed):
    if "shapes.txt" not in names or not needed:
        return {}
    pts = defaultdict(list)
    for r in open_csv(z, "shapes.txt"):
        sid = r["shape_id"]
        if sid in needed:
            pts[sid].append(
                (int(float(r["shape_pt_sequence"])), float(r["shape_pt_lat"]), float(r["shape_pt_lon"]))
            )
    out = {}
    for sid, lst in pts.items():
        lst.sort()
        out[sid] = thin([(la, lo) for _, la, lo in lst])
    return out


def build(zip_path, out_dir, bbox, days, base, all_modes, regions=None):
    z = zipfile.ZipFile(zip_path)
    names = set(z.namelist())
    lat0, lon0, lat1, lon1 = bbox

    print("Lese Linien …", file=sys.stderr)
    routes = {}
    for r in open_csv(z, "routes.txt"):
        try:
            rt = int((r.get("route_type") or "3").strip())
        except ValueError:
            rt = 3
        if all_modes or rt in BUS_TYPES:
            routes[r["route_id"]] = r

    print("Lese Haltestellen …", file=sys.stderr)
    stops, parents = {}, {}
    for s in open_csv(z, "stops.txt"):
        try:
            la, lo = float(s["stop_lat"]), float(s["stop_lon"])
        except (ValueError, KeyError, TypeError):
            continue
        stops[s["stop_id"]] = ((s.get("stop_name") or "").strip(), la, lo)
        parents[s["stop_id"]] = (s.get("parent_station") or "").strip()
    in_box = {k for k, (_, la, lo) in stops.items() if lat0 <= la <= lat1 and lon0 <= lo <= lon1}

    print("Lese Fahrten …", file=sys.stderr)
    trips = {}
    for t in open_csv(z, "trips.txt"):
        if t["route_id"] in routes:
            trips[t["trip_id"]] = (
                t["route_id"],
                t["service_id"],
                (t.get("trip_headsign") or "").strip(),
                (t.get("shape_id") or "").strip(),
            )

    pattern_index = {}
    patterns = []  # dicts: route_id, headsign, stop_ids, t, d, shape_id
    pattern_trips = []  # je Muster: [(first, service_id)]

    def flush(trip_id, rows):
        info = trips.get(trip_id)
        if not info or len(rows) < 2:
            return
        rows.sort(key=lambda r: r[0])
        if any(r[1] not in stops for r in rows):
            return
        if not any(r[1] in in_box for r in rows):
            return
        done = complete_times([(r[1], r[2], r[3]) for r in rows])
        if not done:
            return
        arr, dep = done
        first = dep[0]
        stop_ids = tuple(r[1] for r in rows)
        rel_a = tuple(a - first for a in arr)
        rel_d = tuple(d - first for d in dep)
        key = (info[0], info[2], stop_ids, rel_a, rel_d)
        pi = pattern_index.get(key)
        if pi is None:
            pi = len(patterns)
            pattern_index[key] = pi
            patterns.append(
                {"route": info[0], "head": info[2], "stops": stop_ids, "t": rel_a, "d": rel_d, "shape": info[3]}
            )
            pattern_trips.append([])
        pattern_trips[pi].append((first, info[1]))

    print("Lese Fahrzeiten (das dauert beim Gesamtfeed einige Minuten) …", file=sys.stderr)
    cur_id, rows, finished = None, [], set()
    for r in open_csv(z, "stop_times.txt"):
        tid = r["trip_id"]
        if tid != cur_id:
            if cur_id is not None:
                flush(cur_id, rows)
                if cur_id in trips:
                    finished.add(cur_id)
            if tid in finished:
                raise SystemExit("stop_times.txt ist nicht nach trip_id gruppiert – bitte vorher sortieren.")
            cur_id, rows = tid, []
        if tid in trips:
            rows.append((int(r["stop_sequence"]), r["stop_id"], hms(r["arrival_time"]), hms(r["departure_time"])))
    if cur_id is not None:
        flush(cur_id, rows)

    print("Berechne Betriebstage …", file=sys.stderr)
    wanted = {sid for lst in pattern_trips for _, sid in lst}
    services = load_services(z, names, wanted, base, days)
    active_services = {sid for sid, bits in services.items() if "1" in bits}

    keep = []
    for pi, lst in enumerate(pattern_trips):
        lst2 = sorted((f, s) for f, s in lst if s in active_services)
        if lst2:
            keep.append((pi, lst2))
    if not keep:
        raise SystemExit("Keine Busfahrten im gewählten Zeitraum/Gebiet gefunden.")

    svc_ids = sorted({s for _, lst in keep for _, s in lst})
    svc_idx = {sid: i for i, sid in enumerate(svc_ids)}
    last_day = max(bits.rfind("1") for sid, bits in services.items() if sid in svc_idx)

    shape_pts = read_shapes(z, names, {patterns[pi]["shape"] for pi, _ in keep if patterns[pi]["shape"]})

    stop_new, stop_out = {}, {"n": [], "la": [], "lo": [], "k": []}
    kreis_idx, kreis_names = {}, []

    def kreis_index(name):
        if not name:
            return -1
        if name not in kreis_idx:
            kreis_idx[name] = len(kreis_names)
            kreis_names.append(name)
        return kreis_idx[name]

    route_new, route_out = {}, []
    pat_out, trip_out = [], []
    for pi, lst in keep:
        p = patterns[pi]
        for sid in p["stops"]:
            if sid not in stop_new:
                stop_new[sid] = len(stop_out["n"])
                name, la, lo = stops[sid]
                stop_out["n"].append(name)
                stop_out["la"].append(round(la, 5))
                stop_out["lo"].append(round(lo, 5))
                code = code_from_id(sid) or code_from_id(parents.get(sid))
                if code:
                    kname = KREIS_NAMES.get(code, f"Landkreis {code}")
                elif regions:
                    kname = region_of(regions, la, lo)
                else:
                    kname = None
                stop_out["k"].append(kreis_index(kname))
        if p["route"] not in route_new:
            route_new[p["route"]] = len(route_out)
            r = routes[p["route"]]
            short = (r.get("route_short_name") or "").strip() or (r.get("route_long_name") or "").strip()
            route_out.append([short, (r.get("route_long_name") or "").strip(), int((r.get("route_type") or 3))])
        entry = {
            "r": route_new[p["route"]],
            "h": p["head"],
            "s": [stop_new[s] for s in p["stops"]],
            "t": list(p["t"]),
            "sh": shape_pts.get(p["shape"]) or 0,
        }
        if p["d"] != p["t"]:
            entry["d"] = list(p["d"])
        pat_out.append(entry)
        flat = []
        for first, sid in lst:
            flat += [first, svc_idx[sid]]
        trip_out.append(flat)

    known = sum(1 for k in stop_out["k"] if k >= 0)
    share = 100.0 * known / max(1, len(stop_out["k"]))
    print(f"Landkreis-Zuordnung: {known} von {len(stop_out['k'])} Haltestellen ({share:.0f} %), "
          f"{len(kreis_names)} Landkreise/Städte", file=sys.stderr)
    if share < 50:
        print("WARNUNG: Die meisten Haltestellen konnten keinem Landkreis zugeordnet werden "
              "(Haltestellen-IDs ohne 'de:<Kreisschlüssel>:'). Mit --kreise-geojson <Datei> "
              "kann eine Grenzdatei angegeben werden.", file=sys.stderr)
    if known:
        stop_out["kn"] = kreis_names
    else:
        del stop_out["k"]

    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "base": base.isoformat(),
        "days": days,
        "last_service_day": (base + dt.timedelta(days=last_day)).isoformat(),
        "counts": {
            "stops": len(stop_out["n"]),
            "routes": len(route_out),
            "patterns": len(pat_out),
            "trips": sum(len(t) // 2 for t in trip_out),
        },
    }

    os.makedirs(out_dir, exist_ok=True)

    def dump(name, obj):
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  {name}: {os.path.getsize(path) / 1e6:.2f} MB", file=sys.stderr)

    dump("meta.json", meta)
    dump("stops.json", stop_out)
    dump("routes.json", route_out)
    dump("patterns.json", pat_out)
    dump("trips.json", {"svc": [services[s] for s in svc_ids], "tr": trip_out})
    print("Fertig:", json.dumps(meta["counts"]), file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", help="lokale GTFS-Zip-Datei statt Download")
    ap.add_argument("--url", default=DEFAULT_URL, help="Download-URL des GTFS-Feeds")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "web", "data"))
    ap.add_argument("--bbox", default=DEFAULT_BBOX, help="lat_min,lon_min,lat_max,lon_max")
    ap.add_argument("--days", type=int, default=120, help="Wie viele Tage ab Startdatum eingebaut werden")
    ap.add_argument("--base-date", help="Startdatum YYYY-MM-DD (Standard: heute)")
    ap.add_argument("--all-modes", action="store_true", help="auch Bahn/Tram usw. aufnehmen")
    ap.add_argument("--kreise-geojson", help="optional: GeoJSON mit Landkreis-Grenzen für Haltestellen ohne Kreis-ID")
    a = ap.parse_args()

    bbox = tuple(float(x) for x in a.bbox.split(","))
    base = dt.date.fromisoformat(a.base_date) if a.base_date else dt.date.today()
    regions = load_regions(a.kreise_geojson) if a.kreise_geojson else None

    if a.zip:
        build(a.zip, a.out, bbox, a.days, base, a.all_modes, regions)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "gtfs.zip")
            print(f"Lade {a.url} …", file=sys.stderr)
            try:
                download(a.url, target)
            except Exception as e:  # noqa: BLE001
                raise SystemExit(f"Download fehlgeschlagen: {e}")
            build(target, a.out, bbox, a.days, base, a.all_modes, regions)


if __name__ == "__main__":
    main()
