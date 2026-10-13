import { test, expect, devices } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
// The contents: the PDF's bookmarks where it has them, otherwise a small picture of every page, painted as they near view.
const reader = page => page.locator('e-brosjyre');
async function ready(page) {
  await expect(reader(page).locator('.sheet canvas').first()).toBeVisible();
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => reader(page).evaluate(el => el.leaves.length > 0 || el.nudge.active || !!el.view || !!el.settling)).toBe(false);
}
const label = page => reader(page).locator('.pages').textContent();
const toggle = page => reader(page).locator('.toc');
const panel = page => reader(page).locator('.panel');
const painted = page => reader(page).evaluate(el => el.shadowRoot.querySelectorAll('.thumb canvas').length);
const CHAPTERS = [['Velkommen', 1], ['Våre produkter', 4], ['Kapittel tre', 8], ['Priser og bestilling', 10]];
const LINK = [60, 600, 300, 640]; // A web link on page 8, over the words "Les mer på nettsiden".
// Ten pages with bookmarks, one of them nested ("Eple og pære" under "Våre produkter"), and text and a link on page 8.
async function chaptered(page) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: 10 }, (_, i) => { const p = pdf.addPage([595, 842]); p.drawText(`Side ${i + 1}`, { x: 60, y: 760, size: 28, font }); return p; });
  pages[7].drawText('Kapittel tre', { x: 60, y: 700, size: 24, font });
  pages[7].drawText('Les mer på nettsiden', { x: 64, y: 612, size: 18, font });
  const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: LINK, Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/') } }));
  pages[7].node.set(PDFName.of('Annots'), pdf.context.obj([link]));
  const root = pdf.context.nextRef(), refs = CHAPTERS.map(() => pdf.context.nextRef()), child = pdf.context.nextRef();
  CHAPTERS.forEach(([title, number], i) => pdf.context.assign(refs[i], pdf.context.obj({
    Title: PDFHexString.fromText(title), Parent: root, Dest: [pages[number - 1].ref, 'Fit'],
    ...(i > 0 && { Prev: refs[i - 1] }), ...(i < refs.length - 1 && { Next: refs[i + 1] }),
    ...(i === 1 && { First: child, Last: child, Count: 1 }),
  })));
  pdf.context.assign(child, pdf.context.obj({ Title: PDFHexString.fromText('Eple og pære'), Parent: refs[1], Dest: [pages[5].ref, 'Fit'] }));
  pdf.context.assign(root, pdf.context.obj({ Type: 'Outlines', First: refs[0], Last: refs.at(-1), Count: refs.length + 1 }));
  pdf.catalog.set(PDFName.of('Outlines'), root);
  await serve(page, pdf);
}
// A sixty page catalog without bookmarks, every page with something to see in a thumbnail.
async function catalog(page) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 60; i++) {
    const p = pdf.addPage([595, 842]);
    p.drawRectangle({ x: 40, y: 360, width: 515, height: 420, color: { type: 'RGB', red: (i * 37 % 100) / 100, green: .55, blue: (i * 61 % 100) / 100 } });
    p.drawText(String(i), { x: 60, y: 120, size: 160, font });
  }
  await serve(page, pdf);
}
// Served in place of the demo's own PDF, so that / runs it too.
async function serve(page, pdf) {
  const body = Buffer.from(await pdf.save());
  await page.route(url => url.pathname === '/demo.pdf', route => route.fulfill({ contentType: 'application/pdf', body }));
}
const entries = page => reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('.entries button')].map(b => ({ name: b.getAttribute('aria-label'), current: b.hasAttribute('aria-current'), depth: b.closest('ol').parentElement.closest('ol') ? 1 : 0 })));
// Where the text "Kapittel tre" and the link on page 8 sit, as page points measured on the painted canvas.
const page8 = page => reader(page).evaluate(el => {
  const span = [...el.shadowRoot.querySelectorAll('.slot .textLayer span')].find(s => s.textContent === 'Kapittel tre');
  const link = el.shadowRoot.querySelector('.slot .links a');
  const canvas = span.closest('.sheet').querySelector('canvas').getBoundingClientRect();
  const at = box => [(box.left - canvas.left) / canvas.width * 595, (box.top - canvas.top) / canvas.height * 842, box.width / canvas.width * 595, box.height / canvas.height * 842];
  return { text: at(span.getBoundingClientRect()), link: at(link.getBoundingClientRect()), visibility: getComputedStyle(span).visibility };
});
function expectPage8InPlace(at) {
  expect(at.visibility).toBe('visible');
  expect(at.text[0]).toBeCloseTo(60, 0);
  expect(at.text[1]).toBeGreaterThan(842 - 700 - 24);
  expect(at.text[1]).toBeLessThan(842 - 700);
  [LINK[0], 842 - LINK[3], LINK[2] - LINK[0], LINK[3] - LINK[1]].forEach((value, i) => expect(at.link[i]).toBeCloseTo(value, 0));
}

