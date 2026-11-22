// Smoke test of the built single-file app: node e2e/smoke.mjs (after npm run build).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(join(here, '..', 'dist', 'index.html')).href;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
// Playwright can't drive the native save dialog, so this stands in for it and keeps what was written.
await context.addInitScript(() => {
  window.showSaveFilePicker = async (options) => {
    window.__savePicker = { suggestedName: options.suggestedName };
    return {
      name: 'picked.json',
      createWritable: async () => ({
        write: async (text) => (window.__savePicker.text = text),
        close: async () => {},
      }),
    };
  };
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}`);
    await browser.close();
    throw e;
  }
};

const tableRows = () =>
  page.$$eval('table.elements tbody tr', (rows) =>
    rows.map((tr) => {
      const inputs = [...tr.querySelectorAll('input')].map((i) => i.value);
      return [tr.querySelector('td.type')?.textContent, ...inputs, tr.querySelector('td.part')?.textContent ?? ''].join(' | ');
    }),
  );
const zInput = async (label) => {
  const index = await page.$$eval(
    'table.elements tbody tr',
    (rows, wanted) => rows.findIndex((tr) => tr.querySelector('input')?.value === wanted),
    label,
  );
  assert.ok(index >= 0, `no row labelled ${label}`);
  return page.locator('table.elements tbody tr').nth(index).locator('input').nth(1);
};
const zOf = async (label) => Number(await (await zInput(label)).inputValue());

await page.goto(pageUrl);
await page.evaluate(() => localStorage.clear());
await page.reload();
const canvas = page.locator('canvas.bench-canvas');
await canvas.waitFor();
await page.waitForTimeout(200);

await step('bench is drawn', async () => {
  const drawn = await canvas.evaluate((c) => {
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let differing = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) differing++;
    }
    return differing;
  });
  assert.ok(drawn > 1000, `only ${drawn} pixels differ from the background`);
});

await step('readouts show a focal shift', async () => {
  assert.match(await page.locator('section.readouts').innerText(), /Δfocus/);
});

// The view's mm-to-pixel mapping, read back from the hover tooltip at two points.
const box = await canvas.boundingBox();
const worldAt = async (px, py) => {
  await page.mouse.move(box.x + px, box.y + py);
  const text = await page.locator('.bench-tooltip .pos').innerText();
  const [, z, y] = text.match(/z (-?[\d.]+) mm\s+y (-?[\d.]+) mm/);
  return [Number(z), Number(y)];
};
const [z1, y1] = await worldAt(100, 100);
const [z2, y2] = await worldAt(box.width - 100, box.height - 100);
const toPx = (z, y) => [100 + ((z - z1) / (z2 - z1)) * (box.width - 200), 100 + ((y - y1) / (y2 - y1)) * (box.height - 200)];

await step('dragging the first achromat moves it, and Ctrl+Z puts it back', async () => {
  const startZ = await zOf('L3');
  const [px, py] = toPx(startZ + 2, 0);
  await page.mouse.move(box.x + px, box.y + py);
  await page.mouse.down();
  for (let dx = 10; dx <= 60; dx += 10) await page.mouse.move(box.x + px + dx, box.y + py);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const draggedZ = await zOf('L3');
  assert.ok(draggedZ > startZ, `L3 z went from ${startZ} to ${draggedZ}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  assert.equal(await zOf('L3'), startZ);
});

await step('a saved setup opens again after a reload', async () => {
  const z = await zInput('L4');
  await z.fill('150');
  await z.press('Enter');
  await page.waitForTimeout(100);
  const saved = await tableRows();
  await page.getByRole('button', { name: 'Save…' }).click();
  await page.waitForFunction(() => window.__savePicker?.text);
  const picked = await page.evaluate(() => window.__savePicker);
  assert.equal(picked.suggestedName, 'optics-setup.json');
  const file = join(mkdtempSync(join(tmpdir(), 'optics-sim-')), 'setup.json');
  writeFileSync(file, picked.text);

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await canvas.waitFor();
  assert.notDeepEqual(await tableRows(), saved, 'the reload should start from the default setup');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Open…' }).click()]);
  await chooser.setFiles(file);
  await page.waitForTimeout(200);
  assert.deepEqual(await tableRows(), saved);
});

await step('without a native save dialog, Save asks for a name and downloads', async () => {
  await page.evaluate(() => (window.showSaveFilePicker = undefined));
  await page.getByRole('button', { name: 'Save…' }).click();
  const name = page.getByRole('textbox', { name: 'File name' });
  assert.equal(await name.inputValue(), 'setup.json', 'Save should suggest the file last opened');
  await name.fill('my bench');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), 'my bench.json');
});

await step('no console errors', async () => {
  assert.deepEqual(errors, []);
});

await page.screenshot({ path: join(here, 'screenshot.png') });
await browser.close();
