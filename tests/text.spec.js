import { test, expect, devices } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
// The text layer and the PDF's own links over the painted pages: selectable text where the words are drawn, out of the way
// while a WebGL leaf turns, and back in place when it lands, however the turn ends.
const reader = page => page.locator('e-brosjyre');
async function ready(page) {
  await expect(reader(page).locator('.sheet canvas').first()).toBeVisible();
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => reader(page).evaluate(el => el.leaves.length > 0 || el.nudge.active || !!el.view || !!el.settling)).toBe(false);
  // Every page on show has its text layer.
  await expect.poll(() => reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('.slot .sheet:not(.blank)')].every(sheet => sheet.querySelector('.textLayer')))).toBe(true);
}
const label = page => reader(page).locator('.pages').textContent();
const turning = page => reader(page).evaluate(el => ({
  leaves: el.leaves.length,
  turning: el.shadowRoot.querySelector('.reader').classList.contains('turning'),
  visibility: [...el.shadowRoot.querySelectorAll('.slot :is(.textLayer, .links)')].map(layer => getComputedStyle(layer).visibility),
}));
// Where a run of text sits on its page, as fractions of the painted canvas, and the canvas' own size on screen.
const run = (page, pattern) => reader(page).evaluate((el, source) => {
  const pattern = new RegExp(source);
  const span = [...el.shadowRoot.querySelectorAll('.slot .textLayer span')].find(s => pattern.test(s.textContent));
  const canvas = span.closest('.sheet').querySelector('canvas').getBoundingClientRect(), box = span.getBoundingClientRect();
  return { text: span.textContent, x: (box.left - canvas.left) / canvas.width, y: (box.top - canvas.top) / canvas.height, w: box.width / canvas.width, h: box.height / canvas.height, canvas: { width: canvas.width, height: canvas.height }, box: { left: box.left, top: box.top, width: box.width, height: box.height }, scale: el.scaleFor(el.page) };
}, pattern.source);
// The demo's page 3 heading: drawn by scripts/demo-pdf.mjs at x = 30, baseline y = 550 on a 420 × 594 pt page, 8 pt Helvetica Bold.
const HEADING = /SESONGENS UTVALG/;
function expectHeadingInPlace(at) {
  expect(at.x * 420).toBeCloseTo(30, 0);
  // Its box runs from the font's ascent above the baseline (594 − 550 = 44 pt from the top) to about its descent below it.
  expect(at.y * 594).toBeGreaterThan(44 - 8);
  expect(at.y * 594).toBeLessThan(44 - 4);
  expect((at.y + at.h) * 594).toBeGreaterThan(44);
  expect(at.h * 594).toBeCloseTo(8, 0);
}
const selection = page => page.evaluate(() => document.getSelection().toString());
// Synthetic pointer sequence that starts at a point on the book, so it lands on whatever is drawn there (text, link or canvas).
// The rest goes to the scroller, as pointer capture would send it (synthetic pointers cannot be captured).
const pointer = (page, { type = 'touch', from, steps, up = true, wait = 16 }) => reader(page).evaluate(async (el, { type, from, steps, up, wait }) => {
  const target = el.shadowRoot.elementFromPoint(...from), scroller = el.shadowRoot.querySelector('.scroller');
  const fire = (name, [x, y]) => (name === 'pointerdown' ? target : scroller).dispatchEvent(new PointerEvent(name, { bubbles: true, composed: true, pointerId: 9, pointerType: type, isPrimary: true, button: 0, clientX: x, clientY: y }));
  fire('pointerdown', from);
  for (const step of steps) { await new Promise(r => setTimeout(r, wait)); fire('pointermove', step); }
  if (up) fire('pointerup', steps.at(-1) ?? from);
  return target.className || target.tagName;
}, { type, from, steps, up, wait });
async function spread(page, path) {
  await page.goto(path);
  await ready(page);
  await reader(page).locator('.next').click();
  await ready(page);
  await reader(page).scrollIntoViewIfNeeded();
  expect(await label(page)).toBe('2–3 / 6');
}

