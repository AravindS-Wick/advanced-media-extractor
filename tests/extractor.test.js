// Unit Tests for Media Extractor PRO Utilities & HLS Downloader Engine
const ZipBuilder = require('../lib/zip-builder.js');
const { HlsDownloader, parseMasterPlaylist, parseMediaPlaylist, parseSubtitleRenditions, inspectHlsStream, resolveUrl } = require('../lib/hls-downloader.js');

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

describe('HlsDownloader & Playlist Parsing Unit Tests', () => {
  const sampleMasterM3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=836280,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=408x720,NAME="720"
https://vod.dmcdn.net/video/720/manifest.m3u8#cell=cf3
#EXT-X-STREAM-INF:BANDWIDTH=460560,CODECS="mp4a.40.2,avc1.42001e",RESOLUTION=360x480,NAME="480"
https://vod.dmcdn.net/video/480/manifest.m3u8#cell=cf3
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",NAME="audio"
https://vod.dmcdn.net/video/audio/manifest.m3u8`;

  const sampleMediaM3u8fMP4 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:3.000000,
0.m4s
#EXTINF:3.000000,
1.m4s
#EXTINF:4.500000,
2.m4s`;

  const sampleMediaM3u8Ts = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.000000,
segment0.ts
#EXTINF:4.000000,
segment1.ts`;

  test('parses HLS master playlist into sorted variant cards', () => {
    const variants = parseMasterPlaylist(sampleMasterM3u8, 'https://vod.dmcdn.net/master.m3u8');
    expect(variants.length).toBe(3);
    expect(variants[0].label).toBe('720p');
    expect(variants[0].bandwidth).toBe(836280);
    expect(variants[0].url).toBe('https://vod.dmcdn.net/video/720/manifest.m3u8#cell=cf3');
    expect(variants[1].label).toBe('480p');
    expect(variants[2].isAudioOnly).toBe(true);
  });

  test('parses fMP4 media playlist with exact EXTINF duration calculation', () => {
    const parsed = parseMediaPlaylist(sampleMediaM3u8fMP4, 'https://vod.dmcdn.net/video/720/manifest.m3u8');
    expect(parsed.isFmp4).toBe(true);
    expect(parsed.mapUri).toBe('https://vod.dmcdn.net/video/720/init.mp4');
    expect(parsed.segments.length).toBe(3);
    expect(parsed.totalDuration).toBe(11); // 3.0 + 3.0 + 4.5 = 10.5 rounded to 11
    expect(parsed.segments[0].url).toBe('https://vod.dmcdn.net/video/720/0.m4s');
    expect(parsed.segments[1].url).toBe('https://vod.dmcdn.net/video/720/1.m4s');
    expect(parsed.segments[2].url).toBe('https://vod.dmcdn.net/video/720/2.m4s');
  });

  const sampleMasterWithSubs = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="subs/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Spanish",LANGUAGE="es",URI="subs/es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=836280,RESOLUTION=408x720,SUBTITLES="subs"
video/720/manifest.m3u8`;

  test('parses subtitle/CC renditions declared via EXT-X-MEDIA:TYPE=SUBTITLES', () => {
    const subs = parseSubtitleRenditions(sampleMasterWithSubs, 'https://vod.dmcdn.net/master.m3u8');
    expect(subs.length).toBe(2);
    expect(subs[0].label).toBe('English');
    expect(subs[0].lang).toBe('en');
    expect(subs[0].url).toBe('https://vod.dmcdn.net/subs/en.m3u8');
    expect(subs[1].label).toBe('Spanish');
  });

  test('ignores playlists with no subtitle renditions', () => {
    const subs = parseSubtitleRenditions(sampleMasterM3u8, 'https://vod.dmcdn.net/master.m3u8');
    expect(subs).toEqual([]);
  });

  test('parses standard MPEG-TS media playlist', () => {
    const parsed = parseMediaPlaylist(sampleMediaM3u8Ts, 'https://vod.dmcdn.net/video/manifest.m3u8');
    expect(parsed.isFmp4).toBe(false);
    expect(parsed.mapUri).toBeNull();
    expect(parsed.segments.length).toBe(2);
    expect(parsed.totalDuration).toBe(8);
    expect(parsed.segments[0].url).toBe('https://vod.dmcdn.net/video/segment0.ts');
  });

  test('initializes HlsDownloader instance with default options', () => {
    const downloader = new HlsDownloader({ concurrency: 8, maxRetries: 4 });
    expect(downloader.concurrency).toBe(8);
    expect(downloader.maxRetries).toBe(4);
    expect(downloader.retryDelayMs).toBe(1000);
  });
});

describe('Per-Domain Ad Blocker Unit Tests', () => {
  function normalizeDomain(urlOrHost) {
    if (!urlOrHost) return '';
    try {
      let host = urlOrHost;
      if (urlOrHost.includes('://')) {
        host = new URL(urlOrHost).hostname;
      }
      return host.toLowerCase().replace(/^www\./, '').split(':')[0].trim();
    } catch (_) {
      return urlOrHost.toLowerCase().replace(/^www\./, '').split(':')[0].trim();
    }
  }

  function isDomainInList(domain, list) {
    const norm = normalizeDomain(domain);
    if (!norm || !Array.isArray(list)) return false;
    return list.some(item => {
      const normItem = normalizeDomain(item);
      return norm === normItem || norm.endsWith('.' + normItem);
    });
  }

  function domainToRuleId(domain) {
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
    }
    return 100000 + (hash % 800000);
  }

  test('normalizes URLs and hostnames to clean base domains', () => {
    expect(normalizeDomain('https://www.dailymotion.com/video/xaugdoy')).toBe('dailymotion.com');
    expect(normalizeDomain('http://sub.domain.com:8080/path')).toBe('sub.domain.com');
    expect(normalizeDomain('WWW.YOUTUBE.COM')).toBe('youtube.com');
    expect(normalizeDomain('dailymotion.com')).toBe('dailymotion.com');
  });

  test('checks domain match against disabled list with subdomain support', () => {
    const list = ['dailymotion.com', 'news.ycombinator.com'];
    expect(isDomainInList('https://www.dailymotion.com/video/123', list)).toBe(true);
    expect(isDomainInList('touch.dailymotion.com', list)).toBe(true);
    expect(isDomainInList('youtube.com', list)).toBe(false);
    expect(isDomainInList('news.ycombinator.com', list)).toBe(true);
  });

  test('generates deterministic dynamic rule IDs within valid DNR bounds', () => {
    const id1 = domainToRuleId('dailymotion.com');
    const id2 = domainToRuleId('dailymotion.com');
    const id3 = domainToRuleId('youtube.com');

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toBeGreaterThanOrEqual(100000);
    expect(id1).toBeLessThan(900000);
  });
});

describe('Video Player & Downloads Manager Formatting Tests', () => {
  function formatPlayerTime(seconds) {
    if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '00:00';
    seconds = Math.floor(seconds);
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatTimeAgo(ts, now = Date.now()) {
    if (!ts) return '';
    const diff = Math.floor((now - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  test('formats player time in mm:ss and hh:mm:ss', () => {
    expect(formatPlayerTime(0)).toBe('00:00');
    expect(formatPlayerTime(45)).toBe('00:45');
    expect(formatPlayerTime(125)).toBe('02:05');
    expect(formatPlayerTime(3665)).toBe('1:01:05');
    expect(formatPlayerTime(NaN)).toBe('00:00');
    expect(formatPlayerTime(-10)).toBe('00:00');
  });

  test('formats download timestamps into human-readable relative strings', () => {
    const now = 1000000000000;
    expect(formatTimeAgo(now - 10000, now)).toBe('Just now');
    expect(formatTimeAgo(now - 180000, now)).toBe('3m ago');
    expect(formatTimeAgo(now - 7200000, now)).toBe('2h ago');
    expect(formatTimeAgo(now - 172800000, now)).toBe('2d ago');
  });
});

describe('Instagram Extraction & Universal Preview Tests', () => {
  function normalizeSniffedUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (/(\.cdninstagram\.com|\.fbcdn\.net)/i.test(url)) {
      try {
        const u = new URL(url);
        if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          return u.toString();
        }
      } catch (_) {
        return url.replace(/([?&])bytestart=\d+(&|$)/gi, '$1')
                  .replace(/([?&])byteend=\d+(&|$)/gi, '$1')
                  .replace(/[?&]$/, '');
      }
    }
    return url;
  }

  function getFilenameForDownload(title, type, url) {
    let ext = '';
    try {
      const clean = (url || '').split('?')[0].split('#')[0];
      const m = clean.match(/\.([a-z0-9]{2,5})$/i);
      if (m) ext = m[1].toLowerCase();
    } catch (_) {}
    if (!ext) {
      if (type === 'IMAGE') ext = 'jpg';
      else if (type === 'DOC') ext = 'pdf';
      else if (type === 'AUDIO') ext = 'mp3';
      else ext = 'mp4';
    }
    const cleanTitle = (title || 'media').replace(/[\\/:*?"<>|]/g, '_');
    if (cleanTitle.toLowerCase().endsWith('.' + ext)) return cleanTitle;
    return `${cleanTitle}.${ext}`;
  }

  test('normalizes Instagram CDN chunk URLs by stripping bytestart and byteend', () => {
    const chunkUrl = 'https://scontent-iad3-1.cdninstagram.com/o1/v/t16/f1/m86/video.mp4?_nc_ht=scontent&bytestart=2447958&byteend=4985105&efg=123';
    const normalized = normalizeSniffedUrl(chunkUrl);
    expect(normalized).toBe('https://scontent-iad3-1.cdninstagram.com/o1/v/t16/f1/m86/video.mp4?_nc_ht=scontent&efg=123');
    expect(normalized).not.toContain('bytestart');
    expect(normalized).not.toContain('byteend');
  });

  test('preserves non-Instagram URLs without modification', () => {
    const genericUrl = 'https://example.com/video.mp4?bytestart=100';
    expect(normalizeSniffedUrl(genericUrl)).toBe(genericUrl);
  });

  test('generates correct filenames for video, audio, image, and doc in universal preview player', () => {
    expect(getFilenameForDownload('My Video', 'VIDEO', 'https://example.com/stream.mp4')).toBe('My Video.mp4');
    expect(getFilenameForDownload('My Song', 'AUDIO', 'https://example.com/track.mp3')).toBe('My Song.mp3');
    expect(getFilenameForDownload('Instagram Photo', 'IMAGE', 'https://cdninstagram.com/p123.jpg?_nc=1')).toBe('Instagram Photo.jpg');
    expect(getFilenameForDownload('Financial Report', 'DOC', 'https://example.com/report.pdf')).toBe('Financial Report.pdf');
    expect(getFilenameForDownload('Document Without Ext', 'DOC', 'https://example.com/download')).toBe('Document Without Ext.pdf');
    expect(getFilenameForDownload('AlreadyHasExt.png', 'IMAGE', 'https://example.com/img.png')).toBe('AlreadyHasExt.png');
  });

  test('strips browser notification badges from tab titles and extracts reel codes', () => {
    function cleanStringForFilename(str) {
      if (!str) return '';
      return str
        .replace(/^\s*\(\d+\)\s*•?\s*/i, '')
        .replace(/\s*-\s*(Dailymotion|YouTube|Vimeo|Twitter|Instagram|TikTok|X)$/i, '')
        .replace(/\s*•\s*(Instagram|Facebook)$/i, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 100);
    }

    expect(cleanStringForFilename('(1) Instagram')).toBe('Instagram');
    expect(cleanStringForFilename('(5) • Concert Video - Instagram')).toBe('Concert_Video');
    expect(cleanStringForFilename('(14) The Moment a Concert Hall Turned Into a Street Race')).toBe('The_Moment_a_Concert_Hall_Turned_Into_a_Street_Race');

    const reelUrl = 'https://www.instagram.com/reels/DcqwAeQoB06/';
    const match = reelUrl.match(/\/(?:reels?|p)\/([A-Za-z0-9_-]+)/);
    expect(match[1]).toBe('DcqwAeQoB06');
  });

  test('filters silent video-only streams from Videos category so all videos have audio', () => {
    function catOf(it) {
      if (it.type) {
        if (it.type === 'image') return 'image';
        if (it.type === 'audio' || it.isAudio) return 'audio';
        if (it.type === 'doc') return 'doc';
        return 'video';
      }
      if (it.isAudio) return 'audio';
      if (it.isVideo) return 'video';
      return 'doc';
    }

    const testStreams = [
      { url: 'https://googlevideo.com/720p', type: 'video', isVideo: true, isMuxed: true, quality: '720p' }, // Muxed 720p with audio
      { url: 'https://googlevideo.com/1080p', type: 'video', isVideo: true, isMuxed: false, quality: '1080p' }, // Adaptive 1080p without audio
      { url: 'https://googlevideo.com/audio1', type: 'audio', isVideo: false, isAudio: true, quality: '160kbps' }, // Audio track
      { url: 'https://cdninstagram.com/reel.mp4', type: 'video', isVideo: true, isMuxed: true, quality: 'Reel' }, // Instagram Reel with audio
      { url: 'https://example.com/photo.jpg', type: 'image', isVideo: false, isAudio: false }, // Image
    ];

    // Under 'video' category: only items with isMuxed !== false
    const videoCategoryItems = testStreams.filter(it => catOf(it) === 'video' && it.isMuxed !== false);
    expect(videoCategoryItems.length).toBe(2);
    expect(videoCategoryItems.map(x => x.quality)).toEqual(['720p', 'Reel']);
    expect(videoCategoryItems.some(x => x.isMuxed === false)).toBe(false);

    // Under 'audio' category: audio tracks
    const audioCategoryItems = testStreams.filter(it => catOf(it) === 'audio' || it.isAudio);
    expect(audioCategoryItems.length).toBe(1);
    expect(audioCategoryItems[0].quality).toBe('160kbps');
  });

  test('correctly classifies Instagram audio.mp4 streams as audio and assigns .mp3 extension', () => {
    function catOf(it) {
      if (it.isAudio || it.type === 'audio' || (it.mimeType && it.mimeType.startsWith('audio/'))) return 'audio';
      if (it.type === 'image' || it.isImage) return 'image';
      if (it.type === 'doc' || it.isDoc) return 'doc';
      const s = it.size || it.estimatedBytes || 0;
      if (s > 0 && s < 1200000 && /audio/i.test(it.url)) return 'audio';
      if (it.isVideo || it.type === 'video') return 'video';
      return 'doc';
    }

    const instaAudioStream = {
      url: 'https://instagram.fna.fbcdn.net/o1/v/t2/f2/m86/audio_dashinit.mp4?efg=123',
      type: 'audio',
      mimeType: 'audio/mp4',
      size: 349184,
      isAudio: true,
      isVideo: false
    };

    expect(catOf(instaAudioStream)).toBe('audio');

    function getItemFileName(it, pageUrl = '') {
      const isAudio = it.type === 'audio' || it.isAudio || /(\.mp3|\.m4a)/i.test(it.url);
      let ext = 'mp4';
      if (isAudio) ext = 'mp3';

      const reelMatch = pageUrl.match(/\/(?:reels?|p)\/([A-Za-z0-9_-]+)/);
      if (reelMatch) {
        return isAudio ? `Instagram_Reel_${reelMatch[1]}_Audio.${ext}` : `Instagram_Reel_${reelMatch[1]}.${ext}`;
      }
      return `media.${ext}`;
    }

    const filename = getItemFileName(instaAudioStream, 'https://www.instagram.com/reels/Da9uY7Lx1ev/?next=%2F');
    expect(filename).toBe('Instagram_Reel_Da9uY7Lx1ev_Audio.mp3');
  });
});



