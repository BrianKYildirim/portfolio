// Expandable project case studies: one reusable <dialog>, a shared-element (FLIP) morph with
// the Web Animations API, history and deep links, per-project partials, on-demand demos.

const REGISTRY = [
  { id: 'strivoai', demo: null },
  { id: 'enchantment-calculator', demo: null },
  { id: 'rate-limiter', demo: 'ratelimit' },
  { id: 'image-quality-gate', demo: 'iqg' },
  { id: 'kv-server', demo: 'kv' },
];
const PROJECTS = new Map(REGISTRY.map((p) => [p.id, p]));
const DEMO_MODULES = { iqg: './demos/iqg.js', ratelimit: './demos/ratelimit.js', kv: './demos/kv.js' };
const CATEGORY = { 'full-stack': 'Full-stack', systems: 'Systems', backend: 'Backend' };
const HASH = /^#projects\/([\w-]+)$/;
const GHOST_FADE = '.project-featured, .projects-page-info > p, .project-tech, .project-links, .project-expand';
const html = document.documentElement;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (el) => el.getBoundingClientRect();
const fontSize = (el) => parseFloat(getComputedStyle(el).fontSize);
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const findCard = (id) => document.querySelector(`.projects-page-card[data-project="${id}"]`);

if (new URLSearchParams(location.search).has('drafts') || ['localhost', '127.0.0.1'].includes(location.hostname)) html.classList.add('drafts');

// WAAPI needs literal values, so the motion tokens are read from CSS once.
let T = null;
function tokens() {
  if (T) return T;
  const cs = getComputedStyle(html), v = (n) => cs.getPropertyValue(n).trim(), ms = (n) => parseFloat(v(n));
  return (T = { morph: v('--ease-morph'), fade: v('--ease-fade'), expand: ms('--dur-expand'), collapse: ms('--dur-collapse'),
    scrim: ms('--dur-scrim'), reveal: ms('--dur-reveal'), reduced: ms('--dur-reduced'), border: v('--border') });
}

// ---------- Dialog ----------
let dialog = null, els = null;
function ensureDialog() {
  if (dialog) return;
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="project-detail" class="pd" aria-labelledby="pd-title">
  <div class="pd-scrim"></div>
  <div class="pd-surface" aria-hidden="true"></div>
  <div class="pd-ghost-layer" aria-hidden="true"></div>
  <div class="pd-panel">
    <div class="pd-scroll" tabindex="-1">
      <header class="pd-hero">
        <div class="pd-media"><img alt=""></div>
        <div class="pd-hero-text">
          <p class="pd-cat smaller-h3 muted mono" data-reveal></p>
          <div class="pd-meta"><span data-shared="date"></span><span class="project-stat" data-shared="stat"></span></div>
          <h2 class="pd-title" id="pd-title" tabindex="-1" data-shared="title"></h2>
          <p class="pd-lede" data-reveal></p>
          <div class="pd-tech" data-reveal></div>
          <div class="project-links" data-reveal></div>
        </div>
      </header>
      <div class="pd-body"><div class="pd-body-inner"><nav class="pd-toc" aria-label="Case study sections"></nav><div class="pd-sections"></div></div></div>
    </div>
  </div>
  <div class="pd-fly" aria-hidden="true"><img alt=""></div>
  <button class="pd-close" type="button" aria-label="Close case study"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>
  <div class="pd-live vh" aria-live="polite"></div>
</dialog>`);
  dialog = document.getElementById('project-detail');
  const q = (s) => dialog.querySelector(s);
  els = {
    scrim: q('.pd-scrim'), surface: q('.pd-surface'), ghosts: q('.pd-ghost-layer'), panel: q('.pd-panel'), scroll: q('.pd-scroll'),
    hero: q('.pd-hero'), media: q('.pd-media'), heroImg: q('.pd-media img'), cat: q('.pd-cat'), date: q('[data-shared="date"]'),
    stat: q('[data-shared="stat"]'), title: q('.pd-title'), lede: q('.pd-lede'), tech: q('.pd-tech'), links: q('.pd-hero .project-links'),
    body: q('.pd-body'), toc: q('.pd-toc'), sections: q('.pd-sections'), fly: q('.pd-fly'), flyImg: q('.pd-fly img'), close: q('.pd-close'), live: q('.pd-live'),
  };
}

function fillHero(card) {
  const img = card.querySelector('.projects-page-image');
  els.heroImg.src = img.currentSrc || img.src;
  els.flyImg.src = els.heroImg.src;
  const cat = [CATEGORY[card.dataset.category] || ''];
  if (card.classList.contains('featured-project')) cat.unshift(Object.assign(document.createElement('span'), { className: 'accent', textContent: 'Featured' }), ' · ');
  els.cat.replaceChildren(...cat);
  const [date, stat] = card.querySelectorAll('.project-meta > span');
  els.date.textContent = clean(date?.textContent);
  els.stat.textContent = clean(stat?.textContent);
  els.title.textContent = clean(card.querySelector('.project-open').textContent);
  els.lede.textContent = clean(card.querySelector('.projects-page-info > p')?.textContent);
  els.tech.textContent = clean(card.querySelector('.project-tech')?.textContent);
  const links = [...card.querySelectorAll('.project-links a')].map((a) => a.cloneNode(true));
  if (PROJECTS.get(card.dataset.project).demo) {
    links.push(Object.assign(document.createElement('button'), { type: 'button', className: 'project-link pd-try', textContent: 'Try the demo ↓' }));
  }
  els.links.replaceChildren(...links);
}

// ---------- Partials ----------
const partials = new Map(); // id -> { p, html, err }
function loadPartial(id) {
  let e = partials.get(id);
  if (!e || e.err) {
    e = { html: null, err: false };
    e.p = fetch(`pages/projects/${id}.html`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then((h) => (e.html = h), (x) => { e.err = true; throw x; });
    partials.set(id, e);
  }
  return e;
}

function renderSections(id) {
  const e = loadPartial(id), g = gen;
  if (e.html != null) return fillSections(id, e.html);
  els.toc.replaceChildren();
  els.sections.innerHTML = '<div class="pd-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
  e.p.then((h) => {
    if (g !== gen) return;
    fillSections(id, h);
    if (state === 'open') watchDemo();
  }, () => {
    if (g !== gen) return;
    const gh = src?.querySelector('.project-links a[href*="github.com"]');
    els.sections.innerHTML = `<div class="pd-error"><p>Couldn't load the full write-up.</p><div><button type="button" class="project-link pd-retry">Retry</button></div></div>`;
    if (gh) els.sections.querySelector('.pd-error div').append(gh.cloneNode(true));
    els.live.textContent = "Couldn't load the full write-up.";
  });
}

