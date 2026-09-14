import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.NEURO_DJ_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.NEURO_DJ_URL || 'http://127.0.0.1:5173/');
  const inputs = page.locator('input[type=file]');
  await inputs.nth(0).setInputFiles('.cache/fixtures/pulse125.wav');
  await page.getByRole('button', { name: 'Grid A', exact: true }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Grid A', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Deck A beat grid' });
  await dialog.waitFor();
  const estimated = Number(await page.getByLabel('BPM', { exact: true }).inputValue());
  assert.ok(Math.abs(estimated - 125) < .5);
  await page.getByRole('button', { name: 'Half tempo', exact: true }).click();
  assert.ok(Math.abs(Number(await page.getByLabel('BPM', { exact: true }).inputValue()) - estimated / 2) < .01);
  await page.getByRole('button', { name: 'Double tempo', exact: true }).click();
  await page.getByLabel('BPM', { exact: true }).fill('126');
  await page.getByLabel('Beat anchor (seconds)').fill('0.35');
  await page.getByRole('button', { name: 'Audition with clicks', exact: true }).click();
  await page.getByRole('button', { name: 'Stop audition', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Apply reviewed grid', exact: true }).click();
  await page.getByText('Reviewed grid applied and saved in this browser. Playback tempo is unchanged.', { exact: true }).waitFor();
  await page.screenshot({ path: '.cache/grid-editor.png', fullPage: true });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  // Renaming identical bytes must reuse both server analysis and local correction.
  await inputs.nth(0).setInputFiles({ name: 'renamed-loop.wav', mimeType: 'audio/wav', buffer: readFileSync('.cache/fixtures/pulse125.wav') });
  await page.getByRole('button', { name: 'Grid A', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Grid A', exact: true }).click();
  await page.getByText(/Cached analysis/).waitFor();
  assert.equal(await page.getByLabel('BPM', { exact: true }).inputValue(), '126');
  assert.equal(await page.getByLabel('Beat anchor (seconds)').inputValue(), '0.35');
  await page.getByRole('button', { name: 'Close grid' }).click();
  // Hold the first analysis response, then replace its deck with a second file.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let firstRequest;
  const arrived = new Promise(resolve => { firstRequest = resolve; });
  let intercepted = false;
  await page.route('**/api/analysis', async route => {
    if (intercepted) { await route.continue(); return; }
    intercepted = true;
    const response = await route.fetch();
    firstRequest();
    await held;
    try { await route.fulfill({ response }); } catch { /* Superseded request was cancelled. */ }
  });
  await inputs.nth(1).setInputFiles('.cache/fixtures/pulse125.wav');
  await arrived;
  await inputs.nth(1).setInputFiles('.cache/fixtures/pulse90.wav');
  await page.getByRole('button', { name: 'Grid B', exact: true }).waitFor();
  release();
  await page.getByRole('button', { name: 'Grid B', exact: true }).click();
  assert.ok(Math.abs(Number(await page.getByLabel('BPM', { exact: true }).inputValue()) - 90) < .5);
  await page.getByRole('button', { name: 'Close grid' }).click();
  await page.unroute('**/api/analysis');
  // Server outages should retain playback and expose a retry, not a fake result.
  await page.route('**/api/analysis', route => route.fulfill({ status: 503, body: 'offline' }));
  await inputs.nth(1).setInputFiles('.cache/fixtures/pulse90.wav');
  await page.getByRole('button', { name: 'Retry B', exact: true }).waitFor();
  await page.getByText(/Start the local analyzer/).waitFor();
  await page.unroute('**/api/analysis');
  await page.getByRole('button', { name: 'Retry B', exact: true }).click();
  await page.getByRole('button', { name: 'Grid B', exact: true }).waitFor();
  // Returning to a preset invalidates imported metadata and restores musical assistance.
  await page.getByRole('button', { name: 'Deep / Tech House', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Grid A', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Guided Set', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const result = { estimatedBpm: estimated, checks: ['upload', 'tempo correction', 'audition', 'saved correction', 'renamed cache hit', 'stale response', 'server failure/retry', 'preset reset'], pageErrors: errors };
  writeFileSync('.cache/analysis-browser-report.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
// Module summary: This verifies the actual upload, review, cache, and failure paths in a browser.
// It intentionally delays a response to exercise track-identity guards instead of relying on lucky network ordering.
// The local analyzer and generated pulse fixtures must exist, and audible quality still needs listening beyond UI assertions.
