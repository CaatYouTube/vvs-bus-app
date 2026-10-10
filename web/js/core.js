/* Kernlogik: Index, Haltestellensuche, Abfahrten und Verbindungssuche (RAPTOR).
 * Läuft im Browser (window.VVSCore) und in Node (require) – dadurch testbar.
 *
 * Zeiten sind "absolute Sekunden": Tage seit meta.base * 86400 + Sekunden seit Mitternacht.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VVSCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400;
  const TRANSFER = 120; // Mindest-Umsteigezeit an derselben Haltestelle (s)
  const WALK_SPEED = 1.2; // m/s
  const MAX_WALK = 250; // m
  const MIN_WALK = 90; // s

  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

  function distM(la1, lo1, la2, lo2) {
    const dla = (la1 - la2) * 111320;
    const dlo = (lo1 - lo2) * 111320 * Math.cos((la1 * Math.PI) / 180);
    return Math.hypot(dla, dlo);
  }

  function naturalCompare(a, b) {
    return a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });
  }

  /* ---------- Index ---------- */
  function buildIndex(raw) {
    const { meta, stops, routes, patterns, trips } = raw;
    const nStops = stops.n.length;
    const [by, bm, bd] = meta.base.split('-').map(Number);

    // Haltestellen mit gleichem Namen und < 500 m Abstand = eine Haltestelle (Gruppe, mehrere Steige)
    const groups = [];
    const groupOf = new Int32Array(nStops);
    const byName = new Map();
    for (let i = 0; i < nStops; i++) {
      const list = byName.get(stops.n[i]) || [];
      let g = -1;
      for (const gi of list) {
        if (distM(groups[gi].lat, groups[gi].lon, stops.la[i], stops.lo[i]) < 500) { g = gi; break; }
      }
      if (g < 0) {
        g = groups.length;
        groups.push({ id: g, name: stops.n[i], key: norm(stops.n[i]), lat: stops.la[i], lon: stops.lo[i], stops: [] });
        list.push(g);
        byName.set(stops.n[i], list);
      }
      groups[g].stops.push(i);
      groupOf[i] = g;
    }

    for (const p of patterns) if (!p.d) p.d = p.t;

    // Haltestelle -> [Muster, Position]
    const pbs = Array.from({ length: nStops }, () => []);
    patterns.forEach((p, pi) => p.s.forEach((s, pos) => pbs[s].push([pi, pos])));

    // Fußwege zwischen nahen Haltestellen
    const cellOf = (la, lo) => Math.floor(la / 0.0025) + ',' + Math.floor(lo / 0.004);
    const grid = new Map();
    for (let i = 0; i < nStops; i++) {
      const k = cellOf(stops.la[i], stops.lo[i]);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
    const foot = Array.from({ length: nStops }, () => []);
    for (let i = 0; i < nStops; i++) {
      const cy = Math.floor(stops.la[i] / 0.0025), cx = Math.floor(stops.lo[i] / 0.004);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(cy + dy + ',' + (cx + dx)) || []) {
          if (j === i) continue;
          const d = distM(stops.la[i], stops.lo[i], stops.la[j], stops.lo[j]);
          if (d <= MAX_WALK) foot[i].push([j, Math.max(MIN_WALK, Math.round(d / WALK_SPEED))]);
        }
      }
    }

    // Landkreis je Haltestelle (optional): stops.k = Index in stops.kn, -1 = unbekannt
    const kOf = stops.k || null;
    const kn = stops.kn || [];
    const routeInfo = routes.map((r) => ({ name: r[0], long: r[1], type: r[2], patterns: [], ks: new Set() }));
    patterns.forEach((p, pi) => {
      const ri = routeInfo[p.r];
      ri.patterns.push(pi);
      if (kOf) for (const s of p.s) if (kOf[s] >= 0) ri.ks.add(kOf[s]);
    });
    const routesByName = new Map();
    for (const r of routeInfo) {
      if (!r.patterns.length) continue;
      (routesByName.get(r.name) || routesByName.set(r.name, []).get(r.name)).push(r);
    }

    // Gleiche Nummer = gleiche Linie – außer sie liegen in völlig verschiedenen Landkreisen
    const lines = [];
    for (const [name, list] of routesByName) {
      const comps = [];
      for (const r of list) {
        const hit = comps.filter((c) => !kOf || !r.ks.size || !c.ks.size || [...r.ks].some((x) => c.ks.has(x)));
        if (!hit.length) { comps.push({ routes: [r], ks: new Set(r.ks) }); continue; }
        const first = hit[0];
        first.routes.push(r);
        r.ks.forEach((x) => first.ks.add(x));
        for (const o of hit.slice(1)) {
          first.routes.push(...o.routes);
          o.ks.forEach((x) => first.ks.add(x));
          comps.splice(comps.indexOf(o), 1);
        }
      }
      for (const c of comps) {
        const pats = c.routes.flatMap((r) => r.patterns);
        const seen = new Set();
        const kc = new Map();
        for (const pi of pats) {
          for (const s of patterns[pi].s) {
            if (seen.has(s)) continue;
            seen.add(s);
            const k = kOf ? kOf[s] : -1;
            kc.set(k, (kc.get(k) || 0) + 1);
          }
        }
        const kreise = [...kc.entries()].filter(([k]) => k >= 0).sort((a, b) => b[1] - a[1]);
        lines.push({
          key: name, name, long: c.routes[0].long, type: c.routes[0].type,
          patterns: pats, kreise, nStops: seen.size, multi: comps.length > 1,
          text: norm(name + ' ' + c.routes[0].long + ' ' + kreise.map(([k]) => kn[k]).join(' ')),
        });
      }
    }
    // Eindeutiger, stabiler Schlüssel (für "gefahren"): bei mehrfach vergebener Nummer + Haupt-Landkreis
    for (const l of lines) if (l.multi) l.key = l.name + '@' + (l.kreise.length ? kn[l.kreise[0][0]] : '?');
    lines.sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.key, b.key));
    const linesByKey = new Map(lines.map((l) => [l.key, l]));
    const kreise = kn
      .map((name, i) => ({ idx: i, name, lines: lines.filter((l) => l.kreise.some(([k]) => k === i)) }))
      .filter((k) => k.lines.length)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const unassigned = lines.filter((l) => !l.kreise.length);

    return {
      meta, stops, routes, patterns, groups, groupOf, pbs, foot, lines, linesByKey, kreise, kn, unassigned,
      trips: trips.tr,
      svc: trips.svc,
      nStops,
      baseUTC: Date.UTC(by, bm - 1, bd),
    };
  }

  function svcActive(idx, svcIdx, dayIdx) {
    const s = idx.svc[svcIdx];
    return dayIdx >= 0 && dayIdx < s.length && s.charCodeAt(dayIdx) === 49;
  }

  /* ---------- Zeit ---------- */
  function toAbs(idx, date) {
    const dayMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - idx.baseUTC;
    return Math.round(dayMs / 1000) + date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  }
  function fmtTime(abs) {
    const s = ((abs % DAY) + DAY) % DAY;
    return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  }
  function dayIndexOf(abs) { return Math.floor(abs / DAY); }
  function dateOfDay(idx, dayIdx) { return new Date(idx.baseUTC + dayIdx * DAY * 1000); }

  /* ---------- Suche ---------- */
  function searchGroups(idx, q, limit = 8) {
    const n = norm(q.trim());
    if (!n) return [];
    const starts = [], words = [], contains = [];
    for (const g of idx.groups) {
      const pos = g.key.indexOf(n);
      if (pos < 0) continue;
      if (pos === 0) starts.push(g);
      else if (g.key[pos - 1] === ' ' || g.key[pos - 1] === '(' || g.key[pos - 1] === '-') words.push(g);
      else contains.push(g);
      if (starts.length >= limit * 3) break;
    }
    const cmp = (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name, 'de');
    return starts.sort(cmp).concat(words.sort(cmp), contains.sort(cmp)).slice(0, limit);
  }

  /* kreis: undefined/null = alle, -1 = ohne Landkreis-Zuordnung, sonst Landkreis-Index */
  function searchLines(idx, q, kreis) {
    let list = idx.lines;
    if (kreis === -1) list = idx.unassigned;
    else if (kreis !== undefined && kreis !== null) list = idx.lines.filter((l) => l.kreise.some(([k]) => k === kreis));
    const n = norm(q.trim());
    if (!n) return list;
    return list.filter((l) => norm(l.name).startsWith(n) || l.text.includes(n));
  }

  function groupsNear(idx, lat, lon, limit = 15) {
    return idx.groups
      .map((g) => ({ g, d: distM(lat, lon, g.lat, g.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit);
  }

  /* Richtungen einer Linie: je Zielname das Muster mit den meisten Fahrten */
  function lineDirections(idx, line) {
    const best = new Map();
    for (const pi of line.patterns) {
      const p = idx.patterns[pi];
      const last = idx.stops.n[p.s[p.s.length - 1]];
      const key = (p.h || last) + '|' + last;
      const cnt = idx.trips[pi].length / 2;
      const cur = best.get(key);
      if (!cur || cnt > cur.cnt) best.set(key, { pi, cnt, headsign: p.h || last });
    }
    return [...best.values()].sort((a, b) => b.cnt - a.cnt);
  }

  /* ---------- Fahrtensuche ---------- */
  function lowerBound(flat, x) {
    let lo = 0, hi = flat.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (flat[2 * mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* früheste Fahrt des Musters pi, die an Position pos frühestens zur Zeit ready abfährt */
  function earliestTrip(idx, pi, pos, ready) {
    const tr = idx.trips[pi];
    const off = idx.patterns[pi].d[pos];
    const day0 = Math.floor(ready / DAY);
    let best = null;
    for (let sd = day0 - 1; sd <= day0 + 1; sd++) {
      for (let i = lowerBound(tr, ready - sd * DAY - off); i < tr.length / 2; i++) {
        if (svcActive(idx, tr[2 * i + 1], sd)) {
          const abs = sd * DAY + tr[2 * i] + off;
          if (!best || abs < best.abs) best = { first: tr[2 * i], sd, abs };
          break;
        }
      }
    }
    return best;
  }

  /* Nächste Abfahrten einer Haltestelle (Gruppe) */
  function departures(idx, groupId, fromAbs, opts = {}) {
    const limit = opts.limit || 20;
    const window = opts.window || 4 * 3600;
    const out = [];
    const day0 = Math.floor(fromAbs / DAY);
    for (const s of idx.groups[groupId].stops) {
      for (const [pi, pos] of idx.pbs[s]) {
        const p = idx.patterns[pi];
        if (pos === p.s.length - 1) continue; // Endhaltestelle: keine Abfahrt
        const tr = idx.trips[pi];
        const off = p.d[pos];
        const r = idx.routes[p.r];
        for (let sd = day0 - 1; sd <= day0 + 1; sd++) {
          let n = 0;
          for (let i = lowerBound(tr, fromAbs - sd * DAY - off); i < tr.length / 2 && n < limit; i++) {
            const abs = sd * DAY + tr[2 * i] + off;
            if (abs > fromAbs + window) break;
            if (!svcActive(idx, tr[2 * i + 1], sd)) continue;
            out.push({
              abs, pi, pos, line: r[0],
              headsign: p.h || idx.stops.n[p.s[p.s.length - 1]],
              platform: s,
            });
            n++;
          }
        }
      }
    }
    out.sort((a, b) => a.abs - b.abs);
    return out.slice(0, limit);
  }

  function getLabel(labels, k, s) {
    for (let j = k; j >= 0; j--) {
      const l = labels[j].get(s);
      if (l) return [j, l];
    }
    return null;
  }

  function reconstruct(idx, labels, k, stop) {
    const legs = [];
    let kk = k, cur = stop;
    for (let guard = 0; guard < 40; guard++) {
      const found = getLabel(labels, kk, cur);
      if (!found) return null;
      const [j, l] = found;
      if (l.type === 'start') break;
      if (l.type === 'walk') {
        legs.unshift({ type: 'walk', from: l.from, to: cur, secs: l.w });
        cur = l.from; kk = j;
        continue;
      }
      const p = idx.patterns[l.pi];
      legs.unshift({
        type: 'ride', pi: l.pi, boardPos: l.boardPos, alightPos: l.alightPos,
        from: p.s[l.boardPos], to: p.s[l.alightPos],
        dep: l.sd * DAY + l.first + p.d[l.boardPos],
        arr: l.sd * DAY + l.first + p.t[l.alightPos],
        line: idx.routes[p.r][0],
        headsign: p.h || idx.stops.n[p.s[p.s.length - 1]],
      });
      cur = p.s[l.boardPos]; kk = j - 1;
    }
    const rides = legs.filter((l) => l.type === 'ride');
    if (!rides.length) return null;
    const last = legs[legs.length - 1];
    const arr = last.type === 'ride' ? last.arr : rides[rides.length - 1].arr + last.secs;
    return { legs, dep: rides[0].dep, arr, rides: rides.length, transfers: rides.length - 1 };
  }

  /* Eine RAPTOR-Suche: frühestmögliche Ankunft je Anzahl Fahrten */
  function plan(idx, fromStops, toStops, depAbs, maxRides) {
    const nS = idx.nStops;
    const toSet = new Set(toStops);
    const tau = [new Float64Array(nS).fill(Infinity)];
    const labels = [new Map()];
    const best = new Float64Array(nS).fill(Infinity);
    let bestTarget = Infinity;
    let marked = new Set();

    for (const s of fromStops) {
      tau[0][s] = depAbs; best[s] = depAbs;
      labels[0].set(s, { type: 'start' });
      marked.add(s);
    }
    for (const s of [...marked]) {
      for (const [s2, w] of idx.foot[s]) {
        const arr = depAbs + w;
        if (arr < best[s2]) {
          tau[0][s2] = arr; best[s2] = arr;
          labels[0].set(s2, { type: 'walk', from: s, w });
          marked.add(s2);
        }
      }
    }

    for (let k = 1; k <= maxRides; k++) {
      tau[k] = tau[k - 1].slice();
      labels[k] = new Map();
      const Q = new Map();
      for (const s of marked) {
        for (const [pi, pos] of idx.pbs[s]) {
          const c = Q.get(pi);
          if (c === undefined || pos < c) Q.set(pi, pos);
        }
      }
      const rideStops = new Set();
      for (const [pi, pos0] of Q) {
        const p = idx.patterns[pi];
        let cur = null;
        for (let pos = pos0; pos < p.s.length; pos++) {
          const s = p.s[pos];
          if (cur) {
            const arr = cur.sd * DAY + cur.first + p.t[pos];
            if (arr < best[s] && arr < bestTarget) {
              tau[k][s] = arr; best[s] = arr;
              labels[k].set(s, { type: 'ride', pi, boardPos: cur.boardPos, alightPos: pos, first: cur.first, sd: cur.sd });
              rideStops.add(s);
              if (toSet.has(s)) bestTarget = Math.min(bestTarget, arr);
            }
          }
          const prev = tau[k - 1][s];
          if (prev < Infinity && pos < p.s.length - 1) {
            const lab = getLabel(labels, k - 1, s);
            const ready = prev + (lab && lab[1].type === 'ride' ? TRANSFER : 0);
            const curDep = cur ? cur.sd * DAY + cur.first + p.d[pos] : Infinity;
            if (ready <= curDep) {
              const cand = earliestTrip(idx, pi, pos, ready);
              if (cand && cand.abs < curDep) cur = { first: cand.first, sd: cand.sd, boardPos: pos };
            }
          }
        }
      }
      const newMarked = new Set(rideStops);
      for (const s of rideStops) {
        for (const [s2, w] of idx.foot[s]) {
          if (rideStops.has(s2)) continue;
          const arr = tau[k][s] + w;
          if (arr < best[s2] && arr < bestTarget) {
            tau[k][s2] = arr; best[s2] = arr;
            labels[k].set(s2, { type: 'walk', from: s, w });
            newMarked.add(s2);
            if (toSet.has(s2)) bestTarget = Math.min(bestTarget, arr);
          }
        }
      }
      marked = newMarked;
      if (!marked.size) break;
    }

    const results = [];
    let prevBest = Infinity;
    for (let k = 1; k < tau.length; k++) {
      let arr = Infinity, at = -1;
      for (const s of toStops) if (tau[k][s] < arr) { arr = tau[k][s]; at = s; }
      if (arr < prevBest) {
        prevBest = arr;
        const it = reconstruct(idx, labels, k, at);
        if (it) results.push(it);
      }
    }
    return results;
  }

  /* Mehrere Verbindungen: ab Startzeit, dann jeweils nach der ersten Abfahrt weitersuchen */
  function planMany(idx, fromGroup, toGroup, depAbs, opts = {}) {
    const count = opts.count || 4;
    const maxRides = opts.maxRides || 4;
    const horizon = opts.horizon || 12 * 3600; // Folgeverbindungen nur bis 12 h nach der Wunschzeit
    if (fromGroup === toGroup) return [];
    const out = [];
    const seen = new Set();
    let t = depAbs;
    for (let i = 0; i < count + 2 && out.length < count + 2; i++) {
      const res = plan(idx, idx.groups[fromGroup].stops, idx.groups[toGroup].stops, t, maxRides);
      if (!res.length) break;
      let minDep = Infinity;
      for (const it of res) minDep = Math.min(minDep, it.dep);
      if (out.length && minDep > depAbs + horizon) break;
      for (const it of res) {
        const sig = it.legs.filter((l) => l.type === 'ride').map((l) => l.pi + ':' + l.dep).join('|');
        if (!seen.has(sig)) { seen.add(sig); out.push(it); }
      }
      t = minDep + 60;
    }
    const keep = out.filter((a) => !out.some((b) =>
      b !== a && b.dep >= a.dep && b.arr <= a.arr && b.rides <= a.rides &&
      (b.dep > a.dep || b.arr < a.arr || b.rides < a.rides)));
    keep.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
    return keep.slice(0, count);
  }

  return {
    DAY, buildIndex, searchGroups, searchLines, groupsNear, lineDirections,
    departures, plan, planMany, toAbs, fmtTime, dayIndexOf, dateOfDay, distM,
  };
});
