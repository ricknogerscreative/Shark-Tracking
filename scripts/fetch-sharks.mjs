#!/usr/bin/env node
/**
 * Fetches live shark tracking data from the OCEARCH Shark Tracker and writes a
 * compact snapshot to data/sharks.json.
 *
 * Two providers are tried in order; the first that yields sharks wins:
 *
 *   1. Legacy OCEARCH JSON  — https://www.ocearch.org/tracker/ajax/filter-sharks
 *      One request returns every animal; pings come inline or from
 *      /tracker/ajax/get-pings?shark_id={id}. This is the endpoint most OCEARCH
 *      community tools use.
 *
 *   2. Mapotic public API   — https://map.ocearch.org/api/v1/maps/{mapId}/...
 *      The current tracker backend (docs: https://mapotic.github.io/mapotic.com-api-docs/).
 *      The map id is discovered at runtime, or pinned with MAPOTIC_MAP_ID.
 *
 * Both parsers are deliberately defensive about field names so a backend tweak
 * doesn't break the pipeline. Usage: node scripts/fetch-sharks.mjs [--out FILE]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "data/sharks.json";

const UA =
  "SharkTrackingDashboard/1.0 (+https://github.com/ricknogerscreative/Shark-Tracking; educational, non-commercial)";
const TIMEOUT_MS = 25_000;
const CONCURRENCY = 6;
const MAX_TRACK_POINTS = 300; // most recent kept per animal, keeps the snapshot lean

// ---------- http ----------

async function get(url, { json = true, headers = {}, timeout = TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: json ? "application/json, text/plain, */*" : "*/*",
      "X-Requested-With": "XMLHttpRequest",
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!json) return res.text();
  // Some endpoints mislabel content-type; parse text as JSON defensively.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url} (starts: ${text.slice(0, 60)})`);
  }
}

async function tryGet(url, opts) {
  try {
    return await get(url, opts);
  } catch (e) {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- geo / time ----------

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toEpochMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function trackStats(track) {
  let total = 0;
  let last30 = 0;
  const cutoff = Date.now() - 30 * 864e5;
  for (let i = 1; i < track.length; i++) {
    const [lat1, lng1] = track[i - 1];
    const [lat2, lng2, ts] = track[i];
    const d = haversineKm(lat1, lng1, lat2, lng2);
    if (d > 1000) continue; // ignore absurd jumps from bad satellite fixes
    total += d;
    if (ts && ts >= cutoff) last30 += d;
  }
  return { totalKm: Math.round(total), last30Km: Math.round(last30) };
}

const cleanText = (s) =>
  (s == null ? "" : String(s))
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Build a normalized track [[lat,lng,epochMs],...] from an array of ping-ish rows. */
function pingsToTrack(rows) {
  const pts = [];
  for (const r of rows ?? []) {
    if (!r) continue;
    let lat, lng;
    const coords = r?.geometry?.coordinates ?? r?.point?.coordinates; // GeoJSON Point [lng,lat]
    if (Array.isArray(coords)) {
      [lng, lat] = coords;
    } else if (Array.isArray(r) && r.length >= 2) {
      [lat, lng] = [num(r[0]), num(r[1])];
    } else {
      lat = num(r.lat ?? r.latitude ?? r.y);
      lng = num(r.lng ?? r.lon ?? r.long ?? r.longitude ?? r.x);
    }
    const ts = toEpochMs(
      r.dt_move ?? r.datetime ?? r.date ?? r.pingTime ?? r.ping_time ?? r.timestamp ?? r.time ??
        r.created ?? r.properties?.datetime ?? r.properties?.created
    );
    if (typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      // 4 decimals ≈ 11 m — ample for a world map, and keeps the file small.
      pts.push([+lat.toFixed(4), +lng.toFixed(4), ts]);
    }
  }
  pts.sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0));
  return pts.slice(-MAX_TRACK_POINTS);
}

