import { test, expect } from '@playwright/test';
// The fault server (tests/faults.mjs) is a second origin, so every request here is cross-origin, as a Webflow asset would be.
const faults = `http://127.0.0.1:${Number(process.env.TEST_PORT || 4174) + 1}`;
const reader = page => page.locator('e-brosjyre');
const status = page => reader(page).locator('.status');
const retry = page => reader(page).getByRole('button', { name: 'Prøv igjen' });
const original = page => reader(page).locator('.message').getByRole('link', { name: 'Åpne PDF-en' });
async function ready(page) {
  await expect(reader(page).locator('.sheet canvas').first()).toBeVisible();
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect(reader(page).locator('.message')).toBeHidden();
}
// The viewer on its own page, with the frame under test, or on the demo page, where the source is swapped like a host page would.
const hosts = [['/viewer.html', ''], ['/viewer.html', 'none'], ['/', '']];
async function open(page, [path, chrome], src) {
  if (path === '/') {
    await page.goto('/');
    await ready(page);
    await reader(page).evaluate((el, value) => el.setAttribute('src', value), src);
  } else await page.goto(`${path}?${new URLSearchParams({ src, ...(chrome && { chrome }) })}`);
}
// The download is under way (PDF.js' worker runs and the request is out); only from here is silence a stalled download.
const downloading = page => expect.poll(() => reader(page).evaluate(el => !!el.loadingTask)).toBe(true);
const errors = page => page.evaluate(() => { window.failures = []; document.querySelector('e-brosjyre').addEventListener('brochure-error', e => window.failures.push(e.detail.reason)); });

for (const host of hosts) {
  const name = `${host[0]}${host[1] ? ` chrome=${host[1]}` : ''}`;

  test(`${name}: progress shows and grows while the PDF downloads`, async ({ page }) => {
    await open(page, host, `${faults}/ok/demo.pdf?chunk=600&delay=200`);
    const bar = reader(page).locator('.loaded progress');
    await expect(bar).toBeVisible();
    const first = await bar.evaluate(el => el.value);
    await expect.poll(() => bar.evaluate(el => el.value)).toBeGreaterThan(first);
    await expect(reader(page).locator('.amount')).toHaveText(/^\d+ kB av 7 kB$/);
    await expect(status(page)).toHaveText('Laster brosjyren …');
    await ready(page);
  });

  test(`${name}: try again reloads, twice in a row, without leftovers`, async ({ page }) => {
    await open(page, host, `${faults}/flaky/demo.pdf?fails=2&key=${test.info().project.name}-${encodeURIComponent(name)}-${Date.now()}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(status(page)).toContainText('Forbindelsen ble brutt');
      await expect(retry(page)).toBeVisible();
      await retry(page).click();
    }
    await ready(page);
    await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
    await expect(reader(page).locator('.slot canvas')).toHaveCount(1);
    await expect(retry(page)).toBeHidden();
    await expect(reader(page).locator('.reader')).toBeFocused();
    await reader(page).locator('.reader').press('ArrowRight');
    await expect(reader(page).locator('.pages')).toHaveText('2–3 / 6');
  });
}

// What each failure looks like to the reader. `retry`/`open`: whether trying again or opening the original is offered.
const failures = [
  ['cors', `${faults}/cors/demo.pdf`, 'Kunne ikke vise brosjyren her', /tillater ikke at PDF-en vises på denne nettsiden.*CORS/, false, true],
  ['missing', `${faults}/404/demo.pdf`, 'Fant ikke brosjyren', /\(404\)/, false, false],
  ['status', `${faults}/503/demo.pdf`, 'Kunne ikke åpne brosjyren', /feilkode 503/, true, true],
  ['network', 'https://ingen-slik-vert.invalid/brosjyre.pdf', 'Ingen forbindelse', /Fikk ikke kontakt med filverten/, true, true],
  ['broken', `${faults}/drop/demo.pdf`, 'Forbindelsen ble brutt', /avbrutt underveis/, true, true],
  ['password', `${faults}/ok/passord.pdf`, 'Brosjyren er passordbeskyttet', /krever passord/, false, true],
  ['not-pdf', `${faults}/ok/demo.css`, 'Kunne ikke åpne brosjyren', /ikke en lesbar PDF-fil/, false, true],
  ['invalid-url', 'javascript:alert(1)', 'Kunne ikke åpne brosjyren', /gyldig http- eller https-lenke/, false, false],
];
for (const host of hosts) {
  test(`${host[0]}${host[1] ? ` chrome=${host[1]}` : ''}: each failure names its own cause and remedy`, async ({ page }) => {
    await open(page, host, './demo.pdf');
    await ready(page);
    await errors(page);
    for (const [reason, src, title, detail, canRetry, canOpen] of failures) {
      await reader(page).evaluate((el, value) => el.setAttribute('src', value), src);
      await expect(status(page).locator('strong'), reason).toHaveText(title);
      await expect(status(page).locator('p'), reason).toHaveText(detail);
      await expect(retry(page), reason).toBeVisible({ visible: canRetry });
      await expect(original(page), reason).toBeVisible({ visible: canOpen });
      if (reason !== 'cors') await expect(status(page).locator('p'), reason).not.toContainText('CORS');
      await expect(reader(page).locator('.next')).toBeDisabled();
      await expect(reader(page).locator('.sheet canvas')).toHaveCount(0);
    }
    expect(await page.evaluate(() => window.failures)).toEqual(failures.map(([reason]) => reason));
    if (host[1] === 'none') {
      // No toolbar here: the notice itself carries the way out, reachable by keyboard.
      await reader(page).evaluate((el, value) => el.setAttribute('src', value), `${faults}/drop/demo.pdf`);
      await retry(page).focus();
      await expect(retry(page)).toBeVisible();
      const box = await retry(page).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await reader(page).evaluate(el => el.setAttribute('src', './demo.pdf'));
    await ready(page);
  });
}

test('going offline says so, and coming back online, try again opens the brochure', async ({ page, context }) => {
  await page.goto('/viewer.html');
  await ready(page);
  await context.setOffline(true);
  await reader(page).evaluate((el, value) => el.setAttribute('src', value), `${faults}/ok/demo.pdf`);
  await expect(status(page)).toContainText('Du er uten nett');
  await context.setOffline(false);
  await retry(page).click();
  await ready(page);
});

test.describe('a download that stands still', () => {
  test('is reported after the threshold, with the bytes so far and a way out', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/viewer.html?src=${encodeURIComponent(`${faults}/stall/demo.pdf`)}`);
    await expect(reader(page).locator('.amount')).toHaveText('1 kB av 7 kB');
    await downloading(page);
    await page.clock.fastForward(10_000);
    await expect(status(page)).toHaveText('Laster brosjyren …');
    await page.clock.fastForward(6_000);
    await expect(status(page).locator('strong')).toHaveText('Lastingen står stille');
    await expect(status(page).locator('p')).toContainText('15 sekunder');
    await expect(reader(page).locator('.amount')).toBeVisible();
    await expect(original(page)).toHaveAttribute('href', `${faults}/stall/demo.pdf`);
    await expect(retry(page)).toBeVisible();
  });

  test('is reported when the host never answers', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/viewer.html?chrome=none&src=${encodeURIComponent(`${faults}/hang/demo.pdf`)}`);
    await expect(status(page)).toHaveText('Laster brosjyren …');
    await downloading(page);
    await page.clock.fastForward(16_000);
    await expect(status(page).locator('strong')).toHaveText('Lastingen står stille');
    await expect(reader(page).locator('.loaded')).toBeHidden();
    await expect(retry(page)).toBeVisible();
  });

  test('clears the notice by itself when bytes start arriving again', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/viewer.html?src=${encodeURIComponent(`${faults}/pause/demo.pdf?pause=4000`)}`);
    await expect(reader(page).locator('.amount')).toHaveText('1 kB av 7 kB');
    await downloading(page);
    await page.clock.fastForward(16_000);
    await expect(status(page).locator('strong')).toHaveText('Lastingen står stille');
    await ready(page);
    await expect(reader(page).locator('.pages')).toHaveText('1 / 6');
  });
});

