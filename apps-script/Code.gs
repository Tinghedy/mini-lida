/**
 * Mini-LIDA classroom backend (Google Apps Script, bound to a Google Sheet).
 *
 * Script Properties (Project Settings → Script properties):
 *   GEMINI_API_KEY  – required
 *   GEMINI_MODEL    – optional, default "gemini-2.5-flash"
 *   ADMIN_PIN       – required for reset / regenerate goals (e.g. "2468")
 *
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * Paste the /exec URL into CONFIG.API_URL in index.html.
 */

const SH = { data: 'data', charts: 'charts', votes: 'votes', state: 'state' };
const HEAD = {
  data: ['id', 'ts', 'nickname', 'screen_min', 'bed', 'wake', 'alarms', 'guess_screen_min'],
  charts: ['cid', 'ts', 'pid', 'nickname', 'question', 'headline', 'rationale', 'spec'],
  votes: ['voter', 'cid', 'ts'],
  state: ['key', 'value'],
};

function doGet(e) { return handle_((e && e.parameter) || {}); }
function doPost(e) {
  let p = {};
  try { p = JSON.parse(e.postData.contents); } catch (_) {}
  return handle_(p);
}

function handle_(p) {
  try {
    const fn = {
      submit: submit_, state: state_, goals: goals_, chart: chart_,
      publish: publish_, vote: vote_, admin: admin_,
    }[p.action];
    if (!fn) return out_({ ok: false, error: 'unknown action' });
    return out_(Object.assign({ ok: true }, fn(p)));
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- sheet helpers ---------- */
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(HEAD[name]); }
  return s;
}
function rows_(name) {
  const v = sheet_(name).getDataRange().getValues();
  const h = v.shift();
  return v.filter(r => r[0] !== '').map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
function getState_(key) {
  const r = rows_(SH.state).find(x => x.key === key);
  return r ? r.value : null;
}
function setState_(key, value) {
  const s = sheet_(SH.state);
  const v = s.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (v[i][0] === key) { s.getRange(i + 1, 2).setValue(value); return; }
  s.appendRow([key, value]);
}
function clean_(str, max) { return String(str == null ? '' : str).slice(0, max || 200); }
function hhmm_(v) {
  // Sheets may turn "23:30" into a Date; normalise back to "HH:MM".
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  return clean_(v, 5);
}

/* ---------- actions ---------- */
function submit_(p) {
  const id = clean_(p.id, 40);
  if (!id) throw new Error('missing id');
  const row = [id, new Date(), clean_(p.nickname, 24), num_(p.screen_min, 0, 1440),
    "'" + clean_(p.bed, 5), "'" + clean_(p.wake, 5), num_(p.alarms, 0, 50), num_(p.guess_screen_min, 0, 1440)];
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const s = sheet_(SH.data);
    const v = s.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) if (v[i][0] === id) { s.getRange(i + 1, 1, 1, row.length).setValues([row]); return {}; }
    s.appendRow(row);
  } finally { lock.releaseLock(); }
  return {};
}
function num_(v, lo, hi) { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : ''; }

function publicRows_() {
  return rows_(SH.data).map(r => ({
    pid: String(r.id).slice(0, 8), nickname: r.nickname, screen_min: r.screen_min,
    bed: hhmm_(r.bed), wake: hhmm_(r.wake), alarms: r.alarms, guess_screen_min: r.guess_screen_min,
  }));
}

function state_(p) {
  const votes = rows_(SH.votes);
  const tally = {};
  votes.forEach(v => { tally[v.cid] = (tally[v.cid] || 0) + 1; });
  const charts = rows_(SH.charts).map(c => ({
    cid: c.cid, pid: String(c.pid).slice(0, 8), nickname: c.nickname, question: c.question,
    headline: c.headline, rationale: c.rationale, spec: safeJson_(c.spec), votes: tally[c.cid] || 0,
  }));
  const myVote = p.voter ? (votes.find(v => v.voter === p.voter) || {}).cid || null : null;
  const lang = p.lang === 'zh' ? 'zh' : 'en';
  return { rows: publicRows_(), goals: safeJson_(getState_('goals_' + lang)), charts, myVote };
}
function safeJson_(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

function goals_(p) {
  const lang = p.lang === 'zh' ? 'zh' : 'en';
  const cached = safeJson_(getState_('goals_' + lang));
  if (cached && !p.force) return { goals: cached };
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const again = safeJson_(getState_('goals_' + lang));
    if (again && !p.force) return { goals: again };
    const res = gemini_(goalPrompt_(summary_(), lang), 0.6);
    const goals = (res.goals || []).slice(0, 4);
    setState_('goals_' + lang, JSON.stringify(goals));
    return { goals };
  } finally { lock.releaseLock(); }
}

function chart_(p) {
  const q = clean_(p.question, 200);
  if (!q) throw new Error('empty question');
  const lang = p.lang === 'zh' ? 'zh' : 'en';
  const res = gemini_(chartPrompt_(summary_(), q, lang), 0.8);
  if (!res.spec) throw new Error('model returned no spec');
  return { spec: res.spec, headline: clean_(res.headline, 160), rationale: clean_(res.rationale, 300) };
}

function publish_(p) {
  const cid = Utilities.getUuid().slice(0, 8);
  const spec = JSON.stringify(p.spec || {});
  if (spec.length > 20000) throw new Error('spec too large');
  sheet_(SH.charts).appendRow([cid, new Date(), clean_(p.id, 40), clean_(p.nickname, 24),
    clean_(p.question, 200), clean_(p.headline, 160), clean_(p.rationale, 300), spec]);
  return { cid };
}