for (const path of ['/', '/viewer.html']) {
  test.describe(path, () => {
    test.use({ viewport: { width: 632, height: 760 } });

    test('the text lies where the words are painted, and a mouse drag across it selects and copies it', async ({ page, browserName, context }) => {
      await spread(page, path);
      const at = await run(page, HEADING);
      expect(at.text).toMatch(/02\s+\/\s+SESONGENS UTVALG/);
      expectHeadingInPlace(at);
      // Both pages of the spread carry their own text.
      await expect(reader(page).getByRole('group', { name: 'Side 2' })).toContainText('Det gode ligger');
      await expect(reader(page).getByRole('group', { name: 'Side 3' })).toContainText('Fra naturen,');
      const { box } = at, y = box.top + box.height / 2;
      await page.mouse.move(box.left + 1, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(box.left + 1 + (box.width - 2) * i / 8, y);
      await page.mouse.up();
      expect(await selection(page)).toMatch(/02\s+\/\s+SESONGENS UTVAL/);
      // Selecting is not turning: the book has not moved.
      expect(await turning(page)).toMatchObject({ leaves: 0, turning: false });
      expect(await label(page)).toBe('2–3 / 6');
      await page.screenshot({ path: `test-results/text-selection-${browserName}${path === '/' ? '' : '-viewer'}.png` });
      if (browserName === 'chromium') {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.keyboard.press('ControlOrMeta+C');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/02\s+\/\s+SESONGENS UTVAL/);
      }
      // A drag that starts on the page beside the text still turns it.
      const canvas = await reader(page).locator('.slot.right canvas').boundingBox();
      await page.mouse.move(canvas.x + canvas.width * .9, canvas.y + canvas.height * .88);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(canvas.x + canvas.width * (.9 - .12 * i), canvas.y + canvas.height * .88); await page.waitForTimeout(16); }
      await page.mouse.up();
      await ready(page);
      expect(await label(page)).toBe('4–5 / 6');
    });

    test('screen readers get the page text instead of a picture of it', async ({ page }) => {
      await spread(page, path);
      const canvases = await reader(page).locator('.slot canvas').evaluateAll(list => list.map(c => ({ hidden: c.getAttribute('aria-hidden'), role: c.getAttribute('role') })));
      expect(canvases).toEqual([{ hidden: 'true', role: null }, { hidden: 'true', role: null }]);
      expect(await reader(page).evaluate(el => el.shadowRoot.innerHTML)).not.toContain('Åpne original PDF for tekstlesing');
      await expect(reader(page).getByRole('group', { name: 'Side 3' })).toContainText('Blodappelsin');
    });

    test('the text follows zoom and panning and keeps its place on the page', async ({ page }) => {
      await spread(page, path);
      const before = await run(page, HEADING);
      await reader(page).evaluate(el => el.zoomTo(2));
      await ready(page);
      const zoomed = await run(page, HEADING);
      expect(zoomed.canvas.width / before.canvas.width).toBeCloseTo(2, 2);
      expect(zoomed.box.height / before.box.height).toBeCloseTo(2, 1);
      for (const key of ['x', 'y', 'w', 'h']) expect(Math.abs(zoomed[key] - before[key]), key).toBeLessThan(.003);
      expectHeadingInPlace(zoomed);
      // Panned: the text moves with the page it is on.
      await reader(page).evaluate(el => { const s = el.shadowRoot.querySelector('.scroller'); s.scrollLeft += 120; s.scrollTop += 60; });
      const panned = await run(page, HEADING);
      expect(panned.box.left).toBeCloseTo(zoomed.box.left - 120, 0);
      for (const key of ['x', 'y']) expect(Math.abs(panned[key] - before[key]), key).toBeLessThan(.003);
      // Mid-pinch the held look is scaled, and the text with it.
      await reader(page).evaluate(el => el.zoomTo(1)); await ready(page);
      await reader(page).evaluate(el => { const b = el.box(); el.view = { zoom: 1.6, width: b.width * 1.6, height: b.height * 1.6, left: b.left - 40, top: b.top - 30 }; el.place(); });
      const pinched = await run(page, HEADING);
      for (const key of ['x', 'y', 'w', 'h']) expect(Math.abs(pinched[key] - before[key]), key).toBeLessThan(.003);
      expect(pinched.canvas.width / before.canvas.width).toBeCloseTo(1.6, 2);
      await reader(page).evaluate(el => el.release());
    });

    test('the text stands aside while a leaf turns and is back in place when it lands', async ({ page }) => {
      await spread(page, path);
      const before = await run(page, HEADING);
      const c = await reader(page).locator('.stage').boundingBox(), y = c.y + c.height / 2;
      // Held mid-turn: hidden. Released: the turn lands and the new spread's text is shown in place.
      // Pulled past upright, so it lands on the next spread whatever speed the release is measured at.
      await pointer(page, { from: [c.x + c.width * .85, y], steps: Array.from({ length: 6 }, (_, i) => [c.x + c.width * (.85 - .1 * (i + 1)), y]), up: false });
      let now = await turning(page);
      expect(now.leaves).toBe(1);
      expect(now.turning).toBe(true);
      expect(now.visibility.length).toBeGreaterThan(0);
      expect(new Set(now.visibility)).toEqual(new Set(['hidden']));
      await reader(page).evaluate(el => el.shadowRoot.querySelector('.scroller').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: 0, clientY: 0 })));
      await ready(page);
      expect(await label(page)).toBe('4–5 / 6');
      now = await turning(page);
      expect(now).toMatchObject({ leaves: 0, turning: false });
      expect(new Set(now.visibility)).toEqual(new Set(['visible']));
      await expect(reader(page).getByRole('group', { name: 'Side 4' })).toContainText('ET LITE SERVERINGSTIPS');
      const landed = await run(page, /04\s+\/\s+OPPSKRIFT/);
      expect(landed.x * 420).toBeCloseTo(30, 0);
      expect(Math.abs(landed.y - before.y)).toBeLessThan(.003); // Same place on its page as page 3's heading.
      // Pages turned with the buttons and keys hide and show the text the same way.
      await reader(page).locator('.prev').click();
      expect((await turning(page)).turning).toBe(true);
      await ready(page);
      expect(await turning(page)).toMatchObject({ leaves: 0, turning: false });
      expectHeadingInPlace(await run(page, HEADING));
    });

    test('an interrupted turn leaves the text visible and in place', async ({ page }) => {
      await spread(page, path);
      const before = await run(page, HEADING);
      const c = await reader(page).locator('.stage').boundingBox(), y = c.y + c.height / 2;
      // Pulled halfway, then back to where it started: the leaf falls back and the spread is unchanged.
      const out = Array.from({ length: 6 }, (_, i) => [c.x + c.width * (.85 - .08 * (i + 1)), y]);
      await pointer(page, { from: [c.x + c.width * .85, y], steps: [...out, ...out.slice(0, -1).reverse(), [c.x + c.width * .85, y]], wait: 40 });
      await ready(page);
      expect(await label(page)).toBe('2–3 / 6');
      let now = await turning(page);
      expect(now).toMatchObject({ leaves: 0, turning: false });
      expect(new Set(now.visibility)).toEqual(new Set(['visible']));
      expect(await run(page, HEADING)).toEqual(before);
      // A turn cut off by a zoom lands at once; the zoomed text is visible and in place.
      await reader(page).locator('.next').click();
      expect((await turning(page)).turning).toBe(true);
      await reader(page).evaluate(el => el.setZoom(2));
      await ready(page);
      expect(await label(page)).toBe('4–5 / 6');
      now = await turning(page);
      expect(now).toMatchObject({ leaves: 0, turning: false });
      expect(new Set(now.visibility)).toEqual(new Set(['visible']));
      const zoomed = await run(page, /04\s+\/\s+OPPSKRIFT/);
      expect(zoomed.x * 420).toBeCloseTo(30, 0);
      expect(Math.abs(zoomed.y - before.y)).toBeLessThan(.003);
      // Reversed mid-flight several times, then let go: wherever it ends, the text is shown and lies on its page.
      await reader(page).evaluate(el => el.setZoom(1)); await ready(page);
      await reader(page).evaluate(async el => { const wait = () => new Promise(r => setTimeout(r, 60)); el.navigate(-1); await wait(); el.navigate(1); await wait(); el.navigate(-1); });
      await ready(page);
      expect(await label(page)).toBe('2–3 / 6');
      now = await turning(page);
      expect(now).toMatchObject({ leaves: 0, turning: false });
      expect(new Set(now.visibility)).toEqual(new Set(['visible']));
      expectHeadingInPlace(await run(page, HEADING));
    });
  });
}

