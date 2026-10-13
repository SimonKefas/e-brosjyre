import { test, expect, devices } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// Where the reader is, outside the viewer: a link to a page in the URL fragment (#side=7) and a brochure-page event per spread shown.
const reader = page => page.locator('e-brosjyre').first();
async function ready(page, viewer = reader(page)) {
  await expect(viewer.locator('.sheet canvas').first()).toBeVisible();
  await expect(viewer.locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => viewer.evaluate(el => el.leaves.length > 0 || el.nudge.active || !!el.view || !!el.settling)).toBe(false);
}
const label = (page, viewer = reader(page)) => viewer.locator('.pages').textContent();
const fragment = page => page.evaluate(() => location.hash);
const historyLength = page => page.evaluate(() => history.length);
const next = page => reader(page).locator('.next').click();
// A twelve page brochure, served in place of the demo's own PDF so that / runs it too.
async function twelve(page) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 12; i++) pdf.addPage([420, 594]).drawText(`Side ${i}`, { x: 40, y: 520, size: 28, font });
  const body = Buffer.from(await pdf.save());
  await page.route(url => url.pathname === '/demo.pdf', route => route.fulfill({ contentType: 'application/pdf', body }));
}
// Every brochure-ready and brochure-page event of the first viewer, recorded from before it loads.
const record = page => page.addInitScript(() => {
  window.heard = [];
  for (const type of ['brochure-ready', 'brochure-page']) document.addEventListener(type, e => window.heard.push({ type, ...e.detail }), true);
});
const heard = page => page.evaluate(() => window.heard);

for (const path of ['/', '/viewer.html']) {
  test.describe(path, () => {
    test.beforeEach(({ page }) => twelve(page));

    test(`#side=7 opens on that page, and turning keeps the URL on the page shown without adding history (${path})`, async ({ page }) => {
      await page.goto('about:blank');
      await page.goto(`${path}#side=7`);
      await ready(page);
      expect(await label(page)).toBe('6–7 / 12');
      expect(await fragment(page)).toBe('#side=7'); // Page 7 is on show, so the link is left as it was shared.
      const entries = await historyLength(page);
      await next(page); await ready(page);
      expect(await label(page)).toBe('8–9 / 12');
      expect(await fragment(page)).toBe('#side=8');
      await next(page); await ready(page);
      await reader(page).locator('.prev').click(); await ready(page);
      expect(await fragment(page)).toBe('#side=8');
      await reader(page).locator('.progress').fill('12'); await ready(page);
      expect(await fragment(page)).toBe('#side=12');
      await reader(page).locator('.reader').focus();
      await page.keyboard.press('Home'); await ready(page);
      expect(await label(page)).toBe('1 / 12');
      expect(page.url()).not.toContain('#'); // The cover needs no fragment.
      expect(await historyLength(page)).toBe(entries);
      // Back leaves the brochure in one step, however many pages were turned.
      await page.goBack();
      expect(page.url()).toBe('about:blank');
    });

    test(`a page number that is not in the document opens the cover without an error (${path})`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const wrong = ['#side=13', '#side=99999', '#side=0', '#side=-2', '#side=abc', '#side=7.5', '#side=', '#side=%37'];
      for (const hash of wrong) {
        await page.goto('about:blank');
        await page.goto(`${path}${hash}`);
        await ready(page);
        expect(await label(page), hash).toBe('1 / 12');
        expect(page.url(), hash).not.toContain('#');
      }
      // The same, arriving while the brochure is open.
      for (const hash of wrong) {
        await page.evaluate(hash => { location.hash = hash; }, hash);
        await ready(page);
        expect(await label(page), hash).toBe('1 / 12');
        await expect.poll(() => page.url(), hash).not.toContain('#');
      }
      expect(errors).toEqual([]);
    });

    test(`a link to #side=N on the host page turns there (${path})`, async ({ page }) => {
      await page.goto(path);
      await ready(page);
      await page.evaluate(() => { location.hash = 'side=9'; });
      await ready(page);
      expect(await label(page)).toBe('8–9 / 12');
    });

    test(`deep-link="off" leaves the URL to the host page (${path})`, async ({ page }) => {
      if (path === '/') await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.querySelector('e-brosjyre').setAttribute('deep-link', 'off')));
      await page.goto(`${path}${path === '/' ? '' : '?deep-link=off'}#side=7`);
      await ready(page);
      expect(await label(page)).toBe('1 / 12');
      await next(page); await ready(page);
      await page.evaluate(() => { location.hash = 'side=11'; });
      await page.waitForTimeout(300);
      expect(await label(page)).toBe('2–3 / 12');
      expect(await fragment(page)).toBe('#side=11');
    });

    test(`brochure-page is sent once for each spread the book lands on, with the pages on show (${path})`, async ({ page }) => {
      await record(page);
      await page.goto(path);
      await ready(page);
      await expect.poll(() => heard(page)).toEqual([
        { type: 'brochure-ready', page: 1, pages: [1], total: 12 },
        { type: 'brochure-page', page: 1, pages: [1], total: 12 },
      ]);
      await next(page); await ready(page);
      // A drag held mid-turn has not landed yet: nothing is sent until it has.
      const box = await reader(page).locator('.scroller').boundingBox();
      const y = box.y + box.height / 2, x = box.x + box.width * .75;
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(x - box.width * .05 * i, y); await page.waitForTimeout(16); }
      expect(await reader(page).evaluate(el => el.leaves.length)).toBe(1);
      expect((await heard(page)).length).toBe(3);
      await page.mouse.move(x - box.width * .7, y); await page.mouse.up();
      await ready(page);
      // Zooming, fitting again and asking for the spread on show change no page.
      await reader(page).getByRole('button', { name: 'Zoom inn' }).click(); await ready(page);
      await reader(page).getByRole('button', { name: 'Tilpass til vinduet' }).click(); await ready(page);
      await reader(page).evaluate(el => el.goTo(5)); await ready(page);
      await page.setViewportSize({ width: 1000, height: 800 }); await page.waitForTimeout(300); await ready(page);
      expect((await heard(page)).slice(2)).toEqual([
        { type: 'brochure-page', page: 2, pages: [2, 3], total: 12 },
        { type: 'brochure-page', page: 4, pages: [4, 5], total: 12 },
      ]);
      // Many quick clicks put several leaves in the air: only spreads the book came to rest on are sent, each once, ending where it stopped.
      for (let i = 0; i < 4; i++) await next(page);
      await ready(page);
      expect(await label(page)).toBe('12 / 12');
      const events = (await heard(page)).slice(4);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.length).toBeLessThanOrEqual(4);
      expect(events.at(-1)).toEqual({ type: 'brochure-page', page: 12, pages: [12], total: 12 });
      events.slice(1).forEach((event, i) => expect(event.page).not.toBe(events[i].page));
      // A change of page mode that shows other pages is a new view.
      await reader(page).evaluate(el => { el.goTo(6, true); el.setAttribute('spread', 'single'); });
      await ready(page);
      expect((await heard(page)).at(-1)).toEqual({ type: 'brochure-page', page: 6, pages: [6], total: 12 });
      expect((await heard(page)).filter(event => event.type === 'brochure-ready')).toHaveLength(1);
    });
  });
}

