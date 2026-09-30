/**
 * lib/download-db.js
 * Internal IndexedDB storage engine for Media Extractor PRO.
 * Persists complete download history across all browser tabs for 1000+ days.
 * Works seamlessly in both Service Worker (background) and Window (popup/grabber) contexts.
 */

(function (global) {
  'use strict';

  const DB_NAME = 'MediaExtractorDB';
  const DB_VERSION = 2;
  const STORE_NAME = 'downloads';
  const KV_STORE_NAME = 'kv';

  let dbInstance = null;

  function getLocalIsoDate(timestamp) {
    const d = timestamp ? new Date(timestamp) : new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function openDatabase() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
      const idb = global.indexedDB || (typeof self !== 'undefined' ? self.indexedDB : null);
      if (!idb) {
        return reject(new Error('IndexedDB is not supported in this environment'));
      }

      const request = idb.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('downloadId', 'downloadId', { unique: false });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('completedAt', 'completedAt', { unique: false });
          store.createIndex('startTime', 'startTime', { unique: false });
          store.createIndex('state', 'state', { unique: false });
          store.createIndex('filename', 'filename', { unique: false });
          store.createIndex('domain', 'domain', { unique: false });
        }
        // Small key-value store reserved for settings that can't be
        // JSON-serialized into chrome.storage.local (IndexedDB structured-
        // clones values instead). Currently unused, kept for future settings.
        if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
          db.createObjectStore(KV_STORE_NAME);
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        dbInstance.onclose = () => {
          dbInstance = null;
        };
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        reject(event.target.error || new Error('Failed to open IndexedDB'));
      };
    });
  }

  const DownloadDB = {
    getLocalIsoDate,

    /**
     * Initializes the database connection
     */
    async init() {
      return openDatabase();
    },

    /**
     * Inserts or updates a download record
     * @param {Object} item
     */
    async saveDownload(item) {
      const db = await openDatabase();
      const timestamp = item.completedAt || item.startTime || Date.now();
      const dateStr = item.date || getLocalIsoDate(timestamp);
      const id = item.id || (item.downloadId ? `dl_${item.downloadId}` : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

      let domain = item.domain || '';
      if (!domain && item.url) {
        try {
          domain = new URL(item.url).hostname;
        } catch (_) {}
      }

      const record = {
        id,
        downloadId: item.downloadId || null,
        filename: item.filename || 'media_file',
        savePath: item.savePath || item.filename || '',
        url: item.url || '',
        finalUrl: item.finalUrl || item.url || '',
        referrer: item.referrer || '',
        domain,
        pageTitle: item.pageTitle || '',
        mime: item.mime || '',
        type: item.type || 'file',
        totalBytes: Number(item.totalBytes || item.fileSize || 0),
        startTime: item.startTime || timestamp,
        completedAt: item.completedAt || timestamp,
        date: dateStr,
        state: item.state || 'complete',
        error: item.error || null,
        updatedAt: Date.now()
      };

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(record);

        req.onsuccess = () => resolve(record);
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Get a download record by its unique ID
     */
    async getDownload(id) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Get a download record by Chrome's numeric downloadId
     */
    async getDownloadByChromeId(downloadId) {
      if (!downloadId) return null;
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('downloadId');
        const req = index.get(downloadId);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Query downloads with date filters, search, and pagination
     * @param {Object} opts
     * @param {'today'|'yesterday'|'7days'|'30days'|'all'|'custom'} [opts.filter='today']
     * @param {string} [opts.date] Custom date string (YYYY-MM-DD)
     * @param {string} [opts.query] Search string for filename/url/domain
     * @param {number} [opts.limit=200] Max items to return
     * @param {number} [opts.offset=0] Offset for pagination
     */
    async queryDownloads(opts = {}) {
      const db = await openDatabase();
      const filter = opts.filter || 'today';
      const customDate = opts.date || '';
      const query = (opts.query || '').trim().toLowerCase();
      const limit = opts.limit || 200;
      const offset = opts.offset || 0;

      const now = new Date();
      const todayStr = getLocalIsoDate(now.getTime());

      const yesterday = new Date(now.getTime() - 86400000);
      const yesterdayStr = getLocalIsoDate(yesterday.getTime());

      let minTime = 0;
      let targetDateStr = null;

      if (filter === 'today') {
        targetDateStr = todayStr;
      } else if (filter === 'yesterday') {
        targetDateStr = yesterdayStr;
      } else if (filter === '7days') {
        minTime = now.getTime() - (7 * 86400000);
      } else if (filter === '30days') {
        minTime = now.getTime() - (30 * 86400000);
      } else if (filter === 'custom' && customDate) {
        targetDateStr = customDate;
      }

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const results = [];
        let totalBytes = 0;
        let totalCount = 0;
        let successCount = 0;
        let errorCount = 0;

        // Open cursor descending on completedAt index if available, else open regular cursor
        const index = store.index('completedAt');
        const req = index.openCursor(null, 'prev');

        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const item = cursor.value;

            // Date filtering
            let dateMatch = true;
            if (targetDateStr) {
              dateMatch = (item.date === targetDateStr);
            } else if (minTime > 0) {
              dateMatch = ((item.completedAt || item.startTime || 0) >= minTime);
            }

            if (dateMatch) {
              // Keyword query filtering
              let queryMatch = true;
              if (query) {
                const name = (item.filename || '').toLowerCase();
                const savePath = (item.savePath || '').toLowerCase();
                const url = (item.url || '').toLowerCase();
                const domain = (item.domain || '').toLowerCase();
                const title = (item.pageTitle || '').toLowerCase();
                queryMatch = name.includes(query) || savePath.includes(query) || url.includes(query) || domain.includes(query) || title.includes(query);
              }

              if (queryMatch) {
                totalCount++;
                totalBytes += (item.totalBytes || 0);
                if (item.state === 'complete' && !item.error) {
                  successCount++;
                } else {
                  errorCount++;
                }

                if (results.length < limit && totalCount > offset) {
                  results.push(item);
                }
              }
            }

            cursor.continue();
          } else {
            resolve({
              items: results,
              stats: {
                totalCount,
                totalBytes,
                successCount,
                errorCount,
                filter,
                targetDate: targetDateStr
              }
            });
          }
        };

        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Erases a single download from the database
     */
    async eraseDownload(id, downloadId) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        if (id) {
          store.delete(id);
        }

        if (downloadId) {
          const index = store.index('downloadId');
          const req = index.getKey(downloadId);
          req.onsuccess = () => {
            if (req.result) {
              store.delete(req.result);
            }
          };
        }

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    },

    /**
     * Clears all download history from IndexedDB
     */
    async clearAll() {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();

        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Export all records as a JSON array (Ready for future Cloud DB sync)
     */
    async exportAllForCloud() {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Batch import records from cloud DB or backup
     */
    async batchImport(records = []) {
      if (!Array.isArray(records) || !records.length) return 0;
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let count = 0;

        for (const item of records) {
          if (item && item.id) {
            store.put(item);
            count++;
          }
        }

        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
      });
    }
  };

  // Export to global scope
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DownloadDB;
  } else {
    global.DownloadDB = DownloadDB;
  }
})(typeof self !== 'undefined' ? self : this);
