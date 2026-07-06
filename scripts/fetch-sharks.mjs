#!/usr/bin/env node
/**
 * Fetches live shark tracking data from the OCEARCH Shark Tracker
 * (powered by Mapotic) and writes a compact snapshot to data/sharks.json.
 *
 * Public, key-free endpoints (documented at
 * https://mapotic.github.io/mapotic.com-api-docs/):
 *   GET {base}/api/v1/maps/{mapId}/pois.geojson/          all animals + last position
 *   GET {base}/api/v1/maps/{mapId}/public-pois/{poiId}/   animal detail (species, size, ...)
 *   GET {base}/api/v1/maps/{mapId}/pois/{poiId}/motion/   ping history (trail)
 *
 * The map id is discovered at runtime from the tracker page so this keeps
 * working if OCEARCH re-deploys. Override with env MAPOTIC_MAP_ID.
 *
 * Usage: node scripts/fetch-sharks.mjs [--out data/sharks.json]
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "data/sharks.json";

const BASES = ["https://map.ocearch.org", "https://www.mapotic.com"];
const MAP_SLUG = "ocearch";
const UA = "SharkTrackingDashboard/1.0 (github.com; educational, non-commercial)";
const TIMEOUT_MS = 25_000;
const CONCURRENCY = 6;
const MAX_TRACK_POINTS = 400; // per shark, most recent kept

// ---------- small utils ----------

async function get(url, { json = true } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return json ? res.json() : res.text();
}

async function tryGet(url, opts) {
  try {
    return await get(url, opts);
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

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
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// ---------- map id discovery ----------

async function discoverMapId() {
  if (process.env.MAPOTIC_MAP_ID) {
    return { mapId: Number(process.env.MAPOTIC_MAP_ID), base: BASES[0], how: "env" };
  }

  // Reuse the id from a previous snapshot if present (fast path, still verified below).
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, "utf8"))?.source?.mapId ?? null;
  } catch {}

  const patterns = [
    /api\/v1\/maps\/(\d+)\//i,
    /["']map[_-]?id["']\s*[:=]\s*["']?(\d+)/i,
    /maps\/(\d+)\/pois/i,
  ];

  const candidates = new Set();
  if (previous) candidates.add(Number(previous));

  for (const url of [
    `${BASES[0]}/`,
    `${BASES[1]}/${MAP_SLUG}`,
    `${BASES[1]}/${MAP_SLUG}/`,
  ]) {
    const html = await tryGet(url, { json: false });
    if (!html) continue;
    for (const p of patterns) {
      const m = html.match(p);
      if (m) candidates.add(Number(m[1]));
    }
    // Mapotic SPA embeds initial state; ids also appear in asset URLs.
    for (const m of html.matchAll(/\/maps\/(\d{2,7})\//g)) candidates.add(Number(m[1]));
  }

  // Verify each candidate actually serves POIs, on each base.
  for (const id of candidates) {
    for (const base of BASES) {
      const probe = await tryGet(`${base}/api/v1/maps/${id}/pois.geojson/?limit=1`);
      if (probe && (probe.type === "FeatureCollection" || Array.isArray(probe.features))) {
        return { mapId: id, base, how: previous === id ? "previous-snapshot" : "discovered" };
      }
    }
  }
  throw new Error(
    `Could not discover the OCEARCH Mapotic map id (tried: ${[...candidates].join(", ") || "none"}). ` +
      `Set the MAPOTIC_MAP_ID environment variable to pin it manually.`
  );
}

// ---------- attribute helpers ----------

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Pull "species", "length", etc. out of Mapotic's flexible attribute payloads. */
function extractAttributes(detail) {
  const found = {};
  const buckets = []
    .concat(detail?.attributes_values ?? [])
    .concat(detail?.attribute_values ?? [])
    .concat(detail?.attributes ?? []);
  for (const av of buckets) {
    if (!av || typeof av !== "object") continue;
    const name =
      av.attribute?.name?.en ??
      av.attribute?.name ??
      av.name?.en ??
      av.name ??
      av.attribute_name;
    let value =
      av.value?.en ?? av.value ?? av.choice?.name?.en ?? av.choice?.name ?? av.selected;
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
    raw: found,
  };
}

/** Normalize one motion payload into [[lat, lng, epochMs], ...] oldest→newest. */
function parseTrack(motion) {
  const rows = Array.isArray(motion)
    ? motion
    : motion?.features ?? motion?.results ?? motion?.data ?? motion?.motion ?? [];
  const pts = [];
  for (const r of rows) {
    if (!r) continue;
    let lat, lng;
    const g = r.geometry ?? r.point ?? r.position ?? r;
    if (Array.isArray(g?.coordinates)) {
      [lng, lat] = g.coordinates;
    } else if (Array.isArray(g) && g.length >= 2) {
      [lng, lat] = g;
    } else {
      lat = g?.lat ?? g?.latitude;
      lng = g?.lng ?? g?.lon ?? g?.longitude;
    }
    const ts = toEpochMs(
      r.created ?? r.date ?? r.timestamp ?? r.time ?? r.properties?.created ?? r.properties?.date
    );
    if (typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90) {
      pts.push([+lat.toFixed(5), +lng.toFixed(5), ts]);
    }
  }
  pts.sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0));
  return pts;
}