// A brochure with links: on page 1 a web link, a mail link, a link to page 4, and two that must stay dead (javascript: and file:).
const LINKS = { web: [60, 700, 260, 730], mail: [60, 640, 260, 670], internal: [60, 580, 260, 610], script: [60, 520, 260, 550], file: [60, 460, 260, 490] };
async function linkFixture(page) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: 5 }, (_, i) => { const p = pdf.addPage([595, 842]); p.drawText(`Side ${i + 1}`, { x: 60, y: 780, size: 24, font }); return p; });
  pages[0].drawText('Besøk nettsiden', { x: 64, y: 708, size: 18, font });
  pages[0].drawText('Send oss en e-post', { x: 64, y: 648, size: 18, font });
  pages[0].drawText('Gå til oppskriften', { x: 64, y: 588, size: 18, font });
  const uri = url => ({ A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) } });
  const annots = [
    [LINKS.web, uri('https://example.com/brosjyre?kilde=pdf')],
    [LINKS.mail, uri('mailto:post@example.com')],
    [LINKS.internal, { Dest: [pages[3].ref, 'XYZ', null, null, null] }],
    [LINKS.script, uri('javascript:alert(1)')],
    [LINKS.file, uri('file:///etc/passwd')],
  ].map(([Rect, action]) => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect, Border: [0, 0, 0], ...action })));
  pages[0].node.set(PDFName.of('Annots'), pdf.context.obj(annots));
  const body = Buffer.from(await pdf.save());
  await page.route(url => url.pathname === '/lenker.pdf', route => route.fulfill({ contentType: 'application/pdf', body }));
  await page.context().route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Mål</title>' }));
}
const anchors = page => reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('.links a')].map(a => {
  const canvas = a.closest('.sheet').querySelector('canvas').getBoundingClientRect(), box = a.getBoundingClientRect();
  return { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), page: a.dataset.page ?? null, name: a.getAttribute('aria-label'), at: [(box.left - canvas.left) / canvas.width * 595, (box.top - canvas.top) / canvas.height * 842, box.width / canvas.width * 595, box.height / canvas.height * 842], center: [box.left + box.width / 2, box.top + box.height / 2] };
}));
const expectAt = (at, [x1, y1, x2, y2]) => [x1, 842 - y2, x2 - x1, y2 - y1].forEach((value, i) => expect(at[i]).toBeCloseTo(value, 0));

