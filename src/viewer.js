import { getDocument, GlobalWorkerOptions, setLayerDimensions, TextLayer } from 'pdfjs-dist';
import styles from './viewer.css';
import { Curl, curve } from './curl.js';

const assets = new URL('./pdfjs/', import.meta.url);
GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assets).href;
const icons = {
  prev: '<path d="m14 5-7 7 7 7"/>', next: '<path d="m10 5 7 7-7 7"/>',
  minus: '<path d="M5 12h14"/>', plus: '<path d="M5 12h14M12 5v14"/>',
  full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  open: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
const button = (name, label, extra = '') => `<button type="button" class="${name}" aria-label="${label}" title="${label}" ${extra}>${icon(name)}</button>`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Critically damped spring (Apple's response/damping model, damping 1, response 0.27 s by default).
// It always starts from the on-screen value, keeps its velocity when retargeted and takes the gesture's velocity at release.
// Its host steps every active spring on one shared frame clock and paints once per frame; `settle` runs once it rests on the target.
class Spring {
  constructor(host, settle) { this.host = host; this.settle = settle; this.x = 0; this.v = 0; this.target = 0; this.active = false; this.response = .27; }
  set(x) { this.active = false; this.x = this.target = x; this.v = 0; }
  to(target, velocity, instant = false) {
    this.target = target;
    if (velocity !== undefined) this.v = velocity;
    if (instant) { this.set(target); this.host.frame(); this.settle?.(); return; }
    this.active = true;
    this.host.run();
  }
  // Freeze where it is; a later to() picks up from here.
  stop() { this.active = false; }
  // Advance by dt seconds; true when it came to rest on the target in this step.
  step(dt) {
    const omega = 2 * Math.PI / this.response;
    while (dt > 0) {
      const h = Math.min(dt, .008);
      dt -= h;
      this.v += (-omega * omega * (this.x - this.target) - 2 * omega * this.v) * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x - this.target) < .1 && Math.abs(this.v) < 5) { this.set(this.target); return true; }
    return false;
  }
}

// B = sin(theta) · bend: flat on the page, fullest edge-on. The bend has its own spring toward a small resting bow in the direction
// the leaf last moved (the free edge trails) plus a share of its speed, so a quick flick bows the sheet more than a slow drag.
const BEND = { rest: 7, speed: 16, reference: 450, response: .24 };
// The book's perspective, as CSS would set it: the viewer 2400 px in front of the book's centre.
const PERSPECTIVE = 2400;
const RAD = Math.PI / 180;
// How pages are shown (the `spread` attribute): two by two (the default), one at a time, or one only when the stage is too narrow.
const SPREADS = ['always', 'single', 'auto'];
// How much of the viewer's own frame shows (the `chrome` attribute): the dark box with toolbar and arrows (the default), the same
// controls on a transparent background, or the book alone.
const CHROMES = ['full', 'minimal', 'none'];
// Assumed page format until a PDF has loaded, so the frame starts at the size most brochures end up with.
const A4 = { width: 595, height: 842 };
// Link targets a page may open. Anything else (javascript:, file:, data: …) is left unlinked.
const SCHEMES = ['http:', 'https:', 'mailto:'];
// A link to a page of the brochure, in the host page's URL fragment: #side=7. Any other fragment belongs to the host page.
const PAGE_LINK = /^#side=(.*)$/;

class EBrosjyre extends HTMLElement {
  static observedAttributes = ['src', 'title', 'spread', 'chrome'];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${styles}</style><style class="sizing"></style>
      <section class="reader" aria-label="PDF-brosjyre" tabindex="0">
        <div class="stage">
          <div class="scroller"><div class="spread"><div class="book"><div class="slot left"></div><div class="slot right"></div></div></div></div>
          <canvas class="curl" aria-hidden="true"></canvas>
          <div class="message" role="status" aria-live="polite"><span class="spinner" hidden></span><strong></strong><p></p></div>
          ${button('prev', 'Forrige side')}${button('next', 'Neste side')}
        </div>
        <footer class="toolbar">
          <input class="progress" type="range" min="1" max="1" value="1" aria-label="Gå til side">
          <div class="controls">
            <output class="pages" aria-live="polite" aria-atomic="true">—</output>
            <div class="zoom">${button('minus', 'Zoom ut')}<button type="button" class="fit" aria-label="Tilpass til vinduet" title="Tilpass til vinduet">100 %</button>${button('plus', 'Zoom inn')}</div>
            <div class="actions"><a class="open" target="_blank" rel="noopener noreferrer" aria-label="Åpne original PDF i ny fane" title="Åpne original PDF">${icon('open')}</a>${button('full', 'Fullskjerm')}</div>
          </div>
        </footer>
      </section>`;
    this.$ = selector => this.shadowRoot.querySelector(selector);
    this.book = this.$('.book');
    this.sizing = this.$('style.sizing');
    this.page = 1;
    this.zoom = 1;
    this.generation = 0;
    this.renderId = 0;
    this.cache = new Map();
    this.drag = null;
    this.shift = 0;
    this.shifts = [0];
    this.rightWidth = 0;
    this.ready = false;
    // The book is a chain of spreads with a turning leaf between each pair; `page` is the spread the book is heading to.
    // Leaves in flight each have their own spring (0–180°), so quick repeated turns overlap instead of queueing.
    this.leaves = [];
    // The rubber-band nudge of the whole book at the first/last page.
    this.nudge = new Spring(this);
    this.ticking = 0;
    // Turning leaves are drawn over the stage; `offset` is the book's current drift, `at` its resting box in the stage.
    this.curl = new Curl(this.$('.curl'));
    this.offset = 0;
  }
  connectedCallback() {
    this.events?.abort();
    this.events = new AbortController();
    const on = (el, type, callback) => el.addEventListener(type, callback, { signal: this.events.signal });
    on(this.$('.prev'), 'click', () => this.navigate(-1));
    on(this.$('.next'), 'click', () => this.navigate(1));
    on(this.$('.minus'), 'click', () => this.setZoom(this.zoom - .25));
    on(this.$('.plus'), 'click', () => this.setZoom(this.zoom + .25));
    on(this.$('.fit'), 'click', () => this.setZoom(1));
    on(this.$('.progress'), 'input', e => this.goTo(Number(e.target.value), true));
    on(this.$('.full'), 'click', () => this.toggleFullscreen());
    on(document, 'fullscreenchange', () => {
      const active = document.fullscreenElement === this;
      this.$('.full').setAttribute('aria-label', active ? 'Avslutt fullskjerm' : 'Fullskjerm');
      this.$('.full').title = active ? 'Avslutt fullskjerm' : 'Fullskjerm';
    });
    this.$('.full').hidden = !document.fullscreenEnabled || !this.requestFullscreen;
    this.$('.reader').dataset.chrome = this.chrome;
    on(this.$('.reader'), 'keydown', e => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const actions = { ArrowLeft: () => this.navigate(-1), ArrowRight: () => this.navigate(1), Home: () => this.goTo(1), End: () => this.goTo(this.pdf?.numPages), '+': () => this.setZoom(this.zoom + .25), '-': () => this.setZoom(this.zoom - .25), '0': () => this.setZoom(1) };
      if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
    });
    // A link to #side=N clicked on the host page, or the fragment edited by hand, turns there.
    // One that names no page of the document is cleared, even when the book need not move.
    on(window, 'hashchange', () => {
      const page = this.pdf && this.linked && this.linkedPage();
      if (!page) return;
      this.goTo(page);
      this.writeLink(this.visiblePages());
    });
    this.fresh = true; // The first document after connecting opens at the page the URL asks for.
    // Pointers on the book: one finger or the mouse turns pages (pans when zoomed in), two fingers pinch, a double tap zooms.
    const scroller = this.$('.scroller');
    const points = new Map(); // Pointer id → latest client position, for every pointer held down on the book.
    on(scroller, 'pointerdown', e => {
      // A mouse or pen pressed on the text selects it, as anywhere on the web; a finger swipes there too and selects with a long press.
      if (e.pointerType !== 'touch' && e.target.closest('.textLayer span')) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // So its release is always seen here. Not yet on a link, whose click would then go to the scroller: a drag captures it once it moves.
      if (!e.target.closest('a')) try { scroller.setPointerCapture(e.pointerId); } catch {}
      if (!this.pdf) return;
      // A second finger pinches, unless the first is already turning a leaf: then it is a stray touch and the turn carries on.
      if (points.size === 2 && !this.pinch && !['turn', 'nudge'].includes(this.drag?.mode)) return this.startPinch(points);
      if (points.size === 1 && e.button === 0) this.startDrag(e);
    });
    on(scroller, 'pointermove', e => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) this.movePinch(points);
      else this.moveDrag(e);
    });
    const lift = (e, cancelled) => {
      points.delete(e.pointerId);
      if (this.pinch?.ids.includes(e.pointerId)) {
        this.endPinch();
        // A finger left on the book after a pinch that changed nothing (a stray touch mid-swipe) carries on from where it is.
        const [[id, point] = []] = points;
        if (id !== undefined && !this.view && this.zoom === 1) this.startDrag({ pointerId: id, clientX: point.x, clientY: point.y, timeStamp: e.timeStamp });
        return;
      }
      if (cancelled) return this.endDrag();
      this.moveDrag(e);
      const drag = this.drag;
      const tap = drag?.id === e.pointerId && !drag.axis && e.timeStamp - drag.t < 300;
      this.endDrag(e);
      if (tap) this.tap(e);
    };
    on(scroller, 'pointerup', e => lift(e));
    on(scroller, 'pointercancel', e => lift(e, true));
    // A link to a page in the same PDF turns there instead of leaving.
    on(scroller, 'click', e => {
      const link = e.target.closest('a[data-page]');
      if (!link) return;
      e.preventDefault();
      this.goTo(Number(link.dataset.page));
    });
    // Two fingers on the book are ours: keep the browser from scrolling or zooming the page under a pinch.
    scroller.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false, signal: this.events.signal });
    // The frame's height follows its width; it is applied a frame later, since resizing inside the observer would loop.
    this.observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(this.fitting);
      this.fitting = requestAnimationFrame(() => this.fit());
      const size = `${entry.contentRect.width}x${entry.contentRect.height}`;
      const initial = this.stageSize === undefined; // The observer fires once on observe(); only later changes matter.
      this.stageSize = size;
      if (initial) return;
      clearTimeout(this.resizeTimer);
      // Skip it when the book is already laid out for this size (a page-mode change renders at once), so a drag is not cut off.
      this.resizeTimer = setTimeout(() => { if (this.layoutKey !== this.cacheKey) this.relayout(); }, 100);
    });
    this.observer.observe(this.$('.stage'));
    this.fit();
    this.curl.prepare(); // While the PDF loads, so the first turn does not wait for it.
    this.load();
  }
  disconnectedCallback() {
    this.events?.abort();
    this.observer?.disconnect();
    clearTimeout(this.resizeTimer);
    cancelAnimationFrame(this.fitting);
    this.generation++;
    this.reset();
    this.loadingTask?.destroy().catch(() => {});
    this.pdf = null;
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === 'src') this.load();
    else if (name === 'spread') this.relayout();
    else if (name === 'chrome') { this.$('.reader').dataset.chrome = this.chrome; this.relayout(); }
    else this.$('.reader').setAttribute('aria-label', this.getAttribute('title') || 'PDF-brosjyre');
  }
  get motion() { return !matchMedia('(prefers-reduced-motion: reduce)').matches; }
  // Room around the pages: the arrow buttons sit inside the stage and may overlap the page edges a little. Without them (chrome="none")
  // only the spread's own padding is left.
  get marginX() { return this.chrome === 'none' || matchMedia('(max-width: 600px)').matches ? 28 : 48; }
  get stageWidth() { return this.$('.stage').clientWidth - this.marginX; }
  get stageHeight() { return this.$('.stage').clientHeight - 32; }
  get spread() {
    const value = this.getAttribute('spread')?.trim().toLowerCase();
    return SPREADS.includes(value) ? value : 'always';
  }
  get chrome() {
    const value = this.getAttribute('chrome')?.trim().toLowerCase();
    return CHROMES.includes(value) ? value : 'full';
  }
  // Whether the viewer may follow the URL (the `deep-link` attribute): on unless set to "off", for a host page that owns its URL.
  get deepLink() { return this.getAttribute('deep-link')?.trim().toLowerCase() !== 'off'; }
  // Only one viewer on a page follows the URL, the first that has not opted out, so several never fight over it.
  get linked() { return this.deepLink && [...document.querySelectorAll('e-brosjyre')].find(el => el.deepLink) === this; }
  // The page the URL asks for: null when the fragment is not a page link, page 1 when its number is not a page of this document.
  linkedPage() {
    const match = PAGE_LINK.exec(location.hash);
    if (!match) return null;
    const page = /^\d+$/.test(match[1]) ? Number(match[1]) : 0;
    return page >= 1 && page <= this.pdf.numPages ? page : 1;
  }
  // Point the URL at the spread on show, replacing the history entry so turning pages never fills the back button. Page 1 needs no
  // fragment; one that already names a page on show is left as it is, and a fragment of the host page's own is never touched.
  writeLink(pages) {
    if (!this.linked) return;
    const match = PAGE_LINK.exec(location.hash);
    if ((location.hash && !match) || (match && pages.includes(Number(match[1])))) return;
    const url = new URL(location.href);
    url.hash = this.page === 1 ? '' : `side=${this.page}`;
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }
  // The book model: two pages side by side, one at a time with spread="single", and with spread="auto" one only when the stage
  // is truly narrow (a page would get under 230 px, roughly a phone).
  get single() {
    if (this.spread !== 'auto') return this.spread === 'single';
    const typical = this.typical ?? A4;
    return Math.min(this.stageWidth / 2, this.stageHeight * typical.width / typical.height) < 230;
  }
  // Shape the frame to what it shows: the typical view (a spread, or one page) filling the width, plus the toolbar (none with
  // chrome="none", where it is laid over the stage).
  // A spread wants a wide, low frame and a single page a tall one. A height the page sets on the element wins, as outer styles beat :host.
  fit() {
    if (!this.clientWidth) return;
    const typical = this.typical ?? A4;
    const toolbar = this.$('.reader').clientHeight - this.$('.stage').clientHeight;
    const height = this.stageWidth / (this.single ? 1 : 2) * typical.height / typical.width + 32 + toolbar;
    const rule = `:host { --fit-height: ${Math.round(height)}px; }`;
    if (this.sizing.textContent !== rule) this.sizing.textContent = rule;
  }
  // Land any turn and lay the book out again for a new page mode or stage size.
  relayout() {
    this.fit();
    if (!this.pdf) return;
    this.snap();
    this.page = this.normalizePage(this.page);
    this.render();
  }
  // One scale for the whole document, fitted to the typical spread, so the cover, the spreads and the last page keep one size.
  get scale() {
    const typical = this.typical;
    if (!typical) return 1;
    return Math.max(.05, Math.min(this.stageWidth / ((this.single ? 1 : 2) * typical.width), this.stageHeight / typical.height)) * this.zoom;
  }
  // What a render depends on: painted pages are only valid for the key they were painted at.
  get layoutKey() { return [this.$('.stage').clientWidth, this.$('.stage').clientHeight, this.zoom, this.single].join(); }
  pair(number) { return !this.single && number > 1 && number % 2 === 0 && number < (this.pdf?.numPages || 1); }
  normalizePage(page) {
    page = clamp(page || 1, 1, this.pdf?.numPages || 1);
    return page % 2 === 1 && this.pair(page - 1) ? page - 1 : page;
  }
  // [left page, right page] of the spread that starts at `page`. The cover is a right page, an even last page a left page.
  sides(page) {
    if (this.single) return [null, page];
    if (this.pair(page)) return [page, page + 1];
    return page % 2 === 0 ? [page, null] : [null, page];
  }
  visiblePages() { return this.pdf ? this.sides(this.page).filter(Boolean) : []; }
  target(direction, from = this.page) {
    if (!this.pdf) return null;
    const next = direction > 0 ? this.sides(from).filter(Boolean).at(-1) + 1 : from - 1;
    return next >= 1 && next <= this.pdf.numPages ? this.normalizePage(next) : null;
  }
  // A spread that would not fit at the document scale is shrunk to fit.
  scaleFor(number) {
    const pages = this.sides(this.normalizePage(number)).filter(Boolean);
    const width = pages.reduce((sum, n) => sum + this.sizes[n - 1].width, 0);
    const height = Math.max(...pages.map(n => this.sizes[n - 1].height));
    return Math.min(this.scale, Math.max(.05, Math.min(this.stageWidth / width, this.stageHeight / height)) * this.zoom);
  }
  cancelRender() {
    this.renderId++;
    for (const entry of this.cache.values()) entry.task?.cancel();
    this.cache.clear();
  }
  reset() {
    cancelAnimationFrame(this.ticking);
    this.ticking = 0;
    this.nudge.stop();
    this.nudge.x = 0;
    for (const leaf of this.leaves) leaf.turn.stop();
    this.leaves = [];
    this.cancelDrag();
    this.cancelRender();
    this.release();
    this.offset = 0;
    this.book.style.transform = '';
    this.curl.clear();
    this.$('.reader').classList.remove('turning');
    this.$('.slot.left').replaceChildren();
    this.$('.slot.right').replaceChildren();
  }
  message(title, detail = '', loading = false) {
    this.$('.reader').setAttribute('aria-busy', String(loading));
    this.$('.message').hidden = false;
    this.$('.message strong').textContent = title;
    this.$('.message p').textContent = detail;
    this.$('.spinner').hidden = !loading;
  }
  async load() {
    const generation = ++this.generation;
    const previousTask = this.loadingTask;
    this.loadingTask = null;
    this.pdf = null;
    this.sizes = null;
    this.typical = null;
    this.page = 1;
    this.zoom = 1;
    this.ready = false;
    this.shown = null;
    this.reset();
    this.$('.open').removeAttribute('href');
    this.$('.reader').setAttribute('aria-label', this.getAttribute('title') || 'PDF-brosjyre');
    this.updateControls();
    this.message('Laster brosjyren …', '', true);
    try {
      await previousTask?.destroy();
      if (generation !== this.generation) return;
      const source = this.getAttribute('src');
      if (!source) { this.message('Din neste leseopplevelse', 'Legg til en PDF-lenke for å åpne brosjyren.'); return; }
      const fresh = this.fresh;
      this.fresh = false;
      const url = new URL(source, document.baseURI);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
      this.$('.open').href = url.href;
      this.loadingTask = getDocument({
        url: url.href,
        cMapUrl: new URL('cmaps/', assets).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', assets).href,
        wasmUrl: new URL('wasm/', assets).href,
        iccUrl: new URL('iccs/', assets).href,
        isEvalSupported: false,
      });
      const pdf = await this.loadingTask.promise;
      // Real, rotation-corrected page sizes (getViewport honours /Rotate) drive layout and scale, so fetch them all up front.
      const sizes = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then(page => {
        const { width, height } = page.getViewport({ scale: 1 });
        return { width, height };
      })));
      if (generation !== this.generation) return;
      const counts = new Map();
      for (const { width, height } of sizes) {
        const key = `${Math.round(width)}x${Math.round(height)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const [common] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      this.typical = { width: Number(common.split('x')[0]), height: Number(common.split('x')[1]) };
      this.sizes = sizes;
      this.pdf = pdf;
      if (fresh && this.linked) this.page = this.normalizePage(this.linkedPage() ?? 1);
      this.fit();
      await this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      this.pdf = null;
      this.updateControls();
      const detail = error.message === 'invalid-url' ? 'Bruk en gyldig http- eller https-lenke direkte til PDF-filen.' : error.name === 'PasswordException' ? 'PDF-en er passordbeskyttet. Bruk en PDF uten passord.' : 'Kontroller at lenken går direkte til en offentlig PDF, og at filverten tillater CORS. Du kan også prøve å åpne originalen.';
      this.message('Kunne ikke åpne brosjyren', detail);
      this.dispatchEvent(new CustomEvent('brochure-error', { detail: { message: detail } }));
    }
  }
  // The chain of spreads currently on the table: the resting spread, or every spread a leaf in flight connects.
  spreads() { return this.leaves.length ? [this.leaves[0].a, ...this.leaves.map(leaf => leaf.b)] : [this.page]; }
  heading(leaf) { return leaf.turn.target >= 90 ? 180 : 0; }
  // Leaves heading to 180° form a prefix of the chain (they cannot pass each other), so the destination is the spread after them.
  destination() {
    const turned = this.leaves.filter(leaf => this.heading(leaf) === 180).length;
    return this.leaves.length ? (turned ? this.leaves[turned - 1].b : this.leaves[0].a) : this.page;
  }
  // The leaf a further step in `direction` acts on: one still coming back that way, if any. Otherwise a new leaf is needed.
  boundary(direction) { return direction > 0 ? this.leaves.find(leaf => this.heading(leaf) === 0) : this.leaves.findLast(leaf => this.heading(leaf) === 180); }
  // Keep page, controls and spring responses in step with the chain. With a backlog every leaf turns faster, like riffling.
  sync() {
    this.page = this.destination();
    this.updateControls();
    const response = Math.max(.15, .27 * .8 ** (this.leaves.length - 1));
    for (const leaf of this.leaves) leaf.turn.response = response;
  }
  goTo(page, instant = false) {
    if (!this.pdf) return;
    const next = this.normalizePage(page);
    this.cancelDrag();
    if (instant || this.zoom !== 1 || !this.motion) {
      this.snap();
      this.release();
      this.zoom = 1;
      this.page = next;
      this.render();
      return;
    }
    const spreads = this.spreads();
    const index = spreads.indexOf(next);
    if (index >= 0) { this.leaves.forEach((leaf, i) => leaf.turn.to(i < index ? 180 : 0)); this.sync(); }
    else if (next > spreads.at(-1)) this.addLeaf(spreads.at(-1), next, 0, 180);
    else if (next < spreads[0]) this.addLeaf(next, spreads[0], 180, 0);
    else { this.snap(); this.goTo(next); } // A page inside the chain but not on it: land first, then turn there.
  }
  navigate(direction) {
    if (!this.pdf) return;
    const leaf = this.boundary(direction);
    if (leaf) { leaf.turn.to(direction > 0 ? 180 : 0); this.sync(); return; } // Against a turn in progress: reverse it.
    const spreads = this.spreads();
    const from = direction > 0 ? spreads.at(-1) : spreads[0];
    const next = this.target(direction, from);
    if (next) this.goTo(next);
  }
  // The buttons and keys zoom in steps of .25 about the middle of the stage.
  setZoom(zoom) { this.zoomTo(clamp(Math.round(zoom * 4) / 4, 1, 3)); }
  updateControls() {
    const pages = this.visiblePages();
    const label = pages.length > 1 ? `${pages[0]}–${pages[1]}` : `${this.page}`;
    this.$('.pages').textContent = this.pdf ? `${label} / ${this.pdf.numPages}` : '—';
    this.$('.progress').max = this.pdf?.numPages || 1;
    this.$('.progress').value = this.page;
    this.$('.progress').disabled = !this.pdf;
    this.$('.progress').setAttribute('aria-valuetext', this.pdf ? `Side ${label} av ${this.pdf.numPages}` : 'Ingen brosjyre');
    this.$('.prev').disabled = !this.pdf || this.page === 1;
    this.$('.next').disabled = !this.pdf || pages.at(-1) === this.pdf.numPages;
    this.$('.minus').disabled = !this.pdf || this.zoom <= 1;
    this.$('.plus').disabled = !this.pdf || this.zoom >= 3;
    this.$('.fit').disabled = !this.pdf;
    this.$('.fit').textContent = `${Math.round(this.zoom * 100)} %`;
    // At rest a vertical swipe still scrolls the page; zoomed in, every touch pans or pinches the book.
    this.$('.scroller').style.touchAction = this.zoom === 1 ? 'pan-y' : 'none';
    this.$('.reader').classList.toggle('zoomed', this.zoom > 1);
  }
  // Paint one page to a cached canvas. Neighbouring spreads are painted ahead so a turn can start at once.
  paint(number) {
    const cached = this.cache.get(number);
    if (cached) return cached.promise;
    const entry = { sheet: document.createElement('div'), canvas: document.createElement('canvas'), done: false, task: null, width: 0, height: 0 };
    entry.sheet.className = 'sheet';
    entry.sheet.append(entry.canvas);
    entry.promise = (async () => {
      const page = await this.pdf.getPage(number);
      if (this.cache.get(number) !== entry) throw new Error('stale');
      const viewport = page.getViewport({ scale: this.scaleFor(number) });
      // Keep memory bounded on large screens and when zooming.
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(5_000_000 / (viewport.width * viewport.height)));
      const { canvas } = entry;
      canvas.width = Math.floor(viewport.width * density);
      canvas.height = Math.floor(viewport.height * density);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Side ${number}`);
      entry.sheet.style.setProperty('--total-scale-factor', viewport.scale);
      entry.width = viewport.width;
      entry.height = viewport.height;
      entry.task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [density, 0, 0, density, 0, 0] });
      await entry.task.promise;
      entry.task = null;
      entry.done = true;
      this.curl.preload(canvas);
      this.layout();
      this.annotate(number, page, viewport, entry).catch(() => {});
      return canvas;
    })();
    entry.promise.catch(() => { if (this.cache.get(number) === entry) this.cache.delete(number); });
    this.cache.set(number, entry);
    return entry.promise;
  }
  async render() {
    if (!this.pdf) return;
    const id = ++this.renderId;
    const key = this.layoutKey;
    if (key !== this.cacheKey) { this.cacheKey = key; for (const entry of this.cache.values()) entry.task?.cancel(); this.cache.clear(); }
    const current = this.visiblePages();
    const neighbours = this.zoom === 1 ? [1, -1].flatMap(direction => { const next = this.target(direction); return next ? this.sides(next).filter(Boolean) : []; }) : [];
    for (const [number, entry] of this.cache) if (!current.includes(number) && !neighbours.includes(number)) { entry.task?.cancel(); this.cache.delete(number); }
    this.updateControls();
    this.$('.reader').setAttribute('aria-busy', 'true');
    try {
      await Promise.all(current.map(number => this.paint(number)));
      if (id !== this.renderId) return;
      this.layout();
      this.$('.scroller').scrollTo(0, 0);
      this.$('.message').hidden = true;
      this.$('.reader').setAttribute('aria-busy', 'false');
      if (!this.ready) { this.ready = true; this.dispatchEvent(new CustomEvent('brochure-ready', { detail: this.position() })); }
      this.landed();
      for (const number of neighbours) this.paint(number).catch(() => {});
      return true;
    } catch (error) {
      if (id !== this.renderId || error.name === 'RenderingCancelledException' || error.message === 'stale') return;
      this.$('.reader').setAttribute('aria-busy', 'false');
      this.message('Siden kunne ikke vises', 'Prøv å bla videre, eller åpne original PDF.');
    }
  }
  // Where the reader is: the spread's first page, the pages on show and the document's length.
  position() { return { page: this.page, pages: this.visiblePages(), total: this.pdf.numPages }; }
  // The book has come to rest on its pages: once per spread shown, the URL follows and the host page hears of it.
  landed() {
    const { pages } = this.position();
    if (pages.join() === this.shown) return;
    this.shown = pages.join();
    this.writeLink(pages);
    this.dispatchEvent(new CustomEvent('brochure-page', { detail: this.position() }));
  }
  // Lay the page's text and links over its painted canvas, once it shows. Each is built off-DOM and added in one go.
  async annotate(number, page, viewport, entry) {
    const stale = () => this.cache.get(number) !== entry;
    const text = document.createElement('div');
    text.className = 'textLayer';
    const layer = new TextLayer({ textContentSource: await page.getTextContent(), container: text, viewport });
    if (stale()) return;
    await layer.render();
    if (stale()) return;
    entry.sheet.append(text);
    // With its text on the page, a screen reader reads the page itself; the picture of it is then left out.
    if (layer.textContentItemsStr.some(item => item.trim())) {
      entry.canvas.removeAttribute('role');
      entry.canvas.removeAttribute('aria-label');
      entry.canvas.setAttribute('aria-hidden', 'true');
      entry.sheet.setAttribute('role', 'group');
      entry.sheet.setAttribute('aria-label', `Side ${number}`);
    } else entry.canvas.setAttribute('aria-label', `Side ${number}. Siden har ingen tekst som kan leses opp.`);
    const links = await this.links(page, viewport);
    if (stale() || !links.length) return;
    const container = document.createElement('div');
    container.className = 'links';
    setLayerDimensions(container, viewport); // Sized and turned like the text layer, so both share the page's unrotated layout.
    container.append(...links);
    entry.sheet.append(container);
  }
  // The page's link annotations as anchors placed over their areas: web and mail links open outside, links to a page in the
  // document turn there (see the click handler on the scroller).
  async links(page, viewport) {
    const annotations = await page.getAnnotations();
    const pdf = this.pdf;
    const anchors = await Promise.all(annotations.filter(a => a.subtype === 'Link').map(async annotation => {
      const a = document.createElement('a');
      if (annotation.dest) {
        const number = await this.destinationPage(pdf, annotation.dest).catch(() => null);
        if (!number) return null;
        a.href = `#side=${number}`;
        a.dataset.page = number;
        a.setAttribute('aria-label', `Gå til side ${number}`);
      } else {
        let url;
        try { url = new URL(annotation.url ?? annotation.unsafeUrl); } catch { return null; }
        if (!SCHEMES.includes(url.protocol)) return null;
        a.href = url.href;
        a.rel = 'noopener noreferrer';
        let address = url.pathname;
        try { address = decodeURIComponent(address); } catch {}
        if (url.protocol === 'mailto:') a.setAttribute('aria-label', `E-post til ${address}`);
        else { a.target = '_blank'; a.setAttribute('aria-label', `${url.href} (åpnes i ny fane)`); }
      }
      // The rectangle in the page's own, unrotated layout, as fractions of it, like the text layer's runs.
      const [x1, y1, x2, y2] = annotation.rect, { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
      a.style.left = `${(Math.min(x1, x2) - pageX) / pageWidth * 100}%`;
      a.style.top = `${(pageY + pageHeight - Math.max(y1, y2)) / pageHeight * 100}%`;
      a.style.width = `${Math.abs(x2 - x1) / pageWidth * 100}%`;
      a.style.height = `${Math.abs(y2 - y1) / pageHeight * 100}%`;
      return a;
    }));
    return anchors.filter(Boolean);
  }
  // The page number a link destination points to: a named destination or an explicit one, whose first entry is the page.
  async destinationPage(pdf, dest) {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    const [ref] = explicit ?? [];
    const index = Number.isInteger(ref) ? ref : ref && typeof ref === 'object' ? await pdf.getPageIndex(ref) : null;
    return index !== null && index >= 0 && index < pdf.numPages ? index + 1 : null;
  }
  // Put a page's sheet into a slot; a blank sheet stands in until it is painted.
  fill(container, number) {
    const entry = number ? this.cache.get(number) : null;
    if (entry?.done) { if (container.firstChild !== entry.sheet) container.replaceChildren(entry.sheet); return; }
    if (!number) { container.replaceChildren(); return; }
    if (container.firstElementChild?.classList.contains('blank')) return;
    const blank = document.createElement('div');
    blank.className = 'sheet blank';
    const scale = this.scaleFor(number);
    blank.style.width = `${this.sizes[number - 1].width * scale}px`;
    blank.style.height = `${this.sizes[number - 1].height * scale}px`;
    container.replaceChildren(blank);
  }
  // Lay out the book: static left/right slots for the ends of the chain, plus one leaf between each pair of spreads.
  layout() {
    if (!this.pdf) return;
    const spreads = this.spreads();
    const sides = spreads.map(spread => this.sides(spread));
    const measure = (key, numbers) => Math.max(0, ...numbers.map(n => (n && this.cache.get(n)?.done ? this.cache.get(n)[key] : 0)));
    // Columns are one typical page wide at the spread's own scale, so the spine stays centred and a shrunk spread still fits.
    const column = Math.max(...spreads.map(spread => this.typical.width * this.scaleFor(spread)));
    const leftWidth = this.single ? 0 : Math.max(column, measure('width', sides.map(side => side[0])));
    const rightWidth = Math.max(column, measure('width', sides.map(side => side[1])));
    const height = Math.max(this.typical.height * this.scale, measure('height', sides.flat()));
    this.rightWidth = rightWidth;
    this.book.style.width = `${leftWidth + rightWidth}px`;
    this.book.style.height = `${height}px`;
    this.book.classList.toggle('double', !this.single);
    this.$('.reader').classList.toggle('turning', this.leaves.length > 0);
    this.$('.slot.left').style.width = `${leftWidth}px`;
    this.$('.slot.right').style.width = `${rightWidth}px`;
    this.$('.slot.right').style.left = `${leftWidth}px`;
    this.shifts = sides.map(([left, right]) => (left ? 0 : -leftWidth / 2) + (right ? 0 : rightWidth / 2));
    this.shift = this.shifts[0];
    this.fill(this.$('.slot.left'), sides[0][0]);
    this.fill(this.$('.slot.right'), sides.at(-1)[1]);
    // Leaf i carries spread i's right page on its front and spread i+1's left page on its back.
    this.leaves.forEach((leaf, i) => {
      this.dress(leaf, 'front', sides[i][1], false, height);
      this.dress(leaf, 'back', this.single ? null : sides[i + 1][0], true, height);
    });
    // Where the book rests in the stage, without its drift, so the leaves can be drawn over it.
    if (this.leaves.length) {
      const stage = this.$('.stage').getBoundingClientRect(), box = this.book.getBoundingClientRect();
      this.at = { x: box.left - stage.left - this.offset, y: box.top - stage.top, width: leftWidth + rightWidth, height, spine: leftWidth, stage };
    }
    this.frame();
    this.place();
  }
  // What one side of a leaf shows: a painted page straight from its finished canvas (never re-rendered), plain paper until it is
  // painted, or nothing. Pages hang from the spine and are centred on the leaf's height.
  dress(leaf, side, number, paper, height) {
    const entry = number ? this.cache.get(number) : null;
    const size = entry?.done ? entry : number ? { width: this.sizes[number - 1].width * this.scaleFor(number), height: this.sizes[number - 1].height * this.scaleFor(number) } : paper ? { width: this.typical.width * this.scale, height: this.typical.height * this.scale } : null;
    leaf[side] = size && { source: entry?.done ? entry.canvas : null, width: size.width, height: size.height, top: (height - size.height) / 2 };
  }
  // One shared frame clock for every spring: step them all, paint once, then let the ones that came to rest settle.
  // It keeps running while a leaf is on the table, since a leaf's bend relaxes even while a finger holds it still.
  run() {
    if (this.ticking) return;
    this.time = performance.now();
    this.ticking = requestAnimationFrame(now => this.tick(now));
  }
  tick(now) {
    const dt = clamp(now - this.time, 0, 64) / 1000;
    this.time = now;
    for (const leaf of this.leaves) this.flex(leaf, now);
    const landed = [this.nudge, ...this.leaves.flatMap(leaf => [leaf.turn, leaf.bend])].filter(spring => spring.active && spring.step(dt));
    this.frame();
    for (const spring of landed) spring.settle?.();
    this.ticking = this.nudge.active || this.leaves.length ? requestAnimationFrame(next => this.tick(next)) : 0;
  }
  // Aim a leaf's bend at its motion: angular speed from the spring, or from the finger's last 100 ms while it is held.
  flex(leaf, now) {
    let velocity = leaf.turn.v;
    if (this.drag?.leaf === leaf) {
      const { samples } = this.drag, first = samples[0], last = samples.at(-1);
      velocity = now - last.t < 50 && last.t > first.t ? (last.theta - first.theta) / (last.t - first.t) * 1000 : 0;
    }
    if (Math.abs(velocity) > 30) leaf.dir = Math.sign(velocity);
    leaf.bend.to(leaf.stiff ? 0 : BEND.rest * leaf.dir + BEND.speed * Math.tanh(velocity / BEND.reference));
  }
  // Paint the current angles: each leaf's curve with its own light, the book's drift between spread offsets, and the shadows
  // the leaves cast on the pages beneath out to their projected edge. A leaf never shows ahead of the one before it.
  frame() {
    let shift = this.shifts[0], ceiling = 180, right = 0, rightWidth = 0, left = 0, leftWidth = 0;
    const leaves = this.leaves.map((leaf, i) => {
      const theta = ceiling = Math.min(leaf.turn.x, ceiling);
      shift += (this.shifts[i + 1] - this.shifts[i]) * theta / 180;
      const lift = Math.sin(theta * RAD), bend = leaf.bend.x * lift;
      const xs = curve(theta, bend).map(([x]) => x), reach = Math.max(0, ...xs), back = Math.min(0, ...xs);
      // Rising off the right page the leaf shades it out to its projected edge; past vertical it lands on the left page.
      const onRight = theta <= 90;
      const shadeRight = onRight ? lift : lift * ((180 - theta) / 90) ** 2;
      const shadeLeft = onRight ? lift * (theta / 90) ** 3 : lift;
      if (shadeRight > right) { right = shadeRight; rightWidth = .1 + .9 * reach; }
      if (shadeLeft > left) { left = shadeLeft; leftWidth = .1 + .9 * -back; }
      return { theta, bend, front: leaf.front, back: leaf.back };
    });
    this.offset = shift + this.nudge.x;
    this.book.style.transform = `translateX(${this.offset}px)`;
    this.book.style.setProperty('--shade-r', right.toFixed(3));
    this.book.style.setProperty('--shade-rw', rightWidth.toFixed(3));
    this.book.style.setProperty('--shade-l', left.toFixed(3));
    this.book.style.setProperty('--shade-lw', leftWidth.toFixed(3));
    this.curl.keep([...this.cache.values()].map(entry => entry.canvas));
    if (!leaves.length || !this.at) return this.curl.clear();
    const { x, y, width, height, spine, stage } = this.at;
    this.curl.draw({
      width: stage.width, height: stage.height, depth: PERSPECTIVE, leaves,
      origin: [x + this.offset + width / 2, y + height / 2], spine: [x + this.offset + spine, y],
      leaf: { width: this.rightWidth, height }, crease: this.single ? 0 : .14,
    });
  }
  // Add a leaf between an earlier spread `a` (theta 0) and a later one `b` (theta 180) at either end of the chain, and let it go
  // toward `target` unless a finger holds it (target undefined). The pages it reveals, and the following spread's, are painted ahead.
  addLeaf(a, b, theta, target, velocity) {
    // Reduced motion never bends: the leaf only follows a finger and lands at once.
    const leaf = { a, b, dir: theta === 0 ? 1 : -1, stiff: !this.motion, turn: new Spring(this, () => this.retire()), bend: new Spring(this) };
    leaf.bend.response = BEND.response;
    leaf.turn.set(theta);
    if (this.leaves.length && b === this.leaves[0].a) this.leaves.unshift(leaf);
    else this.leaves.push(leaf);
    const ahead = theta === 0 ? [b, this.target(1, b)] : [a, this.target(-1, a)];
    for (const spread of ahead) if (spread) for (const number of this.sides(spread).filter(Boolean)) this.paint(number).catch(() => {});
    this.layout();
    if (target !== undefined) leaf.turn.to(target, velocity);
    this.sync();
    return leaf;
  }
  // A leaf that has come to rest flat at either end of the chain leaves the table; once the last one is gone the book is at rest.
  retire() {
    const flat = leaf => !leaf.turn.active && leaf !== this.drag?.leaf;
    this.page = this.destination(); // Decided while the leaves are still here to tell.
    let changed = false;
    while (this.leaves.length && flat(this.leaves[0]) && this.leaves[0].turn.x === 180) { this.leaves.shift(); changed = true; }
    while (this.leaves.length && flat(this.leaves.at(-1)) && this.leaves.at(-1).turn.x === 0) { this.leaves.pop(); changed = true; }
    if (!changed) return;
    this.sync();
    this.layout();
    if (!this.leaves.length) this.render();
  }
  // Land every leaf at once on the side it is heading to (resize, zoom, instant jumps).
  snap() {
    this.cancelDrag();
    if (!this.leaves.length) return;
    this.page = this.destination();
    for (const leaf of this.leaves) leaf.turn.stop();
    this.leaves = [];
    this.layout();
    this.updateControls();
  }
  // Apple's rubber band: the further past the edge, the less the book follows.
  rubber(x) {
    const band = this.rightWidth / 2;
    return (x * band * .55) / (band + .55 * Math.abs(x));
  }
  // One pointer down on the book: it turns pages at rest, and pans the zoomed book (`pan` is the scroll position it started from).
  startDrag(e) {
    this.settle();
    const scroller = this.$('.scroller');
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, samples: [], pan: this.zoom > 1 && [scroller.scrollLeft, scroller.scrollTop] };
    this.$('.reader').classList.add('dragging');
  }
  moveDrag(e) {
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      drag.axis = drag.pan ? 'both' : Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'y') return this.endDrag();
      try { this.$('.scroller').setPointerCapture(drag.id); } catch {}
    }
    if (drag.pan) {
      const scroller = this.$('.scroller');
      scroller.scrollLeft = drag.pan[0] - dx;
      scroller.scrollTop = drag.pan[1] - dy;
      drag.samples = drag.samples.filter(sample => e.timeStamp - sample.t < 100);
      drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      return;
    }
    if (!drag.mode) {
      // A pull against a leaf in flight grabs that leaf; a push the way it is already going turns the next one.
      const forward = dx < 0, direction = forward ? 1 : -1;
      let leaf = this.boundary(direction);
      if (!leaf) {
        const spreads = this.spreads();
        const from = forward ? spreads.at(-1) : spreads[0];
        const next = this.target(direction, from);
        if (next) leaf = this.addLeaf(forward ? from : next, forward ? next : from, forward ? 0 : 180);
      }
      if (!leaf) { drag.mode = 'nudge'; }
      else {
        leaf.turn.stop(); // Grab it where it is.
        drag.mode = 'turn';
        drag.leaf = leaf;
        drag.edge = this.rightWidth * Math.cos(leaf.turn.x * Math.PI / 180);
        drag.samples = [{ theta: leaf.turn.x, t: drag.t }]; // Velocity counts from where the leaf was when the finger landed.
      }
    }
    if (drag.mode === 'nudge') { this.nudge.set(this.rubber(dx)); this.frame(); return; }
    // The leaf's free edge follows the finger: edge = width · cos(theta). It cannot pass its neighbours in the chain.
    const index = this.leaves.indexOf(drag.leaf);
    const theta = clamp(Math.acos(clamp((drag.edge + dx) / this.rightWidth, -1, 1)) * 180 / Math.PI, this.leaves[index + 1]?.turn.x ?? 0, this.leaves[index - 1]?.turn.x ?? 180);
    drag.leaf.turn.set(theta);
    drag.samples = drag.samples.filter(sample => e.timeStamp - sample.t < 100);
    drag.samples.push({ theta, t: e.timeStamp });
    this.frame();
    this.run();
  }
  cancelDrag() {
    if (!this.drag) return;
    try { this.$('.scroller').releasePointerCapture(this.drag.id); } catch {}
    this.drag = null;
    this.$('.reader').classList.remove('dragging');
  }
  // Release: a flick decides by its direction; otherwise the projected resting angle picks the nearer side.
  endDrag(e) {
    const drag = this.drag;
    if (!drag || (e && drag.id !== e.pointerId)) return;
    this.cancelDrag();
    if (drag.mode === 'nudge') { this.nudge.to(0, undefined, !this.motion); return; }
    if (drag.pan) {
      const { samples } = drag, first = samples[0], last = samples.at(-1);
      if (e && samples.length > 1 && e.timeStamp - last.t < 100) this.glide((first.x - last.x) / (last.t - first.t || 1), (first.y - last.y) / (last.t - first.t || 1));
      return;
    }
    const leaf = drag.leaf;
    if (!leaf || !this.leaves.includes(leaf)) return;
    const { samples } = drag;
    let velocity = 0;
    if (e && samples.length > 1 && e.timeStamp - samples.at(-1).t < 100) {
      velocity = (samples.at(-1).theta - samples[0].theta) / Math.max(1, samples.at(-1).t - samples[0].t) * 1000;
    }
    const flick = 45000 / this.rightWidth; // ≈ 500 px/s at the free edge
    const rest = leaf.turn.x + (velocity / 1000) * .998 / .002;
    const target = Math.abs(velocity) > flick ? (velocity > 0 ? 180 : 0) : rest > 90 ? 180 : 0;
    leaf.turn.to(target, velocity, !this.motion);
    this.sync();
  }
  // A zoomed book let go mid-pan glides on and slows down like a scrolled page (velocity in px/ms, .998 decay per ms).
  glide(vx, vy) {
    if (!this.motion) return;
    const scroller = this.$('.scroller');
    let time = performance.now();
    const step = now => {
      const dt = now - time, decay = .998 ** dt;
      time = now;
      scroller.scrollLeft += vx * dt;
      scroller.scrollTop += vy * dt;
      vx *= decay;
      vy *= decay;
      this.gliding = Math.hypot(vx, vy) > .02 ? requestAnimationFrame(step) : 0;
    };
    this.gliding = requestAnimationFrame(step);
  }
  // Two taps close together in time and place zoom in about the tapped point, or back out when zoomed in.
  tap(e) {
    const last = this.lastTap;
    this.lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (!last || e.timeStamp - last.t > 350 || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 40) return;
    this.lastTap = null;
    this.zoomTo(this.zoom > 1 ? 1 : 2, { x: e.clientX, y: e.clientY });
  }
  // Pinch: the book follows the fingers continuously, scaled about the point between them, and past 1× or 3× it gives way
  // less and less. Nothing is painted during the gesture; the held look is scaled until the fingers lift.
  startPinch(points) {
    this.cancelDrag();
    this.snap();
    this.settle();
    const ids = [...points.keys()];
    for (const id of ids) try { this.$('.scroller').setPointerCapture(id); } catch {} // The drag let go of the first.
    const [a, b] = ids.map(id => points.get(id));
    const from = this.view ?? this.box();
    this.pinch = { ids, from, distance: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    this.pinch.focus = this.pinch.mid;
    this.view = { ...from };
    this.$('.reader').classList.add('dragging');
  }
  movePinch(points) {
    const { ids, from, distance, mid } = this.pinch;
    const [a, b] = ids.map(id => points.get(id));
    const raw = from.zoom * Math.hypot(b.x - a.x, b.y - a.y) / distance, bound = clamp(raw, 1, 3);
    const zoom = bound * (raw / bound) ** .3, k = zoom / from.zoom;
    const focus = this.pinch.focus = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.view = { zoom, width: from.width * k, height: from.height * k, left: focus.x - (mid.x - from.left) * k, top: focus.y - (mid.y - from.top) * k };
    this.place();
    this.$('.fit').textContent = `${Math.round(clamp(zoom, 1, 3) * 100)} %`;
  }
  endPinch() {
    const { focus } = this.pinch;
    this.pinch = null;
    this.$('.reader').classList.remove('dragging');
    const zoom = clamp(this.view.zoom, 1, 3);
    this.zoomTo(zoom < 1.05 ? 1 : zoom, focus);
  }
  // Zoom to `zoom`, keeping the page point at `focus` (client px, the middle of the stage by default) where it is on screen.
  // The book keeps its current look while its pages are painted at the new size, then eases from that look into place.
  async zoomTo(zoom, focus) {
    if (!this.pdf) return;
    this.snap();
    this.settle();
    if (!focus) { const stage = this.$('.stage').getBoundingClientRect(); focus = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 }; }
    const from = this.view ?? this.box(), k = zoom / from.zoom;
    const target = { left: focus.x - (focus.x - from.left) * k, top: focus.y - (focus.y - from.top) * k };
    const held = this.view = { ...from };
    this.place();
    if (zoom !== this.zoom) {
      this.zoom = zoom;
      const done = await this.render();
      if (this.view !== held) return;
      if (!done) return this.release();
    }
    // Scroll the new layout so the focus lands back under itself, as far as the book reaches, then ease from the held look.
    this.view = null;
    this.place();
    const scroller = this.$('.scroller');
    let box = this.box();
    scroller.scrollLeft += box.left - target.left;
    scroller.scrollTop += box.top - target.top;
    box = this.box();
    this.updateControls();
    if (!this.motion) return;
    const settling = this.settling = this.$('.spread').animate([{ transform: this.transform(box, from) }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.25, 1, .5, 1)' });
    const done = () => { if (this.settling === settling) this.settling = null; };
    settling.onfinish = settling.oncancel = done;
  }
  // The book's box on screen as it looks now, and the zoom it looks like.
  box() {
    const { left, top, width, height } = this.book.getBoundingClientRect();
    return { left, top, width, height, zoom: this.view?.zoom ?? this.zoom };
  }
  // Show the book at the box `view` whatever size it is laid out at: a pinch in progress, or a zoom waiting for its pages.
  place() {
    const spread = this.$('.spread');
    if (!spread.style.transform && !this.view) return;
    spread.style.transform = '';
    if (this.view) spread.style.transform = this.transform(this.box(), this.view);
  }
  // The transform of the (untransformed) spread that moves the book from box `from` to box `to`.
  transform(from, to) {
    const origin = this.$('.spread').getBoundingClientRect(), s = to.width / from.width;
    return `translate(${to.left - origin.left - (from.left - origin.left) * s}px, ${to.top - origin.top - (from.top - origin.top) * s}px) scale(${s})`;
  }
  // Finish any zoom easing and pan glide at once, so a new gesture starts from where things are.
  settle() {
    this.settling?.finish();
    cancelAnimationFrame(this.gliding);
    this.gliding = 0;
  }
  // Drop a held look and any pinch (reloads and instant jumps).
  release() {
    this.settle();
    this.pinch = null;
    this.view = null;
    this.place();
  }
  async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this) await document.exitFullscreen();
      else await this.requestFullscreen();
    } catch {
      this.$('.full').hidden = true;
    }
  }
}
if (!customElements.get('e-brosjyre')) customElements.define('e-brosjyre', EBrosjyre);