for (const path of ['/', '/viewer.html']) {
  test.describe(path, () => {
    test.use({ viewport: { width: 1440, height: 1000 } });

    test(`bookmarks list the chapters, and choosing one turns there with its text and links in place (${path})`, async ({ page, browserName }) => {
      await chaptered(page);
      await page.goto(path);
      await ready(page);
      await expect(toggle(page)).toBeVisible();
      await expect(panel(page)).toBeHidden();
      await toggle(page).click();
      await expect(panel(page)).toBeVisible();
      await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => entries(page)).toEqual([
        { name: 'Velkommen, side 1', current: true, depth: 0 },
        { name: 'Våre produkter, side 4', current: false, depth: 0 },
        { name: 'Eple og pære, side 6', current: false, depth: 1 },
        { name: 'Kapittel tre, side 8', current: false, depth: 0 },
        { name: 'Priser og bestilling, side 10', current: false, depth: 0 },
      ]);
      await reader(page).screenshot({ path: `test-results/contents-chapters-desktop-${browserName}${path === '/' ? '' : '-viewer'}.png` });
      await panel(page).getByRole('button', { name: 'Kapittel tre, side 8' }).click();
      await expect(panel(page)).toBeHidden();
      await ready(page);
      expect(await label(page)).toBe('8–9 / 10');
      expect(page.url()).toContain('#side=8');
      await expect.poll(() => reader(page).evaluate(el => !!el.shadowRoot.querySelector('.slot .links a'))).toBe(true);
      expectPage8InPlace(await page8(page));
      // Opened again, the chapter on show is the one marked and focused.
      await toggle(page).click();
      await expect.poll(() => reader(page).evaluate(el => el.shadowRoot.activeElement?.getAttribute('aria-label'))).toBe('Kapittel tre, side 8');
      expect((await entries(page)).filter(entry => entry.current).map(entry => entry.name)).toEqual(['Kapittel tre, side 8']);
    });

    test(`the contents work from the keyboard (${path})`, async ({ page }) => {
      await chaptered(page);
      await page.goto(path);
      await ready(page);
      await toggle(page).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => reader(page).evaluate(el => el.shadowRoot.activeElement?.getAttribute('aria-label'))).toBe('Velkommen, side 1');
      // The arrow keys move through the list instead of turning pages behind it.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('End');
      expect(await reader(page).evaluate(el => el.shadowRoot.activeElement?.getAttribute('aria-label'))).toBe('Priser og bestilling, side 10');
      expect(await label(page)).toBe('1 / 10');
      // Escape closes them and gives focus back to the button that opened them.
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      expect(await reader(page).evaluate(el => el.shadowRoot.activeElement?.className)).toBe('toc');
      await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(panel(page)).toBeHidden();
      await ready(page);
      expect(await label(page)).toBe('4–5 / 10');
      // Focus is back on the button, where the arrow keys turn pages again.
      await page.keyboard.press('ArrowRight');
      await ready(page);
      expect(await label(page)).toBe('6–7 / 10');
    });

    test(`without bookmarks, sixty pages show as thumbnails painted as they near view, without holding the viewer up (${path})`, async ({ page, browserName }) => {
      await catalog(page);
      await page.goto(path);
      await ready(page);
      // The longest gap between frames while the contents open and their first thumbnails paint.
      await page.evaluate(() => {
        window.gaps = [];
        let last = performance.now();
        const frame = now => { window.gaps.push(now - last); last = now; if (window.gaps.length < 90) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      });
      await toggle(page).click();
      await expect(reader(page).locator('.grid button')).toHaveCount(60);
      await expect.poll(() => painted(page)).toBeGreaterThan(5);
      await page.waitForTimeout(800);
      const first = await painted(page);
      expect(first).toBeLessThan(40);
      await expect.poll(() => page.evaluate(() => window.gaps.length)).toBe(90);
      const longest = Math.max(...(await page.evaluate(() => window.gaps)));
      console.log(`${browserName} ${path}: ${first} of 60 thumbnails painted at first, longest frame gap ${Math.round(longest)} ms`);
      expect(longest).toBeLessThan(250);
      const size = await reader(page).evaluate(el => { const c = el.shadowRoot.querySelector('.thumb canvas'); return [c.width, c.height]; });
      expect(size[0]).toBeLessThanOrEqual(192);
      await reader(page).screenshot({ path: `test-results/contents-thumbnails-desktop-${browserName}${path === '/' ? '' : '-viewer'}.png` });
      // Scrolled to the end, the last pages are painted too.
      await reader(page).locator('.entries').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect.poll(() => reader(page).evaluate(el => !!el.shadowRoot.querySelector('.grid button[data-page="60"] canvas'))).toBe(true);
      await panel(page).getByRole('button', { name: 'Side 47', exact: true }).click();
      await ready(page);
      expect(await label(page)).toBe('46–47 / 60');
      await toggle(page).click();
      expect((await entries(page)).filter(entry => entry.current).map(entry => entry.name)).toEqual(['Side 46', 'Side 47']);
      // A touch on the book puts them away.
      const box = await reader(page).locator('.scroller').boundingBox();
      await page.mouse.click(box.x + box.width * .8, box.y + box.height / 2);
      await expect(panel(page)).toBeHidden();
    });
  });
}

