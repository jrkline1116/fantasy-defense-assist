#!/usr/bin/env node
// Writes a plain-HTML "at a glance" section into index.html from data/defense.json,
// between the SNAPSHOT:START and SNAPSHOT:END markers. The interactive grid is drawn by
// JavaScript, so this gives readers (and search engines) the week's key numbers as text.
// Uses ESPN default scoring, the site's default tab. Output is deterministic: if the data
// hasn't changed, index.html doesn't change.
//
// Run locally:  node scripts/build-snapshot.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data', 'defense.json');
const INDEX = path.join(ROOT, 'index.html');
const START = '<!-- SNAPSHOT:START -->';
const END = '<!-- SNAPSHOT:END -->';
const PLAYOFF_WEEKS = [15, 16, 17];
const GAME_LENGTH_MS = 4.5 * 3600 * 1000;

// ESPN default D/ST scoring (keep in sync with PRESETS.espn in app.js).
const ESPN = {
  sack: 1, int: 2, fumRec: 2, td: 6, safety: 2, block: 2,
  pointsAllowed: [[0, 5], [6, 4], [13, 3], [17, 1], [27, 0], [34, -1], [45, -3], [Infinity, -5]],
  yardsAllowed: [[99, 5], [199, 3], [299, 2], [349, 0], [399, -1], [449, -3], [499, -5], [549, -6], [Infinity, -7]],
};
const tier = (table, v) => { for (const [max, pts] of table) if (v <= max) return pts; return 0; };
const score = (g, s = ESPN) => g.sacks * s.sack + g.ints * s.int + g.fumLost * s.fumRec +
  g.defTd * s.td + g.safeties * s.safety + (g.blocks ?? 0) * s.block +
  tier(s.pointsAllowed, g.pa) + tier(s.yardsAllowed, g.ya);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => n.toFixed(1);
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// Competition ranking (ties share a rank) on the 1-decimal value shown.
function rankBy(rows, value, highFirst) {
  const out = {};
  for (const r of rows) {
    const shown = Math.round(value(r) * 10);
    const ahead = rows.filter((o) => (highFirst
      ? Math.round(value(o) * 10) > shown
      : Math.round(value(o) * 10) < shown)).length;
    out[r.t] = ahead + 1;
  }
  return out;
}

