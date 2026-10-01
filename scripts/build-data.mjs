#!/usr/bin/env node
// Builds data/defense.json from ESPN's public NFL endpoints.
// Stores RAW defensive stats per game; the website does the scoring,
// so custom league scoring can be added later without changing this script.
//
// Run locally:  node scripts/build-data.mjs        (SEASON=2026 to force a year)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = path.join(ROOT, 'data', 'defense.json');
const WEEKS = 18;

const now = new Date();
const SEASON = Number(process.env.SEASON) ||
  (now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'fantasydefenseassist/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url} -> ${err.message}`);
      await sleep(1500 * i);
    }
  }
}

function teamInfo(t = {}) {
  return {
    abbr: t.abbreviation,
    id: String(t.id ?? ''),
    name: t.displayName ?? t.name ?? t.abbreviation,
    short: t.shortDisplayName ?? t.name ?? t.abbreviation,
    logo: t.logo ?? '',
  };
}

export function parseScoreboardEvent(ev, week) {
  const comp = ev.competitions?.[0];
  const sides = comp?.competitors ?? [];
  const home = sides.find((c) => c.homeAway === 'home');
  const away = sides.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const status = comp.status?.type ?? ev.status?.type ?? {};
  return {
    id: String(ev.id),
    week,
    date: ev.date,
    completed: !!status.completed,
    home: teamInfo(home.team),
    away: teamInfo(away.team),
    homeScore: Number(home.score),
    awayScore: Number(away.score),
  };
}

const firstNum = (v) => {
  if (v == null) return NaN;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

// Scoring plays that count as a D/ST touchdown for the team that scored them.
export function isDstTouchdown(text = '') {
  return /touchdown/i.test(text) &&
    /(interception|fumble|punt|kickoff|kick off|blocked|missed field goal|return)/i.test(text) &&
    !/\bown\b/i.test(text);
}

// Returns { [offenseAbbr]: {pa, ya, sacks, ints, fumLost, defTd, safeties} }
// Each record = what the DEFENSE FACING that offense did in this game.
export function parseSummary(summary, game) {
  const { home, away } = game;
  const idToAbbr = { [home.id]: home.abbr, [away.id]: away.abbr };
  const score = { [home.abbr]: game.homeScore, [away.abbr]: game.awayScore };
  const opp = { [home.abbr]: away.abbr, [away.abbr]: home.abbr };

  const box = {};
  for (const t of summary.boxscore?.teams ?? []) {
    const abbr = idToAbbr[String(t.team?.id)] ?? t.team?.abbreviation;
    const stats = {};
    for (const s of t.statistics ?? []) stats[s.name] = s.displayValue ?? s.value;
    box[abbr] = stats;
  }

  const tds = { [home.abbr]: 0, [away.abbr]: 0 };
  const safeties = { [home.abbr]: 0, [away.abbr]: 0 };
  for (const p of summary.scoringPlays ?? []) {
    const scorer = idToAbbr[String(p.team?.id)] ?? p.team?.abbreviation;
    if (!(scorer in tds)) continue;
    const text = p.type?.text ?? '';
    if (/safety/i.test(text)) safeties[scorer]++;
    else if (isDstTouchdown(text)) tds[scorer]++;
  }

  const out = {};
  for (const off of [home.abbr, away.abbr]) {
    const s = box[off] ?? {};
    const def = opp[off];
    out[off] = {
      pa: score[off],
      ya: firstNum(s.totalYards),
      sacks: firstNum(s.sacksYardsLost), // "3-21" -> 3 sacks taken by this offense
      ints: firstNum(s.interceptions),   // interceptions thrown by this offense
      fumLost: firstNum(s.fumblesLost),
      defTd: tds[def],
      safeties: safeties[def],
    };
  }
  return out;
}

const isComplete = (off) =>
  off && Object.values(off).every((o) =>
    ['pa', 'ya', 'sacks', 'ints', 'fumLost'].every((k) => Number.isFinite(o[k])));

async function main() {
  let previous = {};
  try {
    const old = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    if (old.season === SEASON) previous = old.results ?? {};
  } catch { /* first run */ }

  const teams = {};
  const schedule = [];
  for (let week = 1; week <= WEEKS; week++) {
    const sb = await getJSON(`${BASE}/scoreboard?dates=${SEASON}&seasontype=2&week=${week}&limit=100`);
    for (const ev of sb.events ?? []) {
      const g = parseScoreboardEvent(ev, week);
      if (!g) continue;
      for (const t of [g.home, g.away]) {
        teams[t.abbr] = { name: t.name, short: t.short, logo: t.logo };
      }
      schedule.push(g);
    }
    await sleep(250);
  }

  if (Object.keys(teams).length !== 32) {
    throw new Error(`Expected 32 teams, found ${Object.keys(teams).length}. Not writing data.`);
  }

  const results = {};
  let fetched = 0, reused = 0, incomplete = 0;
  for (const g of schedule.filter((x) => x.completed)) {
    if (isComplete(previous[g.id]?.off)) {
      results[g.id] = previous[g.id];
      reused++;
      continue;
    }
    const summary = await getJSON(`${BASE}/summary?event=${g.id}`);
    const off = parseSummary(summary, g);
    if (!isComplete(off)) {
      incomplete++;
      console.warn(`Week ${g.week} ${g.away.abbr}@${g.home.abbr}: missing stats`, JSON.stringify(off));
    }
    results[g.id] = { week: g.week, home: g.home.abbr, away: g.away.abbr, off };
    fetched++;
    await sleep(300);
  }

  const scored = Object.keys(results).length;
  if (scored > 0 && incomplete / scored > 0.25) {
    throw new Error(`${incomplete}/${scored} games missing stats; ESPN's format may have changed. Not writing data.`);
  }

  const pending = schedule.filter((g) => !g.completed).map((g) => g.week);
  const currentWeek = pending.length ? Math.min(...pending) : WEEKS;

  const data = {
    season: SEASON,
    updatedAt: new Date().toISOString(),
    currentWeek,
    teams,
    schedule: schedule.map((g) => ({
      id: g.id, week: g.week, date: g.date, home: g.home.abbr, away: g.away.abbr, completed: g.completed,
    })),
    results,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(data) + '\n');
  console.log(`Season ${SEASON}, current week ${currentWeek}. Games scored: ${scored} (${fetched} fetched, ${reused} reused, ${incomplete} incomplete).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
