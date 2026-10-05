import { test, expect } from '@playwright/test';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const reader = page => page.locator('e-brosjyre');
const leafCount = page => reader(page).first().evaluate(el => el.leaves.length);
async function ready(page) {
  await expect(reader(page).locator('.sheet canvas').first()).toBeVisible();
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => reader(page).first().evaluate(el => el.leaves.length > 0 || el.nudge.active || !!el.view || !!el.settling)).toBe(false);
}
// Synthetic pointer sequence with controlled timing: [x, delay-before-ms] steps, then release.
const drag = (page, pointerType, y, steps) => reader(page).locator('.scroller').evaluate(async (el, { pointerType, y, steps }) => {
  const fire = (type, clientX) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType, button: 0, clientX, clientY: y }));
  fire('pointerdown', steps[0][0]);
  for (const [x, wait] of steps.slice(1)) { await new Promise(r => setTimeout(r, wait)); fire('pointermove', x); }
  fire('pointerup', steps.at(-1)[0]);
}, { pointerType, y, steps });
const angle = page => reader(page).first().evaluate(el => el.leaves.at(-1)?.turn.x ?? 0);
const bookShift = page => reader(page).first().evaluate(el => new DOMMatrix(getComputedStyle(el.shadowRoot.querySelector('.book')).transform).m41 - el.shift);
// Visible canvases: sizes and how much of the stage the current spread uses.
const shape = page => reader(page).first().evaluate(el => {
  const stage = el.shadowRoot.querySelector('.stage').getBoundingClientRect();
  const boxes = [...el.shadowRoot.querySelectorAll('.slot canvas')].map(c => c.getBoundingClientRect());
  const width = boxes.reduce((sum, b) => sum + b.width, 0), height = Math.max(...boxes.map(b => b.height));
  const fillW = width / (stage.width - el.marginX), fillH = height / (stage.height - 32);
  return { fill: Math.max(fillW, fillH), fillW, fillH, boxes: boxes.map(b => [Math.round(b.width), Math.round(b.height)]), stage: [Math.round(stage.width), Math.round(stage.height)], leafWidth: el.rightWidth };
});
async function fixture(page, name, build) {
  const pdf = await PDFDocument.create();
  build(pdf);
  const data = Buffer.from(await pdf.save());
  await page.route(url => url.pathname === `/${name}.pdf`, route => route.fulfill({ contentType: 'application/pdf', body: data }));
}
const next = page => page.getByRole('button', { name: 'Neste side', exact: true }).click();
const prev = page => page.getByRole('button', { name: 'Forrige side', exact: true }).click();

test('desktop cover, spreads, final page, keyboard and zoom', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await ready(page);
  await expect(reader(page).locator('.sheet canvas')).toHaveCount(1);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await next(page);
  await ready(page);
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await page.screenshot({ path: 'test-results/spread.png' });
  const original = await reader(page).locator('.sheet canvas').first().boundingBox();
  await page.getByRole('button', { name: 'Zoom inn' }).click();
  await ready(page);
  expect((await reader(page).locator('.sheet canvas').first().boundingBox()).width).toBeGreaterThan(original.width);
  await page.getByRole('button', { name: 'Tilpass til vinduet' }).click();
  await ready(page);
  await reader(page).locator('.reader').focus();
  await page.keyboard.press('End');
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('6 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
  await expect(reader(page).locator('.next')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 6');
  await page.keyboard.press('Home');
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  expect(errors).toEqual([]);
});

test('mobile shows spreads by default, with touch navigation and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await ready(page);
  const scroller = reader(page).locator('.scroller');
  const y = (await reader(page).boundingBox()).y + 150;
  await scroller.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 290, clientY: y });
  await scroller.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 70, clientY: y });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
});

