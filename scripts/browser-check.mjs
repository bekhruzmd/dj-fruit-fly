import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.NEURO_DJ_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.NEURO_DJ_URL || 'http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'Guided Set', exact: true }).waitFor();
  await page.getByRole('button', { name: '○ Record WAV', exact: true }).click();
  await page.getByRole('button', { name: '● Stop capture', exact: true }).waitFor();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: '● Stop capture', exact: true }).click();
  const download = page.getByRole('link', { name: 'Download WAV' });
  await download.waitFor();
  const capture = await download.evaluate(async element => {
    const data = await (await fetch(element.href)).arrayBuffer();
    const view = new DataView(data);
    let peak = 0, power = 0;
    for (let i = 44; i < data.byteLength; i += 2) {
      const sample = view.getInt16(i, true) / 32768;
      peak = Math.max(peak, Math.abs(sample)); power += sample * sample;
    }
    return { bytes: data.byteLength, peak, rms: Math.sqrt(power / ((data.byteLength - 44) / 2)), sampleRate: view.getUint32(24, true) };
  });
  assert.ok(capture.rms > 0.01 && capture.peak < 1);
  await page.getByRole('button', { name: 'Show Learning', exact: true }).click();
  await page.getByRole('button', { name: 'Practice 5', exact: true }).click();
  await page.getByText(/Live practice: 5 passes left/).waitFor();
  await page.getByRole('button', { name: 'Hide Learning', exact: true }).click();
  // A standalone page avoids React/WebGL competing with offline rendering.
  const evaluationPage = await browser.newPage();
  await evaluationPage.goto(new URL('/test-audio.html', page.url()).href);
  const audioEvaluation = await evaluationPage.evaluate(async () => (await import('/test_audio_browser.ts')).evaluateLearning());
  assert.deepEqual(errors, []);
  const report = { capture, audioEvaluation, pageErrors: errors };
  writeFileSync('docs/audio-evaluation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