/** Turn a finished shark object into the snapshot record, computing stats. */
function finalize(base, track) {
  const { totalKm, last30Km } = trackStats(track);
  const lastFromTrack = track.length ? track[track.length - 1] : null;
  const lat = base.lat ?? (lastFromTrack ? lastFromTrack[0] : null);
  const lng = base.lng ?? (lastFromTrack ? lastFromTrack[1] : null);
  const lastPingAt = (lastFromTrack && lastFromTrack[2]) || base.lastPingAt || null;
  return {
    id: base.id,
    name: base.name || `Animal ${base.id}`,
    category: base.category ?? null,
    species: base.species ?? base.category ?? null,
    gender: base.gender ?? null,
    length: base.length ?? null,
    weight: base.weight ?? null,
    stage: base.stage ?? null,
    tagDate: base.tagDate ?? null,
    tagLocation: base.tagLocation ?? null,
    image: base.image ?? null,
    description: cleanText(base.description).slice(0, 500) || null,
    lat: typeof lat === "number" ? +lat.toFixed(5) : null,
    lng: typeof lng === "number" ? +lng.toFixed(5) : null,
    lastPingAt,
    pingCount: track.length || base.pingCount || null,
    distanceTotalKm: track.length > 1 ? totalKm : base.distanceReported ?? null,
    distance30dKm: track.length > 1 ? last30Km : null,
    track,
  };
}

// ---------- provider 1: legacy OCEARCH JSON ----------

async function fetchLegacy() {
  const roots = ["https://www.ocearch.org", "https://ocearch.org"];
  let sharksRaw = null;
  let root = null;
  for (const r of roots) {
    for (const path of ["/tracker/ajax/filter-sharks", "/tracker/ajax/filter-sharks/"]) {
      const data = await tryGet(`${r}${path}`);
      const arr = Array.isArray(data) ? data : data?.sharks ?? data?.data;
      if (Array.isArray(arr) && arr.length) {
        sharksRaw = arr;
        root = r;
        break;
      }
    }
    if (sharksRaw) break;
  }
  if (!sharksRaw) return null;
  const sharkId = (s) => s.id ?? s.shark_id ?? s.tagId ?? s.name;
  const inlinePings = (s) => s.pings ?? s.pingCollection ?? s.locations ?? s.track;
  console.log(`Legacy provider: ${sharksRaw.length} animals from ${root}/tracker/ajax/filter-sharks`);

  // Decide the ping strategy ONCE (avoid per-shark timeout storms):
  //   - if the list already carries inline pings, use them;
  //   - else probe get-pings variants on the first shark to find a working
  //     template; if none answer, skip pings and use latest position only.
  const hasInline = sharksRaw.some((s) => Array.isArray(inlinePings(s)) && inlinePings(s).length);
  let pingTemplate = null;
  if (!hasInline) {
    const probeId = sharkId(sharksRaw[0]);
    for (const build of [
      (id) => `${root}/tracker/ajax/get-pings?shark_id=${encodeURIComponent(id)}`,
      (id) => `${root}/tracker/ajax/getPings?shark_id=${encodeURIComponent(id)}`,
      (id) => `${root}/tracker/ajax/filter-pings?shark_id=${encodeURIComponent(id)}`,
    ]) {
      const pd = await tryGet(build(probeId), { timeout: 12_000 });
      const arr = Array.isArray(pd) ? pd : pd?.pings ?? pd?.data;
      if (Array.isArray(arr) && arr.length) {
        pingTemplate = build;
        break;
      }
    }
    console.log(`Legacy pings: ${hasInline ? "inline" : pingTemplate ? "per-shark endpoint" : "unavailable (positions only)"}`);
  }

  return mapLimit(sharksRaw, CONCURRENCY, async (s) => {
    const id = sharkId(s);
    const base = {
      id,
      name: cleanText(s.name),
      category: cleanText(s.species) || null,
      species: cleanText(s.species) || null,
      gender: cleanText(s.gender || s.sex) || null,
      length: cleanText(s.length) || null,
      weight: cleanText(s.weight) || null,
      stage: cleanText(s.stageOfLife || s.stage_of_life || s.lifeStage) || null,
      tagDate: cleanText(s.tagDate || s.tag_date || s.dateTagged) || null,
      tagLocation: cleanText(s.tagLocation || s.tag_location) || null,
      image: s.profile || s.image || s.thumb_url || s.thumbUrl || null,
      description: s.description || s.bio || "",
      lat: num(s.lat ?? s.latitude),
      lng: num(s.lng ?? s.lon ?? s.long ?? s.longitude),
      lastPingAt: toEpochMs(s.pingTime ?? s.ping_time ?? s.lastPing ?? s.tagDate),
      distanceReported: num(s.dist ?? s.distance),
      pingCount: num(s.pingCount ?? s.pings_count),
    };

    let track = [];
    const inline = inlinePings(s);
    if (Array.isArray(inline) && inline.length) {
      track = pingsToTrack(inline);
    } else if (pingTemplate && id != null) {
      const pd = await tryGet(pingTemplate(id), { timeout: 12_000 });
      const arr = Array.isArray(pd) ? pd : pd?.pings ?? pd?.data;
      if (Array.isArray(arr) && arr.length) track = pingsToTrack(arr);
    }
    return finalize(base, track);
  });
}