let spy = null;
function fillSections(id, markup) {
  els.sections.innerHTML = markup;
  const list = document.createElement('ol');
  for (const s of els.sections.querySelectorAll('section[data-toc]')) {
    const a = Object.assign(document.createElement('a'), { href: `#${s.id}`, textContent: s.dataset.toc });
    a.dataset.target = s.id;
    const li = document.createElement('li');
    li.append(a);
    list.append(li);
  }
  els.toc.replaceChildren(list);
  list.querySelector('a')?.setAttribute('aria-current', 'true');
  spy?.disconnect();
  spy = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) for (const a of list.querySelectorAll('a')) a.setAttribute('aria-current', String(a.dataset.target === en.target.id));
  }, { root: els.scroll, rootMargin: '-20% 0px -70% 0px' });
  els.sections.querySelectorAll('section[data-toc]').forEach((s) => spy.observe(s));
  if (html.classList.contains('drafts')) console.info(`[project-detail] ${id}: ${els.sections.querySelectorAll('[data-placeholder]').length} placeholder(s)`);
}

function scrollToSection(sec) {
  if (!sec) return;
  const top = rect(sec).top - rect(els.scroll).top + els.scroll.scrollTop - 24;
  els.scroll.scrollTo({ top, behavior: reducedMotion() ? 'instant' : 'smooth' });
  sec.querySelector('[tabindex="-1"]')?.focus({ preventScroll: true });
}