test('a viewer that cannot get started says it is taking long, not that the download stands still', async ({ page }) => {
  await page.clock.install();
  await page.route('**/pdf.worker.min.mjs', () => {}); // The worker never arrives.
  await page.goto('/viewer.html');
  await expect(status(page)).toHaveText('Laster brosjyren …');
  await page.clock.fastForward(30_000);
  await expect(status(page)).toHaveText('Laster brosjyren …');
  await page.clock.fastForward(31_000);
  await expect(status(page).locator('strong')).toHaveText('Dette tar lang tid');
  await expect(retry(page)).toBeVisible();
});

test('throttled network: progress climbs in steps and the brochure opens (Chromium, CDP)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebKit has no CDP network throttling');
  const cdp = await page.context().newCDPSession(page);
  await page.goto('/viewer.html');
  await ready(page);
  await cdp.send('Network.enable');
  // About 4 Mbit/s: the 1.5 MB file takes a few seconds, enough to see the bar move.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 500_000, uploadThroughput: 100_000 });
  await reader(page).evaluate((el, value) => el.setAttribute('src', value), `${faults}/nolength/stor.pdf`);
  const seen = new Set();
  await expect.poll(async () => { seen.add(await reader(page).locator('.amount').textContent()); return seen.size; }, { intervals: [100] }).toBeGreaterThan(3);
  // Without Content-Length there is no total: the amount shows, no bar pretends to know how far along it is.
  await expect(reader(page).locator('.amount')).toHaveText(/MB lastet ned|kB lastet ned/);
  await expect(reader(page).locator('.loaded progress')).toBeHidden();
  await ready(page);
});