function trackStats(track) {
  let total = 0;
  let last30 = 0;
  const cutoff = Date.now() - 30 * 864e5;
  for (let i = 1; i < track.length; i++) {
    const [lat1, lng1] = track[i - 1];
    const [lat2, lng2, ts] = track[i];
    const d = haversineKm(lat1, lng1, lat2, lng2);
    if (d > 1000) continue; // guard against bad fixes producing absurd jumps
    total += d;
    if (ts && ts >= cutoff) last30 += d;
  }
  return { totalKm: Math.round(total), last30Km: Math.round(last30) };
}

// ---------- main ----------

async function main() {
  const { mapId, base, how } = await discoverMapId();
  console.log(`Using map id ${mapId} on ${base} (${how})`);

  const geo = await get(
    `${base}/api/v1/maps/${mapId}/pois.geojson/?image=240x240&extra_fields=created`
  );
  const features = geo?.features ?? [];
  console.log(`Fetched ${features.length} tracked animals`);
  if (!features.length) throw new Error("pois.geojson returned no features");

  // Work out which motion endpoint this deployment answers, using the first POI.
  const motionCandidates = (id) => [
    `${base}/api/v1/maps/${mapId}/pois/${id}/motion/`,
    `${base}/api/v1/maps/${mapId}/public-pois/${id}/motion/`,
    `${base}/api/v1/pois/${id}/motion/`,
  ];
  let motionTemplate = null;
  {
    const probeId = features[0]?.properties?.id;
    for (const url of motionCandidates(probeId)) {
      const m = await tryGet(url);
      if (m && parseTrack(m).length) {
        motionTemplate = url.replace(`/${probeId}/`, "/{id}/");
        break;
      }
    }
    console.log(`Motion endpoint: ${motionTemplate ?? "none found (trails disabled)"}`);
  }

  const sharks = await mapLimit(features, CONCURRENCY, async (f) => {
    const p = f.properties ?? {};
    const id = p.id;
    const [lng, lat] = f.geometry?.coordinates ?? [];

    const detail = await tryGet(`${base}/api/v1/maps/${mapId}/public-pois/${id}/`);
    const attrs = detail ? extractAttributes(detail) : {};

    let track = [];
    if (motionTemplate) {
      const motion = await tryGet(motionTemplate.replace("{id}", id));
      if (motion) track = parseTrack(motion).slice(-MAX_TRACK_POINTS);
    }
    const { totalKm, last30Km } = trackStats(track);

    const lastTs =
      track.length && track[track.length - 1][2]
        ? track[track.length - 1][2]
        : toEpochMs(p.last_position ?? p.created ?? detail?.updated ?? detail?.created);

    const category =
      p.category?.name?.en ?? p.category?.name ?? detail?.category?.name?.en ?? null;

    return {
      id,
      name: p.name ?? detail?.name ?? `Animal ${id}`,
      category,
      species: attrs.species ?? category,
      gender: attrs.gender ?? null,
      length: attrs.length ?? null,
      weight: attrs.weight ?? null,
      stage: attrs.stage ?? null,
      tagDate: attrs.tagDate ?? null,
      tagLocation: attrs.tagLocation ?? null,
      image: p.image ?? detail?.image?.url ?? detail?.image ?? null,
      description:
        (detail?.description?.en ?? detail?.description ?? "")
          .toString()
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500) || null,
      lat: typeof lat === "number" ? +lat.toFixed(5) : null,
      lng: typeof lng === "number" ? +lng.toFixed(5) : null,
      lastPingAt: lastTs,
      pingCount: track.length || null,
      distanceTotalKm: track.length > 1 ? totalKm : null,
      distance30dKm: track.length > 1 ? last30Km : null,
      track,
    };
  });

  const valid = sharks.filter((s) => s.lat != null && s.lng != null);
  valid.sort((a, b) => (b.lastPingAt ?? 0) - (a.lastPingAt ?? 0));

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: {
      name: "OCEARCH Shark Tracker (via Mapotic public API)",
      site: "https://www.ocearch.org/tracker/",
      base,
      mapId,
      motionEndpoint: motionTemplate,
    },
    count: valid.length,
    sharks: valid,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot));
  const withTracks = valid.filter((s) => s.track.length > 1).length;
  console.log(`Wrote ${OUT}: ${valid.length} animals, ${withTracks} with trails`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