// ---------- Demos ----------
let demoIO = null, demoApi = null, demoInView = false, demoLoading = false;
function watchDemo() {
  const sec = els.sections.querySelector('#pd-demo');
  if (!sec || !current?.demo || demoIO) return;
  demoIO = new IntersectionObserver(([en]) => {
    demoInView = en.isIntersecting;
    if (demoInView && !demoApi && !demoLoading) mountDemo(sec, gen);
    else if (demoApi) demoInView && !document.hidden ? demoApi.resume() : demoApi.pause();
  }, { root: els.scroll, rootMargin: '200px' });
  demoIO.observe(sec);
}
async function mountDemo(sec, g) {
  demoLoading = true;
  const shell = sec.querySelector('.demo');
  try {
    const mod = await import(DEMO_MODULES[current.demo]);
    if (g !== gen || state !== 'open') return;
    const statusEl = shell.querySelector('.demo-status [role="status"]');
    demoApi = mod.mount(shell, { status: (msg) => { statusEl.textContent = msg; } });
    if (!demoInView || document.hidden) demoApi.pause();
  } catch (err) {
    console.error(err);
    if (g === gen) shell.querySelector('.demo-mount').innerHTML = '<p class="pd-caption">Couldn’t load this demo. Reload the page to try again.</p>';
  } finally { demoLoading = false; }
}
function destroyDemo() {
  demoIO?.disconnect(); demoIO = null; demoInView = false;
  try { demoApi?.destroy(); } catch (err) { console.error(err); }
  demoApi = null;
}

// ---------- Motion ----------
let state = 'idle', anims = [], gen = 0, ghost = null, src = null, savedY = 0, current = null, skipNextPop = false, ownCloses = 0;
const play = (el, kf, { duration, delay = 0, easing = T.morph }) => {
  const a = el.animate(kf, { duration, delay, easing, fill: 'both' }); anims.push(a); return a;
};
const whenDone = (g, fn) => Promise.all(anims.map((a) => a.finished)).then(() => { if (g === gen) fn(); }, () => {});
const cancelAll = () => { anims.forEach((a) => a.cancel()); anims = []; };

// Card <-> hero pairs that travel: title, date, stat.
const shared = (node) => [node.querySelector('h2'), node.querySelector('.project-meta > span:first-child'), node.querySelector('.project-meta .project-stat')];
const heroShared = () => [els.title, els.date, els.stat];

function measure(card) {
  const img = card.querySelector('.projects-page-image'), media = card.querySelector('.project-media');
  const W = img.naturalWidth, H = img.naturalHeight;
  const cover = (b) => { const k = Math.max(b.width / W, b.height / H), w = W * k, h = H * k; return { x: b.left + (b.width - w) / 2, y: b.top + (b.height - h) / 2, w, h }; };
  const m = {
    D: rect(dialog), R0: rect(card), R1: rect(els.panel), S: rect(els.scroll), I0: rect(img), C0: rect(media), I1: rect(els.media),
    W, H, cover, cardBorder: getComputedStyle(card).borderTopColor, expandOpacity: getComputedStyle(card.querySelector('.project-expand')).opacity,
    pairs: shared(card).map((a, i) => { const b = heroShared()[i]; return a && b ? { A: rect(a), B: rect(b), s: fontSize(a) / fontSize(b) } : null; }),
  };
  return m;
}
// clip-path inset() relative to the dialog, rounding the corners that coincide with `outer`.
function insetIn(m, b, outer, r) {
  const near = (x, y) => Math.abs(x - y) < 2;
  const rad = [near(b.left, outer.left) && near(b.top, outer.top), near(b.right, outer.right) && near(b.top, outer.top),
    near(b.right, outer.right) && near(b.bottom, outer.bottom), near(b.left, outer.left) && near(b.bottom, outer.bottom)].map((c) => (c ? r : 0) + 'px');
  return `inset(${b.top - m.D.top}px ${m.D.right - b.right}px ${m.D.bottom - b.bottom}px ${b.left - m.D.left}px round ${rad.join(' ')})`;
}
const shrink = (b, d) => ({ left: b.left + d, top: b.top + d, right: b.right - d, bottom: b.bottom - d });
const geo = (m, b, r) => ({ left: b.left - m.D.left + 'px', top: b.top - m.D.top + 'px', width: b.width + 'px', height: b.height + 'px', borderRadius: r + 'px' });
const panelClip = (m) => `inset(${m.R0.top - m.R1.top}px ${m.R1.right - m.R0.right}px ${m.R1.bottom - m.R0.bottom}px ${m.R0.left - m.R1.left}px round 8px)`;

function makeGhost(card, m) {
  const g = card.cloneNode(true);
  g.classList.remove('is-source');
  g.classList.add('pd-ghost');
  g.removeAttribute('data-project');
  g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  g.inert = true;
  g.setAttribute('aria-hidden', 'true');
  Object.assign(g.style, { left: m.R0.left - m.D.left + 'px', top: m.R0.top - m.D.top + 'px', width: m.R0.width + 'px', height: m.R0.height + 'px' });
  els.ghosts.append(g);
  return g;
}

