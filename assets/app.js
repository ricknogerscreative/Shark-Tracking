/* Live Shark Tracker — reads data/sharks.json (refreshed by a scheduled
   GitHub Action) and, when the Mapotic API allows cross-origin requests,
   overlays live positions fetched straight from the browser. */
(() => {
  "use strict";

  const DATA_URL = "data/sharks.json";
  const SNAPSHOT_POLL_MS = 5 * 60 * 1000; // re-read committed snapshot
  const LIVE_POLL_MS = 2 * 60 * 1000; // direct-API position refresh
  const FRESH_MS = 72 * 3600 * 1000;
  const RECENT_MS = 30 * 24 * 3600 * 1000;

  const els = {
    cards: document.getElementById("cards"),
    template: document.getElementById("card-template"),
    search: document.getElementById("search"),
    sort: document.getElementById("sort"),
    count: document.getElementById("result-count"),
    status: document.getElementById("status-text"),
    liveDot: document.getElementById("live-dot"),
    banner: document.getElementById("sample-banner"),
  };

  let snapshot = null;
  let selectedId = null;
  const markers = new Map(); // shark id -> Leaflet marker
  let trailLayer = null;

  // ---------- map ----------
  const map = L.map("map", {
    worldCopyJump: true,
    zoomControl: true,
    renderer: L.canvas(),
  }).setView([28, -45], 3);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 12,
    minZoom: 2,
  }).addTo(map);

  // ---------- helpers ----------
  const fmtKm = (km) => (km == null ? "—" : km >= 1000 ? `${(km / 1000).toFixed(1)}k km` : `${km.toLocaleString()} km`);

  function timeAgo(ts) {
    if (!ts) return "unknown";
    const s = (Date.now() - ts) / 1000;
    if (s < 0) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 30 * 86400) return `${Math.round(s / 86400)} d ago`;
    if (s < 365 * 86400) return `${Math.round(s / (30 * 86400))} mo ago`;
    return `${(s / (365 * 86400)).toFixed(1)} y ago`;
  }

  const recency = (ts) => {
    if (!ts) return "stale";
    const age = Date.now() - ts;
    return age <= FRESH_MS ? "fresh" : age <= RECENT_MS ? "recent" : "stale";
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- markers ----------
  function markerIcon(shark, selected) {
    const r = recency(shark.lastPingAt);
    const size = r === "fresh" ? 14 : r === "recent" ? 11 : 8;
    return L.divIcon({
      className: `shark-marker ${r}${selected ? " selected" : ""}`,
      iconSize: [size, size],
    });
  }

  function renderMarkers() {
    for (const shark of snapshot.sharks) {
      const existing = markers.get(shark.id);
      const pos = [shark.lat, shark.lng];
      if (existing) {
        existing.setLatLng(pos);
        existing.setIcon(markerIcon(shark, shark.id === selectedId));
      } else {
        const m = L.marker(pos, {
          icon: markerIcon(shark, false),
          title: shark.name,
          keyboard: false,
        }).addTo(map);
        m.bindPopup(() =>
          `<div class="popup-name">${esc(shark.name)}</div>` +
          `<div class="popup-sub">${esc(shark.species ?? "")}</div>` +
          `<div class="popup-sub">Last ping ${esc(timeAgo(shark.lastPingAt))}</div>`
        );
        m.on("click", () => selectShark(shark.id, { pan: false }));
        markers.set(shark.id, m);
      }
    }
  }

  // ---------- trail ----------
  function drawTrail(shark) {
    if (trailLayer) { trailLayer.remove(); trailLayer = null; }
    if (!shark?.track || shark.track.length < 2) return;

    const group = L.layerGroup();
    const latlngs = shark.track.map((p) => [p[0], p[1]]);
    L.polyline(latlngs, { color: "#4595e8", weight: 2, opacity: 0.85 }).addTo(group);

    const n = shark.track.length;
    shark.track.forEach((p, i) => {
      const last = i === n - 1;
      L.circleMarker([p[0], p[1]], {
        radius: last ? 6 : 3,
        color: last ? "#5ff0c8" : "#4595e8",
        fillColor: last ? "#5ff0c8" : "#0c1c2e",
        fillOpacity: 1,
        weight: last ? 2 : 1.5,
      })
        .bindTooltip(`${esc(shark.name)} — ${p[2] ? new Date(p[2]).toLocaleString() : "ping"}`)
        .addTo(group);
    });
    trailLayer = group.addTo(map);
  }

  function selectShark(id, { pan = true } = {}) {
    selectedId = id;
    const shark = snapshot.sharks.find((s) => s.id === id);
    if (!shark) return;

    for (const [sid, m] of markers) {
      const s = snapshot.sharks.find((x) => x.id === sid);
      if (s) m.setIcon(markerIcon(s, sid === id));
    }
    drawTrail(shark);

    if (pan) {
      if (shark.track?.length > 1) {
        map.fitBounds(L.latLngBounds(shark.track.map((p) => [p[0], p[1]])).pad(0.2), { maxZoom: 7 });
      } else {
        map.flyTo([shark.lat, shark.lng], 6);
      }
    }
    markers.get(id)?.openPopup();
    renderCards();
    document.querySelector(`.card[data-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---------- cards ----------
  function visibleSharks() {
    const q = els.search.value.trim().toLowerCase();
    let list = snapshot.sharks;
    if (q) {
      list = list.filter(
        (s) =>
          s.name?.toLowerCase().includes(q) ||
          s.species?.toLowerCase().includes(q) ||
          s.category?.toLowerCase().includes(q)
      );
    }
    const sort = els.sort.value;
    list = [...list].sort((a, b) => {
      if (sort === "name") return (a.name ?? "").localeCompare(b.name ?? "");
      if (sort === "distance") return (b.distance30dKm ?? -1) - (a.distance30dKm ?? -1);
      if (sort === "total") return (b.distanceTotalKm ?? -1) - (a.distanceTotalKm ?? -1);
      return (b.lastPingAt ?? 0) - (a.lastPingAt ?? 0);
    });
    return list;
  }

  function renderCards() {
    const list = visibleSharks();
    els.count.textContent = `${list.length} of ${snapshot.sharks.length} tracked animals`;
    els.cards.replaceChildren(
      ...list.map((shark) => {
        const node = els.template.content.firstElementChild.cloneNode(true);
        node.dataset.id = shark.id;
        if (shark.id === selectedId) node.classList.add("selected");

        const img = node.querySelector(".card-img");
        if (shark.image) {
          img.src = shark.image;
          img.alt = shark.name;
          img.hidden = false;
        }
        node.querySelector(".name").textContent = shark.name;
        node.querySelector(".species").textContent = [shark.species, shark.gender].filter(Boolean).join(" · ") || "Tracked animal";

        const r = recency(shark.lastPingAt);
        const dot = node.querySelector(".ping-dot");
        dot.classList.add(r);
        dot.title = `Last ping ${timeAgo(shark.lastPingAt)}`;

        node.querySelector(".last-ping").textContent = timeAgo(shark.lastPingAt);
        node.querySelector(".dist-30").textContent = fmtKm(shark.distance30dKm);
        node.querySelector(".dist-total").textContent = fmtKm(shark.distanceTotalKm);
        node.querySelector(".bio").textContent = shark.description ?? "";

        const meta = [];
        if (shark.length) meta.push(`Length ${shark.length}`);
        if (shark.weight) meta.push(`Weight ${shark.weight}`);
        if (shark.stage) meta.push(shark.stage);
        if (shark.pingCount) meta.push(`${shark.pingCount} pings`);
        node.querySelector(".meta").textContent = meta.join(" · ");

        const activate = () => selectShark(shark.id);
        node.addEventListener("click", activate);
        node.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
        });
        return node;
      })
    );
  }

  // ---------- status ----------
  function renderStatus() {
    const age = Date.now() - Date.parse(snapshot.generatedAt);
    const stale = age > 3 * 3600 * 1000;
    els.liveDot.classList.toggle("stale-data", stale);
    els.status.textContent = `${snapshot.count} sharks · data ${timeAgo(Date.parse(snapshot.generatedAt))}`;
    els.banner.hidden = !snapshot.sample;
  }

  // ---------- data loading ----------
  async function loadSnapshot() {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${DATA_URL}: HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.sharks)) throw new Error("Malformed snapshot");
    snapshot = data;
    renderMarkers();
    renderCards();
    renderStatus();
    if (selectedId) drawTrail(snapshot.sharks.find((s) => s.id === selectedId));
  }

  /* Progressive enhancement: if the Mapotic API sends CORS headers, pull
     latest positions straight from the source between snapshot commits. */
  async function refreshLivePositions() {
    const src = snapshot?.source;
    if (!src?.base || !src?.mapId) return;
    try {
      const res = await fetch(`${src.base}/api/v1/maps/${src.mapId}/pois.geojson/`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const geo = await res.json();
      let moved = 0;
      for (const f of geo.features ?? []) {
        const shark = snapshot.sharks.find((s) => s.id === f.properties?.id);
        const [lng, lat] = f.geometry?.coordinates ?? [];
        if (!shark || typeof lat !== "number") continue;
        if (Math.abs(shark.lat - lat) > 1e-4 || Math.abs(shark.lng - lng) > 1e-4) {
          shark.lat = lat;
          shark.lng = lng;
          shark.lastPingAt = Date.now();
          if (Array.isArray(shark.track)) shark.track.push([lat, lng, Date.now()]);
          moved++;
        }
      }
      if (moved) {
        renderMarkers();
        renderCards();
        els.status.textContent = `${snapshot.count} sharks · live · ${moved} just moved`;
      }
    } catch {
      /* No CORS or network hiccup — the committed snapshot remains the source. */
    }
  }

  // ---------- events ----------
  els.search.addEventListener("input", renderCards);
  els.sort.addEventListener("change", renderCards);

  // ---------- boot ----------
  loadSnapshot()
    .then(() => {
      setInterval(() => loadSnapshot().catch(() => {}), SNAPSHOT_POLL_MS);
      setInterval(refreshLivePositions, LIVE_POLL_MS);
      setInterval(renderStatus, 60 * 1000);
      refreshLivePositions();
    })
    .catch((err) => {
      els.status.textContent = "Could not load shark data";
      els.liveDot.classList.add("stale-data");
      console.error(err);
    });
})();