test('chrome="none" has no contents, and switching to it closes them', async ({ page }) => {
  await chaptered(page);
  await page.goto('/viewer.html?chrome=none');
  await ready(page);
  await expect(toggle(page)).toBeHidden();
  await reader(page).evaluate(el => el.toggleContents(true));
  await expect(panel(page)).toBeHidden();
  // The keyboard path through the hidden toolbar skips it too.
  const focusable = await reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('button, input, a[href]')].filter(t => t.checkVisibility()).map(t => t.className));
  expect(focusable).not.toContain('toc');
  await page.goto('/viewer.html');
  await ready(page);
  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  await reader(page).evaluate(el => el.setAttribute('chrome', 'none'));
  await expect(panel(page)).toBeHidden();
  await expect(toggle(page)).toBeHidden();
  await reader(page).evaluate(el => el.setAttribute('chrome', 'minimal'));
  await expect(toggle(page)).toBeVisible();
});

const profile = name => { const { defaultBrowserType, ...rest } = devices[name]; return rest; };
for (const name of ['iPhone 15', 'iPhone 15 landscape', 'iPad (gen 7)', 'Galaxy S9+']) {
  test.describe(name, () => {
    test.use(profile(name));
    test(`${name}: the contents open with a tap, scroll with a finger and keep the frame's height, on / and /viewer.html`, async ({ page, browserName }) => {
      await catalog(page);
      for (const path of ['/', '/viewer.html']) {
        await page.goto(path);
        await ready(page);
        await reader(page).scrollIntoViewIfNeeded();
        const height = await reader(page).evaluate(el => el.getBoundingClientRect().height);
        // Nothing in the toolbar spills over on the narrowest phone, and the new button is a full touch target.
        expect(await reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('.toolbar, .controls, .track')].every(row => row.scrollWidth <= row.clientWidth + 1))).toBe(true);
        const button = await toggle(page).boundingBox();
        expect(button.width).toBeGreaterThanOrEqual(44);
        expect(button.height).toBeGreaterThanOrEqual(44);
        // The whole button takes the tap, the edge that reaches over the page count too.
        await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height - 3);
        await expect(panel(page)).toBeVisible();
        await expect.poll(() => painted(page)).toBeGreaterThan(2);
        expect(await reader(page).evaluate(el => el.getBoundingClientRect().height)).toBe(height);
        const targets = await reader(page).evaluate(el => [...el.shadowRoot.querySelectorAll('.panel button')].slice(0, 6).map(b => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
        for (const [w, h] of targets) { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); }
        const list = reader(page).locator('.entries');
        expect(await list.evaluate(el => [getComputedStyle(el).overflowY, el.scrollHeight > el.clientHeight])).toEqual(['auto', true]);
        if (path === '/') await page.screenshot({ path: `test-results/contents-thumbnails-${name.replace(/\W+/g, '-')}-${browserName}.png` });
        // A finger drag scrolls the list (Chromium can drive real touch scrolling; WebKit gets the same scroll set directly).
        const box = await list.boundingBox();
        if (browserName === 'chromium') {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height * .8), yDistance: -Math.round(box.height * .6), gestureSourceType: 'touch', speed: 800 });
        } else await list.evaluate(el => { el.scrollTop = el.clientHeight * .6; });
        await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(20);
        expect(await page.evaluate(() => scrollY)).toBeLessThan(1 + await page.evaluate(() => document.documentElement.scrollHeight - innerHeight));
        const target = panel(page).getByRole('button', { name: 'Side 9', exact: true });
        await target.scrollIntoViewIfNeeded();
        const at = await target.boundingBox();
        await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
        await expect(panel(page)).toBeHidden();
        await ready(page);
        expect(await label(page)).toBe('8–9 / 60');
      }
    });
  });
}

test('screenshots of the chapters on a phone', async ({ browser, browserName }) => {
  const context = await browser.newContext(profile('iPhone 15'));
  const page = await context.newPage();
  await chaptered(page);
  await page.goto('/');
  await ready(page);
  await reader(page).scrollIntoViewIfNeeded();
  await page.touchscreen.tap(...await toggle(page).boundingBox().then(b => [b.x + b.width / 2, b.y + b.height / 2]));
  await expect(reader(page).locator('.entries button')).toHaveCount(5);
  await page.screenshot({ path: `test-results/contents-chapters-iPhone-15-${browserName}.png` });
  await context.close();
});