// ---------- provider 2: Mapotic ----------

const SHARKY = /shark|ocearch|white shark|tiger shark|mako|hammerhead|marine|turtle|seal|dolphin|whale/i;

/**
 * Confirm a candidate map really is the OCEARCH tracker — not just any Mapotic
 * map. We check the map's own name/domain/slug and, failing that, whether its
 * POI categories look like tracked marine animals. This is what stops discovery
 * from silently locking onto an unrelated public map.
 */
async function verifyMap(id, bases) {
  for (const base of bases) {
    const detail = await tryGet(`${base}/api/v1/maps/${id}/`);
    const nameBlob = JSON.stringify([
      detail?.name, detail?.title, detail?.slug, detail?.domain, detail?.subdomain,
    ]);
    let sharky = detail && SHARKY.test(nameBlob);

    const probe = await tryGet(`${base}/api/v1/maps/${id}/pois.geojson/?limit=30`);
    const feats = probe?.features;
    if (!Array.isArray(feats) || !feats.length) continue;

    if (!sharky) {
      const catBlob = feats
        .map((f) => JSON.stringify(f?.properties?.category?.name ?? f?.properties?.category ?? ""))
        .join(" ");
      sharky = SHARKY.test(catBlob);
    }
    if (sharky) {
      console.log(`  verified map ${id} on ${base} (name=${detail?.name ?? "?"}, ${feats.length}+ pois)`);
      return { mapId: Number(id), base, name: detail?.name ?? null };
    }
    console.log(`  rejected map ${id} on ${base} (name=${detail?.name ?? "?"}) — not marine-tracking`);
  }
  return null;
}

// OCEARCH's Mapotic map id, confirmed at runtime (map name "Ocearch"). Kept as
// a fast, reliable default; discovery still runs and re-verifies, so if OCEARCH
// ever re-publishes under a new id the scraper/name-resolver will find it.
const KNOWN_OCEARCH_MAP_ID = 3413;

