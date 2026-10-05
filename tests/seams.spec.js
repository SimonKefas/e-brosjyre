import { test, expect } from '@playwright/test';
// The owner's panel renders with WebKit, where a leaf built from CSS 3D strips showed a hairline at every joint.
test.use({ browserName: 'webkit', deviceScaleFactor: 2, viewport: { width: 632, height: 760 } });
const reader = page => page.locator('e-brosjyre');
async function ready(page) {
  await expect(reader(page).locator('.reader')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => reader(page).evaluate(el => el.leaves.length > 0 || el.nudge.active)).toBe(false);
}
// Columns in a screenshot that stand out from their neighbours two pixels away on most rows: vertical lines. Page content
// has no line that tall; a seam between strips runs the full height of the leaf.
const seams = (page, png) => page.evaluate(async data => {
  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
  const context = new OffscreenCanvas(image.width, image.height).getContext('2d');
  context.drawImage(image, 0, 0);
  const { data: px, width, height } = context.getImageData(0, 0, image.width, image.height);
  const lum = (x, y) => { const i = (y * width + x) * 4; return .3 * px[i] + .59 * px[i + 1] + .11 * px[i + 2]; };
  const found = [];
  for (let x = 2; x < width - 2; x++) {
    let hits = 0;
    for (let y = 0; y < height; y++) if (Math.abs(lum(x, y) - (lum(x - 2, y) + lum(x + 2, y)) / 2) > 5) hits++;
    if (hits / height > .5) found.push(x);
  }
  return found;
}, png.toString('base64'));
// Whether the leaf covers a point (page coordinates): read straight back from the surface it is drawn on.
const covered = (page, x, y) => reader(page).evaluate((el, [x, y]) => {
  el.frame();
  const { gl } = el.curl, canvas = el.shadowRoot.querySelector('.curl'), box = canvas.getBoundingClientRect(), ratio = canvas.width / box.width;
  const px = new Uint8Array(4);
  gl.readPixels(Math.round((x - box.left) * ratio), Math.round(canvas.height - (y - box.top) * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px[3] === 255;
}, [x, y]);

for (const path of ['/', '/viewer.html']) {
  test(`a turning leaf reads as one sheet, without seams, at 60° and 120° (${path})`, async ({ page }) => {
    await page.goto(path); await ready(page);
    await page.getByRole('button', { name: 'Neste side', exact: true }).click(); await ready(page);
    const g = await reader(page).evaluate(el => { const r = el.shadowRoot.querySelector('.book').getBoundingClientRect(); return { x: r.right - 16, y: r.top + r.height / 2, top: r.top, height: r.height, spine: r.left + r.width / 2, width: el.rightWidth }; });
    const scroller = reader(page).locator('.scroller');
    const move = theta => scroller.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 7, clientX: g.x - g.width * (1 - Math.cos(theta * Math.PI / 180)), clientY: g.y });
    // The inner part of the leaf's projection, away from its outline and the spine.
    const clip = theta => { const edge = g.spine + g.width * Math.cos(theta * Math.PI / 180); const [a, b] = [Math.min(g.spine, edge), Math.max(g.spine, edge)]; return { x: a + (b - a) * .15, y: g.top + g.height * .2, width: (b - a) * .7, height: g.height * .6 }; };
    await scroller.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 7, button: 0, clientX: g.x, clientY: g.y });
    await move(20);
    for (const theta of [60, 120]) {
      await move(theta); await page.waitForTimeout(800);
      expect(Math.round(await reader(page).evaluate(el => el.leaves[0].turn.x))).toBe(theta);
      const shot = await page.screenshot({ clip: clip(theta) });
      const box = clip(theta);
      expect(await covered(page, box.x + box.width / 2, box.y + box.height / 2)).toBe(true);
      expect(await seams(page, shot)).toEqual([]);
    }
    await scroller.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 7, clientX: g.x - g.width * 1.5, clientY: g.y });
    await ready(page);
  });
}
