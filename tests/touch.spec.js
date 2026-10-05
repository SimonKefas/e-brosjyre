import { test, expect, devices } from '@playwright/test';
// Touch on real device profiles (touch events, mobile viewport and scale), in both engines: pinch, double tap, panning and
// touch target sizes. `defaultBrowserType` is dropped so every profile runs in Chromium and WebKit alike.
const profile = name => { const { defaultBrowserType, ...rest } = devices[name]; return rest; };
const reader = page => page.locator('e-brosjyre');
async function ready(page) {
  await expect(reader(page).locator('.sheet canvas').first()).toBeVisible();
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => reader(page).evaluate(el => el.leaves.length > 0 || el.nudge.active || !!el.view || !!el.settling)).toBe(false);
}
async function open(page, path) {
  await page.goto(path);
  await ready(page);
  await reader(page).locator('.next').click();
  await ready(page);
  await reader(page).scrollIntoViewIfNeeded();
}
const stage = async page => { const b = await reader(page).locator('.stage').boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b }; };
// Where a screen point falls on the book, as fractions of the book's box: the same page point stays at the same fractions.
const onBook = (page, x, y) => reader(page).evaluate((el, [x, y]) => { const r = el.book.getBoundingClientRect(); return [(x - r.left) / r.width, (y - r.top) / r.height]; }, [x, y]);
const state = page => reader(page).evaluate(el => {
  const s = el.shadowRoot.querySelector('.scroller');
  return { zoom: el.zoom, label: el.shadowRoot.querySelector('.pages').textContent, fit: el.shadowRoot.querySelector('.fit').textContent, scroll: [s.scrollLeft, s.scrollTop], touchAction: s.style.touchAction, leaves: el.leaves.length, pageScale: visualViewport.scale };
});
// Synthetic touch pointers with controlled timing. `moves` are per step the position of each finger; each step is followed by
// a sample of the live zoom, the zoom label and where the fingers' midpoint falls on the book.
const gesture = (page, { down, moves, up = true, wait = 16 }) => reader(page).locator('.scroller').evaluate(async (el, { down, moves, up, wait }) => {
  const host = el.getRootNode().host;
  const fire = (type, id, [x, y]) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', isPrimary: id === 1, button: 0, clientX: x, clientY: y }));
  down.forEach((p, i) => fire('pointerdown', i + 1, p));
  const samples = [];
  let last = down;
  for (const step of moves) {
    await new Promise(r => setTimeout(r, wait));
    step.forEach((p, i) => p && fire('pointermove', i + 1, p));
    last = step.map((p, i) => p ?? last[i]);
    const mid = last.length > 1 ? [(last[0][0] + last[1][0]) / 2, (last[0][1] + last[1][1]) / 2] : last[0];
    const r = host.book.getBoundingClientRect();
    samples.push({ zoom: host.view?.zoom ?? host.zoom, fit: host.shadowRoot.querySelector('.fit').textContent, at: [(mid[0] - r.left) / r.width, (mid[1] - r.top) / r.height] });
  }
  if (up) last.forEach((p, i) => fire('pointerup', i + 1, p));
  return samples;
}, { down, moves, up, wait });
const spreadFingers = (c, distance) => [[c.x - distance / 2, c.y], [c.x + distance / 2, c.y]];

for (const name of ['iPhone 15', 'iPhone 15 landscape', 'iPad (gen 7)', 'Galaxy S9+']) {
  test.describe(name, () => {
    test.use(profile(name));
    test(`${name}: controls are at least 44×44 and a double tap zooms in about the tapped point and back out, on / and /viewer.html`, async ({ page }) => {
      for (const path of ['/', '/viewer.html']) {
        await open(page, path);
        const targets = await reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('button, a[href], input')]
          .filter(t => t.checkVisibility({ visibilityProperty: true }))
          .map(t => { const r = t.getBoundingClientRect(); return { name: t.className, width: Math.round(r.width), height: Math.round(r.height) }; }));
        expect(targets.map(t => t.name)).toEqual(expect.arrayContaining(['prev', 'next', 'progress', 'plus', 'fit']));
        for (const t of targets) { expect(t.width, `${path} ${t.name}`).toBeGreaterThanOrEqual(44); expect(t.height, `${path} ${t.name}`).toBeGreaterThanOrEqual(44); }
        const c = await stage(page), x = c.x + c.box.width / 8;
        const before = await onBook(page, x, c.y);
        await page.touchscreen.tap(x, c.y);
        await page.waitForTimeout(60);
        await page.touchscreen.tap(x, c.y);
        await ready(page);
        let now = await state(page);
        expect(now).toMatchObject({ zoom: 2, fit: '200 %', label: '2–3 / 6', touchAction: 'none', pageScale: 1 });
        // The tapped point on the page is still under the finger, along each axis the zoomed book overflows (along the others
        // it is centred, as there is nothing to scroll).
        const after = await onBook(page, x, c.y);
        const overflows = await reader(page).evaluate(el => { const s = el.shadowRoot.querySelector('.scroller'); return [s.scrollWidth > s.clientWidth, s.scrollHeight > s.clientHeight]; });
        expect(overflows).toContain(true);
        overflows.forEach((overflow, axis) => overflow && expect(Math.abs(after[axis] - before[axis]), `${path} axis ${axis}`).toBeLessThan(.01));
        await page.screenshot({ path: `test-results/touch-${name.replace(/\W+/g, '-')}${path === '/' ? '' : '-viewer'}-zoomed.png` });
        await page.touchscreen.tap(x, c.y);
        await page.waitForTimeout(60);
        await page.touchscreen.tap(x, c.y);
        await ready(page);
        now = await state(page);
        expect(now).toMatchObject({ zoom: 1, fit: '100 %', label: '2–3 / 6', touchAction: 'pan-y', pageScale: 1 });
      }
    });
  });
}

