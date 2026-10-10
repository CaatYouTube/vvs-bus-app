(function () {
  'use strict';
  const C = window.VVSCore;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let idx = null;
  let map = null, mapLayer = null, stopLayer = null;
  const RIDES_KEY = 'vvs-bus-gefahren-v1';
  const KREIS_KEY = 'vvs-bus-landkreis-v1';
  const state = { from: null, to: null, openGroup: null, trips: [], rides: loadRides() };

  function loadRides() {
    try { return JSON.parse(localStorage.getItem(RIDES_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveRides() {
    try { localStorage.setItem(RIDES_KEY, JSON.stringify(state.rides)); } catch (e) { /* Speicher nicht verfügbar */ }
  }
  const todayISO = () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  };
  const germanDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('de-DE');
  const COLORS = ['#0b6b3a', '#c2410c', '#1d4ed8', '#a21caf', '#0f766e', '#b45309'];

  const badge = (name) => `<span class="badge${/^N/i.test(name) ? ' night' : ''}">${esc(name)}</span>`;
  const pad = (n) => String(n).padStart(2, '0');

  async function getJSON(name) {
    const r = await fetch('data/' + name + '.json');
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    return r.json();
  }

  /* ---------- Start ---------- */
  async function init() {
    setupTabs();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    try {
      const names = ['meta', 'stops', 'routes', 'patterns', 'trips'];
      const [meta, stops, routes, patterns, trips] = await Promise.all(names.map(getJSON));
      idx = C.buildIndex({ meta, stops, routes, patterns, trips });
    } catch (e) {
      $('#status').textContent = 'Keine Fahrplandaten';
      $('#line-list').innerHTML = '<div class="error"><b>Fahrplandaten fehlen.</b><br>Bitte zuerst <code>python3 scripts/build_data.py</code> ausführen (siehe README).</div>';
      return;
    }
    const m = idx.meta;
    const last = new Date(m.last_service_day + 'T12:00:00');
    const todayIdx = C.dayIndexOf(C.toAbs(idx, new Date()));
    const stale = todayIdx < 0 || todayIdx >= m.days || last < new Date();
    const st = $('#status');
    st.textContent = stale
      ? 'Fahrplandaten veraltet – bitte aktualisieren'
      : `Fahrplan bis ${last.toLocaleDateString('de-DE')} · ${m.counts.stops.toLocaleString('de-DE')} Halte`;
    if (stale) st.classList.add('warn');

    $('#info').innerHTML = `Fahrplandaten: NVBW / MobiData BW (Soll-Fahrplan, keine Echtzeit – Verspätungen und Ausfälle sind nicht enthalten). Karte © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende. Stand der Daten: ${esc(new Date(m.generated).toLocaleDateString('de-DE'))}. Alle Angaben ohne Gewähr.`;

    const now = new Date();
    $('#trip-date').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    $('#trip-time').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // Landkreis-Auswahl füllen
    const sel = $('#kreis-sel');
    if (idx.kreise.length) {
      sel.innerHTML = '<option value="">Alle Landkreise</option>' +
        idx.kreise.map((k) => `<option value="${k.idx}">${esc(k.name)} (${k.lines.length})</option>`).join('') +
        (idx.unassigned.length ? `<option value="-1">Ohne Zuordnung (${idx.unassigned.length})</option>` : '');
      try {
        const saved = localStorage.getItem(KREIS_KEY);
        if (saved !== null && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
      } catch (e) { /* egal */ }
    } else {
      sel.hidden = true;
      $('#line-filters').style.gridTemplateColumns = '1fr';
    }

    renderLines();
    bind();
  }

  /* ---------- Tabs ---------- */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'map') { ensureMap(); setTimeout(() => map.invalidateSize(), 50); }
  }
  function setupTabs() {
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (b) showTab(b.dataset.tab);
    });
  }

  /* ---------- Linien ---------- */
  function selectedKreis() {
    const v = $('#kreis-sel').value;
    return v === '' ? null : Number(v);
  }

  function renderLines() {
    const kreis = selectedKreis();
    const mode = $('#ride-sel').value;
    const base = C.searchLines(idx, $('#line-q').value, kreis);
    const done = base.filter((l) => state.rides[l.key]).length;
    const list = base.filter((l) => mode === 'all' || (mode === 'done') === !!state.rides[l.key]);

    const prog = $('#progress');
    const pct = base.length ? Math.round((100 * done) / base.length) : 0;
    prog.innerHTML = `<b>${done} von ${base.length}</b> Linien gefahren (${pct} %)<div class="bar"><i style="width:${pct}%"></i></div>`;
    prog.hidden = !base.length || !$('#line-detail').hidden;

    $('#line-list').innerHTML = list.length
      ? list.slice(0, 1500).map((l) => {
          const ridden = !!state.rides[l.key];
          const here = kreis !== null && kreis >= 0 ? (l.kreise.find(([k]) => k === kreis) || [0, 0])[1] + ' Halte hier' : '';
          const where = here || l.kreise.slice(0, 2).map(([k]) => idx.kn[k]).join(', ');
          const label = `Linie ${l.name} ${ridden ? 'als nicht gefahren markieren' : 'als gefahren markieren'}`;
          return `<div class="row-wrap"><button type="button" class="row" data-line="${esc(l.key)}">${badge(l.name)}<span class="grow">${esc(l.long || '')}${where ? `<br><small>${esc(where)}</small>` : ''}</span></button><button type="button" class="tick" data-tick="${esc(l.key)}" aria-pressed="${ridden}" aria-label="${esc(label)}" title="${esc(label)}">✓</button></div>`;
        }).join('')
      : `<p class="empty">${mode === 'todo' && base.length ? 'Alle Linien hier schon gefahren 🎉' : 'Keine Linie gefunden.'}</p>`;
  }

  function toggleRide(key) {
    if (state.rides[key]) delete state.rides[key];
    else state.rides[key] = todayISO();
    saveRides();
    renderLines();
    syncDetailTick();
  }

  function syncDetailTick() {
    const btn = $('#line-detail [data-tick]');
    if (!btn) return;
    const date = state.rides[btn.dataset.tick];
    btn.classList.toggle('on', !!date);
    btn.textContent = date ? `✓ Gefahren am ${germanDate(date)}` : 'Als gefahren markieren';
  }

  function openLine(key) {
    const line = idx.linesByKey.get(key);
    if (!line) return;
    const dirs = C.lineDirections(idx, line);
    const kreisText = line.kreise.map(([k, n]) => `${idx.kn[k]} (${n} Halte)`).join(' · ');
    let html = `<button type="button" class="back" data-act="back-lines">‹ Alle Linien</button><h2>${badge(line.name)} <span>${esc(line.long || '')}</span></h2>`;
    if (kreisText) html += `<p class="meta">${esc(kreisText)}</p>`;
    html += `<div class="actions"><button type="button" class="small" data-tick="${esc(line.key)}"></button></div>`;
    for (const d of dirs) {
      const p = idx.patterns[d.pi];
      html += `<div class="dir"><div class="dir-head"><b>Richtung ${esc(d.headsign)}</b><button type="button" class="small" data-act="map-pattern" data-pi="${d.pi}">Auf Karte</button></div><ol class="stoplist">`;
      p.s.forEach((s) => { html += `<li><button type="button" class="link" data-group="${idx.groupOf[s]}">${esc(idx.stops.n[s])}</button></li>`; });
      html += '</ol></div>';
    }
    const box = $('#line-detail');
    box.innerHTML = html;
    box.hidden = false;
    $('#line-list').hidden = true;
    $('#line-q').hidden = true;
    $('#line-filters').hidden = true;
    $('#progress').hidden = true;
    syncDetailTick();
    $('#tab-lines').scrollTop = 0;
  }
  function backToLines() {
    $('#line-detail').hidden = true;
    $('#line-list').hidden = false;
    $('#line-q').hidden = false;
    $('#line-filters').hidden = false;
    renderLines();
  }

  function exportRides() {
    const blob = new Blob([JSON.stringify({ version: 1, rides: state.rides }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gefahrene-buslinien.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importRides(file) {
    file.text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        const rides = data.rides || data;
        let added = 0;
        for (const [k, v] of Object.entries(rides)) {
          if (typeof v === 'string' && !state.rides[k]) { state.rides[k] = v; added++; }
        }
        saveRides();
        renderLines();
        alert(`${added} Linie(n) hinzugefügt.`);
      } catch (e) {
        alert('Die Datei konnte nicht gelesen werden.');
      }
    });
  }

  /* ---------- Haltestellen & Abfahrten ---------- */
  function renderStopResults(items) {
    $('#stop-results').innerHTML = items.length
      ? items.map(({ g, d }) => `<button type="button" class="row" data-group="${g.id}"><span class="grow">${esc(g.name)}${d != null ? `<br><small>${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km'} entfernt</small>` : ''}</span></button>`).join('')
      : '<p class="empty">Keine Haltestelle gefunden.</p>';
  }

  function dayLabel(abs, ref) {
    const diff = C.dayIndexOf(abs) - C.dayIndexOf(ref);
    return diff === 0 ? '' : diff === 1 ? ' (morgen)' : diff === -1 ? ' (gestern)' : ` (+${diff} Tage)`;
  }

  function openStop(gid) {
    showTab('stops');
    state.openGroup = gid;
    const g = idx.groups[gid];
    const now = C.toAbs(idx, new Date());
    const deps = C.departures(idx, gid, now, { limit: 30, window: 8 * 3600 });
    let html = `<button type="button" class="back" data-act="back-stops">‹ Suche</button><h2>${esc(g.name)}</h2>`;
    html += `<div class="actions"><button type="button" class="small" data-act="from-here" data-group="${gid}">Von hier</button><button type="button" class="small" data-act="to-here" data-group="${gid}">Nach hier</button><button type="button" class="small" data-act="map-stop" data-group="${gid}">Auf Karte</button><button type="button" class="small" data-act="refresh" data-group="${gid}">Aktualisieren</button></div>`;
    html += `<p class="muted">Abfahrten ab ${C.fmtTime(now)} Uhr (Soll-Fahrplan)</p>`;
    if (!deps.length) html += '<p class="empty">In den nächsten 8 Stunden fährt hier laut Fahrplan kein Bus ab.</p>';
    for (const d of deps) {
      const mins = Math.round((d.abs - now) / 60);
      html += `<div class="dep"><span class="time">${C.fmtTime(d.abs)}</span>${badge(d.line)}<span class="grow">${esc(d.headsign)}<br><small>${mins <= 0 ? 'jetzt' : mins < 60 ? 'in ' + mins + ' min' : ''}${esc(dayLabel(d.abs, now))}</small></span></div>`;
    }
    const box = $('#stop-detail');
    box.innerHTML = html;
    box.hidden = false;
    $('#stop-search').hidden = true;
    $('#tab-stops').scrollTop = 0;
  }
  function backToStops() {
    $('#stop-detail').hidden = true;
    $('#stop-search').hidden = false;
    state.openGroup = null;
  }

  function locateNear() {
    if (!navigator.geolocation) { renderStopResults([]); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => renderStopResults(C.groupsNear(idx, pos.coords.latitude, pos.coords.longitude, 15)),
      () => { $('#stop-results').innerHTML = '<div class="error">Standort nicht verfügbar. Bitte Standortfreigabe erlauben oder die Haltestelle suchen.</div>'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  /* ---------- Verbindung ---------- */
  function setPlace(key, gid) {
    state[key] = gid;
    $('#' + key + '-q').value = idx.groups[gid].name;
    $('#' + key + '-s').hidden = true;
  }
  function attachSuggest(key) {
    const input = $('#' + key + '-q'), box = $('#' + key + '-s');
    input.addEventListener('input', () => {
      state[key] = null;
      const res = C.searchGroups(idx, input.value, 8);
      box.innerHTML = res.map((g) => `<button type="button" data-g="${g.id}">${esc(g.name)}</button>`).join('');
      box.hidden = !res.length;
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (b) setPlace(key, +b.dataset.g);
    });
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 200));
  }
  function resolve(key) {
    if (state[key] !== null) return true;
    const r = C.searchGroups(idx, $('#' + key + '-q').value, 1)[0];
    if (!r) return false;
    setPlace(key, r.id);
    return true;
  }

  function searchTrips() {
    const out = $('#trip-results');
    if (!resolve('from') || !resolve('to')) {
      out.innerHTML = '<div class="error">Bitte Start und Ziel als Haltestelle eingeben.</div>';
      return;
    }
    const [y, m, d] = $('#trip-date').value.split('-').map(Number);
    const [hh, mm] = ($('#trip-time').value || '00:00').split(':').map(Number);
    if (!y) { out.innerHTML = '<div class="error">Bitte ein Datum wählen.</div>'; return; }
    const depAbs = C.toAbs(idx, new Date(y, m - 1, d, hh, mm));
    const dayIdx = C.dayIndexOf(depAbs);
    if (dayIdx < 0 || dayIdx >= idx.meta.days) {
      out.innerHTML = `<div class="error">Für dieses Datum sind keine Fahrplandaten vorhanden (Daten gelten ab ${esc(idx.meta.base)} für ${idx.meta.days} Tage).</div>`;
      return;
    }
    out.innerHTML = '<p class="empty">Suche …</p>';
    setTimeout(() => {
      const t0 = performance.now();
      const res = C.planMany(idx, state.from, state.to, depAbs, { count: 5 });
      state.trips = res;
      if (!res.length) {
        out.innerHTML = '<p class="empty">Keine Busverbindung gefunden (bis zu 4 Umstiege, nur Bus, Fußwege bis 250 m).</p>';
        return;
      }
      out.innerHTML = res.map((it, i) => renderTrip(it, i, depAbs)).join('') +
        `<p class="muted" style="font-size:.75rem">Berechnet in ${Math.round(performance.now() - t0)} ms · Soll-Fahrplan ohne Echtzeit</p>`;
    }, 30);
  }

  function renderTrip(it, i, ref) {
    const dur = Math.round((it.arr - it.dep) / 60);
    const tr = it.transfers === 0 ? 'direkt' : it.transfers + '× umsteigen';
    let html = `<div class="trip"><div class="trip-head"><b>${C.fmtTime(it.dep)} → ${C.fmtTime(it.arr)}${esc(dayLabel(it.arr, ref) && C.dayIndexOf(it.arr) !== C.dayIndexOf(it.dep) ? ' (+1)' : '')}</b><button type="button" class="small" data-act="map-trip" data-i="${i}">Auf Karte</button></div><div class="muted">${dur} min · ${tr}${C.dayIndexOf(it.dep) !== C.dayIndexOf(ref) ? esc(dayLabel(it.dep, ref)) : ''}</div>`;
    for (const l of it.legs) {
      if (l.type === 'walk') {
        const a = idx.stops.n[l.from], b = idx.stops.n[l.to];
        html += `<div class="leg walk">🚶 ${a === b ? `Steigwechsel an der Haltestelle ${esc(a)}` : `Fußweg ${esc(a)} → ${esc(b)}`}, ca. ${Math.ceil(l.secs / 60)} min</div>`;
      } else {
        html += `<div class="leg">${badge(l.line)}<div><b>${esc(idx.stops.n[l.from])}</b> ${C.fmtTime(l.dep)} → <b>${esc(idx.stops.n[l.to])}</b> ${C.fmtTime(l.arr)}<br><small class="muted">Richtung ${esc(l.headsign)} · ${l.alightPos - l.boardPos} Halte</small></div></div>`;
      }
    }
    return html + '</div>';
  }

  /* ---------- Karte ---------- */
  function ensureMap() {
    if (map) return;
    map = L.map('map').setView([48.7758, 9.1829], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    map.on('moveend', drawStops);
    drawStops();
    $('#map').addEventListener('click', (e) => {
      const a = e.target.closest('[data-group]');
      if (a) { e.preventDefault(); openStop(+a.dataset.group); }
    });
  }
  function drawStops() {
    stopLayer.clearLayers();
    if (map.getZoom() < 14) return;
    const b = map.getBounds();
    let n = 0;
    for (const g of idx.groups) {
      if (g.lat < b.getSouth() || g.lat > b.getNorth() || g.lon < b.getWest() || g.lon > b.getEast()) continue;
      if (++n > 500) break;
      L.circleMarker([g.lat, g.lon], { radius: 5, weight: 2, color: '#0b6b3a', fillColor: '#fff', fillOpacity: 1 })
        .bindPopup(`<b>${esc(g.name)}</b><br><a href="#" data-group="${g.id}">Abfahrten anzeigen</a>`)
        .addTo(stopLayer);
    }
  }
  function stopLatLng(s) { return [idx.stops.la[s], idx.stops.lo[s]]; }
  function showOnMap(build) {
    showTab('map');
    mapLayer.clearLayers();
    const pts = build(mapLayer) || [];
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
  }
  function mapPattern(pi) {
    const p = idx.patterns[pi];
    showOnMap((layer) => {
      const line = p.sh && p.sh.length > 1 ? p.sh : p.s.map(stopLatLng);
      L.polyline(line, { color: COLORS[0], weight: 5, opacity: 0.85 }).addTo(layer);
      p.s.forEach((s, i) => {
        const m = L.circleMarker(stopLatLng(s), { radius: 4, weight: 2, color: COLORS[0], fillColor: '#fff', fillOpacity: 1 }).addTo(layer);
        m.bindTooltip(esc(idx.stops.n[s]), { direction: 'top' });
        m.on('click', () => openStop(idx.groupOf[s]));
      });
      return line;
    });
  }
  function mapStop(gid) {
    const g = idx.groups[gid];
    showOnMap((layer) => {
      L.marker([g.lat, g.lon]).addTo(layer).bindTooltip(esc(g.name), { permanent: true, direction: 'top' });
      return [[g.lat, g.lon]];
    });
    map.setView([g.lat, g.lon], 16);
  }
  function mapTrip(i) {
    const it = state.trips[i];
    if (!it) return;
    showOnMap((layer) => {
      const all = [];
      let c = 0;
      for (const l of it.legs) {
        if (l.type === 'walk') {
          const pts = [stopLatLng(l.from), stopLatLng(l.to)];
          L.polyline(pts, { color: '#6b7280', weight: 4, dashArray: '6 8' }).addTo(layer);
          all.push(...pts);
        } else {
          const p = idx.patterns[l.pi];
          const pts = p.s.slice(l.boardPos, l.alightPos + 1).map(stopLatLng);
          const col = COLORS[c++ % COLORS.length];
          L.polyline(pts, { color: col, weight: 6, opacity: 0.9 }).addTo(layer).bindTooltip('Linie ' + esc(l.line), { sticky: true });
          L.circleMarker(pts[0], { radius: 7, color: col, fillColor: '#fff', fillOpacity: 1, weight: 3 }).addTo(layer).bindTooltip(esc(idx.stops.n[l.from]) + ' ' + C.fmtTime(l.dep));
          L.circleMarker(pts[pts.length - 1], { radius: 7, color: col, fillColor: col, fillOpacity: 1, weight: 3 }).addTo(layer).bindTooltip(esc(idx.stops.n[l.to]) + ' ' + C.fmtTime(l.arr));
          all.push(...pts);
        }
      }
      return all;
    });
  }

  /* ---------- Ereignisse ---------- */
  function bind() {
    $('#line-q').addEventListener('input', renderLines);
    $('#ride-sel').addEventListener('change', renderLines);
    $('#kreis-sel').addEventListener('change', () => {
      try { localStorage.setItem(KREIS_KEY, $('#kreis-sel').value); } catch (e) { /* egal */ }
      renderLines();
    });
    $('#rides-export').addEventListener('click', exportRides);
    $('#rides-import').addEventListener('click', () => $('#rides-file').click());
    $('#rides-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importRides(f);
      e.target.value = '';
    });
    $('#stop-q').addEventListener('input', () => {
      const q = $('#stop-q').value;
      renderStopResults(q.trim() ? C.searchGroups(idx, q, 30).map((g) => ({ g, d: null })) : []);
    });
    $('#near-btn').addEventListener('click', locateNear);
    attachSuggest('from');
    attachSuggest('to');
    $('#swap').addEventListener('click', () => {
      const a = state.from, b = state.to, ta = $('#from-q').value, tb = $('#to-q').value;
      state.from = b; state.to = a;
      $('#from-q').value = tb; $('#to-q').value = ta;
    });
    $('#trip-go').addEventListener('click', searchTrips);

    document.addEventListener('click', (e) => {
      const tick = e.target.closest('[data-tick]');
      if (tick) { toggleRide(tick.dataset.tick); return; }
      const el = e.target.closest('[data-line],[data-group],[data-act]');
      if (!el || el.closest('#map')) return;
      if (el.dataset.act) {
        const g = +el.dataset.group;
        switch (el.dataset.act) {
          case 'back-lines': backToLines(); break;
          case 'back-stops': backToStops(); break;
          case 'map-pattern': mapPattern(+el.dataset.pi); break;
          case 'map-stop': mapStop(g); break;
          case 'map-trip': mapTrip(+el.dataset.i); break;
          case 'refresh': openStop(g); break;
          case 'from-here': setPlace('from', g); showTab('trip'); break;
          case 'to-here': setPlace('to', g); showTab('trip'); break;
        }
        return;
      }
      if (el.dataset.line !== undefined) openLine(el.dataset.line);
      else if (el.dataset.group !== undefined) openStop(+el.dataset.group);
    });
  }

  init();
})();
