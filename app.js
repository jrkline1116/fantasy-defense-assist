// Fantasy Defense Assist: D/ST Matchup Grid
// Scores every completed game from raw stats, averages D/ST points allowed by
// each offense, ranks offenses 1 (toughest for defenses) to 32 (easiest).

// Default D/ST scoring by platform. Tables are [max inclusive, points];
// an empty table means the category isn't scored.
const YAHOO_STYLE = {
  sack: 1, int: 2, fumRec: 2, td: 6, safety: 2, block: 2,
  pointsAllowed: [[0, 10], [6, 7], [13, 4], [20, 1], [27, 0], [34, -1], [Infinity, -4]],
  yardsAllowed: [],
};
const PRESETS = {
  espn: {
    label: 'ESPN',
    sack: 1, int: 2, fumRec: 2, td: 6, safety: 2, block: 2,
    pointsAllowed: [[0, 5], [6, 4], [13, 3], [17, 1], [27, 0], [34, -1], [45, -3], [Infinity, -5]],
    yardsAllowed: [[99, 5], [199, 3], [299, 2], [349, 0], [399, -1], [449, -3], [499, -5], [549, -6], [Infinity, -7]],
  },
  yahoo: { label: 'Yahoo', ...YAHOO_STYLE },
  sleeper: { label: 'Sleeper', ...YAHOO_STYLE },  // same defaults as Yahoo today
};
let SCORING = PRESETS.espn;

// Custom scoring (paid beta). Set the price and, once payments are set up,
// a checkout link (Stripe Payment Link, Buy Me a Coffee membership, etc.).
const CUSTOM = {
  price: '$X.XX',
  checkoutUrl: '',   // not used yet; popup says pricing is coming later
};

// ESPN-style colors: low ranks red, high ranks green.
const tierFor = (rank) => (rank <= 10 ? 'bad' : rank >= 21 ? 'good' : 'mid');

const $ = (id) => document.getElementById(id);
const els = {
  grid: $('grid'),
  sub: $('sub'),
  status: $('status'),
  hide: $('hideUnavailable'),
  takenCount: $('takenCount'),
  scoringNote: $('scoringNote'),
  tabs: $('scoringTabs'),
  custom: $('customDialog'),
  customBody: $('customBody'),
  clear: $('clearUnavailable'),
  detail: $('detail'),
  detailBody: $('detailBody'),
  picks: $('picks'),
};

const state = {
  data: null,
  weeks: [],
  teams: [],          // abbrs in display order
  ranks: {},          // offense abbr -> { rank, avg, games }
  dstRanks: {},       // defense abbr -> { rank, total, games, avg } (points the D/ST scored)
  logs: {},           // offense abbr -> week -> game stats + pts
  nflAvg: 0,
  matchups: {},       // week -> team -> { opp, home }
  sort: { key: 'prk', dir: 'asc' },   // 'prk' (D/ST rank), 'team' (A–Z) or a week number
  scoringKey: 'espn',
  unavailable: new Set(),
  storageKey: 'dst-grid',
};

/* ---------- scoring ---------- */

function tier(table, value) {
  for (const [max, pts] of table) if (value <= max) return pts;
  return 0;
}

function scoreGame(g, s = SCORING) {
  return g.sacks * s.sack + g.ints * s.int + g.fumLost * s.fumRec +
    g.defTd * s.td + g.safeties * s.safety + (g.blocks ?? 0) * (s.block ?? 0) +
    tier(s.pointsAllowed, g.pa) + tier(s.yardsAllowed, g.ya);
}

