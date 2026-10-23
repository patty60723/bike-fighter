// bike-fighter API (Cloudflare Worker + D1)
//
// GET  /stations        Taipei + New Taipei YouBike 2.0 stations with live counts
// POST /anger           record one batch of anger after checking it server-side
// GET  /stats           a station's anger totals and its current empty-station boss
// GET  /events          recent finished empty/full spells (the demand log)
// GET  /ntpc?page=N     raw New Taipei data (kept for pages from before /stations)
// cron, every minute    open/close empty-station spells from the live counts

const RADIUS = 100;              // m: you must be this close to the station
const GPS_SLACK = 50;            // m: at most this much of the reported GPS error is forgiven
const COOLDOWN = 30_000;         // ms between batches from one device
const COOLDOWN_GRACE = 2_000;    // ms: clocks and network delay
const MIN_GAP = 60;              // ms: taps closer than this are not a human finger
const MAX_SPEED = 30;            // m/s between two batches (about 108 km/h)
const BOSS_WINDOW = 10 * 60_000; // ms: the boss counts people from the last 10 minutes
const BOSS_TARGET = 20;          // people needed to defeat it
const TYPES = ['rent', 'ret'];

const TP_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';
const NTPC_URL = page =>
  `https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=${page}&size=1000`;
const SOURCES = [
  { city: '台北市', prefix: 'tp', load: async () => fetchRows(TP_URL) },
  { city: '新北市', prefix: 'nt', load: async () => {
      // the first two pages together cover New Taipei today; fetch them at once
      const first = await Promise.all([fetchRows(NTPC_URL(0)), fetchRows(NTPC_URL(1))]);
      let rows = first.flat();
      for (let page = 2, last = first[1]; page < 6 && last.length === 1000; page++) {
        last = await fetchRows(NTPC_URL(page));
        rows = rows.concat(last);
      }
      return rows;
    } },
];

// ---------- station data ----------

async function fetchRows(url) {
  const res = await fetch(url, { cf: { cacheTtl: 50, cacheEverything: true } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : (json.retVal || json.data || []);
}

// The two cities name the same fields differently; take the first name present, any letter case.
const RENT_KEYS = ['available_rent_bikes', 'sbi', 'sbi_quantity', 'available_bikes', 'availablerentbikes'];
const RET_KEYS = ['available_return_bikes', 'bemp', 'available_spaces', 'availablereturnbikes'];
function pick(row, names) {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find(k => k.toLowerCase() === n);
    if (k !== undefined && row[k] !== null && row[k] !== '') return Number(row[k]);
  }
  return NaN;
}
// '2026-10-22 18:05:12' (Taipei) or '20261022T180403' (New Taipei), Taiwan time
function parseTime(v) {
  const m = String(v || '').match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) || null : null;
}
function parseRows(rows, prefix) {
  const out = new Map(); // one station per id
  for (const x of rows) {
    if (x.act !== undefined && String(x.act) !== '1') continue;
    const s = {
      id: prefix + x.sno,
      name: String(x.sna || '').replace(/^YouBike2\.0_/, ''),
      area: String(x.sarea || ''),
      lat: Number(x.latitude ?? x.lat), lng: Number(x.longitude ?? x.lng),
      rent: pick(x, RENT_KEYS), ret: pick(x, RET_KEYS),
      time: parseTime(x.srcUpdateTime || x.infoTime || x.updateTime || x.mday),
    };
    // a station without counts is dropped: a false 0 would open an empty-station spell
    if ([s.lat, s.lng, s.rent, s.ret].every(Number.isFinite) && s.lat > 20) out.set(s.id, s);
  }
  return [...out.values()];
}

