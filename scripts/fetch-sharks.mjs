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
const MAX_TRACK_POINTS = 400;

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
    if (Array.isArray(r?.geometry?.coordinates)) {
      [lng, lat] = r.geometry.coordinates;
    } else if (Array.isArray(r) && r.length >= 2) {
      [lat, lng] = [num(r[0]), num(r[1])];
    } else {
      lat = num(r.lat ?? r.latitude ?? r.y);
      lng = num(r.lng ?? r.lon ?? r.long ?? r.longitude ?? r.x);
    }
    const ts = toEpochMs(
      r.datetime ?? r.date ?? r.pingTime ?? r.ping_time ?? r.timestamp ?? r.time ?? r.created ??
        r.properties?.datetime ?? r.properties?.created
    );
    if (typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      pts.push([+lat.toFixed(5), +lng.toFixed(5), ts]);
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

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function extractAttributes(detail) {
  const found = {};
  const buckets = []
    .concat(detail?.attributes_values ?? [])
    .concat(detail?.attribute_values ?? [])
    .concat(detail?.attributes ?? []);
  for (const av of buckets) {
    if (!av || typeof av !== "object") continue;
    const name =
      av.attribute?.name?.en ?? av.attribute?.name ?? av.name?.en ?? av.name ?? av.attribute_name;
    let value = av.value?.en ?? av.value ?? av.choice?.name?.en ?? av.choice?.name ?? av.selected;
    if (value && typeof value === "object") value = value.name ?? value.value ?? null;
    if (name != null && value != null && value !== "") found[norm(name)] = String(value);
  }
  const pick = (...keys) => {
    for (const k of keys) if (found[k]) return found[k];
    return null;
  };
  return {
    species: pick("species", "animaltype", "type"),
    gender: pick("gender", "sex"),
    length: pick("length", "totallength", "size"),
    weight: pick("weight", "mass"),
    stage: pick("stageoflife", "lifestage", "maturity"),
    tagDate: pick("taggingdate", "tagdate", "datetagged", "taggeddate"),
    tagLocation: pick("tagginglocation", "taglocation", "locationtagged"),
  };
}

async function verifyMap(id, bases) {
  for (const base of bases) {
    const probe = await tryGet(`${base}/api/v1/maps/${id}/pois.geojson/?limit=1`);
    if (probe && (probe.type === "FeatureCollection" || Array.isArray(probe.features))) {
      return { mapId: Number(id), base };
    }
  }
  return null;
}

async function discoverMapId(bases) {
  const candidates = new Set();
  if (process.env.MAPOTIC_MAP_ID) candidates.add(Number(process.env.MAPOTIC_MAP_ID));

  // 1. Ask the Mapotic API to resolve the map by its custom domain / slug.
  const resolvers = [
    "https://map.ocearch.org/api/v1/maps/",
    "https://www.mapotic.com/api/v1/maps/?domain=map.ocearch.org",
    "https://www.mapotic.com/api/v1/maps/?slug=ocearch",
    "https://www.mapotic.com/api/v1/maps/?subdomain=ocearch",
  ];
  for (const url of resolvers) {
    const data = await tryGet(url);
    const rows = Array.isArray(data) ? data : data?.results ?? data?.maps ?? (data?.id ? [data] : []);
    for (const r of rows) if (r?.id) candidates.add(Number(r.id));
  }

  // 2. Scrape the tracker HTML for an embedded map id.
  for (const url of ["https://map.ocearch.org/", "https://www.mapotic.com/ocearch"]) {
    const html = await tryGet(url, { json: false });
    if (!html) continue;
    for (const m of html.matchAll(/maps\/(\d{2,7})\//g)) candidates.add(Number(m[1]));
    for (const m of html.matchAll(/["']map[_-]?id["']\s*[:=]\s*["']?(\d{2,7})/gi)) candidates.add(Number(m[1]));
  }

  // 3. Documented example id as a last-resort candidate (verified below either way).
  candidates.add(2941);

  for (const id of candidates) {
    const ok = await verifyMap(id, bases);
    if (ok) return ok;
  }
  console.log(`Mapotic discovery: no verified id among {${[...candidates].join(", ")}}`);
  return null;
}

async function fetchMapotic() {
  const bases = ["https://map.ocearch.org", "https://www.mapotic.com"];
  const found = await discoverMapId(bases);
  if (!found) return null;
  const { mapId, base } = found;
  console.log(`Mapotic provider: map id ${mapId} on ${base}`);

  const geo = await get(`${base}/api/v1/maps/${mapId}/pois.geojson/?image=240x240`);
  const features = geo?.features ?? [];
  if (!features.length) return null;

  const motionCandidates = (id) => [
    `${base}/api/v1/maps/${mapId}/pois/${id}/motion/`,
    `${base}/api/v1/maps/${mapId}/public-pois/${id}/motion/`,
  ];
  let motionTemplate = null;
  const probeId = features[0]?.properties?.id;
  for (const url of motionCandidates(probeId)) {
    const m = await tryGet(url);
    if (m && pingsToTrack(Array.isArray(m) ? m : m.features ?? m.results ?? m.data ?? []).length) {
      motionTemplate = url.replace(`/${probeId}/`, "/{id}/");
      break;
    }
  }

  return mapLimit(features, CONCURRENCY, async (f) => {
    const p = f.properties ?? {};
    const id = p.id;
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const detail = await tryGet(`${base}/api/v1/maps/${mapId}/public-pois/${id}/`);
    const attrs = detail ? extractAttributes(detail) : {};
    let track = [];
    if (motionTemplate) {
      const motion = await tryGet(motionTemplate.replace("{id}", id));
      if (motion) track = pingsToTrack(Array.isArray(motion) ? motion : motion.features ?? motion.results ?? motion.data ?? []);
    }
    const category = p.category?.name?.en ?? p.category?.name ?? null;
    return finalize(
      {
        id,
        name: p.name ?? detail?.name ?? `Animal ${id}`,
        category,
        species: attrs.species ?? category,
        gender: attrs.gender,
        length: attrs.length,
        weight: attrs.weight,
        stage: attrs.stage,
        tagDate: attrs.tagDate,
        tagLocation: attrs.tagLocation,
        image: p.image ?? detail?.image?.url ?? detail?.image ?? null,
        description: detail?.description?.en ?? detail?.description ?? "",
        lat: num(lat),
        lng: num(lng),
        lastPingAt: toEpochMs(p.last_position ?? p.created ?? detail?.updated),
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
