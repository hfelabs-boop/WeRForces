import { expect, type Page, test } from '@playwright/test';

const OPEN = 'http://127.0.0.1:8130';
const KEYED = 'http://127.0.0.1:8131';

type Win = Window & { werforces: any };

async function ready(page: Page, url: string): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Win).werforces?.state?.entities?.length > 0 && (window as unknown as Win).werforces?.grid);
  (page as unknown as { errors: string[] }).errors = errors;
}

/** Page coordinates of a world (local metres) position on the 2D map. */
async function mapPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const canvas = page.locator('#map canvas').first();
  const box = (await canvas.boundingBox())!;
  const s = await page.evaluate(([wx, wy]) => (window as unknown as Win).werforces.map.toScreen({ x: wx, y: wy }), [x, y]);
  return { x: box.x + s.x, y: box.y + s.y };
}

/** A dry, empty spot near (x, y) with dry, empty ground 1.5 km east of it too. */
async function dryLand(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([x0, y0]) => {
    const app = (window as unknown as Win).werforces;
    const grid = app.grid;
    const clear = (px: number, py: number) => {
      const s = app.map.toScreen({ x: px, y: py });
      return !grid.isWater(px, py) && px < grid.spec.size && !app.map.hitTest(s.x, s.y);
    };
    for (let r = 0; r < 6000; r += 100) {
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const px = x0 + Math.sin(a) * r;
        const py = y0 + Math.cos(a) * r;
        if (clear(px, py) && clear(px + 1500, py)) return { x: px, y: py };
      }
    }
    throw new Error('no dry land');
  }, [x, y]);
}

async function api(path: string, method = 'GET', body?: unknown, base = OPEN, key?: string) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  return r.json();
}

test.beforeEach(async () => {
  await api('/api/v1/scenarios/calloway-crossroads/load', 'POST');
});

test('place an entity from the palette and order it to move', async ({ page }) => {
  await ready(page, OPEN);
  await page.click('.palette-item[data-key="type:us-m1a2"]');
  const spot = await dryLand(page, 8000, 6000);
  const at = await mapPoint(page, spot.x, spot.y);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#inspector h3 input')).toHaveValue(/M1A2 Abrams/);
  const id = await page.evaluate(() => (window as unknown as Win).werforces.selectedId);
  // Right-click empty ground to the east: "Move here".
  const dest = await mapPoint(page, spot.x + 1500, spot.y);
  await page.mouse.click(dest.x, dest.y, { button: 'right' });
  await page.click('#context-menu button:has-text("Move here")');
  await expect(page.locator('[data-bind="activity"]')).toContainText('Move to');
  await page.click('#btn-step');
  await page.click('#btn-step');
  await expect.poll(async () => (await api(`/api/v1/entities/${id}`)).speed).toBeGreaterThan(0);
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});

test('undo and redo an edit, select several things and measure', async ({ page }) => {
  await ready(page, OPEN);
  const before = (await api('/api/v1/entities')).length;
  await page.click('.palette-item[data-key="type:us-m1a2"]');
  const spot = await dryLand(page, 8000, 6000);
  const at = await mapPoint(page, spot.x, spot.y);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await api('/api/v1/entities')).length).toBe(before + 1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await api('/api/v1/entities')).length).toBe(before);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await api('/api/v1/entities')).length).toBe(before + 1);
  // Shift+click two units: a group inspector.
  const units = (await api('/api/v1/units?force=blue')).slice(0, 2);
  await page.evaluate(([a, b]) => {
    const w = (window as unknown as Win).werforces;
    w.select(a);
    w.toggleSelect(b);
  }, [units[0].id, units[1].id]);
  await expect(page.locator('#inspector h3')).toHaveText('2 selected');
  // Measure: two points give a distance and a line-of-sight answer.
  await page.click('#btn-measure');
  const p1 = await mapPoint(page, spot.x, spot.y);
  const p2 = await mapPoint(page, spot.x + 1500, spot.y);
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.click(p2.x, p2.y);
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).werforces.map.mode.los)).not.toBeUndefined();
  await page.keyboard.press('Escape');
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});

test('run, then review the recording in the AAR', async ({ page }) => {
  await api('/api/v1/simulation/step', 'POST', { seconds: 240 });
  await ready(page, OPEN);
  await page.click('#btn-aar');
  await expect(page.locator('#aar-bar')).toBeVisible();
  await expect(page.locator('#scenario-name')).toContainText('(AAR)');
  await page.locator('.aar-slider').fill('120');
  await expect(page.locator('#sim-time')).toHaveText('00:02:00');
  await page.click('#aar-bar button:has-text("Report")');
  await expect(page.locator('.aar-report h3')).toContainText('After-action review');
  await expect(page.locator('.aar-chart')).toBeVisible();
  await page.locator('#modal').click({ position: { x: 5, y: 5 } });
  await page.click('#aar-bar button:has-text("Exit")');
  await expect(page.locator('#aar-bar')).toBeHidden();
  await expect(page.locator('#sim-time')).toHaveText('00:04:00');
});

test('3D view loads and shows the scene', async ({ page }) => {
  await ready(page, OPEN);
  await page.click('[data-view="3d"]');
  await expect(page.locator('#view3d canvas')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as Win).werforces.view3d?.terrainMesh);
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});

test('a player sees only their force and its contacts', async ({ page }) => {
  await api('/api/v1/scenarios/calloway-crossroads/load', 'POST', undefined, KEYED, 'e2e-control');
  await ready(page, `${KEYED}/?api_key=e2e-blue`);
  await expect(page.locator('#role-status')).toHaveText(/Blue player/);
  await expect(page.locator('#btn-run')).toBeHidden();
  await expect(page.locator('[data-tab="create"]')).toBeHidden();
  const forces = await page.evaluate(() => [...new Set((window as unknown as Win).werforces.state.entities.filter((e: any) => e.contactAge === undefined).map((e: any) => e.force))]);
  expect(forces).toEqual([1]);
  // Exercise control runs the clock; the player's view fills in with contacts.
  await api('/api/v1/simulation/step', 'POST', { seconds: 150 }, KEYED, 'e2e-control');
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).werforces.state.entities.filter((e: any) => e.contactAge !== undefined).length)).toBeGreaterThan(0);
  const truth = (await api('/api/v1/entities', 'GET', undefined, KEYED, 'e2e-control')).length;
  const seen = await page.evaluate(() => (window as unknown as Win).werforces.state.entities.length);
  expect(seen).toBeLessThan(truth);
});

test('documentation site and API reference load', async ({ page }) => {
  await page.goto(`${OPEN}/docs/`);
  await expect(page.locator('h1').first()).toBeVisible();
  await page.goto(`${OPEN}/api/docs`);
  await expect(page.locator('body')).toContainText('WeRForces');
});
