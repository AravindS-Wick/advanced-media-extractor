// Playwright runs the browser specs only. The *.test.js files in tests/ are Jest unit tests
// (they use describe/test globals Playwright does not provide) and are run by `npm test`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js'
});
