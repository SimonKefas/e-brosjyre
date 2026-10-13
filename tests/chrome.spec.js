import { test, expect, devices } from '@playwright/test';
// The `chrome` attribute: the full dark box, the same controls without surfaces, or the book alone.
const reader = page => page.locator('e-brosjyre');
async function ready(page) {
  await expect(reader(page).locator('.sheet canvas').first()).toBeVisible();
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => reader(page).evaluate(el => el.leaves.length > 0 || el.nudge.active || !!el.view || !!el.settling)).toBe(false);
}
// What shows of the frame: backgrounds, the size of the toolbar and arrows, and the room between the book and the element's edges.
const look = page => reader(page).evaluate(el => {
  const $ = s => el.shadowRoot.querySelector(s), size = s => { const r = $(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const host = el.getBoundingClientRect(), book = el.book.getBoundingClientRect();
  return {
    chrome: $('.reader').dataset.chrome,
    background: getComputedStyle($('.reader')).backgroundColor,
    toolbarBackground: getComputedStyle($('.toolbar')).backgroundColor,
    arrowBackground: getComputedStyle($('.next')).backgroundColor,
    color: getComputedStyle($('.reader')).color,
    toolbar: size('.toolbar'), next: size('.next'),
    above: Math.round(book.top - host.top), below: Math.round(host.bottom - book.bottom),
    height: Math.round(host.height), label: $('.reader').getAttribute('aria-label'), pages: $('.pages').textContent,
  };
});
const set = (page, value) => reader(page).evaluate((el, value) => value === null ? el.removeAttribute('chrome') : el.setAttribute('chrome', value), value);
const transparent = 'rgba(0, 0, 0, 0)';

for (const [width, height] of [[1440, 1000], [632, 760], [390, 844]]) {
  test(`${width}×${height}: full, minimal and none on / show the right parts, with no empty band under the book`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await ready(page);
    const full = await look(page);
    expect(full.chrome).toBe('full');
    expect(full.background).toBe('rgb(48, 49, 47)');
    expect(full.toolbarBackground).toBe('rgb(34, 35, 32)');
    expect(full.toolbar[1]).toBeGreaterThan(40);
    expect(full.next[0]).toBeGreaterThanOrEqual(44);
    expect(full.below - full.above).toBeGreaterThan(40); // The toolbar sits under the book.

    await page.getByRole('button', { name: 'Minimal', exact: true }).click();
    await ready(page);
    const minimal = await look(page);
    expect(minimal.chrome).toBe('minimal');
    expect([minimal.background, minimal.toolbarBackground]).toEqual([transparent, transparent]);
    expect(minimal.color).toBe('rgb(40, 57, 46)'); // The demo page's own text colour, not the light one of the dark box.
    expect(minimal.toolbar).toEqual(full.toolbar);
    expect(minimal.next[0]).toBeGreaterThanOrEqual(44);
    expect(minimal.height).toBe(full.height);

    await page.getByRole('button', { name: 'Bare boken', exact: true }).click();
    await ready(page);
    const none = await look(page);
    expect(none.chrome).toBe('none');
    expect(none.background).toBe(transparent);
    // Toolbar and arrows are visually gone, and the frame shrinks by the toolbar: the book has the same room above and below.
    expect(none.toolbar[0]).toBeLessThanOrEqual(1);
    expect(none.next[0]).toBeLessThanOrEqual(1);
    expect(Math.abs(none.below - none.above)).toBeLessThanOrEqual(2);
    expect(none.below).toBeLessThanOrEqual(20);
    expect(none.label).toBe('Smaken av sesongen');
    expect(errors).toEqual([]);
  });
}

test('none: the keyboard still turns pages, and the hidden controls show while they have keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 632, height: 760 });
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Bare boken', exact: true }).click();
  await ready(page);
  await reader(page).locator('.reader').focus();
  await page.keyboard.press('ArrowRight');
  await ready(page);
  expect((await look(page)).pages).toBe('2–3 / 6');
  await page.keyboard.press('End');
  await ready(page);
  expect((await look(page)).pages).toBe('6 / 6');
  await page.keyboard.press('Home');
  await ready(page);
  // Tab from the book reaches "Neste side" (the first page has no previous one), which shows while focused and works.
  await page.keyboard.press('Tab');
  await expect(reader(page).locator('.next')).toBeFocused();
  expect((await look(page)).next[0]).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await ready(page);
  expect((await look(page)).pages).toBe('2–3 / 6');
  // Into the toolbar: it is laid over the stage while it has focus, so the frame's height does not change.
  const before = (await look(page)).height;
  await reader(page).locator('.progress').focus();
  const focused = await look(page);
  expect(focused.toolbar[1]).toBeGreaterThan(40);
  expect(focused.height).toBe(before);
  // Screen readers still get every control by name.
  for (const name of ['Forrige side', 'Neste side', 'Zoom inn', 'Zoom ut', 'Tilpass til vinduet']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  await expect(page.getByRole('slider', { name: 'Gå til side' })).toHaveCount(1);
});

test('an unknown value falls back to full, and switching at runtime relays the frame out without throwing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 632, height: 760 });
  await page.goto('/');
  await ready(page);
  const full = await look(page);
  await set(page, 'glass');
  await ready(page);
  expect(await look(page)).toMatchObject({ chrome: 'full', height: full.height, background: full.background });
  await set(page, ' NONE ');
  await ready(page);
  const none = await look(page);
  expect(none.chrome).toBe('none');
  expect(none.height).toBeLessThan(full.height);
  await set(page, null);
  await ready(page);
  expect(await look(page)).toMatchObject({ chrome: 'full', height: full.height });
  expect(errors).toEqual([]);
});

