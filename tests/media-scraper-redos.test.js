// Unit proof for review finding on #42: the media-URL regex must not backtrack
// catastrophically. We extract the real `relUrlRegex` literal from the source
// so the test fails if the vulnerable form is reintroduced.
const fs = require('fs');
const path = require('path');

function extractRelUrlRegex(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const m = src.match(/const relUrlRegex = (\/.*\/gi);/);
  if (!m) throw new Error('relUrlRegex literal not found in ' + file);
  const lit = m[1];
  const lastSlash = lit.lastIndexOf('/');
  return () => new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));
}

for (const file of ['content/media-scraper.js', 'service-worker.js']) {
  describe(`relUrlRegex in ${file}`, () => {
    const make = extractRelUrlRegex(file);

    test('matches a media URL including an & in the query string', () => {
      const re = make();
      const m = re.exec('<a href="videos/clip.mp4?a=1&b=2&c=3">');
      expect(m && m[1]).toBe('videos/clip.mp4?a=1&b=2&c=3');
    });

    test('matches a plain path with no query', () => {
      const re = make();
      const m = re.exec('"audio/track.m4a"');
      expect(m && m[1]).toBe('audio/track.m4a');
    });

    test('a crafted unterminated attribute does NOT cause catastrophic backtracking', () => {
      // Opening quote + plausible filename + a long run of `?` and NO closing
      // quote. The old `(?:\?...)*` form was exponential in the number of `?`.
      const evil = '"' + 'a.mp4' + '?'.repeat(60);
      const t0 = Date.now();
      make().exec(evil); // single attempt; global lastIndex starts at 0 on a fresh regex
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(100);
    });
  });
}