test('a 632×760 preview panel shows spreads, and with spread="auto" single pages only start around phone width', async ({ page }) => {
  await page.setViewportSize({ width: 632, height: 760 });
  await page.goto('/viewer.html?spread=auto'); await ready(page);
  await next(page); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  const spread = await shape(page);
  expect(spread.boxes).toHaveLength(2);
  expect(spread.fill).toBeGreaterThan(.95);
  await page.screenshot({ path: 'test-results/panel-632x760-spread.png' });
  await page.setViewportSize({ width: 480, height: 760 });
  await expect(reader(page).locator('.pages')).toHaveText('2 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
  await page.setViewportSize({ width: 540, height: 760 });
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
});

test('viewer.html accepts both pdf= and src=', async ({ page }) => {
  await fixture(page, 'nine', pdf => { for (let i = 0; i < 9; i++) pdf.addPage([595, 842]).drawText(`${i + 1}`); });
  await page.goto('/viewer.html?src=/nine.pdf'); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 9');
  await page.goto('/viewer.html?pdf=/nine.pdf'); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 9');
});

test('rapid navigation and source changes settle on the newest request', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await reader(page).evaluate(el => { el.goTo(4); el.goTo(6); el.goTo(2); el.setAttribute('src', './missing.pdf'); el.setAttribute('src', './demo.pdf?fresh=1'); });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  await expect(reader(page).locator('.sheet canvas')).toHaveCount(1);
});

test('invalid, missing, and non-PDF sources have readable errors and recover', async ({ page }) => {
  await page.goto('/viewer.html'); await ready(page);
  for (const src of ['javascript:alert(1)', '/missing.pdf', '/demo.css']) {
    await reader(page).evaluate((el, value) => el.setAttribute('src', value), src);
    await expect(reader(page).getByText('Kunne ikke åpne brosjyren')).toBeVisible();
    await expect(reader(page).locator('.next')).toBeDisabled();
    await expect(reader(page).locator('.sheet canvas')).toHaveCount(0);
  }
  await reader(page).evaluate(el => el.setAttribute('src', './demo.pdf'));
  await ready(page);
});

test('single-page and odd-length landscape documents pair like a book', async ({ page }) => {
  for (const count of [1, 5]) {
    await fixture(page, `fixture-${count}`, pdf => { for (let i = 0; i < count; i++) pdf.addPage([640, 360]).drawText(`Page ${i + 1}`); });
    await page.goto(`/viewer.html?pdf=/fixture-${count}.pdf`); await ready(page);
    await expect(reader(page).locator('.sheet canvas')).toHaveCount(1);
    await reader(page).locator('.reader').focus(); await page.keyboard.press('End'); await ready(page);
    await expect(reader(page).locator('.pages')).toHaveText(count === 1 ? '1 / 1' : '4–5 / 5');
    await expect(reader(page).locator('.next')).toBeDisabled();
    if (count === 5) { const spread = await shape(page); expect(spread.boxes).toHaveLength(2); expect(spread.fill).toBeGreaterThan(.95); }
  }
  await page.screenshot({ path: 'test-results/landscape-desktop.png' });
});

