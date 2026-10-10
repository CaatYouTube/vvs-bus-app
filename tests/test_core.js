// Test der Kernlogik gegen die Ausgabe der Pipeline (Beispiel-Fahrplan).
// Aufruf: node tests/test_core.js <Ordner mit meta.json, stops.json, ...>
const fs = require('fs');
const path = require('path');
const C = require('../web/js/core.js');

const dir = process.argv[2];
if (!dir) { console.error('Datenordner fehlt'); process.exit(2); }
const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const idx = C.buildIndex({ meta: load('meta.json'), stops: load('stops.json'), routes: load('routes.json'), patterns: load('patterns.json'), trips: load('trips.json') });

let failed = 0;
function check(name, cond, info) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(info)));
  if (!cond) failed++;
}
const at = (y, m, d, hh, mm) => C.toAbs(idx, new Date(y, m - 1, d, hh, mm));
const gid = (name) => idx.groups.find((g) => g.name === name).id;
const t = (abs) => C.fmtTime(abs);

// Gruppierung: die zwei "Gamma"-Steige sind eine Haltestelle
check('Gamma-Steige zu einer Haltestelle gruppiert', idx.groups.filter((g) => g.name === 'Gamma').length === 1 && idx.groups[gid('Gamma')].stops.length === 2, idx.groups.map((g) => g.name));

// Suche
check('Suche "gam" findet Gamma', C.searchGroups(idx, 'gam')[0].name === 'Gamma');
check('Linienliste sortiert (zwei verschiedene Linien "7")', idx.lines.map((l) => l.name).join(',') === '1,2,3,7,7,N1', idx.lines.map((l) => l.name));

// Landkreise
const kn = (l) => l.kreise.map(([k]) => idx.kn[k]).sort();
const byName = (n) => idx.lines.filter((l) => l.name === n);
check('Linie 1 nur in Stuttgart', JSON.stringify(kn(byName('1')[0])) === JSON.stringify(['Stuttgart (Stadt)']), kn(byName('1')[0]));
check('Linie 2 in Stuttgart und Rems-Murr-Kreis', JSON.stringify(kn(byName('2')[0])) === JSON.stringify(['Rems-Murr-Kreis', 'Stuttgart (Stadt)']), kn(byName('2')[0]));
check('Linie 3 in Stuttgart und Ludwigsburg', JSON.stringify(kn(byName('3')[0])) === JSON.stringify(['Landkreis Ludwigsburg', 'Stuttgart (Stadt)']), kn(byName('3')[0]));
check('Zwei Linien "7" bleiben getrennt, eindeutige Schlüssel', JSON.stringify(byName('7').map((l) => l.key).sort()) === JSON.stringify(['7@Rems-Murr-Kreis', '7@Stuttgart (Stadt)']), byName('7').map((l) => l.key));
check('Schlüssel eindeutiger Linien = Nummer', byName('1')[0].key === '1' && byName('N1')[0].key === 'N1');
check('Landkreis-Liste alphabetisch', idx.kreise.map((k) => k.name).join('|') === 'Landkreis Ludwigsburg|Rems-Murr-Kreis|Stuttgart (Stadt)', idx.kreise.map((k) => k.name));
const idxOf = (name) => idx.kreise.find((k) => k.name === name).idx;
const names = (list) => list.map((l) => l.name).sort().join(',');
check('Rems-Murr-Kreis: Linien 2, 7, N1', names(C.searchLines(idx, '', idxOf('Rems-Murr-Kreis'))) === '2,7,N1', names(C.searchLines(idx, '', idxOf('Rems-Murr-Kreis'))));
check('Ludwigsburg: Linie 3', names(C.searchLines(idx, '', idxOf('Landkreis Ludwigsburg'))) === '3');
check('Stuttgart: Linien 1, 2, 3, 7', names(C.searchLines(idx, '', idxOf('Stuttgart (Stadt)'))) === '1,2,3,7');
check('Suche "rems" findet Linien über Landkreisnamen', names(C.searchLines(idx, 'rems')) === '2,7,N1', names(C.searchLines(idx, 'rems')));
check('Landkreis + Suche kombiniert', names(C.searchLines(idx, 'nacht', idxOf('Rems-Murr-Kreis'))) === 'N1');
check('Keine Linien ohne Landkreis', idx.unassigned.length === 0, idx.unassigned.length);

// Ohne Landkreisdaten (optionales zweites Argument): alles bleibt benutzbar
if (process.argv[3]) {
  const loadB = (n) => JSON.parse(fs.readFileSync(path.join(process.argv[3], n), 'utf8'));
  const idxB = C.buildIndex({ meta: loadB('meta.json'), stops: loadB('stops.json'), routes: loadB('routes.json'), patterns: loadB('patterns.json'), trips: loadB('trips.json') });
  check('Ohne Landkreisdaten: keine Landkreise, alle Linien "ohne Zuordnung"', idxB.kreise.length === 0 && idxB.unassigned.length === idxB.lines.length, [idxB.kreise.length, idxB.unassigned.length]);
  check('Ohne Landkreisdaten: gleiche Nummer wird zusammengefasst', idxB.lines.map((l) => l.name).join(',') === '1,2,3,7,N1', idxB.lines.map((l) => l.name));
  check('Ohne Landkreisdaten: Suche und Abfahrten funktionieren', C.searchLines(idxB, 'nacht').length === 1 && C.searchGroups(idxB, 'alp').length === 1);
}

