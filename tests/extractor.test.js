// Unit Tests for Media Extractor PRO Utilities
const ZipBuilder = require('../lib/zip-builder.js');

describe('ZipBuilder Unit Tests', () => {
  test('creates a valid uncompressed ZIP blob', () => {
    const builder = new ZipBuilder();
    const content = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    builder.addFile('test.txt', content);
    const zipBlob = builder.build();

    expect(zipBlob).toBeDefined();
    expect(zipBlob.size).toBeGreaterThan(0);
  });

  test('handles multiple files in ZipBuilder', () => {
    const builder = new ZipBuilder();
    builder.addFile('file1.txt', new Uint8Array([65, 66]));
    builder.addFile('file2.txt', new Uint8Array([67, 68]));
    const zipBlob = builder.build();

    expect(zipBlob.size).toBeGreaterThan(100);
  });
});

describe('Filename & Resolution Helper Tests', () => {
  const BITRATE_MAP = {
    '2160p': 12000000,
    '1080p': 3500000,
    '720p': 2145000,
    '480p': 1050000,
    '360p': 600000,
  };

  function detectResolutionFromUrl(url) {
    const m = url.match(/(?:x|hd|_|-|\/)(2160|1080|720|480|360|240)(?:p|\/|\.|\?|_|-|$)/i);
    return m ? m[1] + 'p' : '';
  }

  function cleanStringForFilename(str) {
    if (!str) return '';
    return str
      .replace(/\s*-\s*(Dailymotion|YouTube|Vimeo|Twitter|Instagram|TikTok|X)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 100);
  }

  test('detects resolution from Dailymotion variant URLs', () => {
    expect(detectResolutionFromUrl('https://vod3.cf.dmcdn.net/sec/x720/manifest.m3u8')).toBe('720p');
    expect(detectResolutionFromUrl('https://s1.dmcdn.net/v/XauGd/x1080')).toBe('1080p');
    expect(detectResolutionFromUrl('https://vod3.cf.dmcdn.net/video/x480.m3u8')).toBe('480p');
  });

  test('cleans page titles for filesystem safety', () => {
    const raw = 'From Hell and Back For My Mother - Full Drama Movie English Sub - Dailymotion';
    const cleaned = cleanStringForFilename(raw);
    expect(cleaned).toBe('From_Hell_and_Back_For_My_Mother_-_Full_Drama_Movie_English_Sub');
    expect(cleaned).not.toContain('Dailymotion');
  });

  test('calculates video stream size correctly from bitrate & duration', () => {
    const bandwidth = BITRATE_MAP['720p']; // 2,145,000 bps
    const duration = 6912; // 1h 55m 12s
    const estimatedBytes = Math.round((bandwidth / 8) * duration);
    const estimatedMB = estimatedBytes / (1024 * 1024);

    expect(estimatedMB).toBeGreaterThan(1700);
    expect(estimatedMB).toBeLessThan(1900);
  });
});