test('mixed portrait, landscape and rotated pages keep the book model and one document scale', async ({ page }) => {
  await fixture(page, 'mixed', pdf => {
    const add = (size, rotation = 0, label) => { const p = pdf.addPage(size); p.setRotation(degrees(rotation)); p.drawText(label, { x: 40, y: 40, size: 36 }); p.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], borderWidth: 6, borderColor: rgb(.2, .3, .2) }); };
    add([595, 842], 0, '1 cover'); add([595, 842], 0, '2'); add([595, 842], 0, '3');
    add([842, 595], 0, '4 landscape'); add([595, 842], 90, '5 rotated 90');
    add([595, 842], 0, '6'); add([420, 595], 0, '7 A5'); add([595, 842], 0, '8'); add([842, 595], 0, '9 landscape');
  });
  await page.goto('/viewer.html?pdf=/mixed.pdf'); await ready(page);
  const seen = {};
  for (const expected of ['1 / 9', '2–3 / 9', '4–5 / 9', '6–7 / 9', '8–9 / 9']) {
    await expect(reader(page).locator('.pages')).toHaveText(expected);
    const s = await shape(page);
    seen[expected] = s;
    expect(s.fill).toBeLessThan(1.02);
    await page.screenshot({ path: `test-results/mixed-desktop-${expected.split(' ')[0].replace('–', '-')}.png` });
    if (expected !== '8–9 / 9') { await next(page); await ready(page); }
  }
  // Cover, spreads and A4 pages share one scale; the A5 page is smaller at that same scale; landscape pairs are shrunk to fit.
  expect(seen['1 / 9'].boxes[0]).toEqual(seen['2–3 / 9'].boxes[0]);
  expect(seen['2–3 / 9'].fill).toBeGreaterThan(.95);
  expect(seen['6–7 / 9'].boxes[0]).toEqual(seen['2–3 / 9'].boxes[0]);
  expect(seen['6–7 / 9'].boxes[1][1]).toBeLessThan(seen['6–7 / 9'].boxes[0][1]);
  expect(seen['4–5 / 9'].boxes).toHaveLength(2);
  expect(seen['4–5 / 9'].boxes[0][0]).toBeGreaterThan(seen['4–5 / 9'].boxes[0][1]);
  expect(seen['4–5 / 9'].boxes[1][0]).toBeGreaterThan(seen['4–5 / 9'].boxes[1][1]);
  expect(await page.evaluate(() => { const sc = document.querySelector('e-brosjyre').shadowRoot.querySelector('.scroller'); return sc.scrollWidth <= sc.clientWidth && sc.scrollHeight <= sc.clientHeight; })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await reader(page).evaluate(el => { el.setAttribute('spread', 'auto'); el.goTo(2, true); }); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2 / 9');
  await expect(reader(page).locator('.sheet canvas')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/mixed-mobile-2.png' });
  await reader(page).evaluate(el => el.goTo(4, true)); await ready(page);
  expect((await shape(page)).fill).toBeGreaterThan(.95);
  await page.screenshot({ path: 'test-results/mixed-mobile-4.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 9');
});

test('real catalog: 12 portrait A4 pages read as cover and spreads, on mobile too', async ({ page }) => {
  test.skip(!existsSync('public/lokal-katalog.pdf'), 'Katalogen ligger ikke i public/');
  await page.goto('/viewer.html?pdf=./lokal-katalog.pdf'); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 12');
  const cover = await shape(page);
  await page.screenshot({ path: 'test-results/katalog-desktop-cover.png' });
  await next(page); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 12');
  const spread = await shape(page);
  expect(spread.fill).toBeGreaterThan(.95);
  expect(cover.boxes[0]).toEqual(spread.boxes[0]);
  await page.screenshot({ path: 'test-results/katalog-desktop-spread.png' });
  // Mid-turn screenshots: the free edge sits at width·cos(theta), so drag by width·(1 − cos).
  const scroller = reader(page).locator('.scroller');
  await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: 1000, clientY: 400 });
  for (const theta of [45, 90, 135]) {
    await scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: 1000 - spread.leafWidth * (1 - Math.cos(theta * Math.PI / 180)), clientY: 400 });
    expect(Math.round(await angle(page))).toBe(theta);
    await page.screenshot({ path: `test-results/katalog-turn-${theta}.png` });
  }
  await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: 1000 - spread.leafWidth * (1 - Math.cos(135 * Math.PI / 180)), clientY: 400 });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 12');
  await reader(page).locator('.reader').focus(); await page.keyboard.press('End'); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('12 / 12');
  await page.screenshot({ path: 'test-results/katalog-desktop-last.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await reader(page).evaluate(el => el.goTo(5, true)); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 12');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  expect((await shape(page)).fillW).toBeGreaterThan(.95);
  await page.screenshot({ path: 'test-results/katalog-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await ready(page);
  await page.getByRole('button', { name: 'Bytt PDF' }).click();
  await page.getByRole('button', { name: 'Lokal katalog' }).click();
  await expect(reader(page).locator('.pages')).toHaveText('1 / 12');
  await ready(page);
  await page.screenshot({ path: 'test-results/katalog-demo-page.png' });
});

test('public cross-origin PDF URL and iframe viewer work', async ({ page }) => {
  await page.goto('/viewer.html?pdf=' + encodeURIComponent('http://localhost:4174/demo.pdf'));
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  await page.goto('/');
  await page.evaluate(() => { document.body.innerHTML = '<iframe title="Brosjyre" src="http://localhost:4174/viewer.html?pdf=./demo.pdf" style="width:900px;height:700px" allow="fullscreen"></iframe><iframe title="Uten fullskjerm" src="http://localhost:4174/viewer.html?pdf=./demo.pdf" style="width:900px;height:700px"></iframe>'; });
  await expect(page.frameLocator('iframe').first().locator('e-brosjyre .sheet canvas')).toBeVisible();
  // Fullscreen is only offered where the browser allows it: a cross-origin iframe (the Webflow case) needs allow="fullscreen".
  await expect(page.frameLocator('iframe').first().locator('e-brosjyre .full')).toBeVisible();
  await expect(page.frameLocator('iframe').last().locator('e-brosjyre .sheet canvas')).toBeVisible();
  await expect(page.frameLocator('iframe').last().locator('e-brosjyre .full')).toBeHidden();
});

test('multiple embeds isolate state and survive removal/reconnection', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await page.evaluate(() => { const el = document.createElement('e-brosjyre'); el.id = 'second'; el.setAttribute('src', './demo.pdf'); document.body.append(el); });
  const second = page.locator('#second');
  await expect(second.locator('.sheet canvas')).toBeVisible();
  await second.evaluate(el => el.goTo(4));
  await expect(second.locator('.pages')).toHaveText('4–5 / 6');
  await expect(reader(page).first().locator('.pages')).toHaveText('1 / 6');
  await second.evaluate(el => { el.remove(); document.body.append(el); });
  await expect(second.locator('.sheet canvas')).toBeVisible();
  await expect(second.locator('.pages')).toHaveText('1 / 6');
});

