# Fantasy Defense Assist

Fantasy football defense streaming grid: every NFL team's remaining schedule, with each
opponent's rank (1st = toughest for defenses, 32nd = best) and the average D/ST points
scored against that offense, season to date.

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The website. Scoring rules live at the top of `app.js` (`SCORING`). |
| `scripts/build-data.mjs` | Pulls the schedule and box scores from ESPN's public endpoints and writes `data/defense.json`. |
| `.github/workflows/update-data.yml` | Runs the script Monday, Tuesday and Friday at 5am Arizona time and commits new data. Use "Run workflow" for a manual update anytime. |
| `data/defense.json` | Generated. Don't edit by hand. |
| `ads.js` | Ad slot IDs. Slots stay hidden until an ID is filled in. |
| `ads.txt` | AdSense publisher record. |
| `privacy.html` | Privacy policy (required for AdSense). |
| `robots.txt`, `sitemap.xml` | Help Google find and index the site. |
| `CNAME` | Points GitHub Pages at fantasydefenseassist.com. |

## Setup

1. Create a new public repo and upload everything in this folder (keep the `.github` folder).
2. **Settings → Actions → General → Workflow permissions:** choose *Read and write permissions*, save.
3. **Actions tab → Update defense data → Run workflow.** This creates `data/defense.json` (takes about a minute).
4. **Settings → Pages:** Source *Deploy from a branch*, branch `main`, folder `/ (root)`.
5. Custom domain: the `CNAME` file already points Pages at fantasydefenseassist.com. Under Settings → Pages → Custom domain, confirm it shows fantasydefenseassist.com, then tick *Enforce HTTPS* once the certificate is ready.

## How ranks are calculated

For every completed game, the defense facing each offense is scored with the selected tab's
default D/ST rules, then each offense's average is ranked 1–32.

- **ESPN:** sacks, INTs, fumble recoveries, defensive/return TDs, safeties, points-allowed
  tiers (+5 shutout down to −5), and yards-allowed tiers (+5 down to −7).
- **Yahoo** and **Sleeper** (identical defaults today): same big plays, points-allowed tiers
  (+10 shutout down to −4), no yards allowed.
- **Custom (beta, paid):** opens an unlock popup. Set the price and checkout link in `CUSTOM`
  near the top of `app.js`.

Rule sets live in `PRESETS` at the top of `app.js`. Links can open a tab directly, e.g.
`?scoring=yahoo`. Blocked kicks and 2-point returns aren't in the box score, so they're not
counted; points allowed uses the offense's final score.

## Run locally

```
node scripts/build-data.mjs
python3 -m http.server 8000
```
Then open http://localhost:8000.