const SNAPSHOT_MAX_AGE = 3 * 60_000; // older than this (cron stalled?) → ask the cities directly
let memo = null; // per isolate; the upstream fetches are also cached by Cloudflare for 50 s
async function loadStations(env, { fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memo.updated < 30_000) return memo;
  if (!fresh && !env.STATION_FIXTURE) {
    // if D1 is unavailable (e.g. over the daily limit) fall through and ask the cities directly
    try {
      const row = await env.DB.prepare('SELECT body, updated FROM snapshot WHERE id = 1').first();
      if (row && Date.now() - row.updated < SNAPSHOT_MAX_AGE) return (memo = JSON.parse(row.body));
    } catch (e) { console.error('snapshot read failed', e.message); }
  }
  let data;
  if (env.STATION_FIXTURE) {
    // local development only: a JSON array of stations in the output shape
    data = { updated: Date.now(), cities: ['fixture'], errors: [], stations: JSON.parse(env.STATION_FIXTURE) };
  } else {
    const results = await Promise.allSettled(SOURCES.map(s => s.load()));
    data = { updated: Date.now(), cities: [], errors: [], stations: [], prefixes: [] };
    results.forEach((r, i) => {
      const src = SOURCES[i];
      const list = r.status === 'fulfilled' ? parseRows(r.value, src.prefix) : [];
      if (list.length) { data.cities.push(src.city); data.prefixes.push(src.prefix); data.stations.push(...list); }
      else data.errors.push(`${src.city}：${r.status === 'rejected' ? r.reason.message : '沒有可用的車數資料'}`);
    });
  }
  data.prefixes ??= [...new Set(data.stations.map(s => s.id.slice(0, 2)))];
  if (data.stations.length) memo = data;
  return data;
}