async function discoverMapId(bases) {
  const candidates = [];
  const add = (v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !candidates.includes(n)) candidates.push(n);
  };
  if (process.env.MAPOTIC_MAP_ID) add(process.env.MAPOTIC_MAP_ID);
  add(KNOWN_OCEARCH_MAP_ID);

  // 1. Resolve the map by name/domain/slug through Mapotic's API. Among any
  //    results, prefer entries whose name looks like OCEARCH's tracker.
  const resolvers = [
    "https://map.ocearch.org/api/v1/maps/",
    "https://www.mapotic.com/api/v1/maps/?domain=map.ocearch.org",
    "https://www.mapotic.com/api/v1/maps/?search=ocearch",
    "https://www.mapotic.com/api/v1/maps/?query=ocearch",
    "https://www.mapotic.com/api/v1/public-maps/?search=ocearch",
  ];
  const named = [];
  for (const url of resolvers) {
    const data = await tryGet(url);
    const rows = Array.isArray(data) ? data : data?.results ?? data?.maps ?? (data?.id ? [data] : []);
    for (const r of rows ?? []) {
      if (!r?.id) continue;
      add(r.id);
      if (SHARKY.test(JSON.stringify([r.name, r.title, r.slug, r.domain]))) named.unshift(Number(r.id));
    }
  }

  // 2. Scan the tracker HTML *and any JS bundles it references* for the id —
  //    the SPA bakes its map id into the built JavaScript, not the raw HTML.
  for (const page of ["https://map.ocearch.org/", "https://www.mapotic.com/ocearch"]) {
    const html = await tryGet(page, { json: false });
    if (!html) continue;
    const scan = (text) => {
      for (const m of text.matchAll(/maps\/(\d{2,7})\//g)) add(m[1]);
      for (const m of text.matchAll(/["']?map[_-]?id["']?\s*[:=]\s*["']?(\d{2,7})/gi)) add(m[1]);
    };
    scan(html);
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1]);
    for (const src of scripts.slice(0, 8)) {
      const abs = src.startsWith("http") ? src : new URL(src, page).href;
      const js = await tryGet(abs, { json: false, timeout: 12_000 });
      if (js) scan(js);
    }
  }

  // Try name-matched candidates first, then the rest — each is verified as
  // genuinely marine before being accepted, so order is just an optimization.
  const ordered = [...new Set([...named, ...candidates])];
  console.log(`Mapotic discovery: candidate ids [${ordered.join(", ") || "none"}]`);
  for (const id of ordered) {
    const ok = await verifyMap(id, bases);
    if (ok) return ok;
  }
  console.log("Mapotic discovery: no candidate verified as an OCEARCH/marine map");
  return null;
}