test('only the first viewer on a page follows the URL, and a fragment of the host page is never overwritten', async ({ page }) => {
  await twelve(page);
  await page.goto('/#side=5');
  await ready(page);
  await page.evaluate(() => { const el = document.createElement('e-brosjyre'); el.id = 'second'; el.setAttribute('src', './demo.pdf'); document.body.append(el); });
  const second = page.locator('#second');
  await ready(page, second);
  expect(await label(page, second)).toBe('1 / 12');
  await second.evaluate(el => el.goTo(9)); await ready(page, second);
  expect(await fragment(page)).toBe('#side=5');
  // With the first one opted out, the second takes over.
  await reader(page).evaluate(el => el.setAttribute('deep-link', 'off'));
  await second.evaluate(el => el.goTo(2)); await ready(page, second);
  expect(await fragment(page)).toBe('#side=2');
  // An anchor of the host page (the demo's #oppsett) stays, whatever is turned.
  await page.goto('about:blank');
  await page.goto('/#oppsett');
  await ready(page);
  await next(page); await ready(page);
  expect(await label(page)).toBe('2–3 / 12');
  expect(await fragment(page)).toBe('#oppsett');
});

test('in an iframe the viewer opens at the page in its own address and keeps it there', async ({ page }) => {
  await twelve(page);
  await page.goto('/');
  await page.evaluate(() => { document.body.innerHTML = '<iframe title="Brosjyre" src="/viewer.html?pdf=./demo.pdf#side=4" style="width:900px;height:700px"></iframe>'; });
  const frame = page.frameLocator('iframe').locator('e-brosjyre');
  await ready(page, frame);
  expect(await label(page, frame)).toBe('4–5 / 12');
  await frame.locator('.next').click(); await ready(page, frame);
  expect(await page.frames()[1].evaluate(() => location.hash)).toBe('#side=6');
  expect(page.url()).not.toContain('#');
});

const profile = name => { const { defaultBrowserType, ...rest } = devices[name]; return rest; };
for (const name of ['iPhone 15', 'iPad (gen 7) landscape']) {
  test.describe(name, () => {
    test.use(profile(name));
    test(`${name}: a shared link opens on its page and a swipe moves the URL along, on / and /viewer.html`, async ({ page }) => {
      await twelve(page);
      for (const path of ['/', '/viewer.html']) {
        await page.goto(`${path}#side=7`);
        await ready(page);
        await reader(page).scrollIntoViewIfNeeded();
        expect(await label(page)).toBe('6–7 / 12');
        const entries = await historyLength(page);
        const box = await reader(page).locator('.scroller').boundingBox();
        const reach = await reader(page).evaluate(el => el.rightWidth * 1.15);
        const y = box.y + box.height / 2, x = box.x + box.width * .9;
        await reader(page).locator('.scroller').evaluate(async (el, { x, y, reach }) => {
          const fire = (type, clientX) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, clientX, clientY: y }));
          fire('pointerdown', x);
          for (let i = 1; i <= 10; i++) { await new Promise(r => setTimeout(r, 16)); fire('pointermove', x - reach * i / 10); }
          fire('pointerup', x - reach);
        }, { x, y, reach });
        await ready(page);
        expect(await label(page)).toBe('8–9 / 12');
        expect(await fragment(page)).toBe('#side=8');
        expect(await historyLength(page)).toBe(entries);
      }
    });
  });
}