// ---------- helpers ----------

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const level = n => 31 - Math.clz32(n);
const isDevice = d => typeof d === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(d);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://patty60723.github.io').split(',').map(s => s.trim());
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
const json = (data, status, cors, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const fail = (status, error, message, cors, more = {}) => json({ ok: false, error, message, ...more }, status, cors);

// ---------- routes ----------

async function postAnger(request, env, cors) {
  const text = await request.text();
  if (text.length > 2000) return fail(413, 'too_large', '資料太大', cors);
  let b;
  try { b = JSON.parse(text); } catch { return fail(400, 'bad_json', '資料格式錯誤', cors); }
  const { device, sid, type } = b;
  const clicks = Math.floor(Number(b.clicks)), ms = Number(b.ms);
  const lat = Number(b.lat), lng = Number(b.lng), acc = Math.max(0, Number(b.acc) || 0);
  if (!isDevice(device) || typeof sid !== 'string' || !TYPES.includes(type)
      || !(clicks >= 2 && clicks <= 100000) || !(ms >= 0 && ms <= 3_600_000)
      || ![lat, lng].every(Number.isFinite)) return fail(400, 'bad_request', '欄位不完整或不正確', cors);

  const data = await loadStations(env);
  const s = data.stations.find(x => x.id === sid);
  if (!s) return fail(404, 'no_station', '找不到這個站點', cors);

  // a human can't tap faster than one tap per MIN_GAP ms
  if (clicks > ms / MIN_GAP + 1) return fail(422, 'too_fast', '點擊速度超過人手可能的速度', cors);

  const now = Date.now();
  const last = await env.DB.prepare('SELECT at, lat, lng FROM angers WHERE device = ? ORDER BY at DESC LIMIT 1').bind(device).first();
  if (last) {
    const wait = COOLDOWN - COOLDOWN_GRACE - (now - last.at);
    if (wait > 0) return fail(429, 'cooldown', '還在冷卻中', cors, { retryIn: Math.ceil((wait + COOLDOWN_GRACE) / 1000) });
    const speed = haversine(last, { lat, lng }) / Math.max(1, (now - last.at) / 1000);
    if (speed > MAX_SPEED) return fail(422, 'moved_too_fast', '和上一批的位置相比移動太快，位置可能不準', cors);
  }

  const dist = haversine(s, { lat, lng });
  if (dist > RADIUS + Math.min(acc, GPS_SLACK)) return fail(403, 'not_at_station', `你離站點 ${Math.round(dist)} 公尺`, cors, { dist: Math.round(dist) });

  const avail = s[type], counted = avail === 0 ? 1 : 0, lv = level(clicks);
  await env.DB.prepare('INSERT INTO angers (device, sid, type, clicks, level, counted, avail, lat, lng, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(device, sid, type, clicks, lv, counted, avail, lat, lng, now).run();
  statsMemo.delete(`${sid}:${type}`); // the sender should see their own batch at once
  return json({ ok: true, counted: !!counted, level: lv, avail, at: now }, 201, cors);
}

// Short-lived copies kept in this Worker's memory, so many phones looking at the same station
// share one set of D1 queries. (The Cache API doesn't work on workers.dev addresses.)
const STATS_TTL = 15_000, EVENTS_TTL = 60_000;
const statsMemo = new Map(), eventsMemo = new Map();

async function getStats(url, env, cors) {
  const sid = url.searchParams.get('sid'), type = url.searchParams.get('type'), me = url.searchParams.get('device');
  if (!sid || !TYPES.includes(type)) return fail(400, 'bad_request', '需要 sid 和 type', cors);
  const key = `${sid}:${type}`, hit = statsMemo.get(key);
  const raw = hit && Date.now() - hit.at < STATS_TTL ? hit.raw : await queryStats(env, sid, type);
  if (raw !== hit?.raw) { statsMemo.set(key, { at: Date.now(), raw }); if (statsMemo.size > 500) statsMemo.delete(statsMemo.keys().next().value); }
  const fighters = raw.fighters.map(r => ({ lv: r.lv, me: r.device === me }));
  return json({
    ok: true, sid, type,
    total: raw.total,
    spell: raw.spell, // the current empty/full spell, or null when the station has bikes/docks
    boss: raw.spell === null ? null : {
      windowMin: BOSS_WINDOW / 60000, target: BOSS_TARGET,
      people: fighters.length, defeated: fighters.length >= BOSS_TARGET,
      fighters: fighters.slice(0, 20), // levels only; other devices stay anonymous
    },
    history: raw.history,
  }, 200, cors, { 'Cache-Control': 'no-store' });
}

async function queryStats(env, sid, type) {
  const now = Date.now();
  const since = (await env.DB.prepare('SELECT since FROM empty_open WHERE sid = ? AND type = ?').bind(sid, type).first())?.since ?? null;
  // the boss only counts people from this spell, and at most the last 10 minutes of it
  const from = Math.max(now - BOSS_WINDOW, since ?? now);
  const [tot, ppl, boss, hist] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS sends, COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(level), 0) AS lv FROM angers WHERE sid = ? AND type = ? AND counted = 1').bind(sid, type),
    // people = devices, counted at most once per hour per station
    env.DB.prepare("SELECT COUNT(DISTINCT device || ':' || (at / 3600000)) AS people FROM angers WHERE sid = ? AND type = ? AND counted = 1").bind(sid, type),
    env.DB.prepare('SELECT device, MAX(level) AS lv FROM angers WHERE sid = ? AND type = ? AND counted = 1 AND at >= ? GROUP BY device ORDER BY lv DESC').bind(sid, type, from),
    env.DB.prepare('SELECT start, end, people, jump FROM empty_events WHERE sid = ? AND type = ? ORDER BY end DESC LIMIT 5').bind(sid, type),
  ]);
  const t = tot.results[0];
  let spell = null;
  if (since !== null) {
    const r = await env.DB.prepare('SELECT COUNT(DISTINCT device) AS people FROM angers WHERE sid = ? AND type = ? AND counted = 1 AND at >= ?').bind(sid, type, since).first();
    spell = { since, people: r.people };
  }
  return {
    total: { sends: t.sends, clicks: t.clicks, lv: t.lv, people: ppl.results[0].people },
    spell,
    fighters: boss.results, // device ids stay in memory here; only levels go out
    history: hist.results,
  };
}

async function getEvents(url, env, cors) {
  const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
  const hit = eventsMemo.get(limit);
  let events = hit && Date.now() - hit.at < EVENTS_TTL ? hit.events : null;
  if (!events) {
    events = (await env.DB.prepare('SELECT sid, type, name, start, end, people, jump FROM empty_events WHERE people > 0 ORDER BY end DESC LIMIT ?').bind(limit).all()).results;
    eventsMemo.set(limit, { at: Date.now(), events });
  }
  return json({ ok: true, events }, 200, cors, { 'Cache-Control': 'public, max-age=30' });
}

// ---------- every minute: open and close empty/full spells ----------

