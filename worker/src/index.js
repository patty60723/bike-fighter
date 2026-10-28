// bike-fighter API (Cloudflare Worker + D1)
//
// GET  /stations        Taipei + New Taipei YouBike 2.0 stations with live counts
// POST /anger           record one batch of anger after checking it server-side
// GET  /stats           a station's anger totals and its current empty-station boss
// GET  /events          recent finished empty/full spells (the demand log)
// GET  /ntpc?page=N     raw New Taipei data (kept for pages from before /stations)
// GET  /usage          today's estimated D1 usage (what the cron's self-throttling sees)
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

  const suspended = suspendedPrefixes(data.stations).includes(sid.slice(0, 2));
  const avail = s[type], counted = avail === 0 && !suspended ? 1 : 0, lv = level(clicks);
  await env.DB.prepare('INSERT INTO angers (device, sid, type, clicks, level, counted, avail, lat, lng, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(device, sid, type, clicks, lv, counted, avail, lat, lng, now).run();
  statsMemo.delete(`${sid}:${type}`); // the sender should see their own batch at once
  return json({ ok: true, counted: !!counted, suspended, level: lv, avail, at: now }, 201, cors);
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
  // open spells live in the snapshot row (see sweep); one row read
  // [since, name, recoveredAt?]; a spell whose station has bikes/docks again is no longer shown
  const entry = /^[A-Za-z0-9_-]{1,40}$/.test(sid)
    ? (await env.DB.prepare('SELECT json_extract(open, ?) AS spell FROM snapshot WHERE id = 1').bind(`$."${sid}:${type}"`).first())?.spell ?? null
    : null;
  const e = entry ? JSON.parse(entry) : null;
  const since = e && e[2] == null ? e[0] : null;
  // the boss only counts people from this spell, and at most the last 10 minutes of it
  const from = Math.max(now - BOSS_WINDOW, since ?? now);
  const [tot, ppl, boss, hist] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS sends, COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(level), 0) AS lv FROM angers WHERE sid = ? AND type = ? AND counted = 1').bind(sid, type),
    // people = devices, counted at most once per hour per station
    env.DB.prepare("SELECT COUNT(DISTINCT device || ':' || (at / 3600000)) AS people FROM angers WHERE sid = ? AND type = ? AND counted = 1").bind(sid, type),
    env.DB.prepare('SELECT device, MAX(level) AS lv FROM angers WHERE sid = ? AND type = ? AND counted = 1 AND at >= ? GROUP BY device ORDER BY lv DESC').bind(sid, type, from),
    // spells since v1.4, then the ones logged in empty_events before it; each side reads at most 5 rows
    env.DB.prepare(`SELECT start, end, people, jump FROM (
        SELECT * FROM (SELECT start, end, people, jump FROM spells WHERE sid = ?1 AND type = ?2 ORDER BY end DESC LIMIT 5)
        UNION ALL
        SELECT * FROM (SELECT start, end, people, jump FROM empty_events WHERE sid = ?1 AND type = ?2 ORDER BY end DESC LIMIT 5))
      ORDER BY end DESC LIMIT 5`).bind(sid, type),
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
    // both sides walk only their partial index of affected spells
    events = (await env.DB.prepare(`SELECT sid, type, name, start, end, people, jump FROM (
        SELECT * FROM (SELECT sid, type, name, start, end, people, jump FROM spells WHERE people > 0 ORDER BY end DESC LIMIT ?1)
        UNION ALL
        SELECT * FROM (SELECT sid, type, name, start, end, people, jump FROM empty_events WHERE people > 0 ORDER BY end DESC LIMIT ?1))
      ORDER BY end DESC LIMIT ?1`).bind(limit).all()).results;
    eventsMemo.set(limit, { at: Date.now(), events });
  }
  return json({ ok: true, events }, 200, cors, { 'Cache-Control': 'public, max-age=30' });
}

// ---------- every minute: open and close empty/full spells ----------

// Which station/type pairs are at 0. A station with 0 bikes AND 0 docks is out of service, not empty.
// When most of a city's stations have no bikes at once (a typhoon, a system outage), YouBike has
// stopped service there; that's not demand, so those stations open no spells and count no anger.
const SUSPEND_SHARE = 0.6, SUSPEND_MIN_STATIONS = 50;
const PREFIX_CITY = { tp: '台北市', nt: '新北市' };
function suspendedPrefixes(stations) {
  const n = {}, zero = {};
  for (const s of stations) { const p = s.id.slice(0, 2); n[p] = (n[p] || 0) + 1; if (s.rent === 0) zero[p] = (zero[p] || 0) + 1; }
  return Object.keys(n).filter(p => n[p] >= SUSPEND_MIN_STATIONS && (zero[p] || 0) / n[p] >= SUSPEND_SHARE);
}
function zeroKeys(stations) {
  const keys = new Set(), off = new Set(suspendedPrefixes(stations));
  for (const s of stations) {
    if (off.has(s.id.slice(0, 2))) continue;
    if (s.rent === 0 && s.ret === 0) continue;
    for (const t of TYPES) if (s[t] === 0) keys.add(`${s.id}:${t}`);
  }
  return keys;
}
const SPELL_MIN_KEEP = 5 * 60_000; // a spell nobody complained about is only logged if it lasted this long
// A spell ends when the station has had bikes (docks) for this long; a 0 -> 1 -> 0 flap inside it
// stays one spell. The end time logged is still the minute the bikes came back.
const CLOSE_DEBOUNCE = 3 * 60_000;
let seeded = null; // open spells taken from empty_open, kept in case the first write fails (D1 over its limit)