test('embed generator and external component module can be used on another site', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await page.getByLabel('Adresse til ebrosjyre.js').fill('http://localhost:4174/ebrosjyre.js');
  await page.getByLabel('Adresse til PDF', { exact: true }).fill('http://localhost:4174/demo.pdf?x=1&y=2');
  await page.getByRole('button', { name: 'Lag innbyggingskode' }).click();
  const code = await page.getByLabel('Klar for Code Embed i Webflow').inputValue();
  expect(code).toContain('&amp;y=2');
  await writeFile('dist/embedding-test.html', `<html><body>${code}</body></html>`);
  try {
    await page.goto('/embedding-test.html');
    await ready(page);
    await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  } finally { await unlink('dist/embedding-test.html'); }
});

test('fullscreen toggles from an explicit button click', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await page.getByRole('button', { name: 'Fullskjerm', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.getByRole('button', { name: 'Avslutt fullskjerm', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

test('mouse drag turns the leaf with the pointer, a quick flick completes and a slow short drag falls back', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await drag(page, 'mouse', 400, [[700, 0], [690, 5], [650, 5]]);
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  const scroller = reader(page).locator('.scroller');
  const { leafWidth } = await shape(page);
  await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: 700, clientY: 400 });
  await scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: 700 - leafWidth * (1 - Math.cos(Math.PI / 6)), clientY: 400 });
  expect(Math.round(await angle(page))).toBe(30);
  await expect.poll(() => leafCount(page)).toBe(1);
  // The leaf is drawn over the stage, from the painted pages it carries: page 3 on its front and page 4 on its back.
  await expect(reader(page).locator('.curl')).toBeVisible();
  expect(await reader(page).evaluate(el => [el.leaves[0].front, el.leaves[0].back].map(face => face.source === el.cache.get(face === el.leaves[0].front ? 3 : 4)?.canvas))).toEqual([true, true]);
  await expect(reader(page).locator('.reader')).toHaveClass(/dragging/);
  await page.waitForTimeout(150);
  await scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: 700 - leafWidth * (1 - Math.cos(Math.PI / 5)), clientY: 400 });
  await page.waitForTimeout(150);
  await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: 700 - leafWidth * (1 - Math.cos(Math.PI / 5)), clientY: 400 });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await expect(reader(page).locator('.reader')).not.toHaveClass(/dragging/);
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
});