// Which station/type pairs are at 0. A station with 0 bikes AND 0 docks is out of service, not empty.
function zeroKeys(stations) {
  const keys = new Set();
  for (const s of stations) {
    if (s.rent === 0 && s.ret === 0) continue;
    for (const t of TYPES) if (s[t] === 0) keys.add(`${s.id}:${t}`);
  }
  return keys;
}
const SPELL_MIN_KEEP = 5 * 60_000; // a spell nobody complained about is only logged if it lasted this long

async function sweep(env) {
  const data = await loadStations(env, { fresh: true });
  if (!data.stations.length) return { opened: 0, closed: 0 };
  const now = Date.now(), byId = new Map(data.stations.map(s => [s.id, s]));

  // Compare with last minute's snapshot (one row) instead of reading every open spell.
  // Without a recent snapshot (first run, or the cron stalled), fall back to the open-spell table once.
  const prevRow = await env.DB.prepare('SELECT body, updated FROM snapshot WHERE id = 1').first();
  let before;
  if (prevRow && now - prevRow.updated < 5 * 60_000) before = zeroKeys(JSON.parse(prevRow.body).stations);
  else before = new Set((await env.DB.prepare('SELECT sid, type FROM empty_open').all()).results.map(o => `${o.sid}:${o.type}`));
  const after = zeroKeys(data.stations);

  const stmts = [env.DB.prepare('INSERT OR REPLACE INTO snapshot (id, body, updated) VALUES (1, ?, ?)').bind(JSON.stringify(data), data.updated)];
  let opened = 0, closed = 0;
  for (const key of after) {
    if (before.has(key)) continue;
    const [sid, type] = key.split(':');
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO empty_open (sid, type, name, since) VALUES (?, ?, ?, ?)').bind(sid, type, byId.get(sid).name, now));
    opened++;
  }
  for (const key of before) {
    if (after.has(key)) continue;
    const [sid, type] = key.split(':');
    // leave a city's spells alone when that city didn't answer this minute
    if (!data.prefixes.includes(sid.slice(0, 2))) continue;
    const jump = byId.get(sid)?.[type] ?? 0;
    // log the spell if someone was affected or it lasted a while; short blips nobody noticed are dropped
    stmts.push(env.DB.prepare(`INSERT INTO empty_events (sid, type, name, start, end, people, jump)
      SELECT sid, type, name, since, ?1, people, ?2 FROM (
        SELECT o.sid, o.type, o.name, o.since,
          (SELECT COUNT(DISTINCT a.device) FROM angers a WHERE a.sid = o.sid AND a.type = o.type AND a.counted = 1 AND a.at >= o.since) AS people
        FROM empty_open o WHERE o.sid = ?3 AND o.type = ?4)
      WHERE people > 0 OR ?1 - since >= ?5`).bind(now, jump, sid, type, SPELL_MIN_KEEP));
    stmts.push(env.DB.prepare('DELETE FROM empty_open WHERE sid = ? AND type = ?').bind(sid, type));
    closed++;
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { opened, closed };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/stations') {
        const d = await loadStations(env);
        if (!d.stations.length) return fail(502, 'upstream', `讀不到站點資料（${d.errors.join('；')}）`, cors);
        const { updated, cities, errors, stations } = d;
        return json({ ok: true, updated, cities, errors, stations }, 200, cors, { 'Cache-Control': 'public, max-age=30' });
      }
      if (request.method === 'POST' && url.pathname === '/anger') return await postAnger(request, env, cors);
      if (request.method === 'GET' && url.pathname === '/stats') return await getStats(url, env, cors);
      if (request.method === 'GET' && url.pathname === '/events') return await getEvents(url, env, cors);
      if (request.method === 'GET' && url.pathname === '/ntpc') {
        const page = Math.min(10, Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0));
        const upstream = await fetch(NTPC_URL(page), { cf: { cacheTtl: 60, cacheEverything: true } });
        return new Response(upstream.body, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
      }
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, cors);
      return fail(404, 'not_found', '沒有這個路徑', cors);
    } catch (e) {
      console.error(e);
      return fail(500, 'server_error', '伺服器發生錯誤', cors);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env).then(r => console.log('sweep', JSON.stringify(r))));
  },
};
