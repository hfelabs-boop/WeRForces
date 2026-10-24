import { expect, type Page, test } from '@playwright/test';

// The v0.5 tools: quick battle, order line, Why?, alerts, quick-task bar, viewshed,
// drive mode, catalog editor and one-step group undo.

const OPEN = 'http://127.0.0.1:8130';

type Win = Window & { werforces: any };

async function ready(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(OPEN);
  await page.waitForFunction(() => (window as unknown as Win).werforces?.state?.entities?.length > 0 && (window as unknown as Win).werforces?.grid);
  return errors;
}

async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${OPEN}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  return r.json();
}

const select = (page: Page, id: string) => page.evaluate((x) => (window as unknown as Win).werforces.select(x), id);

test.beforeEach(async () => {
  await api('/api/v1/scenarios/calloway-crossroads/load', 'POST');
});

test('build a quick battle, read the brief and look at the phases', async ({ page }) => {
  const errors = await ready(page);
  await page.click('#btn-file');
  await page.click('text=Quick battle…');
  await page.click('[data-mission=defend]');
  await page.locator('.qb-red select').nth(2).selectOption('company');
  await page.locator('.quick-battle input[type=number]').fill('42');
  await page.click('.quick-battle button:has-text("Build battle")');
  await expect(page.locator('.quick-battle-brief h3')).toContainText('Defence at');
  await expect(page.locator('.quick-battle-brief p')).toContainText('Seed 42');
  await expect(page.locator('#scenario-name')).toContainText('Defence at');
  await page.click('.quick-battle-brief button:has-text("Show phases")');
  await expect(page.locator('.sync-name').first()).toBeVisible();
  const matrices = await api('/api/v1/sync-matrix');
  expect(matrices.map((m: { force: number }) => m.force).sort()).toEqual([1, 2]);
  expect(errors).toEqual([]);
});

test('type an order, and take back a group order in one undo', async ({ page }) => {
  const errors = await ready(page);
  await page.keyboard.press('/');
  await expect(page.locator('.order-input')).toBeFocused();
  await page.keyboard.type('Team ARMOR move to Calloway');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await api('/api/v1/units/U1')).task).toMatch(/Move/);
  // Two units ordered together: one edit.
  await page.evaluate(() => {
    const w = (window as unknown as Win).werforces;
    w.select('U1');
    w.toggleSelect('U2');
  });
  await page.click('#inspector button:has-text("Stop all")');
  await expect.poll(async () => (await api('/api/v1/units/U1')).task ?? 'none').not.toMatch(/Move/);
  // One undo takes back both stops (U1 was stopped first): it is moving again.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await api('/api/v1/units/U1')).task).toMatch(/Move/);
  expect(errors).toEqual([]);
});

test('Why?, alerts, quick-task bar and viewshed', async ({ page }) => {
  const errors = await ready(page);
  await select(page, 'U1');
  await expect(page.locator('#inspector .why h4')).toContainText('Why?');
  await expect(page.locator('#inspector .why-summary')).not.toHaveText('…');
  // The quick-task bar shows for an orderable selection; "Stop" is one key.
  await expect(page.locator('#quickbar')).toBeVisible();
  await expect(page.locator('#quickbar button.quick').first()).toBeVisible();
  // Alerts: run a little so something needs attention, then open the menu.
  await api('/api/v1/simulation/step', 'POST', { seconds: 60 });
  await page.click('#btn-alerts');
  await expect(page.locator('#alerts-menu')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  // Viewshed from the inspector.
  const tank = (await api('/api/v1/units/U1')).leaderId;
  await select(page, tank);
  await page.click('#inspector button:has-text("Viewshed")');
  await expect(page.locator('#viewshed-chip')).toContainText('of the ground within');
  await page.click('#viewshed-chip button');
  await expect(page.locator('#viewshed-chip')).toBeHidden();
  expect(errors).toEqual([]);
});

test('drive an entity by hand', async ({ page }) => {
  const errors = await ready(page);
  const tank = (await api('/api/v1/units/U1')).leaderId;
  await select(page, tank);
  await page.locator('#map canvas').first().hover();
  await page.keyboard.press('g');
  await expect(page.locator('#drive-hud')).toBeVisible();
  await expect(page.locator('#drive-hud .drive-title')).toContainText('Driving');
  await page.keyboard.press('w');
  await page.keyboard.press('w');
  await api('/api/v1/simulation/step', 'POST', { seconds: 5 });
  await expect.poll(async () => (await api(`/api/v1/entities/${tank}`)).speed).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drive-hud')).toBeHidden();
  expect(errors).toEqual([]);
});

test('make a vehicle variant in the catalog editor', async ({ page }) => {
  const errors = await ready(page);
  await page.click('#btn-file');
  await page.click('text=Catalog editor…');
  await page.fill('.catalog-editor input[placeholder="Filter…"]', 'm1a2');
  await page.click('.catalog-item >> nth=0');
  await page.click('text=Copy as new');
  const name = page.locator('.catalog-grid input[type=text]').first();
  await name.fill('M1A2 e2e variant');
  await name.dispatchEvent('change');
  await page.click('.catalog-editor button.primary');
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).werforces.catalog.entityTypes.some((t: { name: string }) => t.name === 'M1A2 e2e variant'))).toBe(true);
  expect(errors).toEqual([]);
});