test('dragging past the last page nudges the book with resistance instead of turning', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await reader(page).locator('.reader').focus(); await page.keyboard.press('End'); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('6 / 6');
  const scroller = reader(page).locator('.scroller');
  await scroller.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, button: 0, clientX: 700, clientY: 400 });
  await scroller.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 400, clientY: 400 });
  const resisted = await bookShift(page);
  expect(resisted).toBeLessThan(-20);
  expect(resisted).toBeGreaterThan(-300);
  await expect.poll(() => leafCount(page)).toBe(0);
  await scroller.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: 400, clientY: 400 });
  await ready(page);
  await expect.poll(() => bookShift(page)).toBeCloseTo(0, 0);
  await expect(reader(page).locator('.pages')).toHaveText('6 / 6');
  await drag(page, 'touch', 400, [[300, 0], [310, 5], [350, 5]]);
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 6');
});

test('reduced motion switches without turning while drag navigation keeps working', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await ready(page);
  await drag(page, 'touch', 350, [[300, 0], [290, 5], [250, 5]]);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await expect.poll(() => leafCount(page)).toBe(0);
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await next(page);
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 6');
  await expect.poll(() => leafCount(page)).toBe(0);
  expect(await angle(page)).toBe(0);
});

test('navigation and drags that interrupt a turn leave a consistent state', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await next(page);
  await prev(page);
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  await expect(reader(page).locator('.sheet canvas')).toHaveCount(1);
  // Two turns in flight, then a flick the same way: each is its own leaf, so the flick turns a third (the book ends at the last page).
  await reader(page).evaluate(el => { el.navigate(1); el.navigate(1); });
  await expect.poll(() => leafCount(page)).toBe(2);
  await drag(page, 'mouse', 400, [[700, 0], [690, 5], [650, 5]]);
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('6 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
  // Back, then immediately forward again: the same leaf reverses mid-air.
  await reader(page).evaluate(el => { el.navigate(-1); el.navigate(1); });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('6 / 6');
  await drag(page, 'touch', 400, [[300, 0], [310, 5], [350, 5]]);
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('4–5 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  expect(await angle(page)).toBe(0);
});

// Rapid turning: every quick swipe or click is one more leaf in the air, the book lands on the right spread and the controls agree.
test('many quick swipes and clicks all count, on the demo page and in the panel viewer', async ({ page }) => {
  const swipe = () => drag(page, 'touch', 380, [[600, 0], [580, 8], [470, 8]]);
  const state = () => reader(page).first().evaluate(el => [el.shadowRoot.querySelector('.pages').textContent, el.shadowRoot.querySelector('.progress').value, el.page]);
  for (const [path, viewport] of [['/', { width: 1440, height: 1000 }], ['/viewer.html', { width: 632, height: 760 }], ['/', { width: 632, height: 760 }]]) {
    await page.setViewportSize(viewport);
    await page.goto(path); await ready(page);
    for (let i = 0; i < 5; i++) { await swipe(); await page.waitForTimeout(60); }
    await ready(page);
    expect(await state()).toEqual(['6 / 6', '6', 6]);
    await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
    await reader(page).locator('.reader').focus();
    for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(40); }
    await ready(page);
    expect(await state()).toEqual(['1 / 6', '1', 1]);
    // Three forward, one back while they fly: the last leaf turns back and the book lands one spread short.
    await reader(page).evaluate(el => { el.navigate(1); el.navigate(1); el.navigate(1); el.navigate(-1); });
    await expect(reader(page).locator('.pages')).toHaveText('4–5 / 6');
    await ready(page);
    expect(await state()).toEqual(['4–5 / 6', '4', 4]);
    await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  }
  // Mid-turn stills in the panel format so the shadows can be judged: the leaf half raised (45°) and edge-on (90°).
  const { leafWidth } = await shape(page);
  const scroller = reader(page).locator('.scroller');
  await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: 1000, clientY: 500 });
  for (const theta of [45, 90]) {
    await scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: 1000 - leafWidth * (1 - Math.cos(theta * Math.PI / 180)), clientY: 500 });
    expect(Math.round(await angle(page))).toBe(theta);
    await page.screenshot({ path: `test-results/demo-turn-${theta}.png` });
  }
  await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: 1000 - leafWidth * 2, clientY: 500 });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('6 / 6');
});

