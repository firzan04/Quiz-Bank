/*
 * Persistence for Quiz Bank.
 *
 * IndexedDB keeps imported workbooks (one record per sheet grid), saved
 * session artifacts and the live session snapshot. localStorage keeps small
 * preferences. If IndexedDB is unavailable the app keeps working in memory
 * and reports that data will not survive a restart.
 */
(function (g) {
  'use strict';

  var QB = (g.QB = g.QB || {});
  var DB_NAME = 'quizbank';
  var DB_VERSION = 1;
  var dbPromise = null;
  var memory = null; // in-memory fallback

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!g.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req;
      try { req = g.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('workbooks')) db.createObjectStore('workbooks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sheets')) {
          var s = db.createObjectStore('sheets', { keyPath: 'key' });
          s.createIndex('workbookId', 'workbookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* ignore */ } };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { reject(new Error('IndexedDB is blocked by another tab')); };
    }).catch(function (e) {
      memory = { workbooks: {}, sheets: {}, sessions: {}, kv: {} };
      QB.store.persistent = false;
      QB.store.failure = String(e && e.message || e);
      return null;
    });
    return dbPromise;
  }

  function tx(db, stores, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t;
      try { t = db.transaction(stores, mode); } catch (e) { reject(e); return; }
      var result;
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error || new Error('Storage transaction failed')); };
      t.onabort = function () { reject(t.error || new Error('Storage transaction aborted (the device may be out of space)')); };
      try {
        fn(t, function (value) { result = value; });
      } catch (e2) {
        try { t.abort(); } catch (x) { /* ignore */ }
        reject(e2);
      }
    });
  }

  function reqValue(request, setResult) {
    request.onsuccess = function () { setResult(request.result); };
  }

  function sheetKey(workbookId, name) { return workbookId + '\u0001' + name; }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  var store = {
    persistent: true,
    failure: null,

    init: function () { return openDb(); },

    listWorkbooks: function () {
      return openDb().then(function (db) {
        if (!db) return Object.keys(memory.workbooks).map(function (k) { return clone(memory.workbooks[k]); });
        return tx(db, ['workbooks'], 'readonly', function (t, set) { reqValue(t.objectStore('workbooks').getAll(), set); });
      }).then(function (list) {
        return (list || []).sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0); });
      });
    },

    /** Insert or replace a workbook and all of its sheet grids atomically. */
    putWorkbook: function (meta, grids, replaceIds) {
      replaceIds = replaceIds || [];
      return openDb().then(function (db) {
        if (!db) {
          replaceIds.forEach(function (id) { store._memDeleteWorkbook(id); });
          memory.workbooks[meta.id] = clone(meta);
          Object.keys(grids).forEach(function (name) {
            memory.sheets[sheetKey(meta.id, name)] = { key: sheetKey(meta.id, name), workbookId: meta.id, name: name, grid: grids[name] };
          });
          return meta;
        }
        return Promise.all(replaceIds.map(function (id) { return store.deleteWorkbook(id); })).then(function () {
          return tx(db, ['workbooks', 'sheets'], 'readwrite', function (t, set) {
            t.objectStore('workbooks').put(meta);
            var sheets = t.objectStore('sheets');
            Object.keys(grids).forEach(function (name) {
              sheets.put({ key: sheetKey(meta.id, name), workbookId: meta.id, name: name, grid: grids[name] });
            });
            set(meta);
          });
        });
      });
    },

    _memDeleteWorkbook: function (id) {
      delete memory.workbooks[id];
      Object.keys(memory.sheets).forEach(function (k) { if (memory.sheets[k].workbookId === id) delete memory.sheets[k]; });
    },

    deleteWorkbook: function (id) {
      return openDb().then(function (db) {
        if (!db) { store._memDeleteWorkbook(id); return; }
        return tx(db, ['workbooks', 'sheets'], 'readwrite', function (t) {
          t.objectStore('workbooks').delete(id);
          var index = t.objectStore('sheets').index('workbookId');
          var cursorReq = index.openKeyCursor(g.IDBKeyRange.only(id));
          cursorReq.onsuccess = function () {
            var cursor = cursorReq.result;
            if (cursor) {
              t.objectStore('sheets').delete(cursor.primaryKey);
              cursor.continue();
            }
          };
        });
      });
    },

    getSheetGrid: function (workbookId, name) {
      return openDb().then(function (db) {
        if (!db) {
          var rec = memory.sheets[sheetKey(workbookId, name)];
          return rec ? rec.grid : null;
        }
        return tx(db, ['sheets'], 'readonly', function (t, set) {
          reqValue(t.objectStore('sheets').get(sheetKey(workbookId, name)), function (r) { set(r ? r.grid : null); });
        });
      });
    },

    listSessions: function () {
      return openDb().then(function (db) {
        if (!db) return Object.keys(memory.sessions).map(function (k) { return clone(memory.sessions[k]); });
        return tx(db, ['sessions'], 'readonly', function (t, set) { reqValue(t.objectStore('sessions').getAll(), set); });
      }).then(function (list) { return list || []; });
    },

    putSession: function (entry) {
      return openDb().then(function (db) {
        if (!db) { memory.sessions[entry.name] = clone(entry); return entry; }
        return tx(db, ['sessions'], 'readwrite', function (t, set) { t.objectStore('sessions').put(entry); set(entry); });
      });
    },

    /** Add a session only if the name is still free (never overwrite). */
    addSession: function (entry) {
      return openDb().then(function (db) {
        if (!db) {
          if (memory.sessions[entry.name]) { var e = new Error('exists'); e.code = 'exists'; throw e; }
          memory.sessions[entry.name] = clone(entry);
          return entry;
        }
        return new Promise(function (resolve, reject) {
          var t = db.transaction(['sessions'], 'readwrite');
          var r = t.objectStore('sessions').add(entry);
          r.onerror = function (ev) {
            var e2 = new Error('exists');
            e2.code = r.error && r.error.name === 'ConstraintError' ? 'exists' : 'failed';
            e2.detail = r.error && r.error.message;
            ev.preventDefault();
            reject(e2);
          };
          t.oncomplete = function () { resolve(entry); };
          t.onabort = function () {
            if (!r.error) reject(t.error || new Error('Storage transaction aborted'));
          };
        });
      });
    },

    deleteSession: function (name) {
      return openDb().then(function (db) {
        if (!db) { delete memory.sessions[name]; return; }
        return tx(db, ['sessions'], 'readwrite', function (t) { t.objectStore('sessions').delete(name); });
      });
    },

    kvGet: function (key) {
      return openDb().then(function (db) {
        if (!db) return memory.kv[key] === undefined ? null : clone(memory.kv[key]);
        return tx(db, ['kv'], 'readonly', function (t, set) {
          reqValue(t.objectStore('kv').get(key), function (r) { set(r ? r.value : null); });
        });
      });
    },

    kvSet: function (key, value) {
      return openDb().then(function (db) {
        if (!db) { memory.kv[key] = clone(value); return; }
        return tx(db, ['kv'], 'readwrite', function (t) { t.objectStore('kv').put({ key: key, value: value }); });
      });
    },

    kvDelete: function (key) {
      return openDb().then(function (db) {
        if (!db) { delete memory.kv[key]; return; }
        return tx(db, ['kv'], 'readwrite', function (t) { t.objectStore('kv').delete(key); });
      });
    },

    // ---------------------------------------------------------------- small prefs
    prefGet: function (key, fallback) {
      try {
        var raw = g.localStorage.getItem('qb.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },

    prefSet: function (key, value) {
      try { g.localStorage.setItem('qb.' + key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
    },

    estimate: function () {
      try {
        if (g.navigator && g.navigator.storage && g.navigator.storage.estimate) return g.navigator.storage.estimate();
      } catch (e) { /* ignore */ }
      return Promise.resolve(null);
    },

    requestPersistence: function () {
      try {
        if (g.navigator && g.navigator.storage && g.navigator.storage.persist) return g.navigator.storage.persist();
      } catch (e) { /* ignore */ }
      return Promise.resolve(false);
    }
  };

  QB.store = store;
})(typeof window !== 'undefined' ? window : globalThis);
