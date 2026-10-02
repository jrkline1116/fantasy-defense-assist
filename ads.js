// Ad slots. Paste each AdSense ad unit's slot ID below (AdSense > Ads > By ad unit).
// A slot stays invisible until it has an ID, so nothing breaks before approval.
const ADSENSE = {
  client: 'ca-pub-5134360334819238',
  slots: {
    top: '5815182387',     // responsive display unit, above the scoring tabs
    bottom: '2878117144',  // responsive display unit, below the grid
    side: '4933345557',    // fixed 160x600 unit, shown left and right on wide screens only
  },
};

(function placeAds() {
  const wide = window.matchMedia('(min-width: 1500px)');
  // Phones get a fixed 320x100 banner. A responsive unit on a phone can grow
  // to a full-screen-tall square, which buries the grid.
  const phone = window.matchMedia('(max-width: 767px)').matches;
  let railsShown = false;

  function fill(el, slot, fixed) {
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.dataset.adClient = ADSENSE.client;
    ins.dataset.adSlot = slot;
    if (fixed) {
      ins.style.cssText = `display:inline-block;width:${fixed[0]}px;height:${fixed[1]}px`;
    } else {
      ins.style.display = 'block';
      ins.dataset.adFormat = 'horizontal';
      ins.dataset.fullWidthResponsive = 'false';
    }
    el.append(ins);
    el.classList.add('ad-on');
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* blocked */ }
  }

  for (const el of document.querySelectorAll('[data-ad="top"], [data-ad="bottom"]')) {
    const slot = ADSENSE.slots[el.dataset.ad];
    if (slot) fill(el, slot, phone ? [320, 100] : null);
  }

  // Side rails only on wide screens, so the grid keeps its width elsewhere.
  function rails() {
    if (railsShown || !wide.matches || !ADSENSE.slots.side) return;
    railsShown = true;
    document.body.classList.add('has-rails');
    for (const el of document.querySelectorAll('[data-ad="side"]')) fill(el, ADSENSE.slots.side, [160, 600]);
  }
  rails();
  wide.addEventListener?.('change', rails);
})();