// Regression: a narrow desktop panel (the Kai preview pane) must still read as a book, not as single pages.
// It used to fall back to one page per view because the threshold sat above this panel's page width.
test('with spread="auto" a narrow desktop panel keeps the book model while a real phone goes single', async ({ page }) => {
  await page.setViewportSize({ width: 632, height: 760 });
  await page.goto('/'); await ready(page);
  await reader(page).evaluate(el => el.setAttribute('spread', 'auto')); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  await next(page); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);

  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/'); await ready(page);
  await reader(page).evaluate(el => el.setAttribute('spread', 'auto')); await ready(page);
  await next(page); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
});

// The sheet bends as it turns. Joint i of the strip chain is rotateY(phi[i-1] - phi[i]); their sum is how far the sheet's angle
// changes from the spine to the free edge.
// How far the sheet curves from spine to free edge, in degrees.
const bend = page => reader(page).first().evaluate(el => Math.abs(el.leaves[0].bend.x * Math.sin(el.leaves[0].turn.x * Math.PI / 180)));
const grip = page => reader(page).first().evaluate(el => { const r = el.shadowRoot.querySelector('.book').getBoundingClientRect(); return { x: r.right - 16, y: r.top + r.height / 2, width: el.rightWidth }; });
const edgeAt = (g, theta) => g.x - g.width * (1 - Math.cos(theta * Math.PI / 180));
test('a turning leaf bends like paper: nearly flat on the page, fuller mid-turn, more for a quick drag, flat when it lands', async ({ page }) => {
  await page.setViewportSize({ width: 632, height: 760 });
  for (const path of ['/', '/viewer.html']) {
    await page.goto(path); await ready(page);
    const g = await grip(page);
    const scroller = reader(page).locator('.scroller');
    const move = theta => scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: edgeAt(g, theta), clientY: g.y });
    await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: g.x, clientY: g.y });
    await move(25); await move(8); await page.waitForTimeout(500); // Past the 8 px drag threshold first.
    const nearFlat = await bend(page);
    await move(90); await page.waitForTimeout(700);
    const held = await bend(page);
    // A quick sweep back to 30° and forward to 90° again.
    await move(30); await page.waitForTimeout(300);
    for (let theta = 36; theta <= 90; theta += 6) { await move(theta); await page.waitForTimeout(10); }
    const quick = await bend(page);
    expect(nearFlat).toBeLessThan(1.5);
    expect(held).toBeGreaterThan(3);
    expect(quick).toBeGreaterThan(held * 1.4);
    // The free edge still follows the pointer: the chain's chord ends where a flat leaf's edge would.
    expect(Math.round(await angle(page))).toBe(90);
    await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: edgeAt(g, 150), clientY: g.y });
    await expect.poll(() => angle(page)).toBeGreaterThan(170);
    await ready(page);
    await expect.poll(() => leafCount(page)).toBe(0);
  }
});

test('reduced motion keeps a dragged leaf straight', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 632, height: 760 });
  await page.goto('/'); await ready(page);
  const g = await grip(page);
  const scroller = reader(page).locator('.scroller');
  await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: g.x, clientY: g.y });
  for (let theta = 10; theta <= 90; theta += 10) { await scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: edgeAt(g, theta), clientY: g.y }); await page.waitForTimeout(8); }
  await page.waitForTimeout(200);
  expect(await bend(page)).toBe(0);
  await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: edgeAt(g, 90), clientY: g.y });
  await ready(page);
});

// Stills of the bent leaf in the owner's 632×760 panel, held at 45°, 90° and 135°, on the demo page and in the panel viewer.
test('bent leaf stills at 45°, 90° and 135° in the 632×760 panel', async ({ page }) => {
  const catalog = existsSync('public/lokal-katalog.pdf');
  await page.setViewportSize({ width: 632, height: 760 });
  for (const [name, path] of [['demo', '/'], ['viewer', catalog ? '/viewer.html?pdf=./lokal-katalog.pdf' : '/viewer.html']]) {
    await page.goto(path); await ready(page);
    if (name === 'demo' && catalog) { await reader(page).evaluate(el => el.setAttribute('src', './lokal-katalog.pdf')); await expect(reader(page).locator('.pages')).toHaveText('1 / 12'); await ready(page); }
    await next(page); await ready(page);
    const g = await grip(page);
    const scroller = reader(page).locator('.scroller');
    await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: g.x, clientY: g.y });
    for (const theta of [45, 90, 135]) {
      await scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: edgeAt(g, theta), clientY: g.y });
      await page.waitForTimeout(700);
      expect(Math.round(await angle(page))).toBe(theta);
      await page.screenshot({ path: `test-results/bend-${name}-632x760-${theta}.png` });
    }
    await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: edgeAt(g, 135), clientY: g.y });
    await ready(page);
  }
});

