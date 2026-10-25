import { expect, type Page, test } from '@playwright/test';

// The v0.6 tools: commanders, aggregate units, emission control and unmanned systems.

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

test('hand a force to the rule-based commander', async ({ page }) => {
  const errors = await ready(page);
  await page.click('#btn-commander');
  await expect(page.locator('#modal-body h3', { hasText: 'Commander' })).toBeVisible();
  await page.locator('#modal-body select').first().selectOption('rules');
  await page.click('#modal-body button:has-text("Apply")');
  await expect.poll(async () => (await api('/api/v1/forces/blue/commander')).kind).toBe('rules');
  expect(errors).toEqual([]);
});

test('aggregate a unit and split it again from the inspector', async ({ page }) => {
  const errors = await ready(page);
  await select(page, 'U1');
  await page.click('#inspector button:has-text("Aggregate")');
  await expect.poll(async () => !!(await api('/api/v1/units/U1')).aggregate).toBe(true);
  await page.click('#inspector button:has-text("Disaggregate")');
  await expect.poll(async () => !!(await api('/api/v1/units/U1')).aggregate).toBe(false);
  expect(errors).toEqual([]);
});

test('put a unit on radio silence', async ({ page }) => {
  const errors = await ready(page);
  await select(page, 'U1');
  await page.locator('#inspector label:has-text("Radio silence") input').check();
  const lead = (await api('/api/v1/units/U1')).leaderId;
  await expect.poll(async () => (await api(`/api/v1/entities/${lead}`)).emcon?.radioSilence).toBe(true);
  expect(errors).toEqual([]);
});

test('a loitering munition shows its datalink and can be sent to strike', async ({ page }) => {
  const errors = await ready(page);
  const u = await api('/api/v1/units', 'POST', { templateId: 'us-switchblade-section', force: 1, position: { x: 8000, y: 3000 } });
  const drone = u.members[0].id;
  await page.waitForFunction((id) => (window as unknown as Win).werforces.state.entities.some((e: { id: string }) => e.id === id), drone);
  await select(page, drone);
  await expect(page.locator('#inspector h4', { hasText: 'Datalink' })).toBeVisible();
  await expect(page.locator('#inspector button:has-text("Strike")')).toBeVisible();
  expect(errors).toEqual([]);
});