// Positions the flying screenshot at the hero's displayed (cover-fit) rect and returns its two geometries.
function setupFly(m, I1) {
  const D0 = m.cover(m.I0), D1 = m.cover(I1);
  Object.assign(els.flyImg.style, { left: D1.x - m.D.left + 'px', top: D1.y - m.D.top + 'px', width: D1.w + 'px', height: D1.h + 'px' });
  els.fly.style.display = 'block';
  els.heroImg.style.visibility = 'hidden';
  return { card: `translate(${D0.x - D1.x}px, ${D0.y - D1.y}px) scale(${D0.w / D1.w})`, hero: 'translate(0px, 0px) scale(1)' };
}

async function open(id, { trigger, animate = true, push = true } = {}) {
  const card = trigger;
  if (state !== 'idle' || !card || card.hidden || !PROJECTS.has(id)) return;
  ensureDialog(); tokens();
  state = 'opening';
  const g = ++gen;
  src = card; current = PROJECTS.get(id); savedY = scrollY;
  if (push) history.pushState({ pd: id, pushed: true }, '', `#projects/${id}`);
  fillHero(card);
  renderSections(id);
  const motion = animate && !reducedMotion();
  if (motion) await Promise.race([els.heroImg.decode().catch(() => {}), wait(120)]);
  if (g !== gen) return;
  html.classList.add('pd-lock');
  dialog.showModal();
  els.scroll.scrollTop = 0;
  card.querySelector('.project-open').setAttribute('aria-expanded', 'true');
  if (!motion) {
    measureScrollbar();
    play(dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: T.reduced, easing: 'linear' });
    return whenDone(g, finishOpen);
  }
  // All reads, then all writes.
  const sbw = els.scroll.offsetWidth - els.scroll.clientWidth, m = measure(card);
  dialog.style.setProperty('--pd-sbw', `${sbw}px`);
  ghost = makeGhost(card, m);
  card.classList.add('is-source');
  dialog.classList.add('is-animating');
  const E = T.expand, fadeIn = [{ opacity: 0 }, { opacity: 1 }], fadeOut = [{ opacity: 1 }, { opacity: 0 }];
  play(els.scrim, fadeIn, { duration: T.scrim, easing: T.fade });
  play(els.surface, [{ ...geo(m, m.R0, 8), borderColor: m.cardBorder }, { ...geo(m, m.R1, 16), borderColor: T.border }], { duration: E });
  play(els.panel, [{ clipPath: panelClip(m) }, { clipPath: 'inset(0px 0px 0px 0px round 16px)' }], { duration: E });
  ghost.querySelector('.projects-page-image').style.visibility = 'hidden';
  if (m.W && m.H) {
    const f = setupFly(m, m.I1);
    play(els.flyImg, [{ transform: f.card }, { transform: f.hero }], { duration: E });
    play(els.fly, [{ clipPath: insetIn(m, m.C0, shrink(m.R0, 1), 7) }, { clipPath: insetIn(m, m.I1, m.S, 15) }], { duration: E });
  } else {
    play(els.media, fadeIn, { duration: T.reveal, delay: 200, easing: T.fade });
  }
  const ghostShared = shared(ghost);
  heroShared().forEach((el, i) => {
    const p = m.pairs[i], gEl = ghostShared[i];
    if (!p) return;
    play(el, [{ transform: `translate(${p.A.left - p.B.left}px, ${p.A.top - p.B.top}px) scale(${p.s})` }, { transform: 'translate(0px, 0px) scale(1)' }], { duration: E });
    play(el, fadeIn, { duration: 120, easing: 'linear' });
    play(gEl, [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: `translate(${p.B.left - p.A.left}px, ${p.B.top - p.A.top}px) scale(${1 / p.s})` }], { duration: E });
    play(gEl, fadeOut, { duration: 120, easing: 'linear' });
  });
  ghost.querySelectorAll(GHOST_FADE).forEach((el) => {
    play(el, [{ opacity: el.matches('.project-expand') ? m.expandOpacity : 1 }, { opacity: 0 }], { duration: 180, easing: T.fade });
  });
  const rise = [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0px)' }];
  els.hero.querySelectorAll('[data-reveal]').forEach((el, i) => play(el, rise, { duration: T.reveal, delay: 260 + 30 * i, easing: T.fade }));
  play(els.body, rise, { duration: T.reveal, delay: 340, easing: T.fade });
  play(els.close, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 200, delay: 300, easing: T.fade });
  whenDone(g, finishOpen);
}

