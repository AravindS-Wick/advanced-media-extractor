const { test, expect } = require('@playwright/test');
const path = require('path');

test.describe('Media Extractor PRO Playwright Suite', () => {
  test('extension manifests and assets are correctly formatted', async ({ page }) => {
    const manifest = require('../manifest.json');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toContain('Media Extractor');
    expect(manifest.action.default_popup).toBe('popup/popup.html');
  });

  test('popup HTML loads required UI components', async ({ page }) => {
    await page.goto(`file://${path.resolve(__dirname, '../popup/popup.html')}`);
    
    // Header & Logo
    const title = await page.locator('.logo-text').textContent();
    expect(title).toContain('Media Extractor');

    // Tabs
    await expect(page.locator('[data-tab="tab-extractor"]')).toBeVisible();
    await expect(page.locator('[data-tab="tab-adblock"]')).toBeVisible();

    // Controls
    await expect(page.locator('#searchInput')).toBeVisible();
    await expect(page.locator('#formatFilter')).toBeVisible();
    await expect(page.locator('#bulkDownloadBtn')).toBeVisible();
  });
});
