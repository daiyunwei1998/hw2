// GET /api/export?key=ADMIN_KEY&format=summary|trials.csv|adjust.csv|json
import { json, adminOk, listAll, readJSON, pool } from './_lib.js';

const TRIAL_COLS = ['pid', 'list', 'mode', 'design_version', 'seq', 'trial_no', 'kind', 'item', 'clip', 'ver', 'k', 'bin',
  'rate', 'syl_per_s', 'narr_dur', 'file', 'status', 'content_choice', 'content_correct', 'content_rt_ms', 'accept',
  'accept_rt_ms', 'effort', 'effort_rt_ms', 'jar', 'jar_rt_ms', 'hidden_during_audio', 'client_ts', 'server_ts'];
const ADJ_COLS = ['pid', 'list', 'mode', 'design_version', 'seq', 'adj_no', 'item', 'start_k', 'final_k', 'final_rate',
  'final_syl_per_s', 'n_plays', 'path', 'total_ms', 'client_ts', 'server_ts'];

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCSV = (cols, rows) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');

export async function GET(request) {
  const u = new URL(request.url);
  if (!adminOk(u.searchParams.get('key') || '')) return json({ ok: false, error: 'forbidden' }, 403);
  const format = u.searchParams.get('format') || 'summary';
  const blobs = await listAll('data/');
  const events = (await pool(blobs, 24, (b) => readJSON(b.pathname).catch(() => null))).filter(Boolean);
  events.sort((a, b) => (a.pid === b.pid ? a.seq - b.seq : a.pid < b.pid ? -1 : 1));

  const meta = {};
  for (const e of events) {
    const m = (meta[e.pid] ||= { pid: e.pid, list: null, mode: null, design_version: null, n_events: 0, n_trials: 0,
      n_adjust: 0, hp_pass: null, attention_pass: null, finished: false, first_ts: e.server_ts, last_ts: e.server_ts });
    m.n_events++;
    m.last_ts = e.server_ts;
    if (e.type === 'session') Object.assign(m, { list: e.payload?.list, mode: e.payload?.mode, design_version: e.design_version });
    if (e.type === 'trial' && ['main', 'attention', 'retest'].includes(e.payload?.kind)) m.n_trials++;
    if (e.type === 'trial' && e.payload?.kind === 'attention') m.attention_pass = e.payload.effort === 1;
    if (e.type === 'adjust') m.n_adjust++;
    if (e.type === 'hp_check') m.hp_pass = e.payload?.pass;
    if (e.type === 'finish') m.finished = true;
  }
  const withMeta = (e) => ({ ...e.payload, pid: e.pid, list: meta[e.pid]?.list, mode: meta[e.pid]?.mode,
    design_version: e.design_version, seq: e.seq, client_ts: e.client_ts, server_ts: e.server_ts });

  if (format === 'summary') return json({ ok: true, participants: Object.values(meta), n_events: events.length });
  if (format === 'json') return json({ ok: true, events });
  if (format === 'trials.csv') {
    const rows = events.filter((e) => e.type === 'trial').map(withMeta);
    return new Response(toCSV(TRIAL_COLS, rows), { headers: { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="trials.csv"', 'cache-control': 'no-store' } });
  }
  if (format === 'adjust.csv') {
    const rows = events.filter((e) => e.type === 'adjust').map(withMeta);
    return new Response(toCSV(ADJ_COLS, rows), { headers: { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="adjust.csv"', 'cache-control': 'no-store' } });
  }
  return json({ ok: false, error: 'bad_format' }, 400);
}