function finishOpen() {
  els.fly.style.display = 'none';
  els.heroImg.style.visibility = '';
  ghost?.remove(); ghost = null;
  cancelAll();
  dialog.classList.remove('is-animating');
  state = 'open';
  els.title.focus({ preventScroll: true });
  watchDemo();
}

function leaveHistory() {
  if (history.state?.pd === current?.id && history.state?.pushed) { skipNextPop = true; history.back(); }
  else if (HASH.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}

function close({ fromHistory = false } = {}) {
  if (state !== 'opening' && state !== 'open') return;
  if (!fromHistory) leaveHistory();
  if (state === 'opening') {
    state = 'closing';
    const g = ++gen;
    anims.forEach((a) => a.reverse());
    return whenDone(g, teardown);
  }
  state = 'closing';
  const g = ++gen, card = src;
  demoApi?.pause();
  const R0 = rect(card), motion = !reducedMotion();
  const inView = R0.bottom > 0 && R0.top < innerHeight && R0.right > 0 && R0.left < innerWidth;
  if (!motion || !inView) {
    play(dialog, [{ opacity: 1 }, { opacity: 0 }], { duration: motion ? 160 : 120, easing: 'linear' });
    return whenDone(g, teardown);
  }
  const heroInView = els.scroll.scrollTop < els.hero.offsetHeight / 2;
  const sbw = els.scroll.offsetWidth - els.scroll.clientWidth, m = measure(card);
  dialog.style.setProperty('--pd-sbw', `${sbw}px`);
  ghost = makeGhost(card, m);
  dialog.classList.add('is-animating');
  const C = T.collapse, fadeIn = [{ opacity: 0 }, { opacity: 1 }], fadeOut = [{ opacity: 1 }, { opacity: 0 }];
  const out = heroInView ? [...els.hero.querySelectorAll('[data-reveal]'), els.body] : [els.hero, els.body];
  out.forEach((el) => play(el, fadeOut, { duration: 140, easing: T.fade }));
  play(els.close, fadeOut, { duration: 120, easing: T.fade });
  play(els.surface, [geo(m, m.R1, 16), geo(m, m.R0, 8)], { duration: C });
  play(els.panel, [{ clipPath: 'inset(0px 0px 0px 0px round 16px)' }, { clipPath: panelClip(m) }], { duration: C });
  const ghostImg = ghost.querySelector('.projects-page-image');
  if (heroInView && m.W && m.H) {
    ghostImg.style.visibility = 'hidden';
    const vis = { left: Math.max(m.I1.left, m.S.left), top: Math.max(m.I1.top, m.S.top), right: Math.min(m.I1.right, m.S.right), bottom: Math.min(m.I1.bottom, m.S.bottom) };
    const f = setupFly(m, m.I1);
    play(els.flyImg, [{ transform: f.hero }, { transform: f.card }], { duration: C });
    play(els.fly, [{ clipPath: insetIn(m, vis, m.S, 15) }, { clipPath: insetIn(m, m.C0, shrink(m.R0, 1), 7) }], { duration: C });
  }
  if (heroInView) {
    const ghostShared = shared(ghost);
    heroShared().forEach((el, i) => {
      const p = m.pairs[i], gEl = ghostShared[i];
      if (!p) return;
      play(el, [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: `translate(${p.A.left - p.B.left}px, ${p.A.top - p.B.top}px) scale(${p.s})` }], { duration: C });
      play(el, fadeOut, { duration: 120, delay: 340, easing: 'linear' });
      play(gEl, [{ transform: `translate(${p.B.left - p.A.left}px, ${p.B.top - p.A.top}px) scale(${1 / p.s})` }, { transform: 'translate(0px, 0px) scale(1)' }], { duration: C });
      play(gEl, fadeIn, { duration: 120, delay: 340, easing: 'linear' });
    });
    ghost.querySelectorAll(GHOST_FADE).forEach((el) => {
      play(el, [{ opacity: 0 }, { opacity: el.matches('.project-expand') ? m.expandOpacity : 1 }], { duration: 260, delay: 200, easing: T.fade });
    });
  } else {
    play(ghost, fadeIn, { duration: 260, delay: 200, easing: T.fade });
  }
  play(els.scrim, fadeOut, { duration: 340, delay: 120, easing: T.fade });
  whenDone(g, teardown);
}