test('viewer.html takes chrome= like spread=', async ({ page }) => {
  await page.setViewportSize({ width: 632, height: 760 });
  await page.goto('/viewer.html?chrome=none');
  await ready(page);
  const none = await look(page);
  expect(none.chrome).toBe('none');
  expect(none.toolbar[0]).toBeLessThanOrEqual(1);
  await reader(page).locator('.reader').focus();
  await page.keyboard.press('ArrowRight');
  await ready(page);
  expect((await look(page)).pages).toBe('2–3 / 6');
});

// Screenshots of the three variants on the demo's light page, for the owner to compare.
test('screenshots of full, minimal and none on a light page', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await ready(page);
  await reader(page).locator('.next').click();
  await ready(page);
  for (const [value, name] of [['full', 'Full'], ['minimal', 'Minimal'], ['none', 'Bare boken']]) {
    await page.getByRole('button', { name, exact: true }).click();
    await ready(page);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300); // Let the buttons' background transition finish.
    const box = await reader(page).evaluate(el => { const r = el.getBoundingClientRect(); return { y: r.top + scrollY, height: r.height }; });
    await page.screenshot({ path: `test-results/chrome-${value}-${info.project.name}.png`, fullPage: true, clip: { x: 0, y: Math.max(0, box.y - 40), width: 1280, height: box.height + 140 } });
  }
});

const profile = name => { const { defaultBrowserType, ...rest } = devices[name]; return rest; };
for (const name of ['iPhone 15', 'iPhone 15 landscape', 'iPad (gen 7)']) {
  test.describe(name, () => {
    test.use(profile(name));
    test(`${name}: with chrome="none" a swipe turns the page and a double tap zooms, on / and /viewer.html`, async ({ page }) => {
      for (const path of ['/', '/viewer.html?chrome=none']) {
        await page.goto(path);
        await ready(page);
        if (path === '/') { await page.getByRole('button', { name: 'Bare boken', exact: true }).tap(); await ready(page); }
        await reader(page).scrollIntoViewIfNeeded();
        const none = await look(page);
        expect(none.chrome).toBe('none');
        expect(Math.abs(none.below - none.above)).toBeLessThanOrEqual(2);
        const b = await reader(page).locator('.stage').boundingBox(), y = b.y + b.height / 2;
        await reader(page).locator('.scroller').evaluate(async (el, { from, to, y }) => {
          const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y }));
          fire('pointerdown', from);
          for (let i = 1; i <= 6; i++) { await new Promise(r => setTimeout(r, 16)); fire('pointermove', from + (to - from) * i / 6); }
          fire('pointerup', to);
        }, { from: b.x + b.width * .8, to: b.x + b.width * .2, y });
        await ready(page);
        expect((await look(page)).pages).toBe('2–3 / 6');
        const x = b.x + b.width / 2;
        await page.touchscreen.tap(x, y);
        await page.waitForTimeout(60);
        await page.touchscreen.tap(x, y);
        await expect.poll(() => reader(page).evaluate(el => el.zoom)).toBe(2);
        await ready(page);
      }
    });
  });
}