function vote_(p) {
  const voter = clean_(p.voter, 40), cid = clean_(p.cid, 12);
  if (!voter || !cid) throw new Error('missing voter/cid');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const s = sheet_(SH.votes);
    const v = s.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) if (v[i][0] === voter) { s.getRange(i + 1, 2, 1, 2).setValues([[cid, new Date()]]); return {}; }
    s.appendRow([voter, cid, new Date()]);
  } finally { lock.releaseLock(); }
  return {};
}

function admin_(p) {
  const pin = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!pin || String(p.pin) !== String(pin)) throw new Error('wrong PIN');
  if (p.op === 'reset') {
    [SH.data, SH.charts, SH.votes, SH.state].forEach(n => {
      const s = sheet_(n); s.clear(); s.appendRow(HEAD[n]);
    });
    return { reset: true };
  }
  if (p.op === 'goals') return goals_({ lang: p.lang, force: true });
  throw new Error('unknown op');
}

/* ---------- Stage 1: Summarizer (rules only) ---------- */
function summary_() {
  const rows = publicRows_().map(derive_).filter(Boolean);
  const stat = k => {
    const xs = rows.map(r => r[k]).filter(x => typeof x === 'number' && isFinite(x));
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { min: +Math.min.apply(null, xs).toFixed(2), max: +Math.max.apply(null, xs).toFixed(2), mean: +mean.toFixed(2) };
  };
  return {
    name: 'Our class last night', n_people: rows.length,
    fields: [
      { field: 'nickname', type: 'nominal', meaning: 'anonymous emoji nickname of each student' },
      { field: 'screen_hours', type: 'quantitative', meaning: "yesterday's phone screen time in hours", stats: stat('screen_hours') },
      { field: 'bed_hour', type: 'quantitative', meaning: 'bedtime last night as hour of day; values >= 24 mean after midnight (25.5 = 1:30 AM)', stats: stat('bed_hour') },
      { field: 'wake_hour', type: 'quantitative', meaning: 'wake-up time this morning as hour of day (7.5 = 7:30 AM)', stats: stat('wake_hour') },
      { field: 'sleep_hours', type: 'quantitative', meaning: 'hours slept, derived = wake time - bedtime', stats: stat('sleep_hours') },
      { field: 'alarms', type: 'quantitative', meaning: 'number of alarms set this morning', stats: stat('alarms') },
      { field: 'me', type: 'nominal', meaning: 'true only for the row of the person viewing the chart' },
    ],
  };
}
function toHour_(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}
function derive_(r) {
  const bed = toHour_(r.bed), wake = toHour_(r.wake);
  if (bed == null || wake == null || r.screen_min === '' || r.alarms === '') return null;
  const bedH = bed < 12 ? bed + 24 : bed;
  let sleep = wake + 24 - bedH; while (sleep > 18) sleep -= 24; while (sleep < 0) sleep += 24;
  return { screen_hours: r.screen_min / 60, bed_hour: bedH, wake_hour: wake, sleep_hours: sleep, alarms: Number(r.alarms) };
}

/* ---------- prompts ---------- */
function langLine_(lang) { return lang === 'zh' ? 'Write all text in Traditional Chinese (Taiwan).' : 'Write all text in English.'; }

function goalPrompt_(summary, lang) {
  return [
    "You are the GOAL EXPLORER stage of LIDA, an automatic visualization system. You act as a curious, playful data analyst.",
    "Here is a summary of a tiny dataset collected live from a class of design graduate students:",
    JSON.stringify(summary),
    "Propose exactly 4 fun, specific questions the students would want answered about themselves (e.g. relationships between two fields, who is an outlier).",
    "Only use the fields listed. Do not use the field 'me' in questions.",
    langLine_(lang),
    'Return JSON: {"goals":[{"question":"...","visualization":"chart type + fields","rationale":"why this is interesting"}]}',
  ].join('\n\n');
}

function chartPrompt_(summary, question, lang) {
  return [
    "You are the VISGENERATOR stage of LIDA. Write ONE Vega-Lite v5 specification that answers the question.",
    "Dataset summary (the data itself is injected later as {\"values\": [...]}, one row per student):",
    JSON.stringify(summary),
    "Question: " + question,
    [
      "Rules:",
      "- Do NOT include data, datasets, url, $schema, width or height. Only marks, encodings, transforms, layers, config, title.",
      "- Use only these fields: nickname, screen_hours, bed_hour, wake_hour, sleep_hours, alarms, me.",
      "- If marks represent individual students, make rows with me == true stand out (e.g. a different color or larger size) and add nickname to the tooltip.",
      "- For bed_hour / wake_hour axes use labelExpr: \"floor(datum.value % 24) + ':' + (round((datum.value % 1) * 60) < 10 ? '0' : '') + round((datum.value % 1) * 60)\" so they read like clock times.",
      "- Keep text large and readable on a phone.",
    ].join('\n'),
    "Also write:",
    "- headline: a punchy, tabloid-style news headline about what the chart shows (bold claims are fine).",
    "- rationale: one sentence on why you chose this chart type.",
    langLine_(lang),
    'Return JSON: {"spec": {...}, "headline": "...", "rationale": "..."}',
  ].join('\n\n');
}

/* ---------- Gemini ---------- */
function gemini_(prompt, temperature) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: temperature, responseMimeType: 'application/json' },
  };
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const code = r.getResponseCode();
    if (code === 200) {
      const j = JSON.parse(r.getContentText());
      const text = (((j.candidates || [])[0] || {}).content || {}).parts;
      const raw = text ? text.map(x => x.text || '').join('') : '';
      return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    }
    last = code + ' ' + r.getContentText().slice(0, 200);
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * Math.pow(2, attempt) + Math.random() * 1000); continue; }
    break;
  }
  throw new Error('Gemini error: ' + last);
}