// ---------- D1 budget ----------
// Free plan (per UTC day): 5,000,000 rows read, 100,000 rows written. Override with vars if the plan changes.
// The cron keeps a running estimate of today's usage in the snapshot row (no extra write) and
// sweeps less often when it gets ahead of BUDGET_SHARE of the daily limit.
const DAY = 86_400_000;
const BUDGET_SHARE = 0.3;
const ANGER_WRITES = 4;          // one anger = the row + 2 indexes + the AUTOINCREMENT counter
const SWEEP_MIN_GAP = 30_000;    // a second cron firing (duplicate, or another deployment on this database) within this is skipped
function limits(env) {
  return { reads: Number(env.D1_DAILY_READS) || 5_000_000, writes: Number(env.D1_DAILY_WRITES) || 100_000 };
}
function newUsage(day, angerId) { return { day, r: 0, w: 0, a0: angerId ?? 0, sweeps: 0, every: 1 }; }
// today's usage as a share of the daily limit; anger writes are counted from the angers id range
function usageShare(u, angerId, env) {
  const L = limits(env), apiW = Math.max(0, (angerId ?? 0) - u.a0) * ANGER_WRITES;
  return { reads: u.r, writes: u.w + apiW, share: Math.max(u.r / L.reads, (u.w + apiW) / L.writes) };
}
// minutes between sweeps (0 = paused for the rest of the UTC day)
function sweepEvery(share, now) {
  const pace = BUDGET_SHARE * Math.max((now % DAY) / DAY, 2 / 24); // where a 30%-a-day budget should be by now
  if (share >= 0.85) return 0;     // leave the rest for /anger and /stats; /stations falls back to the cities
  if (share >= 0.6 || share > pace * 2) return 10;
  if (share >= BUDGET_SHARE || share > pace) return 2;
  return 1;
}
let carry = { r: 0, w: 0 }; // measured minus estimated usage of the last sweep in this isolate