async function fetchMapotic() {
  const bases = ["https://map.ocearch.org", "https://www.mapotic.com"];
  const found = await discoverMapId(bases);
  if (!found) return null;
  const { mapId, base } = found;
  console.log(`Mapotic provider: map id ${mapId} on ${base}`);

  const geo = await get(`${base}/api/v1/maps/${mapId}/pois.geojson/?image=240x240`);
  let features = geo?.features ?? [];
  if (!features.length) return null;

  const probeId = features[0]?.properties?.id;

  // Optional diagnostics: dump the real detail + motion JSON shapes so parsing
  // can be matched exactly. Enable with DEBUG_SHAPES=1.
  if (process.env.DEBUG_SHAPES) {
    console.log("DEBUG feature.properties:", JSON.stringify(features[0]?.properties)?.slice(0, 1200));
    const detail = await tryGet(`${base}/api/v1/maps/${mapId}/public-pois/${probeId}/`);
    console.log("DEBUG detail keys:", detail && Object.keys(detail).join(","));
    console.log("DEBUG detail:", JSON.stringify(detail)?.slice(0, 2500));
    for (const url of [
      `${base}/api/v1/maps/${mapId}/pois/${probeId}/motion/`,
      `${base}/api/v1/maps/${mapId}/public-pois/${probeId}/motion/`,
      `${base}/api/v1/maps/${mapId}/pois/${probeId}/motion/?limit=3`,
      `${base}/api/v1/maps/${mapId}/pois/${probeId}/track/`,
      `${base}/api/v1/maps/${mapId}/pois/${probeId}/history/`,
      `${base}/api/v1/pois/${probeId}/motion/`,
    ]) {
      const m = await tryGet(url);
      console.log(`DEBUG motion ${url} -> ${m ? JSON.stringify(m).slice(0, 400) : "null"}`);
    }
  }

  const limit = Number(process.env.FETCH_LIMIT) || 0;
  if (limit > 0) features = features.slice(0, limit);

  const motionCandidates = (id) => [
    `${base}/api/v1/maps/${mapId}/pois/${id}/motion/`,
    `${base}/api/v1/maps/${mapId}/public-pois/${id}/motion/`,
    `${base}/api/v1/maps/${mapId}/pois/${id}/track/`,
    `${base}/api/v1/pois/${id}/motion/`,
  ];
  let motionTemplate = null;
  for (const url of motionCandidates(probeId)) {
    const m = await tryGet(url);
    if (m && pingsToTrack(Array.isArray(m) ? m : m.features ?? m.results ?? m.data ?? m.motion ?? []).length) {
      motionTemplate = url.replace(`/${probeId}/`, "/{id}/");
      break;
    }
  }
  console.log(`Mapotic motion endpoint: ${motionTemplate ?? "none (trails unavailable)"}`);

  // Everything the cards need is already in the GeoJSON feature properties
  // (species, size, sex, image, tag location), so we skip the per-POI detail
  // call entirely and only fetch each animal's motion history for its trail.
  return mapLimit(features, CONCURRENCY, async (f) => {
    const p = f.properties ?? {};
    const id = p.id;
    const [lng, lat] = f.geometry?.coordinates ?? [];

    let track = [];
    if (motionTemplate) {
      const motion = await tryGet(motionTemplate.replace("{id}", id));
      if (motion) {
        track = pingsToTrack(
          Array.isArray(motion) ? motion : motion.features ?? motion.results ?? motion.data ?? motion.motion ?? []
        );
      }
    }

    const category = p.category_name?.en ?? p.category_name ?? null;
    // "White Shark (Carcharodon carcharias)" -> "White Shark" for the card line.
    const species = (p.species ?? category)?.toString().replace(/\s*\([^)]*\)\s*$/, "").trim() || null;

    return finalize(
      {
        id,
        name: p.name ?? `Animal ${id}`,
        category,
        species,
        gender: p.gender ?? null,
        length: p.length ?? null,
        weight: p.weight ?? null,
        stage: p.stage_of_life ?? null,
        tagDate: p.tagging_date ?? null,
        tagLocation: p.tag_location ?? null,
        image: p.image ?? null,
        description: p.species && category && p.species !== category ? `${p.species}` : "",
        lat: num(lat),
        lng: num(lng),
        // last motion ping wins in finalize(); these are fallbacks for animals
        // whose motion history is empty.
        lastPingAt: toEpochMs(p.zping_datetime ?? p.last_move_datetime ?? p.last_update),
      },
      track
    );
  });
}

// ---------- main ----------

async function main() {
  const providers = [
    { name: "OCEARCH legacy JSON", run: fetchLegacy, meta: { name: "OCEARCH Shark Tracker (legacy JSON API)", base: "https://www.ocearch.org", endpoint: "/tracker/ajax/filter-sharks" } },
    { name: "Mapotic public API", run: fetchMapotic, meta: { name: "OCEARCH Shark Tracker (via Mapotic public API)", base: "https://map.ocearch.org", endpoint: "/api/v1/maps/{id}/pois.geojson" } },
  ];

  let sharks = null;
  let used = null;
  for (const p of providers) {
    try {
      console.log(`Trying provider: ${p.name}…`);
      const result = await p.run();
      if (result && result.length) {
        sharks = result;
        used = p;
        break;
      }
      console.log(`  ${p.name}: no data`);
    } catch (e) {
      console.log(`  ${p.name} failed: ${e.message}`);
    }
  }

  if (!sharks) throw new Error("All providers failed — no live shark data available");

  const valid = sharks.filter((s) => s.lat != null && s.lng != null);
  valid.sort((a, b) => (b.lastPingAt ?? 0) - (a.lastPingAt ?? 0));

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: {
      name: used.meta.name,
      site: "https://www.ocearch.org/tracker/",
      base: used.meta.base,
      endpoint: used.meta.endpoint,
    },
    count: valid.length,
    sharks: valid,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot));
  const withTracks = valid.filter((s) => s.track.length > 1).length;
  console.log(`Wrote ${OUT} via "${used.name}": ${valid.length} animals, ${withTracks} with trails`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