// The `spread` attribute: always (default), single or auto, read at start and followed when it changes; anything else means always.
test('the spread attribute picks two pages, one page or automatic, at start and when it changes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/viewer.html?spread=single'); await ready(page);
  await next(page); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
  // Switching to spreads lands on the spread that holds the current page, even mid-turn.
  await reader(page).evaluate(el => { el.goTo(3); el.setAttribute('spread', 'always'); });
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  for (const value of ['sideways', '', 'ALWAYS ']) {
    await reader(page).evaluate((el, v) => el.setAttribute('spread', v), value); await ready(page);
    await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
    expect(await reader(page).evaluate(el => el.spread)).toBe('always');
  }
  await reader(page).evaluate(el => el.setAttribute('spread', 'single')); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2 / 6');
  await reader(page).evaluate(el => el.removeAttribute('spread')); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await reader(page).evaluate(el => el.setAttribute('spread', 'auto')); await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reader(page).locator('.pages')).toHaveText('2 / 6');
  expect(errors).toEqual([]);
});

// On a phone the frame takes the shape of what it shows: wide and low for a spread, tall for a single page, so neither floats in empty space.
test('on a phone the frame fits the spread, and drag and bend still work at that size', async ({ page }) => {
  const catalog = existsSync('public/lokal-katalog.pdf');
  for (const [width, height] of [[430, 900], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/'); await ready(page);
    if (catalog) { await reader(page).evaluate(el => el.setAttribute('src', './lokal-katalog.pdf')); await expect(reader(page).locator('.pages')).toHaveText('1 / 12'); await ready(page); }
    await next(page); await ready(page);
    const spread = await shape(page);
    expect(spread.boxes).toHaveLength(2);
    expect(spread.fillW).toBeGreaterThan(.95);
    expect(spread.fillH).toBeGreaterThan(.95);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 430) await page.screenshot({ path: 'test-results/phone-430x900-always.png' });
    await reader(page).evaluate(el => el.setAttribute('spread', 'single')); await ready(page);
    const single = await shape(page);
    expect(single.boxes).toHaveLength(1);
    expect(single.fillW).toBeGreaterThan(.95);
    expect(single.fillH).toBeGreaterThan(.95);
    if (width === 430) await page.screenshot({ path: 'test-results/phone-430x900-single.png' });
    await reader(page).evaluate(el => el.setAttribute('spread', 'always')); await ready(page);
  }
  // Drag-to-turn on the phone spread: the free edge follows the finger, the sheet bends mid-turn, and the turn completes.
  const g = await grip(page);
  expect(g.width).toBeLessThan(200);
  const scroller = reader(page).locator('.scroller');
  const label = await reader(page).locator('.pages').textContent();
  await scroller.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, button: 0, clientX: g.x, clientY: g.y });
  await scroller.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: edgeAt(g, 25), clientY: g.y });
  for (let theta = 30; theta <= 90; theta += 6) { await scroller.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: edgeAt(g, theta), clientY: g.y }); await page.waitForTimeout(10); }
  expect(Math.round(await angle(page))).toBe(90);
  expect(await bend(page)).toBeGreaterThan(3);
  await page.screenshot({ path: 'test-results/phone-360x800-turn-90.png' });
  await scroller.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: edgeAt(g, 150), clientY: g.y });
  await ready(page);
  await expect(reader(page).locator('.pages')).not.toHaveText(label);
  await expect(reader(page).locator('.slot canvas')).toHaveCount(2);
  // Back with a quick touch swipe the other way.
  await drag(page, 'touch', g.y, [[40, 0], [60, 8], [200, 8]]);
  await ready(page);
  await expect(reader(page).locator('.pages')).toHaveText(label);
});