async function sweep(env) {
  const now = Date.now(), day = Math.floor(now / DAY);
  // one row: when the last sweep ran, the open spells, today's usage, and the newest anger id
  const prevRes = await env.DB.prepare('SELECT updated, open, usage, (SELECT MAX(id) FROM angers) AS aid FROM snapshot WHERE id = 1').all();
  const prev = prevRes.results[0] ?? null, aid = prev?.aid ?? 0;
  let u = prev?.usage ? JSON.parse(prev.usage) : null;
  if (!u || u.day !== day) { u = newUsage(day, aid); carry = { r: 0, w: 0 }; }

  // (a snapshot time in the future can't be a recent sweep; don't let it block the cron)
  const gap = prev && prev.updated <= now ? now - prev.updated : Infinity;
  if (gap < SWEEP_MIN_GAP) return { skipped: 'too_soon', gap };
  const every = sweepEvery(usageShare(u, aid, env).share, now);
  if (every === 0) return { skipped: 'over_budget', every };
  if (gap < every * 60_000 - 20_000) return { skipped: 'throttled', every };

  const data = await loadStations(env, { fresh: true });
  if (!data.stations.length) return { opened: 0, closed: 0 };
  const byId = new Map(data.stations.map(s => [s.id, s]));

  // The open spells: "sid:type" -> [since, name, recoveredAt?, jump?]. The last committed sweep's copy is
  // always the right thing to compare with, however old it is (if D1 refused our writes, nothing changed).
  // Right after migration 0005 they come from empty_open, once per isolate.
  let open, seedReads = 0;
  if (prev?.open) open = JSON.parse(prev.open);
  else if (seeded) open = structuredClone(seeded);
  else {
    try {
      const r = await env.DB.prepare('SELECT sid, type, name, since FROM empty_open').all();
      open = Object.fromEntries(r.results.map(o => [`${o.sid}:${o.type}`, [o.since, o.name]]));
      seedReads = r.meta?.rows_read ?? r.results.length;
    } catch (e) { console.error('empty_open seed failed', e.message); open = {}; }
    seeded = structuredClone(open);
  }
  const after = zeroKeys(data.stations);

  let opened = 0;
  const closes = [];
  for (const key of Object.keys(open)) {
    const o = open[key];
    if (after.has(key)) { if (o[2] != null) open[key] = [o[0], o[1]]; continue; } // back to 0 within the debounce: same spell
    const [sid, type] = key.split(':');
    // leave a city's spells alone when that city didn't answer this minute
    if (!data.prefixes.includes(sid.slice(0, 2))) continue;
    if (o[2] == null) { open[key] = [o[0], o[1], now, byId.get(sid)?.[type] ?? 0]; continue; } // bikes are back: wait and see
    if (now - o[2] < CLOSE_DEBOUNCE) continue;
    closes.push([sid, type, o[1], o[0], o[3] ?? 0, o[2]]); // ends when the bikes came back
    delete open[key];
  }
  for (const key of after) {
    if (open[key]) continue;
    open[key] = [now, byId.get(key.split(':')[0]).name];
    opened++;
  }

  // Usage written into this sweep's row: what's known so far, plus an upper bound for this batch
  // (corrected with the measured numbers on the next sweep in this isolate).
  const estW = 1 + closes.length * 2, estR = 2 + closes.length * 2;
  u.r += (prevRes.meta?.rows_read ?? 1) + seedReads + carry.r + estR;
  u.w += carry.w + estW;
  u.sweeps++; u.every = every;
  if (gap < 60 * 60_000) u.r += Math.max(0, Math.round(gap / 60_000) - 1) * 2; // skipped minutes each read one row (+ the angers max id)

  // One transaction. The snapshot only moves forward if nobody else swept since we read it, and the
  // spells are only logged if our snapshot write won, so a duplicate cron run can't log a spell twice.
  const stmts = [env.DB.prepare(`INSERT INTO snapshot (id, body, updated, open, usage) VALUES (1, ?1, ?2, ?3, ?4)
      ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated = excluded.updated, open = excluded.open, usage = excluded.usage
      WHERE snapshot.updated IS ?5`)
    .bind(JSON.stringify(data), data.updated, JSON.stringify(open), JSON.stringify(u), prev ? prev.updated : null)];
  if (closes.length) {
    // log the spells someone was affected by or that lasted a while; short blips nobody noticed are dropped
    // people: devices that sent counted anger during the spell (counted needs 0 bikes, so none after `end`)
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO spells (sid, type, end, start, name, people, jump)
      SELECT sid, type, end, since, name, people, jump FROM (
        SELECT c.sid, c.type, c.name, c.since, c.jump, c.end,
          (SELECT COUNT(DISTINCT a.device) FROM angers a WHERE a.sid = c.sid AND a.type = c.type AND a.counted = 1 AND a.at >= c.since) AS people
        FROM (SELECT value ->> 0 AS sid, value ->> 1 AS type, value ->> 2 AS name, value ->> 3 AS since, value ->> 4 AS jump, value ->> 5 AS end
              FROM json_each(?1)) c)
      WHERE (people > 0 OR end - since >= ?2) AND (SELECT updated FROM snapshot WHERE id = 1) = ?3`)
      .bind(JSON.stringify(closes), SPELL_MIN_KEEP, data.updated));
  }
  const res = await env.DB.batch(stmts);
  const measR = res.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0), measW = res.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
  carry = { r: measR - estR, w: measW - estW };
  if (!res[0].meta?.changes) return { skipped: 'raced' }; // another sweep got there first
  return { opened, closed: closes.length, logged: res[1]?.meta?.changes ?? 0, rowsRead: measR, rowsWritten: measW, every, today: usageShare(u, aid, env) };
}

let usageMemo = null;
async function getUsage(env, cors) {
  if (!usageMemo || Date.now() - usageMemo.at > 60_000) {
    const row = await env.DB.prepare('SELECT usage, (SELECT MAX(id) FROM angers) AS aid FROM snapshot WHERE id = 1').first();
    const u = row?.usage ? JSON.parse(row.usage) : null;
    const L = limits(env);
    usageMemo = { at: Date.now(), body: u && {
      day: new Date(u.day * DAY).toISOString().slice(0, 10), ...usageShare(u, row.aid, env),
      limits: L, budgetShare: BUDGET_SHARE, sweeps: u.sweeps, sweepEveryMin: u.every,
      note: 'cron measured + anger writes from the id range; /stats and /events reads are not included',
    } };
  }
  return json({ ok: true, usage: usageMemo.body }, 200, cors, { 'Cache-Control': 'no-store' });
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
        const suspended = suspendedPrefixes(stations).map(p => PREFIX_CITY[p] || p);
        return json({ ok: true, updated, cities, errors, suspended, stations }, 200, cors, { 'Cache-Control': 'public, max-age=30' });
      }
      if (request.method === 'POST' && url.pathname === '/anger') return await postAnger(request, env, cors);
      if (request.method === 'GET' && url.pathname === '/stats') return await getStats(url, env, cors);
      if (request.method === 'GET' && url.pathname === '/events') return await getEvents(url, env, cors);
      if (request.method === 'GET' && url.pathname === '/ntpc') {
        const page = Math.min(10, Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0));
        const upstream = await fetch(NTPC_URL(page), { cf: { cacheTtl: 60, cacheEverything: true } });
        return new Response(upstream.body, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
      }
      if (request.method === 'GET' && url.pathname === '/usage') return await getUsage(env, cors);
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, cors);
      return fail(404, 'not_found', '沒有這個路徑', cors);
    } catch (e) {
      console.error(e);
      return fail(500, 'server_error', '伺服器發生錯誤', cors);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env).then(r => console.log('sweep', JSON.stringify(r)), e => console.error('sweep failed', e.message)));
  },
};