for (const path of ['/viewer.html?src=/lenker.pdf', '/?lenker']) {
  test(`PDF links open their target safely, and a link to a page turns there (${path})`, async ({ page, context }) => {
    await page.setViewportSize({ width: 632, height: 760 });
    await linkFixture(page);
    await page.goto(path);
    if (path.startsWith('/?')) await reader(page).evaluate(el => el.setAttribute('src', '/lenker.pdf'));
    await expect(reader(page).locator('.pages')).toHaveText('1 / 5');
    await ready(page);
    await expect.poll(async () => (await anchors(page)).length).toBe(3);
    const [web, mail, internal] = await anchors(page);
    expect(web).toMatchObject({ href: 'https://example.com/brosjyre?kilde=pdf', target: '_blank', rel: 'noopener noreferrer', page: null, name: 'https://example.com/brosjyre?kilde=pdf (åpnes i ny fane)' });
    expect(mail).toMatchObject({ href: 'mailto:post@example.com', target: null, rel: 'noopener noreferrer', name: 'E-post til post@example.com' });
    expect(internal).toMatchObject({ href: '#side-4', target: null, page: '4', name: 'Gå til side 4' });
    expectAt(web.at, LINKS.web); expectAt(mail.at, LINKS.mail); expectAt(internal.at, LINKS.internal);
    // Nothing for the javascript: and file: links.
    expect(await reader(page).evaluate(el => el.shadowRoot.querySelectorAll('.links a[href^="javascript"], .links a[href^="file"]').length)).toBe(0);
    // A real click on the web link opens it in a new tab, without a way back to the viewer.
    const [popup] = await Promise.all([context.waitForEvent('page'), page.mouse.click(...web.center)]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe('https://example.com/brosjyre?kilde=pdf');
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
    expect(await label(page)).toBe('1 / 5');
    // A drag that starts on a link turns the page and opens nothing.
    let opened = 0;
    context.on('page', () => opened++);
    await page.mouse.move(...web.center);
    await page.mouse.down();
    const reach = await reader(page).evaluate(el => el.rightWidth * 1.15); // Past upright: it turns at any measured speed.
    for (let i = 1; i <= 10; i++) { await page.mouse.move(web.center[0] - reach * i / 10, web.center[1]); await page.waitForTimeout(16); }
    await page.mouse.up();
    await ready(page);
    expect(await label(page)).toBe('2–3 / 5');
    expect(opened).toBe(0);
    await reader(page).evaluate(el => el.goTo(1, true)); await ready(page);
    // The link to page 4 turns the book there; the URL stays as it was.
    const url = page.url();
    await page.mouse.click(...internal.center);
    // Mid-turn whatever text and links are left in the slots stand aside (page 1 itself is on the leaf).
    const mid = await turning(page);
    expect(mid.turning).toBe(true);
    expect(mid.visibility.filter(v => v !== 'hidden')).toEqual([]);
    await ready(page);
    expect(await label(page)).toBe('4–5 / 5');
    expect(page.url()).toBe(url);
    expect(opened).toBe(0);
  });
}

// Touch on real device profiles: a swipe that starts on the text turns the page rather than selecting, the text can still be
// selected (a long press is the browser's own and cannot be driven from Playwright, so the selection is made the way it would
// leave it), and a tap opens a link.
const profile = name => { const { defaultBrowserType, ...rest } = devices[name]; return rest; };
for (const name of ['iPhone 15', 'iPad (gen 7) landscape']) {
  test.describe(name, () => {
    test.use(profile(name));
    test(`${name}: a swipe on the text turns the page, the text is selectable, and a tap opens a link`, async ({ page, context, browserName }) => {
      for (const path of ['/', '/viewer.html']) {
        await spread(page, path);
        expectHeadingInPlace(await run(page, HEADING));
        const at = await run(page, /Blodappelsin/);
        const y = at.box.top + at.box.height / 2, x = at.box.left + at.box.width * .9;
        // Far enough to carry the leaf past upright, so it turns whatever speed the swipe is measured at on a loaded machine.
        const reach = await reader(page).evaluate(el => el.rightWidth * 1.15);
        const target = await pointer(page, { from: [x, y], steps: Array.from({ length: 10 }, (_, i) => [x - reach * (i + 1) / 10, y]) });
        expect(target).toBe('SPAN'); // It started on the text.
        await ready(page);
        expect(await label(page)).toBe('4–5 / 6');
        expect(await selection(page)).toBe('');
        await reader(page).evaluate(el => el.goTo(2, true)); await ready(page);
        const selected = await reader(page).evaluate(el => {
          const span = [...el.shadowRoot.querySelectorAll('.textLayer span')].find(s => s.textContent.includes('Blodappelsin'));
          getSelection().setBaseAndExtent(span.firstChild, 0, span.firstChild, span.firstChild.length);
          return { userSelect: getComputedStyle(span).webkitUserSelect || getComputedStyle(span).userSelect, text: getSelection().toString() };
        });
        expect(selected).toEqual({ userSelect: 'text', text: 'Blodappelsin' });
        await page.screenshot({ path: `test-results/text-selection-${name.replace(/\W+/g, '-')}-${browserName}${path === '/' ? '' : '-viewer'}.png` });
        await page.evaluate(() => getSelection().removeAllRanges());
      }
      await linkFixture(page);
      await page.goto('/viewer.html?src=/lenker.pdf');
      await ready(page);
      await expect.poll(async () => (await anchors(page)).length).toBe(3);
      const [web, , internal] = await anchors(page);
      const [popup] = await Promise.all([context.waitForEvent('page'), page.touchscreen.tap(...web.center)]);
      await popup.waitForLoadState();
      expect(popup.url()).toBe('https://example.com/brosjyre?kilde=pdf');
      await popup.close();
      await page.touchscreen.tap(...internal.center);
      await ready(page);
      expect(await label(page)).toBe('4–5 / 5');
    });
  });
}