function computeRanks(results, teamAbbrs) {
  const totals = Object.fromEntries(teamAbbrs.map((t) => [t, { sum: 0, games: 0 }]));
  const logs = Object.fromEntries(teamAbbrs.map((t) => [t, {}]));
  const defTotals = Object.fromEntries(teamAbbrs.map((t) => [t, { sum: 0, games: 0 }]));
  const defLogs = Object.fromEntries(teamAbbrs.map((t) => [t, {}]));
  let leagueSum = 0, leagueGames = 0;

  for (const r of Object.values(results)) {
    for (const [off, g] of Object.entries(r.off ?? {})) {
      if (!totals[off]) continue;
      if (![g.pa, g.ya, g.sacks, g.ints, g.fumLost].every(Number.isFinite)) continue;
      const pts = scoreGame(g);
      totals[off].sum += pts;
      totals[off].games += 1;
      leagueSum += pts;
      leagueGames += 1;
      logs[off][r.week] = { ...g, pts };
      // The same stat line is what the opposing defense scored.
      const def = off === r.home ? r.away : off === r.away ? r.home : null;
      if (def && defTotals[def]) {
        defTotals[def].sum += pts;
        defTotals[def].games += 1;
        defLogs[def][r.week] = { ...g, pts };
      }
    }
  }
  const rows = teamAbbrs
    .filter((t) => totals[t].games > 0)
    .map((t) => ({ t, avg: totals[t].sum / totals[t].games, games: totals[t].games }));

  // Competition ranking on the 1-decimal average shown (ties share a rank, like ESPN).
  const ranks = {};
  for (const row of rows) {
    const shown = Math.round(row.avg * 10);
    const better = rows.filter((o) => Math.round(o.avg * 10) < shown).length;
    ranks[row.t] = { rank: better + 1, avg: row.avg, games: row.games };
  }

  // D/ST position rank (like ESPN's PRK): total fantasy points this season, most = 1st.
  const dRows = teamAbbrs.filter((t) => defTotals[t].games > 0);
  const dstRanks = {};
  for (const t of dRows) {
    const shown = Math.round(defTotals[t].sum * 10);
    const better = dRows.filter((o) => Math.round(defTotals[o].sum * 10) > shown).length;
    dstRanks[t] = { rank: better + 1, total: defTotals[t].sum, games: defTotals[t].games,
      avg: defTotals[t].sum / defTotals[t].games };
  }
  return { ranks, logs, defLogs, dstRanks, nflAvg: leagueGames ? leagueSum / leagueGames : 0 };
}

/* ---------- data shaping ---------- */

