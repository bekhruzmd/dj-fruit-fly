import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.NEURO_DJ_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.NEURO_DJ_URL || 'http://127.0.0.1:5173/');
  await page.getByText('Learn from a demonstration', { exact: true }).click();
  await page.getByRole('button', { name: 'Hide Connectome HUD', exact: true }).click();
  const panel = page.locator('.demo-panel');
  await panel.getByRole('button', { name: 'Record teacher take', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: 'Take discarded' }).waitFor();
  await page.getByRole('button', { name: 'ACTIVE (ADAPTING)', exact: true }).click();
  await page.getByTitle('Start / Pause Real Audio Remix').click();
  await page.waitForTimeout(3000);
  for (let take = 0; take < 2; take++) {
    await panel.getByRole('button', { name: 'Record teacher take', exact: true }).click();
    await panel.getByRole('button', { name: /^Finish take \(34s\)$/ }).waitFor({ timeout: 45000 });
    await panel.getByRole('button', { name: /^Finish take/ }).click();
    await panel.getByText(`${take + 1}/2 takes in memory`, { exact: false }).waitFor();
    console.log(`Captured real preset demonstration ${take + 1}`);
  }
  await page.getByTitle('Start / Pause Real Audio Remix').click();
  await panel.getByRole('button', { name: 'Train candidate', exact: true }).click();
  await panel.getByRole('table').waitFor({ timeout: 15000 });
  const status = await panel.getByRole('status').innerText();
  const scores = await panel.getByRole('table').innerText();
  const apply = panel.getByRole('button', { name: 'Apply candidate & freeze' });
  if (status.includes('did not pass')) assert.equal(await apply.isDisabled(), true);
  else {
    await apply.click();
    await panel.getByRole('status').filter({ hasText: 'Candidate applied' }).waitFor();
    await page.getByRole('button', { name: 'FROZEN (TEST)', exact: true }).waitFor();
  }
  assert.deepEqual(errors, []);
  writeFileSync('.cache/demonstration-browser-report.json', JSON.stringify({ status, scores, errors }, null, 2));
  await page.screenshot({ path: '.cache/demonstration-panel.png' });
  console.log(JSON.stringify({ status, scores, errors }));
} catch (error) {
  if (page) {
    console.error(await page.locator('.demo-panel').innerText());
    await page.screenshot({ path: '.cache/demonstration-failure.png' });
  }
  throw error;
} finally { await browser.close(); }
// Module summary: This records actual preset playback twice and exercises the isolated trainer UI.
// A failed imitation gate is an acceptable experimental result, while missing takes or browser errors fail the test.
// Headless audio does not assess perceived sound quality and an overloaded renderer may invalidate a take.