export function buildSnapshot(data, now = Date.now()) {
  const teams = data.teams;
  const abbrs = Object.keys(teams);
  const isOver = (g) => !!g.completed || (!!g.date && now > Date.parse(g.date) + GAME_LENGTH_MS);

  // Season numbers from stored games.
  const off = Object.fromEntries(abbrs.map((t) => [t, { sum: 0, games: 0 }]));
  const def = Object.fromEntries(abbrs.map((t) => [t, { sum: 0, games: 0 }]));
  for (const r of Object.values(data.results ?? {})) {
    for (const [o, g] of Object.entries(r.off ?? {})) {
      if (!off[o] || ![g.pa, g.ya, g.sacks, g.ints, g.fumLost].every(Number.isFinite)) continue;
      const pts = score(g);
      off[o].sum += pts; off[o].games += 1;
      const d = o === r.home ? r.away : r.home;
      if (def[d]) { def[d].sum += pts; def[d].games += 1; }
    }
  }
  const offRows = abbrs.filter((t) => off[t].games).map((t) => ({ t, avg: off[t].sum / off[t].games }));
  const offAvg = Object.fromEntries(offRows.map((r) => [r.t, r.avg]));
  const offRank = rankBy(offRows, (r) => r.avg, false);          // 1st = toughest for D/STs
  const defRows = abbrs.filter((t) => def[t].games).map((t) => ({ t, total: def[t].sum, avg: def[t].sum / def[t].games }));
  const defRank = rankBy(defRows, (r) => r.total, true);
  const defBy = Object.fromEntries(defRows.map((r) => [r.t, r]));

  // Remaining schedule.
  const open = data.schedule.filter((g) => !isOver(g));
  if (!open.length || !defRows.length) return null;
  const weeks = [...new Set(open.map((g) => g.week))].sort((a, b) => a - b);
  const isMonday = (iso) => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/New_York' })
    .format(new Date(iso)) === 'Mon';
  let planWeek = weeks[0];
  for (const w of weeks) {
    const all = data.schedule.filter((g) => g.week === w);
    const left = all.filter((g) => !isOver(g));
    if (!(left.length < all.length && left.every((g) => g.date && isMonday(g.date)))) { planWeek = w; break; }
  }
  const opp = {};   // week -> team -> { opp, home }
  for (const g of open) {
    (opp[g.week] ??= {})[g.home] = { opp: g.away, home: true };
    opp[g.week][g.away] = { opp: g.home, home: false };
  }
  const sos = (wks) => {
    const rows = [];
    for (const t of abbrs) {
      let sum = 0, n = 0;
      for (const w of wks) { const m = opp[w]?.[t]; if (m && offAvg[m.opp] != null) { sum += offAvg[m.opp]; n += 1; } }
      if (n) rows.push({ t, avg: sum / n, n });
    }
    const rank = rankBy(rows, (r) => r.avg, true);
    return Object.fromEntries(rows.map((r) => [r.t, { ...r, rank: rank[r.t] }]));
  };
  const ros = sos(weeks);
  const po = sos(weeks.filter((w) => PLAYOFF_WEEKS.includes(w)));

  // This week's best matchups (all 32 defenses; the live grid can hide taken ones).
  const picks = abbrs.map((t) => {
    const m = opp[planWeek]?.[t];
    if (!m || !defBy[t] || offAvg[m.opp] == null) return null;
    return { t, m, proj: (defBy[t].avg + offAvg[m.opp]) / 2 };
  }).filter(Boolean).sort((a, b) => b.proj - a.proj || a.t.localeCompare(b.t)).slice(0, 10);

  const vs = (m) => (m.home ? 'vs. ' : 'at ') + esc(teams[m.opp].short);
  const updated = new Date(data.updatedAt).toLocaleDateString('en-US', {
    timeZone: 'America/Phoenix', month: 'long', day: 'numeric', year: 'numeric' });

  const pickItems = picks.map((p) => {
    const d = defBy[p.t];
    return `<li><b>${esc(teams[p.t].short)} D/ST</b> ${vs(p.m)}: projected ${fmt(p.proj)}. ` +
      `${esc(teams[p.t].short)} average ${fmt(d.avg)} per game, and the ${esc(teams[p.m.opp].short)} ` +
      `give up ${fmt(offAvg[p.m.opp])} to D/STs (${ordinal(offRank[p.m.opp])} of 32).</li>`;
  }).join('\n        ');

  const offSorted = [...offRows].sort((a, b) => b.avg - a.avg);
  const easiest = offSorted.slice(0, 5).map((r) => `${esc(teams[r.t].short)} (${fmt(r.avg)})`).join(', ');
  const toughest = offSorted.slice(-5).reverse().map((r) => `${esc(teams[r.t].short)} (${fmt(r.avg)})`).join(', ');

  const rows = [...defRows].sort((a, b) => defRank[a.t] - defRank[b.t] || teams[a.t].short.localeCompare(teams[b.t].short))
    .map((r) => {
      const m = opp[planWeek]?.[r.t];
      const g = data.schedule.find((x) => x.week === planWeek && (x.home === r.t || x.away === r.t));
      const next = m ? `${vs(m)}${offRank[m.opp] ? ` (${ordinal(offRank[m.opp])})` : ''}`
        : g ? `Played ${g.home === r.t ? 'vs.' : 'at'} ${esc(teams[g.home === r.t ? g.away : g.home].short)}` : 'Bye';
      const R = ros[r.t], P = po[r.t];
      return `<tr><td>${ordinal(defRank[r.t])}</td><th scope="row">${esc(teams[r.t].short)}</th>` +
        `<td>${fmt(r.total)}</td><td>${fmt(r.avg)}</td><td>${next}</td>` +
        `<td>${R ? ordinal(R.rank) : '–'}</td><td>${P ? ordinal(P.rank) : '–'}</td></tr>`;
    }).join('\n          ');

  return `${START}
  <section class="about glance" id="at-a-glance" aria-labelledby="glanceTitle">
    <h2 id="glanceTitle">Week ${planWeek} streaming defenses at a glance</h2>
    <p class="sub">ESPN default scoring, season stats as of ${esc(updated)}.
      Use the grid above to switch scoring and hide defenses already taken in your league.</p>

    <h3>Best Week ${planWeek} matchups</h3>
    <ol class="glance-picks">
        ${pickItems}
    </ol>
    <p>
      Projection is the average of the defense's own points per game and what its opponent gives up
      to D/STs per game. <a href="guide-how-rankings-work.html">How the rankings work</a>.
    </p>

    <h3>Offenses to target and avoid</h3>
    <p><b>Most D/ST points allowed per game:</b> ${easiest}.</p>
    <p><b>Fewest D/ST points allowed per game:</b> ${toughest}.</p>

    <h3>All 32 defenses</h3>
    <div class="tbl-wrap">
      <table class="tbl glance-tbl">
        <thead><tr><th>Rank</th><th>D/ST</th><th>Season pts</th><th>Per game</th><th>Week ${planWeek}</th><th>Rest of season</th><th>Playoffs</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <p class="note">Week ${planWeek} column shows the opponent and its rank vs. D/STs (32nd is the easiest matchup).
      Rest of season and Playoffs (Weeks 15–17) rank each defense's remaining schedule, 1st = easiest.</p>
  </section>
  ${END}`;
}

async function main() {
  const data = JSON.parse(await readFile(DATA, 'utf8'));
  const html = await readFile(INDEX, 'utf8');
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('Snapshot markers not found in index.html');
  const snap = buildSnapshot(data);
  if (!snap) { console.log('No upcoming games; snapshot left as is.'); return; }
  const out = html.slice(0, a) + snap + html.slice(b + END.length);
  if (out === html) { console.log('Snapshot unchanged.'); return; }
  await writeFile(INDEX, out);
  console.log('Snapshot written to index.html.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