function buildMatchups(schedule, fromWeek) {
  const byWeek = {};
  for (const g of schedule) {
    if (g.week < fromWeek) continue;
    byWeek[g.week] ??= {};
    const done = !!g.completed;
    byWeek[g.week][g.home] = { opp: g.away, home: true, id: g.id, done };
    byWeek[g.week][g.away] = { opp: g.home, home: false, id: g.id, done };
  }
  return byWeek;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ---------- persistence ---------- */

function loadUnavailable() {
  try {
    const raw = localStorage.getItem(state.storageKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.unavailable = new Set(saved.unavailable ?? []);
    els.hide.checked = !!saved.hide;
    if (PRESETS[saved.scoring]) state.scoringKey = saved.scoring;
  } catch { /* storage unavailable */ }
}

function saveUnavailable() {
  try {
    localStorage.setItem(state.storageKey, JSON.stringify({
      unavailable: [...state.unavailable],
      hide: els.hide.checked,
      scoring: state.scoringKey,
    }));
  } catch { /* storage unavailable */ }
}

/* ---------- sorting ---------- */

function sortTeams() {
  const { key, dir } = state.sort;
  const teams = state.data.teams;
  const byName = (a, b) => teams[a].short.localeCompare(teams[b].short);

  if (key === 'team') {
    state.teams.sort((a, b) => (dir === 'asc' ? byName(a, b) : byName(b, a)));
    return;
  }
  if (key === 'prk') {
    const tot = (t) => state.dstRanks[t]?.total ?? null;
    state.teams.sort((a, b) => {
      const va = tot(a), vb = tot(b);
      if (va == null && vb == null) return byName(a, b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir === 'asc' ? vb - va || byName(a, b) : va - vb || byName(a, b);
    });
    return;
  }
  const week = key;
  const value = (t) => {
    const m = state.matchups[week]?.[t];
    if (!m) return null;                         // bye
    if (m.done) return undefined;                // already played: after open games, before byes
    return state.ranks[m.opp]?.avg ?? null;      // sort by underlying average
  };
  const group = (v) => (v === null ? 2 : v === undefined ? 1 : 0);   // open, played, bye
  state.teams.sort((a, b) => {
    const va = value(a), vb = value(b);
    const ga = group(va), gb = group(vb);
    if (ga !== gb) return ga - gb;
    if (ga) return byName(a, b);
    return dir === 'desc' ? vb - va || byName(a, b) : va - vb || byName(a, b);
  });
}

function setSort(key) {
  if (state.sort.key === key) {
    if (key === 'team' || key === 'prk') state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    // Rank opens with 1st on top, A–Z with A on top, weeks with best matchups on top.
    state.sort = { key, dir: key === 'team' || key === 'prk' ? 'asc' : 'desc' };
  }
  sortTeams();
  render();
}

/* ---------- best available picks ---------- */

// Projection = average of the D/ST's own points per game and what the opponent
// gives up to D/STs per game, both in the active scoring. Taken teams are skipped,
// so the list refills as you mark teams taken.
const PICK_COUNT = 3;

function pickWeek() {
  return typeof state.sort.key === 'number' ? state.sort.key : state.planWeek;
}

// The week people are planning for. Once every game of the current week is final
// except Monday night, picks move on to next week (waivers are already open).
function findPlanWeek(schedule, weeks) {
  const isMonday = (iso) => {
    if (!iso) return false;
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/New_York' })
      .format(new Date(iso));
    return day === 'Mon';
  };
  for (const w of weeks) {
    const games = schedule.filter((g) => g.week === w);
    const open = games.filter((g) => !g.completed);
    const onlyMondayLeft = open.length < games.length && open.every((g) => isMonday(g.date));
    if (!onlyMondayLeft) return w;
  }
  return weeks[0];
}

function computePicks() {
  const week = pickWeek();
  const list = [];
  for (const t of Object.keys(state.data.teams)) {
    if (state.unavailable.has(t)) continue;
    const m = state.matchups[week]?.[t];
    const d = state.dstRanks[t];
    const r = m && state.ranks[m.opp];
    if (!m || m.done || !d || !r) continue;     // skip games already played
    list.push({ team: t, m, proj: (d.avg + r.avg) / 2, dAvg: d.avg, oAvg: r.avg, oRank: r.rank });
  }
  list.sort((a, b) => b.proj - a.proj || a.team.localeCompare(b.team));
  state.picks = { week, list: list.slice(0, PICK_COUNT) };
  state.pickPlace = Object.fromEntries(state.picks.list.map((p, i) => [p.team, i + 1]));
}

function renderPicks() {
  const { week, list } = state.picks;
  const el = els.picks;
  if (!week || !list.length) { el.hidden = true; return; }
  const teams = state.data.teams;
  const sortedWeek = typeof state.sort.key === 'number';
  el.hidden = false;
  el.innerHTML =
    `<div class="picks-head"><span class="picks-title">Best available, Week ${week}</span>` +
    `<span class="picks-sub">${SCORING.label} scoring${sortedWeek ? '' : '. Click another week to see its picks'}</span></div>` +
    '<ol class="picks-list">' + list.map((p, i) => {
      const t = teams[p.team];
      return `<li><button type="button" class="pick-card" data-team="${p.team}" ` +
        `title="${t.short}: ${fmt(p.dAvg)} pts/game, and ${teams[p.m.opp].short} allow ${fmt(p.oAvg)} to D/STs (${ordinal(p.oRank)}). Click to jump to the row.">` +
        `<span class="pick-n">${i + 1}</span>` +
        (t.logo ? `<img src="${t.logo}" alt="" loading="lazy">` : '') +
        `<span class="pick-who"><span class="pick-nm">${t.short}</span>` +
        `<span class="pick-vs">${p.m.home ? 'vs' : '@'} ${p.m.opp}</span></span>` +
        `<span class="pick-proj"><b>${fmt(p.proj)}</b><span>proj</span></span></button></li>`;
    }).join('') + '</ol>';
}

/* ---------- rendering ---------- */

function headerCell(label, key, extraClass = '') {
  const th = document.createElement('th');
  th.scope = 'col';
  if (extraClass) th.className = extraClass;
  const active = state.sort.key === key;
  if (active) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sort';
  btn.title = key === 'team' ? 'Sort by team name' : `Sort by Week ${key} matchup`;
  const arrow = !active ? '' : key === 'team'
    ? (state.sort.dir === 'asc' ? '▲' : '▼')
    : (state.sort.dir === 'desc' ? '▼' : '▲');
  btn.innerHTML = `<span>${label}</span><span class="arrow" aria-hidden="true">${arrow}</span>`;
  btn.addEventListener('click', () => setSort(key));
  th.append(btn);
  return th;
}

function cornerCell() {
  const th = document.createElement('th');
  th.scope = 'col';
  th.className = 'corner';
  const wrap = document.createElement('div');
  wrap.className = 'corner-in';
  wrap.innerHTML = '<span class="corner-lbl">Defense</span>';
  const opts = [['prk', 'Rank', 'Sort by points scored this season (D/ST rank)'], ['team', 'A–Z', 'Sort by team name']];
  for (const [key, label, title] of opts) {
    const active = state.sort.key === key;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'corner-sort';
    b.title = title + (active ? '. Click again to reverse.' : '');
    b.setAttribute('aria-pressed', String(active));
    b.innerHTML = label + (active ? `<span class="arrow" aria-hidden="true">${state.sort.dir === 'asc' ? '▲' : '▼'}</span>` : '');
    b.addEventListener('click', () => setSort(key));
    wrap.append(b);
  }
  if (state.sort.key === 'prk' || state.sort.key === 'team') {
    th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
  }
  th.append(wrap);
  return th;
}

function matchupCell(team, week) {
  const td = document.createElement('td');
  td.className = 'cell';
  if (state.sort.key === week) td.classList.add('sorted-col');

  const m = state.matchups[week]?.[team];
  const place = week === state.picks?.week ? state.pickPlace?.[team] : null;
  if (place) td.classList.add('pick');
  if (!m) {
    td.classList.add('bye');
    td.textContent = 'BYE';
    td.title = `${state.data.teams[team].short}: bye in Week ${week}`;
    return td;
  }
  const r = state.ranks[m.opp];
  const oppLabel = (m.home ? '' : '@') + m.opp;
  if (m.done) {
    // Already played (e.g. Thursday night): gray it out and show what this D/ST scored.
    const line = state.data.results?.[m.id]?.off?.[m.opp];
    const pts = line ? scoreGame(line) : null;
    td.classList.add('played');
    if (r) { td.classList.add('clickable'); td.dataset.opp = m.opp; td.tabIndex = 0; td.setAttribute('role', 'button'); }
    td.innerHTML = `<span class="opp">${oppLabel}</span>` +
      `<span class="meta"><span class="fin">FINAL</span>${pts == null ? '' : `<span class="avg">${fmt(pts)} pts</span>`}</span>`;
    td.title = `Week ${week}: already played ${m.home ? 'vs' : 'at'} ${state.data.teams[m.opp].name}.` +
      (pts == null ? ' Points show after the next data update.' : ` ${state.data.teams[team].short} D/ST scored ${fmt(pts)} pts (${SCORING.label}).`);
    return td;
  }
  if (!r) {
    td.innerHTML = `<span class="opp">${oppLabel}</span><span class="meta"><span class="avg">no games yet</span></span>`;
    return td;
  }
  td.classList.add(`tier-${tierFor(r.rank)}`, 'clickable');
  td.dataset.opp = m.opp;
  td.tabIndex = 0;
  td.setAttribute('role', 'button');
  td.innerHTML =
    `<span class="opp">${oppLabel}</span>` +
    `<span class="meta"><span class="rk">${ordinal(r.rank)}</span><span class="avg">${r.avg.toFixed(1)}</span></span>` +
    (place ? `<span class="pick-badge" aria-label="Best available pick ${place}">★${place}</span>` : '');
  td.title = (place ? `Best available pick #${place} for Week ${week}. ` : '') + `Week ${week}: ${m.home ? 'vs' : 'at'} ${state.data.teams[m.opp].name}. ` +
    `Defenses average ${r.avg.toFixed(1)} pts against them (${r.games} games), ${ordinal(r.rank)} of 32. Click for details.`;
  return td;
}

function render() {
  const { teams } = state.data;
  const table = els.grid;
  table.textContent = '';
  computePicks();
  renderPicks();
  table.classList.toggle('hide-unavailable', els.hide.checked);
  els.takenCount.textContent = `(${state.unavailable.size})`;

  const thead = table.createTHead();
  const hr = thead.insertRow();
  hr.append(cornerCell());
  for (const w of state.weeks) hr.append(headerCell(`Week ${w}`, w));

  const tbody = table.createTBody();
  for (const t of state.teams) {
    const tr = tbody.insertRow();
    if (state.unavailable.has(t)) tr.classList.add('unavailable');

    const th = document.createElement('th');
    th.scope = 'row';
    const isOut = state.unavailable.has(t);
    const wrap = document.createElement('div');
    wrap.className = 'team-cell';
    const take = document.createElement('button');
    take.type = 'button';
    take.className = 'take';
    take.setAttribute('role', 'switch');
    take.setAttribute('aria-checked', String(isOut));
    take.setAttribute('aria-label', `${teams[t].short} D/ST taken in your league`);
    take.title = isOut ? 'Taken in your league. Click to mark available.' : 'Mark as taken in your league';
    take.innerHTML = '<span class="knob"></span>';
    take.addEventListener('click', () => toggleTeam(t));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'team';
    btn.dataset.team = t;
    const d = state.dstRanks[t];
    const rankLine = d
      ? `${ordinal(d.rank)} in ${SCORING.label} scoring: ${fmt(d.total)} pts in ${d.games} game${d.games === 1 ? '' : 's'} (${fmt(d.avg)} avg). `
      : '';
    btn.title = rankLine + 'Click to see this D/ST week by week.';
    btn.innerHTML =
      (teams[t].logo ? `<img src="${teams[t].logo}" alt="" loading="lazy">` : '') +
      `<span class="who"><span class="nm">${teams[t].short}</span><span class="ab">${t} D/ST</span></span>` +
      (d ? `<span class="prk"><span class="prk-n">${ordinal(d.rank)}</span><span class="prk-p">${fmt(d.total)} pts (${fmt(d.avg)})</span></span>` : '') +
      `<span class="flag">Taken</span>`;
    btn.addEventListener('click', () => openDefense(t));
    wrap.append(take, btn);
    th.append(wrap);
    tr.append(th);

    for (const w of state.weeks) tr.append(matchupCell(t, w));
  }
}

function toggleTeam(t) {
  if (state.unavailable.has(t)) state.unavailable.delete(t);
  else state.unavailable.add(t);
  saveUnavailable();
  render();
}

function showError(msg) {
  els.status.hidden = false;
  els.status.textContent = msg;
}

/* ---------- detail view (D/STs vs. a team) ---------- */

const fmt = (n) => n.toFixed(1);
const signed = (n) => (n > 0 ? '+' : '') + n.toFixed(1);

function openDetail(off) {
  const { teams, schedule } = state.data;
  const t = teams[off];
  const r = state.ranks[off];
  if (!r) return;
  const pvo = r.avg - state.nflAvg;
  const tierCls = `tier-${tierFor(r.rank)}`;

  const games = {};
  for (const g of schedule) {
    if (g.home === off) games[g.week] = { opp: g.away, home: true };
    else if (g.away === off) games[g.week] = { opp: g.home, home: false };
  }

  let rows = '';
  for (let w = 1; w <= 18; w++) {
    const g = games[w];
    const log = state.logs[off]?.[w];
    if (!g) {
      rows += `<tr class="bye-row"><td>${w}</td><td>Bye</td><td colspan="7"></td></tr>`;
      continue;
    }
    const opp = (g.home ? '' : '@') + g.opp;
    if (!log) {
      rows += `<tr class="future"><td>${w}</td><td>${opp}</td>` + '<td>–</td>'.repeat(7) + '</tr>';
      continue;
    }
    const ptsCls = log.pts >= 10 ? 'good' : log.pts < 3 ? 'bad' : '';
    rows += `<tr><td>${w}</td><td>${opp}</td><td>${log.sacks}</td><td>${log.ints}</td>` +
      `<td>${log.fumLost}</td><td>${log.defTd}</td><td>${log.pa}</td><td>${log.ya}</td>` +
      `<td class="pts ${ptsCls}">${fmt(log.pts)}</td></tr>`;
  }

  els.detailBody.innerHTML = `
    <div class="d-head">
      ${t.logo ? `<img src="${t.logo}" alt="">` : ''}
      <div>
        <h2 id="detailTitle">D/STs vs. ${t.short}</h2>
        <p class="d-sub">${t.name}, ${r.games} game${r.games === 1 ? '' : 's'} played</p>
      </div>
    </div>
    <div class="d-stats ${tierCls}">
      <div><span class="d-num">${fmt(r.avg)}</span><span class="d-lbl">Avg pts allowed to D/STs</span></div>
      <div><span class="d-num">${signed(pvo)}</span><span class="d-lbl">Vs NFL avg (${fmt(state.nflAvg)})</span></div>
      <div><span class="d-num rk">${ordinal(r.rank)}</span><span class="d-lbl">Opponent rank</span></div>
    </div>
    <div class="d-table-wrap">
      <table class="d-table">
        <thead><tr>
          <th>Wk</th><th>Opp</th><th title="Sacks">Sck</th><th title="Interceptions">Int</th>
          <th title="Fumble recoveries">FR</th><th title="Defensive and return touchdowns">TD</th>
          <th title="Points allowed">PA</th><th title="Yards allowed">Yds</th><th>Pts</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  els.detail.showModal();
}

// Week-by-week history for one D/ST: what it scored, plus its upcoming opponents.
function openDefense(def) {
  const { teams, schedule } = state.data;
  const t = teams[def];
  const d = state.dstRanks[def];
  const games = {};
  for (const g of schedule) {
    if (g.home === def) games[g.week] = { opp: g.away, home: true };
    else if (g.away === def) games[g.week] = { opp: g.home, home: false };
  }
  let rows = '';
  for (let w = 1; w <= 18; w++) {
    const g = games[w];
    if (!g) { rows += `<tr class="bye-row"><td>${w}</td><td>Bye</td><td colspan="7"></td></tr>`; continue; }
    const opp = (g.home ? '' : '@') + g.opp;
    const log = state.defLogs[def]?.[w];
    if (!log) {
      const r = state.ranks[g.opp];
      const hint = r ? ` <span class="opp-rk tier-${tierFor(r.rank)}">${ordinal(r.rank)}</span>` : '';
      rows += `<tr class="future"><td>${w}</td><td>${opp}${hint}</td>` + '<td>–</td>'.repeat(7) + '</tr>';
      continue;
    }
    const ptsCls = log.pts >= 10 ? 'good' : log.pts < 3 ? 'bad' : '';
    rows += `<tr><td>${w}</td><td>${opp}</td><td>${log.sacks}</td><td>${log.ints}</td>` +
      `<td>${log.fumLost}</td><td>${log.defTd}</td><td>${log.pa}</td><td>${log.ya}</td>` +
      `<td class="pts ${ptsCls}">${fmt(log.pts)}</td></tr>`;
  }
  const taken = state.unavailable.has(def);
  els.detailBody.innerHTML = `
    <div class="d-head">
      ${t.logo ? `<img src="${t.logo}" alt="">` : ''}
      <div>
        <h2 id="detailTitle">${t.short} D/ST</h2>
        <p class="d-sub">${t.name}, ${d ? `${d.games} game${d.games === 1 ? '' : 's'} played` : 'no games yet'} · ${SCORING.label} scoring${taken ? ' · <b>Taken</b>' : ''}</p>
      </div>
    </div>
    <div class="d-stats">
      <div><span class="d-num">${d ? fmt(d.total) : '–'}</span><span class="d-lbl">Season pts</span></div>
      <div><span class="d-num">${d ? fmt(d.avg) : '–'}</span><span class="d-lbl">Avg per game</span></div>
      <div><span class="d-num rk">${d ? ordinal(d.rank) : '–'}</span><span class="d-lbl">D/ST rank</span></div>
    </div>
    <div class="d-table-wrap">
      <table class="d-table">
        <thead><tr>
          <th>Wk</th><th>Opp</th><th title="Sacks">Sck</th><th title="Interceptions">Int</th>
          <th title="Fumble recoveries">FR</th><th title="Defensive and return touchdowns">TD</th>
          <th title="Points allowed">PA</th><th title="Yards allowed">Yds</th><th>Pts</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="d-note">Upcoming games show the opponent's rank vs. D/STs (21st–32nd is a good matchup).</p>`;
  els.detail.showModal();
}

function applyScoring() {
  SCORING = PRESETS[state.scoringKey] ?? PRESETS.espn;
  ({ ranks: state.ranks, logs: state.logs, defLogs: state.defLogs, dstRanks: state.dstRanks, nflAvg: state.nflAvg } =
    computeRanks(state.data.results ?? {}, Object.keys(state.data.teams)));
  els.scoringNote.textContent = `${SCORING.label} default D/ST scoring`;
  for (const tab of els.tabs.querySelectorAll('[data-scoring]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.scoring === state.scoringKey));
  }
}

function selectScoring(key) {
  if (!PRESETS[key] || key === state.scoringKey) return;
  state.scoringKey = key;
  applyScoring();
  saveUnavailable();
  sortTeams();
  render();
}

function openCustom() {
  els.customBody.innerHTML = `
    <span class="beta">Beta</span>
    <h2 id="customTitle">Import your league's defensive rules?</h2>
    <p>Enter your league's D/ST scoring once (sacks, turnovers, points allowed, yards allowed)
      and every rank, average and breakdown on the grid recalculates to match. Save each league
      under its own name and switch between them with a tab.</p>
    <p class="price-soon">Pricing options coming at a later date.</p>
    <div class="c-actions">
      <button type="button" class="btn primary c-close">Got it</button>
    </div>
    <p class="c-note">Custom scoring is a beta feature and may change as we improve it.</p>`;
  els.custom.showModal();
}

/* ---------- boot ---------- */

async function init() {
  let data;
  try {
    const res = await fetch(`data/defense.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    els.sub.textContent = 'No data yet';
    showError('Schedule data is missing. Run the "Update defense data" workflow on GitHub to create data/defense.json.');
    return;
  }

  state.data = data;
  state.storageKey = `dst-grid-${data.season}`;
  const abbrs = Object.keys(data.teams);
  state.matchups = buildMatchups(data.schedule, data.currentWeek);
  state.weeks = Object.keys(state.matchups).map(Number).sort((a, b) => a - b);
  state.planWeek = findPlanWeek(data.schedule, state.weeks);
  state.teams = abbrs.slice();

  const gamesPlayed = new Set(Object.values(data.results ?? {}).map((r) => r.week));
  const throughWeek = gamesPlayed.size ? Math.max(...gamesPlayed) : 0;
  const updated = new Date(data.updatedAt).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  els.sub.textContent = state.weeks.length
    ? `${data.season} season, Weeks ${state.weeks[0]}–${state.weeks.at(-1)}. ` +
      `Ranks through Week ${throughWeek}. Updated ${updated}.`
    : `${data.season} regular season is over.`;

  loadUnavailable();
  const param = new URLSearchParams(location.search).get('scoring');
  if (PRESETS[param]) state.scoringKey = param;   // shareable links: ?scoring=yahoo
  applyScoring();
  els.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('button');
    if (!tab) return;
    if (tab.dataset.custom != null) openCustom();
    else selectScoring(tab.dataset.scoring);
  });
  els.custom.addEventListener('click', (e) => {
    if (e.target === els.custom || e.target.closest('.c-close')) els.custom.close();
  });
  els.hide.addEventListener('change', () => { saveUnavailable(); render(); });
  els.clear.addEventListener('click', () => {
    state.unavailable.clear();
    saveUnavailable();
    render();
  });

  const openFrom = (e) => {
    const cell = e.target.closest('td[data-opp]');
    if (cell) openDetail(cell.dataset.opp);
  };
  els.grid.addEventListener('click', openFrom);
  els.grid.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('td[data-opp]')) {
      e.preventDefault();
      openFrom(e);
    }
  });
  els.picks.addEventListener('click', (e) => {
    const card = e.target.closest('.pick-card');
    if (!card) return;
    const row = els.grid.querySelector(`button.team[data-team="${card.dataset.team}"]`)?.closest('tr');
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  });
  els.detail.addEventListener('click', (e) => {
    if (e.target === els.detail || e.target.closest('.d-close')) els.detail.close();
  });

  sortTeams();
  render();
}

init();