function teardown() {
  gen++;
  const card = src;
  card?.classList.remove('is-source');
  ghost?.remove(); ghost = null;
  els.fly.style.display = 'none';
  els.heroImg.style.visibility = '';
  cancelAll();
  dialog.classList.remove('is-animating');
  if (dialog.open) { ownCloses++; dialog.close(); }
  html.classList.remove('pd-lock');
  scrollTo({ top: savedY, behavior: 'instant' });
  card?.querySelector('.project-open')?.setAttribute('aria-expanded', 'false');
  destroyDemo();
  spy?.disconnect(); spy = null;
  els.sections.replaceChildren(); els.toc.replaceChildren(); els.live.textContent = '';
  state = 'idle'; src = null; current = null;
  if (card?.isConnected) card.querySelector('.project-open')?.focus({ preventScroll: true });
}

function measureScrollbar() { dialog?.style.setProperty('--pd-sbw', `${els.scroll.offsetWidth - els.scroll.clientWidth}px`); }

// ---------- Listeners (registered once; everything is delegated) ----------
document.addEventListener('click', (e) => {
  const card = e.target.closest('.projects-page-card[data-project]');
  if (!card || card.closest('#project-detail')) return;
  if (e.target.closest('a, button:not(.project-open), input, select, textarea, label')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;
  open(card.dataset.project, { trigger: card });
});

document.addEventListener('click', (e) => {
  if (!dialog || !dialog.contains(e.target)) return;
  const t = e.target;
  if (t.closest('.pd-close') || t === els.scrim) return close();
  if (t.closest('.pd-try')) return scrollToSection(els.sections.querySelector('#pd-demo'));
  if (t.closest('.pd-retry')) return current && renderSections(current.id);
  const toc = t.closest('.pd-toc a');
  if (toc) { e.preventDefault(); scrollToSection(document.getElementById(toc.dataset.target)); }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || state === 'idle') return;
  e.preventDefault();
  close();
});
// Non-bubbling dialog events, caught in the capture phase.
document.addEventListener('cancel', (e) => { if (e.target === dialog) { e.preventDefault(); close(); } }, true);
document.addEventListener('close', (e) => {
  if (e.target !== dialog) return;
  if (ownCloses > 0) { ownCloses--; return; }
  if (state === 'idle') return;
  if (state !== 'closing') leaveHistory(); // close() already handled history
  teardown();
}, true);

addEventListener('popstate', (e) => {
  if (skipNextPop) { skipNextPop = false; return; }
  const pd = e.state?.pd;
  if ((state === 'open' || state === 'opening') && !pd) return close({ fromHistory: true });
  if (state === 'idle' && pd && PROJECTS.has(pd)) {
    const card = findCard(pd);
    if (card && !card.hidden) open(pd, { trigger: card, push: false });
  }
});

addEventListener('resize', () => {
  if (state === 'opening' || state === 'closing') anims.forEach((a) => a.finish());
  else if (state === 'open') measureScrollbar();
});

document.addEventListener('visibilitychange', () => {
  if (state === 'opening' || state === 'closing') { if (document.hidden) anims.forEach((a) => a.finish()); }
  else if (state === 'open' && demoApi) document.hidden ? demoApi.pause() : demoInView && demoApi.resume();
});

document.addEventListener('page:will-change', () => { if (state !== 'idle') teardown(); });
document.addEventListener('page:loaded', (e) => {
  if (e.detail?.page !== 'projects') return;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  idle(() => REGISTRY.forEach((p) => loadPartial(p.id).p.catch(() => {})));
});

// ---------- Deep link (#projects/<id>) ----------
const deep = location.hash.match(HASH);
if (deep) {
  const id = deep[1];
  if (!PROJECTS.has(id)) history.replaceState(null, '', location.pathname + location.search);
  else {
    const go = () => {
      const card = findCard(id);
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
      open(id, { trigger: card, animate: false, push: false });
      history.replaceState({ pd: id }, '', location.href);
    };
    if (document.querySelector('.projects-page-grid')) go();
    else document.addEventListener('page:loaded', function once(e) {
      if (e.detail?.page !== 'projects') return;
      document.removeEventListener('page:loaded', once);
      go();
    });
  }
}