// Abfahrten Montag 12.10.2026 07:00 ab Alpha
let d = C.departures(idx, gid('Alpha'), at(2026, 10, 12, 7, 0), { limit: 3 });
check('Abfahrten Alpha Mo 07:00 -> 07:00, 07:30, 08:00', d.map((x) => t(x.abs)).join(',') === '07:00,07:30,08:00', d.map((x) => t(x.abs)));
check('Abfahrt zeigt Linie 1 Richtung Gamma', d[0].line === '1' && d[0].headsign === 'Gamma', d[0]);

// Endhaltestelle hat keine Abfahrt von Linie 1
d = C.departures(idx, gid('Gamma'), at(2026, 10, 12, 7, 0), { limit: 2 });
check('Gamma: nur Linie 2 fährt ab (Linie 1 endet dort)', d.every((x) => x.line === '2'), d.map((x) => x.line));

// Ausfalltag (calendar_dates) Mi 14.10.
d = C.departures(idx, gid('Alpha'), at(2026, 10, 14, 7, 0), { limit: 3 });
check('Mi 14.10.: keine Abfahrten (Ausnahme)', d.length === 0, d.length);

// Samstag: kein Werktagsverkehr
d = C.departures(idx, gid('Alpha'), at(2026, 10, 17, 7, 0), { limit: 3 });
check('Samstag: keine Abfahrten ab Alpha', d.length === 0, d.length);

// Verbindung mit Umstieg: Alpha -> Epsilon Mo 07:10
let res = C.planMany(idx, gid('Alpha'), gid('Epsilon'), at(2026, 10, 12, 7, 10), { count: 3 });
check('Alpha->Epsilon: Verbindung gefunden', res.length >= 1, res.length);
if (res.length) {
  const r0 = res[0];
  check('  Abfahrt 07:30, Ankunft 08:15, 1 Umstieg', t(r0.dep) === '07:30' && t(r0.arr) === '08:15' && r0.transfers === 1, { dep: t(r0.dep), arr: t(r0.arr), tr: r0.transfers });
  const rides = r0.legs.filter((l) => l.type === 'ride').map((l) => l.line);
  check('  Linien 1 dann 2', rides.join(',') === '1,2', rides);
  check('  Fußweg zwischen den Gamma-Steigen eingebaut', r0.legs.some((l) => l.type === 'walk'), r0.legs.map((l) => l.type));
  check('  weitere Verbindungen später', res.length < 2 || res[1].dep > r0.dep, res.map((r) => t(r.dep)));
}

// Nachtbus über Mitternacht: Delta -> Epsilon Mo 23:45
const nightReq = at(2026, 10, 12, 23, 45);
res = C.planMany(idx, gid('Delta'), gid('Epsilon'), nightReq, { count: 3 });
check('Nachtbus Delta->Epsilon gefunden', res.length >= 1 && res[0].legs[0].line === 'N1', res.map((r) => r.legs[0].line));
if (res.length) {
  check('  Abfahrt 23:50, Ankunft 00:20 am Folgetag', t(res[0].dep) === '23:50' && t(res[0].arr) === '00:20' && C.dayIndexOf(res[0].arr) === 1, { dep: t(res[0].dep), arr: t(res[0].arr) });
  check('  nächster Morgen 06:35 (Linie 2) als Folgeverbindung', res.length >= 2 && t(res[1].dep) === '06:35' && res[1].legs[0].line === '2', res.map((r) => t(r.dep)));
  check('  keine Verbindung später als 12 h nach Wunschzeit (Nachtbus von morgen Nacht fehlt)', res.every((r) => r.dep <= nightReq + 12 * 3600), res.map((r) => r.dep - nightReq));
}

// Kurz nach Mitternacht: Fahrt gehört noch zum Vortag (Zeiten > 24:00)
d = C.departures(idx, gid('Delta'), at(2026, 10, 13, 0, 5), { limit: 3, window: 3600 });
check('00:05 Dienstag: Nachtbus-Abfahrt vom Vortag nicht mehr da (fuhr 23:50)', d.every((x) => x.line !== 'N1'), d.map((x) => x.line + t(x.abs)));
d = C.departures(idx, gid('Epsilon'), at(2026, 10, 13, 0, 5), { limit: 3, window: 3600 });
check('Epsilon ist Endhaltestelle: keine Abfahrten', d.length === 0, d.length);

// Gleiche Start- und Zielhaltestelle
check('Start = Ziel liefert nichts', C.planMany(idx, gid('Alpha'), gid('Alpha'), at(2026, 10, 12, 7, 0)).length === 0);

// Außerhalb des Datenzeitraums
res = C.planMany(idx, gid('Alpha'), gid('Epsilon'), at(2026, 12, 1, 7, 0));
check('Datum außerhalb des Zeitraums: keine Verbindung', res.length === 0, res.length);

// Richtungen
const dirs = C.lineDirections(idx, idx.lines.find((l) => l.name === '1'));
check('Linie 1 hat eine Richtung (Gamma)', dirs.length === 1 && dirs[0].headsign === 'Gamma', dirs);

console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(failed ? 1 : 0);