test.describe('iPhone 15 gestures', () => {
  test.use(profile('iPhone 15'));

  test('a pinch follows the fingers continuously about their midpoint and stays where it was let go', async ({ page }) => {
    for (const path of ['/', '/viewer.html']) {
      await open(page, path);
      const c = await stage(page);
      const before = await onBook(page, c.x, c.y);
      const samples = await gesture(page, { down: spreadFingers(c, 60), moves: Array.from({ length: 10 }, (_, i) => spreadFingers(c, 60 + 9 * (i + 1))) });
      const zooms = samples.map(s => s.zoom);
      // Smooth, not in steps of .25: it rises on every move, mostly to values between the steps.
      for (let i = 1; i < zooms.length; i++) expect(zooms[i]).toBeGreaterThan(zooms[i - 1]);
      expect(zooms.filter(z => Math.abs(z * 4 - Math.round(z * 4)) > .05).length).toBeGreaterThanOrEqual(6);
      expect(zooms.at(-1)).toBeCloseTo(2.5, 2);
      expect(new Set(samples.map(s => s.fit)).size).toBeGreaterThanOrEqual(8); // The label follows along.
      // The book point between the fingers stays between them throughout.
      for (const s of samples) { expect(Math.abs(s.at[0] - before[0])).toBeLessThan(.005); expect(Math.abs(s.at[1] - before[1])).toBeLessThan(.005); }
      await ready(page);
      expect(await state(page)).toMatchObject({ zoom: 2.5, fit: '250 %', label: '2–3 / 6', touchAction: 'none' });
      const after = await onBook(page, c.x, c.y);
      expect(Math.abs(after[0] - before[0])).toBeLessThan(.01);
      // Pinching back in lands on 1×.
      await gesture(page, { down: spreadFingers(c, 150), moves: Array.from({ length: 8 }, (_, i) => spreadFingers(c, 150 - 12 * (i + 1))) });
      await ready(page);
      expect(await state(page)).toMatchObject({ zoom: 1, fit: '100 %', touchAction: 'pan-y' });
    }
  });

  test('past 1× and 3× a pinch gives way less and less, then springs back to the limit', async ({ page }) => {
    await open(page, '/');
    const c = await stage(page);
    let samples = await gesture(page, { down: spreadFingers(c, 160), moves: Array.from({ length: 6 }, (_, i) => spreadFingers(c, 160 - 20 * (i + 1))) });
    expect(samples.at(-1).zoom).toBeLessThan(1);
    expect(samples.at(-1).zoom).toBeGreaterThan(40 / 160); // Resisted: less than the fingers' own ratio.
    await ready(page);
    expect((await state(page)).zoom).toBe(1);
    samples = await gesture(page, { down: spreadFingers(c, 40), moves: Array.from({ length: 8 }, (_, i) => spreadFingers(c, 40 + 25 * (i + 1))) });
    expect(samples.at(-1).zoom).toBeGreaterThan(3);
    expect(samples.at(-1).zoom).toBeLessThan(240 / 40);
    expect(samples.at(-1).fit).toBe('300 %');
    await ready(page);
    expect(await state(page)).toMatchObject({ zoom: 3, fit: '300 %' });
    await expect(reader(page).locator('.plus')).toBeDisabled();
  });

  test('a real two-finger pinch zooms the brochure, not the page', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Only Chromium takes raw multi-touch input from Playwright (CDP); WebKit is covered by the pointer tests.');
    for (const path of ['/', '/viewer.html']) {
      await open(page, path);
      const c = await stage(page);
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
      await touch('touchStart', spreadFingers(c, 60));
      const live = [];
      for (let i = 1; i <= 8; i++) { await touch('touchMove', spreadFingers(c, 60 + 15 * i)); live.push(await reader(page).evaluate(el => el.view?.zoom ?? el.zoom)); }
      await touch('touchEnd', []);
      for (let i = 1; i < live.length; i++) expect(live[i]).toBeGreaterThan(live[i - 1]);
      await ready(page);
      const now = await state(page);
      expect(now.zoom).toBeCloseTo(3, 1);
      expect(now.pageScale).toBe(1);
      // One real finger then pans the zoomed book and does not turn the page.
      const scroll = now.scroll;
      await touch('touchStart', [[c.x + 60, c.y + 30]]);
      for (let i = 1; i <= 6; i++) await touch('touchMove', [[c.x + 60 - 20 * i, c.y + 30 - 5 * i]]);
      await touch('touchEnd', []);
      const panned = await state(page);
      expect(panned.scroll[0]).toBeGreaterThan(scroll[0] + 100);
      expect(panned).toMatchObject({ label: '2–3 / 6', leaves: 0, pageScale: 1 });
    }
  });

  test('zoomed in, one finger pans the book instead of turning, and a flick glides on', async ({ page }) => {
    for (const path of ['/', '/viewer.html']) {
      await open(page, path);
      await reader(page).evaluate(el => el.zoomTo(2.5)); await ready(page);
      const c = await stage(page), start = (await state(page)).scroll;
      // A slow drag moves the book with the finger.
      await gesture(page, { down: [[c.x + 80, c.y]], moves: Array.from({ length: 8 }, (_, i) => [[c.x + 80 - 15 * (i + 1), c.y - 3 * (i + 1)]]), up: false, wait: 20 });
      let now = await state(page);
      expect(now.scroll[0] - start[0]).toBeCloseTo(120, 0);
      expect(now.leaves).toBe(0);
      await reader(page).locator('.scroller').evaluate(el => el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'touch' })));
      // A quick flick keeps going after the finger lifts.
      const flickStart = (await state(page)).scroll[0];
      await gesture(page, { down: [[c.x + 60, c.y]], moves: [[[c.x + 40, c.y]], [[c.x + 10, c.y]], [[c.x - 30, c.y]]], wait: 16 });
      const lifted = (await state(page)).scroll[0];
      await page.waitForTimeout(250);
      now = await state(page);
      expect(lifted - flickStart).toBeGreaterThan(80);
      expect(now.scroll[0]).toBeGreaterThan(lifted + 20);
      expect(now).toMatchObject({ label: '2–3 / 6', leaves: 0, zoom: 2.5 });
      await reader(page).evaluate(el => el.zoomTo(1)); await ready(page);
    }
  });

  test('a second finger that only brushes the screen does not disturb a swipe', async ({ page }) => {
    for (const path of ['/', '/viewer.html']) {
      await open(page, path);
      const c = await stage(page);
      // Mid-turn: the turn carries on, the stray finger is ignored and the page turns.
      await reader(page).locator('.scroller').evaluate(async (el, c) => {
        const fire = (type, id, x, y = c.y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y }));
        const wait = () => new Promise(r => setTimeout(r, 16));
        fire('pointerdown', 1, c.x + 100);
        for (const x of [c.x + 80, c.x + 50]) { await wait(); fire('pointermove', 1, x); }
        fire('pointerdown', 2, c.x - 60, c.y + 40); await wait(); fire('pointermove', 2, c.x - 40, c.y + 60); fire('pointerup', 2, c.x - 40, c.y + 60);
        for (const x of [c.x, c.x - 60]) { await wait(); fire('pointermove', 1, x); }
        fire('pointerup', 1, c.x - 60);
      }, c);
      await ready(page);
      expect(await state(page)).toMatchObject({ zoom: 1, label: '4–5 / 6' });
      // Before the swipe got going: the brief pinch changes nothing, and the finger left behind still swipes.
      await reader(page).locator('.scroller').evaluate(async (el, c) => {
        const fire = (type, id, x, y = c.y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y }));
        const wait = () => new Promise(r => setTimeout(r, 16));
        fire('pointerdown', 1, c.x - 100);
        fire('pointerdown', 2, c.x + 60, c.y + 40); await wait(); fire('pointermove', 2, c.x + 62, c.y + 41); fire('pointerup', 2, c.x + 62, c.y + 41);
        for (const x of [c.x - 80, c.x - 40, c.x, c.x + 60]) { await wait(); fire('pointermove', 1, x); }
        fire('pointerup', 1, c.x + 60);
      }, c);
      await ready(page);
      expect(await state(page)).toMatchObject({ zoom: 1, label: '2–3 / 6' });
    }
  });
});

// The owner's panel and desktops: a mouse double click zooms the same way, and dragging pans the zoomed book.
test('in the 632×760 panel a double click zooms in and out, and a mouse drag pans when zoomed', async ({ page }) => {
  await page.setViewportSize({ width: 632, height: 760 });
  for (const path of ['/', '/viewer.html']) {
    await open(page, path);
    const c = await stage(page);
    await page.mouse.dblclick(c.x + 40, c.y);
    await ready(page);
    expect(await state(page)).toMatchObject({ zoom: 2, fit: '200 %' });
    const start = (await state(page)).scroll[0];
    await page.mouse.move(c.x + 60, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(c.x + 60 - 15 * i, c.y); await page.waitForTimeout(40); }
    await page.waitForTimeout(150);
    await page.mouse.up();
    expect((await state(page)).scroll[0] - start).toBeCloseTo(90, 0);
    expect(await state(page)).toMatchObject({ label: '2–3 / 6', leaves: 0 });
    await page.mouse.dblclick(c.x, c.y);
    await ready(page);
    expect(await state(page)).toMatchObject({ zoom: 1, fit: '100 %', label: '2–3 / 6' });
  }
});
