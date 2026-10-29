/*
 * Quiz Bank — application shell, router and views.
 *
 * Views (mirroring the desktop Streamlit app):
 *   home      — dashboard: New Assessment (setup + blueprint) and Historical Telemetry
 *   countdown — 3-2-1 pre-flight before the first question
 *   session   — quiz / flashcard execution with live timers
 *   results   — post-mortem analytics, export and archive
 */
(function (g) {
  'use strict';

  var QB = g.QB;
  var E = QB.engine;
  var MD = QB.md;
  var X = QB.xlsx;
  var ST = QB.store;
  var CH = QB.charts;
  var doc = g.document;
  var esc = MD.esc;

  var TIMER_DEFAULTS = { none: '00:15:00', total: '00:15:00', per_question: '00:01:30' };
  var TIMER_PRESETS = {
    total: ['00:10:00', '00:15:00', '00:30:00', '01:00:00'],
    per_question: ['00:00:30', '00:01:00', '00:01:30', '00:02:00']
  };
  var PREF_DEFAULTS = {
    mode: 'quiz', allow_prev: true, shuffle: true, shuffle_q: false, feedback: true,
    timer_mode: 'none', timer_value: '00:15:00', timer_touched: false, workbookId: null, sheet: null
  };
  var COUNTDOWN_SECONDS = 3.6;
  var WALKTHROUGH_LIMIT = 60;

  var A = {
    booted: false,
    fatal: null,
    workbooks: [],
    sessions: [],
    sheetResults: {},
    prefs: {},
    homeTab: 'new',
    state: E.initState({}),
    ui: {
      errors: {}, toasts: [], modal: null, sheetPicker: false, sheetSearch: '', importing: null,
      open: {}, reviewFilter: 'All', reviewOpen: {}, histSel: null, confirmAbort: false, chartTip: null
    },
    lastScrollKey: null,
    persistTimer: null,
    version: ''
  };

  // ================================================================ helpers
  function now() { return Date.now() / 1000; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return E.fixed(n / 1024, 1) + ' KB';
    return E.fixed(n / 1048576, 1) + ' MB';
  }
  function fmtDateTime(epoch) {
    if (!epoch) return '—';
    var d = new Date(epoch * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function sheetKey(wbId, sheet) { return wbId + '\u0001' + sheet; }
  function errInfo(e) {
    if (e && e.title) return [e.title, e.detail || ''];
    return ['Unexpected error', String(e && e.message || e)];
  }

  var ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    flag: '<path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/>',
    save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>',
    restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4 4.5V9h4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9 7V4h6v3"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    flip: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    up: '<path d="M7 11v9H4v-9zM7 11l4-7c1.6 0 2.6 1.2 2.2 3L12.5 10h6a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    table: '<path d="M4 5h16v14H4zM4 10h16M10 5v14"/>',
    json: '<path d="M8 4c-2 0-2.5 1.5-2.5 3.5S5 11 3.5 12c1.5 1 2 2.5 2 4.5S6 20 8 20M16 4c2 0 2.5 1.5 2.5 3.5S19 11 20.5 12c-1.5 1-2 2.5-2 4.5S18 20 16 20"/>',
    skip: '<path d="M5 6l6 6-6 6M13 6l6 6-6 6"/>',
    folder: '<path d="M3 6.5h6l2 2h10v10H3z"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    chart: '<path d="M4 19h16M7 16v-5M12 16V7M17 16v-8"/>',
    undo: '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/>',
    task: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.7 2.7L16.2 9"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    chevron: '<path d="M7 10l5 5 5-5"/>',
    rule: '<path d="M4 7h10M4 12h7M4 17h10M16 15l2 2 3.5-4"/>'
  };
  function icon(name, cls) {
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  function attrs(obj) {
    var out = '';
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null || v === false) return;
      out += ' ' + k + (v === true ? '' : '="' + esc(String(v)) + '"');
    });
    return out;
  }

  function btn(label, act, opts) {
    opts = opts || {};
    var cls = 'btn btn--' + (opts.variant || 'secondary') + (opts.block === false ? '' : ' btn--block') + (opts.cls ? ' ' + opts.cls : '');
    var a = { 'class': cls, type: 'button', 'data-act': act, disabled: !!opts.disabled, 'aria-pressed': opts.pressed ? 'true' : null };
    Object.keys(opts.data || {}).forEach(function (k) { a['data-' + k] = opts.data[k]; });
    var ic = opts.icon ? icon(opts.icon) : '';
    var label2 = '<span>' + esc(label) + '</span>';
    return '<button' + attrs(a) + '>' + (opts.iconRight ? label2 + ic : ic + label2) + '</button>';
  }

  function chip(text, tone, dot, raw) {
    return '<span class="chip chip--' + (tone || 'neutral') + '">' + (dot ? '<i class="chip__dot"></i>' : '') +
      (raw ? text : esc(text)) + '</span>';
  }

  function tile(label, valueHtml, hint, accent) {
    return '<div class="tile tile--' + (accent || 'info') + '"><div class="tile__label">' + esc(label) + '</div>' +
      '<div class="tile__value">' + valueHtml + '</div>' + (hint ? '<div class="tile__hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function banner(text, tone, glyph, raw) {
    return '<div class="banner banner--' + (tone || 'info') + '"><span class="banner__icon">' + esc(glyph || 'ℹ') + '</span>' +
      '<span class="banner__text">' + (raw ? text : esc(text)) + '</span></div>';
  }

  function systemAlert(title, detail, code, tone, details) {
    return '<div class="alert alert--' + (tone || 'danger') + '"><div class="alert__head"><span class="alert__title">' +
      esc(title) + '</span>' + (code ? '<span class="alert__code">' + esc(code) + '</span>' : '') + '</div>' +
      '<div class="alert__detail">' + esc(detail) + '</div>' +
      (details ? '<pre class="alert__trace">' + esc(details) + '</pre>' : '') + '</div>';
  }

  function kvList(pairs) {
    return '<dl class="kv">' + pairs.map(function (p) {
      return '<div class="kv__row"><dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function cardHead(eyebrow, title, desc, right) {
    return '<div class="card__head"><div class="card__head-main"><div class="eyebrow">' + esc(eyebrow) + '</div>' +
      '<div class="card__title">' + esc(title) + '</div>' + (desc ? '<div class="card__desc">' + esc(desc) + '</div>' : '') +
      '</div>' + (right ? '<div class="card__head-right">' + right + '</div>' : '') + '</div>';
  }

  function card(inner, opts) {
    opts = opts || {};
    return '<section class="card' + (opts.accent ? ' card--accent' : '') + (opts.tight ? ' card--tight' : '') +
      (opts.cls ? ' ' + opts.cls : '') + '"' + (opts.id ? ' id="' + opts.id + '"' : '') + '>' + inner + '</section>';
  }

  function disclosure(key, title, body, iconName) {
    var open = !!A.ui.open[key];
    return '<div class="disclosure' + (open ? ' is-open' : '') + '"><button type="button" class="disclosure__head" data-act="disclose" data-key="' +
      esc(key) + '" aria-expanded="' + open + '">' + (iconName ? icon(iconName) : '') + '<span>' + esc(title) + '</span>' +
      icon('chevron', 'disclosure__chev') + '</button>' + (open ? '<div class="disclosure__body">' + body + '</div>' : '') + '</div>';
  }

  function toggleRow(key, label, help, on) {
    return '<button type="button" class="toggle' + (on ? ' is-on' : '') + '" role="switch" aria-checked="' + on + '" data-act="toggle" data-key="' + key + '">' +
      '<span class="toggle__text"><span class="toggle__label">' + esc(label) + '</span>' +
      (help ? '<span class="toggle__help">' + esc(help) + '</span>' : '') + '</span><span class="toggle__track"><span class="toggle__thumb"></span></span></button>';
  }

  function segmented(act, options, current) {
    return '<div class="seg" role="radiogroup">' + options.map(function (o) {
      var on = o[0] === current;
      return '<button type="button" class="seg__opt' + (on ? ' is-on' : '') + '" role="radio" aria-checked="' + on + '" data-act="' + act +
        '" data-value="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }

  // ================================================================ toasts & modal
  function toast(text, tone) {
    var id = E.randomHex(6);
    A.ui.toasts.push({ id: id, text: text, tone: tone || 'ok' });
    if (A.ui.toasts.length > 4) A.ui.toasts.shift();
    renderToasts();
    g.setTimeout(function () {
      A.ui.toasts = A.ui.toasts.filter(function (t) { return t.id !== id; });
      renderToasts();
    }, 3600);
  }

  function renderToasts() {
    var host = doc.getElementById('qb-toasts');
    if (!host) return;
    host.innerHTML = A.ui.toasts.map(function (t) {
      return '<div class="toast toast--' + t.tone + '" role="status">' + esc(t.text) + '</div>';
    }).join('');
  }

  function openModal(m) { A.ui.modal = m; render(); }
  function closeModal() { A.ui.modal = null; render(); }

  function renderModal() {
    var m = A.ui.modal;
    var host = doc.getElementById('qb-modal');
    if (!host) return;
    if (A.ui.sheetPicker) { host.innerHTML = renderSheetPicker(); doc.body.classList.add('has-modal'); return; }
    if (!m) { host.innerHTML = ''; doc.body.classList.remove('has-modal'); return; }
    doc.body.classList.add('has-modal');
    host.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="modal__backdrop" data-act="modal-close"></div>' +
      '<div class="modal__panel modal__panel--' + (m.tone || 'info') + '"><div class="modal__title">' + esc(m.title) + '</div>' +
      '<div class="modal__body">' + (m.bodyHtml || esc(m.body || '')) + '</div><div class="modal__actions">' +
      m.actions.map(function (a, k) {
        return btn(a.label, 'modal-act', { variant: a.variant || 'secondary', data: { k: k }, icon: a.icon });
      }).join('') + '</div></div></div>';
  }

  // ================================================================ persistence
  function persistLive() {
    if (A.persistTimer) g.clearTimeout(A.persistTimer);
    A.persistTimer = g.setTimeout(flushLive, 150);
  }

  function flushLive() {
    if (A.persistTimer) { g.clearTimeout(A.persistTimer); A.persistTimer = null; }
    var s = A.state;
    var keep = s.view !== E.VIEW_HOME || s.result;
    var payload = { v: 1, savedAt: Date.now(), state: s };
    // Synchronous copy first: it survives even if the app is killed right after.
    try {
      if (keep) {
        var json = JSON.stringify(payload);
        if (json.length < 2500000) g.localStorage.setItem('qb.live', json);
        else g.localStorage.removeItem('qb.live');
      } else {
        g.localStorage.removeItem('qb.live');
      }
    } catch (e) {
      try { g.localStorage.removeItem('qb.live'); } catch (e2) { /* ignore */ }
    }
    var p = keep ? ST.kvSet('live', payload) : ST.kvDelete('live');
    p.catch(function () { /* storage full: nothing else we can do */ });
  }

  function readLocalLive() {
    try {
      var raw = g.localStorage.getItem('qb.live');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function savePrefs() { ST.prefSet('prefs', A.prefs); }

  // ================================================================ data loading
  function currentWorkbook() {
    for (var i = 0; i < A.workbooks.length; i++) if (A.workbooks[i].id === A.prefs.workbookId) return A.workbooks[i];
    return null;
  }

  function workbookByName(name) {
    for (var i = 0; i < A.workbooks.length; i++) if (A.workbooks[i].name === name) return A.workbooks[i];
    return null;
  }

  function ensureSelection() {
    if (!A.workbooks.length) { A.prefs.workbookId = null; A.prefs.sheet = null; return; }
    if (!currentWorkbook()) A.prefs.workbookId = A.workbooks[0].id;
    var wb = currentWorkbook();
    if (!wb.sheetNames.length) { A.prefs.sheet = null; return; }
    if (wb.sheetNames.indexOf(A.prefs.sheet) < 0) A.prefs.sheet = wb.sheetNames[0];
  }

  function loadSheet(wb, sheet) {
    var key = sheetKey(wb.id, sheet);
    var cached = A.sheetResults[key];
    if (cached && cached.status !== 'error-transient') return Promise.resolve(cached);
    var entry = { status: 'loading' };
    A.sheetResults[key] = entry;
    return ST.getSheetGrid(wb.id, sheet).then(function (grid) {
      if (grid === null || grid === undefined) {
        throw E.error('WorkbookReadError', 'Sheet not found', "Sheet '" + sheet + "' is missing from the stored workbook. Attach the file again.");
      }
      entry.result = E.loadQuestionSheet(sheet, grid);
      entry.status = 'ok';
      return entry;
    }).catch(function (e) {
      entry.status = 'error';
      entry.error = e;
      return entry;
    }).then(function (res) {
      render();
      return res;
    });
  }

  function selectedSheetEntry() {
    var wb = currentWorkbook();
    if (!wb || !A.prefs.sheet) return null;
    var key = sheetKey(wb.id, A.prefs.sheet);
    var entry = A.sheetResults[key];
    if (!entry) { loadSheet(wb, A.prefs.sheet); return { status: 'loading' }; }
    return entry;
  }

  function refreshWorkbooks() {
    return ST.listWorkbooks().then(function (list) {
      A.workbooks = list;
      ensureSelection();
      savePrefs();
    });
  }

  function refreshSessions() {
    return ST.listSessions().then(function (list) { A.sessions = list; });
  }

  // ================================================================ file import
  function readFileBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var r = new g.FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error || new Error('The file could not be read')); };
      r.readAsArrayBuffer(file);
    });
  }

  function readFileText(file) {
    if (file.text) return file.text();
    return new Promise(function (resolve, reject) {
      var r = new g.FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error || new Error('The file could not be read')); };
      r.readAsText(file, 'utf-8');
    });
  }

  function pickFile(inputId) {
    var input = doc.getElementById(inputId);
    if (!input) return;
    input.value = '';
    input.click();
  }

  function importWorkbook(file) {
    if (!file) return;
    delete A.ui.errors.home;
    var original = file.name || 'workbook.xlsx';
    var dot = original.lastIndexOf('.');
    var suffix = dot > 0 ? original.slice(dot).toLowerCase() : '';
    var stem = dot > 0 ? original.slice(0, dot) : original;
    if (suffix && suffix !== '.xlsx' && suffix !== '.xlsm') {
      var hint = suffix === '.xls' ? ' Open it in Excel and save it as .xlsx.' : '';
      A.ui.errors.home = ['Unsupported file', 'Only .xlsx or .xlsm workbooks are supported (got ' + suffix + ').' + hint];
      render();
      return;
    }
    var safe = E.sanitizeFilenameComponent(stem) + (suffix || '.xlsx');
    A.ui.importing = { name: safe, step: 'Reading file…' };
    render();
    readFileBytes(file).then(function (bytes) {
      A.ui.importing.step = 'Opening workbook…';
      updateImportDom();
      return X.openWorkbook(bytes).then(function (wb) {
        if (!wb.sheetNames.length) throw E.error('WorkbookReadError', 'Empty workbook', 'The attached workbook has no sheets.');
        return wb.readAll(function (i, n) {
          A.ui.importing.step = 'Reading sheet ' + i + ' of ' + n + '…';
          updateImportDom();
        }).then(function (grids) {
          var meta = {
            id: E.randomHex(12), name: safe, size: bytes.length, importedAt: Date.now(),
            sheetNames: wb.sheetNames, totalSheets: wb.totalSheets, source: 'import'
          };
          var replace = A.workbooks.filter(function (w) { return w.name.toLowerCase() === safe.toLowerCase(); })
            .map(function (w) { return w.id; });
          A.ui.importing.step = 'Saving to the app…';
          updateImportDom();
          return ST.putWorkbook(meta, grids, replace).then(function () {
            replace.forEach(forgetWorkbookCache);
            A.prefs.workbookId = meta.id;
            A.prefs.sheet = meta.sheetNames[0] || null;
            return refreshWorkbooks();
          }).then(function () {
            toast('Workbook imported · ' + safe, 'ok');
            if (wb.totalSheets > E.MAX_SHEETS) {
              toast('Only the first ' + fmtNum(E.MAX_SHEETS) + ' of ' + fmtNum(wb.totalSheets) + ' sheets were indexed', 'warn');
            }
          });
        });
      });
    }).catch(function (e) {
      var info = errInfo(e);
      if (!e || !e.title) info = ['Workbook could not be read', "'" + safe + "': " + info[1]];
      A.ui.errors.home = info;
    }).then(function () {
      A.ui.importing = null;
      A.homeTab = 'new';
      render();
    });
  }

  function updateImportDom() {
    var el = doc.getElementById('qb-import-step');
    if (el && A.ui.importing) el.textContent = A.ui.importing.step;
  }

  function forgetWorkbookCache(id) {
    Object.keys(A.sheetResults).forEach(function (k) { if (k.indexOf(id + '\u0001') === 0) delete A.sheetResults[k]; });
  }

  function generateDemo() {
    delete A.ui.errors.home;
    var demo = QB.demo.build();
    var meta = {
      id: E.randomHex(12), name: demo.name, size: 0, importedAt: Date.now(),
      sheetNames: demo.sheetNames, totalSheets: demo.totalSheets, source: 'demo'
    };
    var replace = A.workbooks.filter(function (w) { return w.name.toLowerCase() === demo.name.toLowerCase(); })
      .map(function (w) { return w.id; });
    ST.putWorkbook(meta, demo.grids, replace).then(function () {
      replace.forEach(forgetWorkbookCache);
      A.prefs.workbookId = meta.id;
      A.prefs.sheet = meta.sheetNames[0];
      return refreshWorkbooks();
    }).then(function () {
      toast('Demo question bank generated · ' + demo.name, 'ok');
      A.homeTab = 'new';
      render();
    }).catch(function (e) {
      A.ui.errors.home = errInfo(e);
      render();
    });
  }

  function deleteWorkbook(id) {
    var wb = null;
    A.workbooks.forEach(function (w) { if (w.id === id) wb = w; });
    if (!wb) return;
    openModal({
      title: 'Delete workbook?', tone: 'danger',
      body: "'" + wb.name + "' and its " + plural(wb.sheetNames.length, 'sheet') + ' will be removed from the app. Saved session results are kept.',
      actions: [
        { label: 'Cancel', variant: 'secondary', run: function () {} },
        { label: 'Delete workbook', variant: 'danger', icon: 'trash', run: function () {
          ST.deleteWorkbook(id).then(function () {
            forgetWorkbookCache(id);
            if (A.prefs.workbookId === id) { A.prefs.workbookId = null; A.prefs.sheet = null; }
            return refreshWorkbooks();
          }).then(function () { toast('Workbook deleted · ' + wb.name, 'info'); render(); })
            .catch(function (e) { A.ui.errors.home = errInfo(e); render(); });
        } }
      ]
    });
  }

  function importSessionJson(file) {
    if (!file) return;
    delete A.ui.errors.hist;
    readFileText(file).then(function (text) {
      var payload;
      try { payload = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
        throw E.error('SessionFileError', 'Corrupted session file', "'" + file.name + "' is not valid JSON.");
      }
      E.validateRecord(payload, file.name || 'file');
      return saveRecord(payload, payload.artifact).then(function (name) {
        toast('Session imported · ' + name, 'ok');
        A.ui.histSel = name;
      });
    }).catch(function (e) {
      A.ui.errors.hist = errInfo(e);
    }).then(function () { A.homeTab = 'history'; render(); });
  }

  /** Store a record under <Sheet>_Session_<N>.json without overwriting (returns the name). */
  function saveRecord(record, preferredName) {
    var attempt = 0;
    function tryName() {
      var names = A.sessions.map(function (s) { return s.name; });
      var name = preferredName && names.indexOf(preferredName) < 0 && /\.json$/i.test(preferredName) && attempt === 0
        ? preferredName : E.nextSessionName(record.sheet, names);
      var payload = JSON.parse(JSON.stringify(record));
      payload.saved_at = payload.saved_at || E.nowIso();
      payload.artifact = name;
      return ST.addSession({ name: name, savedAt: Date.now(), record: payload }).then(function () {
        return refreshSessions().then(function () { return name; });
      }).catch(function (e) {
        if (e && e.code === 'exists' && attempt < 50) {
          attempt++;
          return refreshSessions().then(tryName);
        }
        throw E.error('SessionFileError', 'Could not save session', (e && (e.detail || e.message)) || 'Storage error');
      });
    }
    return tryName();
  }

  // ================================================================ exports
  var saveWaiters = {};
  g.__qbNativeSaved = function (id, ok, msg) {
    var w = saveWaiters[id];
    delete saveWaiters[id];
    if (w) w(!!ok, msg || '');
  };

  function base64Utf8(text) {
    var bytes = new g.TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return g.btoa(bin);
  }

  function exportFile(name, mime, text) {
    var bridge = g.QuizBankNative;
    if (bridge && typeof bridge.saveFile === 'function') {
      var id = E.randomHex(10);
      saveWaiters[id] = function (ok, msg) {
        if (ok) toast('Saved · ' + name, 'ok');
        else if (msg === 'cancelled') toast('Save cancelled', 'info');
        else toast('Could not save: ' + msg, 'danger');
      };
      try {
        bridge.saveFile(id, name, mime, base64Utf8(text));
      } catch (e) {
        delete saveWaiters[id];
        toast('Could not save: ' + (e.message || e), 'danger');
      }
      return;
    }
    try {
      var blob = new g.Blob([text], { type: mime + ';charset=utf-8' });
      var url = g.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url;
      a.download = name;
      doc.body.appendChild(a);
      a.click();
      g.setTimeout(function () { g.URL.revokeObjectURL(url); a.remove(); }, 1500);
      toast('Downloaded · ' + name, 'ok');
    } catch (e2) {
      toast('Could not save: ' + (e2.message || e2), 'danger');
    }
  }

  function setKeepScreenOn(on) {
    var bridge = g.QuizBankNative;
    if (bridge && typeof bridge.setKeepScreenOn === 'function') {
      try { bridge.setKeepScreenOn(!!on); } catch (e) { /* ignore */ }
    }
  }

  // ================================================================ actions
  function timerOk() {
    if (A.prefs.timer_mode === 'none') return { ok: true, seconds: 0 };
    try { return { ok: true, seconds: E.parseHHMMSS(A.prefs.timer_value) }; } catch (e) { return { ok: false, error: e }; }
  }

  function launch() {
    delete A.ui.errors.launch;
    var wb = currentWorkbook();
    var entry = selectedSheetEntry();
    try {
      if (!wb) throw E.error('ConfigError', 'No workbook', 'Attach an Excel workbook first.');
      if (!entry || entry.status !== 'ok') {
        if (entry && entry.error) throw entry.error;
        throw E.error('ConfigError', 'Sheet still loading', 'Wait a moment and try again.');
      }
      var cfg = E.buildConfig({
        workbook: wb.name, sheet: A.prefs.sheet, mode: A.prefs.mode, allow_previous: A.prefs.allow_prev,
        timer_mode: A.prefs.timer_mode, timer_text: A.prefs.timer_value, shuffle_options: A.prefs.shuffle,
        direct_feedback: A.prefs.feedback, shuffle_questions: A.prefs.shuffle_q
      });
      E.startSession(A.state, cfg, entry.result.questions, now());
      A.ui.confirmAbort = false;
      flushLive();
    } catch (e) {
      A.ui.errors.launch = errInfo(e);
    }
    render();
  }

  function retake() {
    delete A.ui.errors.results;
    var record = A.state.result || {};
    var cfg;
    try {
      cfg = E.configFromDict(record.config || {});
    } catch (e) {
      A.ui.errors.results = ['Retake unavailable', errInfo(e)[1]];
      render();
      return;
    }
    var wb = workbookByName(cfg.workbook);
    if (!wb) {
      A.ui.errors.results = ['Retake unavailable', "Workbook '" + cfg.workbook + "' is no longer in the app. Attach it again first."];
      render();
      return;
    }
    if (wb.sheetNames.indexOf(cfg.sheet) < 0) {
      A.ui.errors.results = ['Retake unavailable', "Sheet '" + cfg.sheet + "' does not exist in '" + wb.name + "'."];
      render();
      return;
    }
    loadSheet(wb, cfg.sheet).then(function (entry) {
      try {
        if (entry.status !== 'ok') throw entry.error;
        E.startSession(A.state, cfg, entry.result.questions, now());
        A.ui.confirmAbort = false;
        A.ui.reviewOpen = {};
        flushLive();
      } catch (e) {
        A.ui.errors.results = ['Retake unavailable', errInfo(e)[1]];
      }
      render();
    });
  }

  function newAssessment() {
    A.state.view = E.VIEW_HOME;
    A.state.result = null;
    A.state.result_source = null;
    A.state.saved_path = null;
    A.ui.reviewOpen = {};
    A.ui.reviewFilter = 'All';
    delete A.ui.errors.results;
    flushLive();
    render();
  }

  function saveResult() {
    var s = A.state;
    if (!s.result || s.saved_path || s.result_source === 'history') return Promise.resolve();
    delete A.ui.errors.results;
    return saveRecord(s.result).then(function (name) {
      s.saved_path = name;
      flushLive();
      toast('Session saved · ' + name, 'ok');
      render();
    }).catch(function (e) {
      A.ui.errors.results = errInfo(e);
      render();
    });
  }

  function finishConfirm() {
    if (A.state.view !== E.VIEW_SESSION) return;
    E.finishSession(A.state, now(), E.FINISH_COMPLETED);
    A.ui.confirmAbort = false;
    A.ui.reviewOpen = {};
    A.ui.reviewFilter = 'All';
    toast('Session submitted · analytics compiled', 'ok');
    flushLive();
    render();
  }

  function finishRequest() {
    if (A.state.view !== E.VIEW_SESSION) return;
    var snap = E.progressSnapshot(A.state);
    if ((snap.unanswered || snap.flagged) && !A.state.confirm_finish) {
      A.state.confirm_finish = true;
      persistLive();
      render();
      g.setTimeout(function () {
        var el = doc.getElementById('qb-confirm-finish');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 30);
      return;
    }
    finishConfirm();
  }

  function abortConfirm() {
    A.ui.confirmAbort = false;
    E.abortSession(A.state);
    toast('Session aborted · no data recorded', 'info');
    flushLive();
    render();
  }

  function hydrate(name) {
    delete A.ui.errors.hist;
    var entry = null;
    A.sessions.forEach(function (s) { if (s.name === name) entry = s; });
    if (!entry) return;
    try {
      E.validateRecord(entry.record, name);
    } catch (e) {
      A.ui.errors.hist = errInfo(e);
      render();
      return;
    }
    A.state.result = entry.record;
    A.state.result_source = 'history';
    A.state.saved_path = name;
    A.state.view = E.VIEW_RESULTS;
    A.ui.reviewOpen = {};
    A.ui.reviewFilter = 'All';
    toast('Dashboard hydrated · ' + name, 'info');
    flushLive();
    render();
  }

  function deleteSession(name) {
    openModal({
      title: 'Delete saved session?', tone: 'danger',
      body: "'" + name + "' will be permanently removed from the archive.",
      actions: [
        { label: 'Cancel', variant: 'secondary', run: function () {} },
        { label: 'Delete', variant: 'danger', icon: 'trash', run: function () {
          ST.deleteSession(name).then(refreshSessions).then(function () {
            if (A.ui.histSel === name) A.ui.histSel = null;
            toast('Session deleted · ' + name, 'info');
            render();
          }).catch(function (e) { A.ui.errors.hist = errInfo(e); render(); });
        } }
      ]
    });
  }

  function leaveSessionModal() {
    openModal({
      title: 'Leave this session?',
      body: 'Your progress is kept while the session is open. Submit it for analytics, or abort to discard it.',
      actions: [
        { label: 'Keep working', variant: 'primary', icon: 'undo', run: function () {} },
        { label: 'Submit session', variant: 'success', icon: 'task', run: function () { finishConfirm(); } },
        { label: 'Abort session', variant: 'danger', icon: 'close', run: function () { abortConfirm(); } }
      ]
    });
  }

  function leaveResultsModal() {
    openModal({
      title: 'Leave the analytics dashboard?',
      body: 'This result has not been saved to the archive yet.',
      actions: [
        { label: 'Stay here', variant: 'secondary', run: function () {} },
        { label: 'Save & leave', variant: 'success', icon: 'save', run: function () {
          saveResult().then(function () { if (A.state.saved_path) newAssessment(); });
        } },
        { label: 'Leave without saving', variant: 'danger', run: function () { newAssessment(); } }
      ]
    });
  }

  // Hardware back button (called by the Android host). Return true when handled.
  g.__qbBack = function () {
    try {
      if (A.ui.modal) { closeModal(); return true; }
      if (A.ui.sheetPicker) { A.ui.sheetPicker = false; render(); return true; }
      if (A.fatal) { recover(); return true; }
      var v = A.state.view;
      if (v === E.VIEW_SESSION) { leaveSessionModal(); return true; }
      if (v === E.VIEW_COUNTDOWN) { abortConfirm(); return true; }
      if (v === E.VIEW_RESULTS) {
        if (A.state.result_source === 'live' && !A.state.saved_path) { leaveResultsModal(); return true; }
        newAssessment();
        return true;
      }
      if (A.homeTab === 'history') { A.homeTab = 'new'; render(); return true; }
      return false;
    } catch (e) {
      return false;
    }
  };

  function recover() {
    A.fatal = null;
    E.abortSession(A.state);
    A.state.result = null;
    A.state.result_source = null;
    A.ui.modal = null;
    A.ui.sheetPicker = false;
    flushLive();
    render();
  }

  // ================================================================ event wiring
  function onClick(ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    var act = el.getAttribute('data-act');
    var d = el.dataset || {};
    var s = A.state;
    var idx = d.idx !== undefined ? parseInt(d.idx, 10) : null;
    try {
      handle(act, d, el, s, idx);
    } catch (e) {
      fatal(e);
    }
  }

  function handle(act, d, el, s, idx) {
    switch (act) {
      case 'tab': A.homeTab = d.tab; render(); break;
      case 'attach': pickFile('qb-file-xlsx'); break;
      case 'attach-json': pickFile('qb-file-json'); break;
      case 'demo': generateDemo(); break;
      case 'wb-delete': deleteWorkbook(d.id); break;
      case 'sheet-open': A.ui.sheetPicker = true; A.ui.sheetSearch = ''; render(); focusLater('qb-sheet-search'); break;
      case 'sheet-close': A.ui.sheetPicker = false; render(); break;
      case 'sheet-pick':
        A.prefs.sheet = d.name;
        A.ui.sheetPicker = false;
        delete A.ui.errors.launch;
        savePrefs();
        render();
        break;
      case 'mode':
        A.prefs.mode = d.value;
        delete A.ui.errors.launch;
        savePrefs();
        render();
        break;
      case 'toggle':
        A.prefs[d.key] = !A.prefs[d.key];
        savePrefs();
        render();
        break;
      case 'timer-mode':
        A.prefs.timer_mode = d.value;
        if (!A.prefs.timer_touched) A.prefs.timer_value = TIMER_DEFAULTS[d.value];
        delete A.ui.errors.launch;
        savePrefs();
        render();
        break;
      case 'timer-preset':
        A.prefs.timer_value = d.value;
        A.prefs.timer_touched = true;
        savePrefs();
        render();
        break;
      case 'launch': launch(); break;
      case 'disclose': A.ui.open[d.key] = !A.ui.open[d.key]; render(); break;
      // ---- history
      case 'hist-select': A.ui.histSel = d.name; render(); break;
      case 'hydrate': if (A.ui.histSel) hydrate(A.ui.histSel); break;
      case 'hist-delete': if (A.ui.histSel) deleteSession(A.ui.histSel); break;
      // ---- session
      case 'select':
        if (s.view === E.VIEW_SESSION && s.cursor === idx) {
          E.recordSelection(s, idx, d.letter);
          persistLive();
          render();
        }
        break;
      case 'flag':
        if (s.view === E.VIEW_SESSION) {
          E.setFlag(s, idx, !E.has(s.flags, idx));
          persistLive();
          render();
        }
        break;
      case 'submit':
        if (s.view === E.VIEW_SESSION && s.cursor === idx) { E.submitAnswer(s, idx, now()); persistLive(); render(); }
        break;
      case 'next':
        if (s.view === E.VIEW_SESSION && s.cursor === idx) { E.nextQuestion(s, now()); persistLive(); render(); }
        break;
      case 'prev':
        if (s.view === E.VIEW_SESSION && s.cursor === idx) { E.previousQuestion(s, now()); persistLive(); render(); }
        break;
      case 'jump':
        if (s.view === E.VIEW_SESSION && s.config.allow_previous) { E.goTo(s, idx, now()); persistLive(); render(); }
        break;
      case 'reveal':
        if (s.view === E.VIEW_SESSION) { E.revealCard(s, idx); persistLive(); render(); }
        break;
      case 'grade':
        if (s.view === E.VIEW_SESSION && s.cursor === idx) { E.gradeCard(s, idx, d.knew === '1', now()); persistLive(); render(); }
        break;
      case 'finish-request': finishRequest(); break;
      case 'finish-confirm': finishConfirm(); break;
      case 'finish-cancel': s.confirm_finish = false; persistLive(); render(); break;
      case 'abort-request': A.ui.confirmAbort = !A.ui.confirmAbort; render(); break;
      case 'abort-confirm': abortConfirm(); break;
      // ---- results
      case 'filter': A.ui.reviewFilter = d.value; A.ui.reviewOpen = {}; render(); break;
      case 'review-toggle': A.ui.reviewOpen[d.n] = !A.ui.reviewOpen[d.n]; render(); break;
      case 'walk-all': walkAll(); break;
      case 'walk-none': A.ui.reviewOpen = {}; render(); break;
      case 'save': saveResult(); break;
      case 'dl-csv': downloadRecord('csv'); break;
      case 'dl-json': downloadRecord('json'); break;
      case 'retake': retake(); break;
      case 'new': newAssessment(); break;
      case 'chart-bar': A.ui.chartTip = parseInt(d.i, 10); renderChartTip(); break;
      // ---- modal & recovery
      case 'modal-close': closeModal(); break;
      case 'modal-act': {
        var m = A.ui.modal;
        var action = m && m.actions[parseInt(d.k, 10)];
        A.ui.modal = null;
        render();
        if (action && action.run) action.run();
        break;
      }
      case 'recover': recover(); break;
      default: break;
    }
  }

  function walkAll() {
    var rows = E.filterReview(E.buildReviewRows(A.state.result), A.ui.reviewFilter);
    A.ui.reviewOpen = {};
    rows.slice(0, WALKTHROUGH_LIMIT).forEach(function (r) { A.ui.reviewOpen[r.number] = true; });
    render();
    if (rows.length > WALKTHROUGH_LIMIT) {
      toast('Showing the first ' + WALKTHROUGH_LIMIT + ' of ' + rows.length + ' questions. Use the filters to narrow down.', 'info');
    }
  }

  function downloadRecord(kind) {
    var s = A.state;
    var record = s.result;
    if (!record) return;
    var stem = s.saved_path ? s.saved_path.replace(/\.json$/i, '') : E.sanitizeFilenameComponent(record.sheet) + '_Session_preview';
    if (kind === 'csv') exportFile(stem + '.csv', 'text/csv', E.recordToCsv(record));
    else exportFile(stem + '.json', 'application/json', E.recordToJson(record));
  }

  function onChange(ev) {
    var t = ev.target;
    try {
      if (t.id === 'qb-wb-select') {
        A.prefs.workbookId = t.value;
        A.prefs.sheet = null;
        ensureSelection();
        delete A.ui.errors.launch;
        savePrefs();
        render();
      } else if (t.id === 'qb-file-xlsx') {
        importWorkbook(t.files && t.files[0]);
      } else if (t.id === 'qb-file-json') {
        importSessionJson(t.files && t.files[0]);
      }
    } catch (e) {
      fatal(e);
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.id === 'qb-timer-input') {
      A.prefs.timer_value = t.value;
      A.prefs.timer_touched = true;
      savePrefs();
      updateTimerHint();
    } else if (t.id === 'qb-sheet-search') {
      A.ui.sheetSearch = t.value;
      var list = doc.getElementById('qb-sheet-list');
      if (list) list.innerHTML = sheetListHtml();
    }
  }

  function focusLater(id) {
    g.setTimeout(function () {
      var el = doc.getElementById(id);
      if (el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
    }, 60);
  }

  // ================================================================ rendering
  function render() {
    if (!A.booted) return;
    var view = doc.getElementById('qb-view');
    var nav = doc.getElementById('qb-nav');
    try {
      var active = doc.activeElement;
      var activeId = active && active.id;
      var selStart = null, selEnd = null;
      if (activeId === 'qb-timer-input') {
        try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e0) { /* ignore */ }
      }
      var scrollKey;
      var html;
      if (A.fatal) {
        html = renderFatal();
        scrollKey = 'fatal';
      } else {
        var v = A.state.view;
        if (v === E.VIEW_SESSION && (!A.state.config || !A.state.questions || !A.state.questions.length)) {
          E.abortSession(A.state);
          v = E.VIEW_HOME;
        }
        if (v === E.VIEW_RESULTS && !A.state.result) { A.state.view = E.VIEW_HOME; v = E.VIEW_HOME; }
        if (v === E.VIEW_COUNTDOWN) html = renderCountdown();
        else if (v === E.VIEW_SESSION) html = renderSession();
        else if (v === E.VIEW_RESULTS) html = renderResults();
        else html = renderHome();
        scrollKey = v + (v === E.VIEW_SESSION ? ':' + A.state.cursor : '') + (v === E.VIEW_HOME ? ':' + A.homeTab : '');
      }
      var y = g.scrollY;
      nav.innerHTML = renderNav();
      view.innerHTML = html;
      if (scrollKey !== A.lastScrollKey) {
        g.scrollTo(0, 0);
        A.lastScrollKey = scrollKey;
      } else {
        g.scrollTo(0, y);
      }
      renderModal();
      renderToasts();
      updateLive();
      setKeepScreenOn(A.state.view === E.VIEW_SESSION || A.state.view === E.VIEW_COUNTDOWN);
      if (activeId) {
        var again = doc.getElementById(activeId);
        if (again && again !== doc.activeElement) {
          try { again.focus({ preventScroll: true }); } catch (e1) { again.focus(); }
          if (selStart !== null) { try { again.setSelectionRange(selStart, selEnd); } catch (e2) { /* ignore */ } }
        }
      }
    } catch (e) {
      if (!A.fatal) fatal(e);
      else view.innerHTML = '<pre class="alert__trace">' + esc(String(e && e.stack || e)) + '</pre>';
    }
  }

  function fatal(e) {
    if (e && e.kind && e.title) {
      A.fatal = { code: String(e.kind).toUpperCase(), title: e.title, message: e.detail || '', details: null };
    } else {
      A.fatal = {
        code: 'SYS-500', title: 'Unexpected system failure',
        message: 'The engine hit an unexpected condition (' + ((e && e.name) || 'Error') + '). Your saved results are safe.',
        details: String((e && (e.stack || e.message)) || e)
      };
    }
    A.ui.modal = null;
    A.ui.sheetPicker = false;
    render();
  }

  function renderFatal() {
    var f = A.fatal;
    return '<div class="stack">' + card(systemAlert(f.title, f.message, f.code, 'danger', f.details) +
      '<div class="btn-row">' + btn('Return to executive dashboard', 'recover', { variant: 'primary', icon: 'home' }) + '</div>') + '</div>';
  }

  function navStatus() {
    var s = A.state;
    var cfg = s.config || {};
    var modeLabel = E.MODE_LABELS[cfg.mode] || '';
    if (A.fatal) return ['ALERT', 'danger', 'Recovery required'];
    if (s.view === E.VIEW_COUNTDOWN) return ['ARMING', 'amber', modeLabel || 'Pre-flight'];
    if (s.view === E.VIEW_SESSION) return ['LIVE', 'brand', modeLabel + ' · ' + (E.TIMER_LABELS[cfg.timer_mode] || '')];
    if (s.view === E.VIEW_RESULTS) {
      if (s.result_source === 'history') return ['ARCHIVE', 'info', 'Historical telemetry'];
      return ['ANALYTICS', 'success', 'Post-session diagnostics'];
    }
    return ['STANDBY', 'info', 'Awaiting configuration'];
  }

  function renderNav() {
    var st = navStatus();
    return '<div class="nav"><div class="brand"><div class="brand__mark">Q</div><div class="brand__text">' +
      '<div class="brand__title"><b>QUIZ BANK</b></div><div class="brand__sub">Quantitative Assessment Engine</div></div></div>' +
      '<div class="nav__right">' + chip(st[0], st[1], true) + '<div class="nav__clock" id="qb-clock">--:--:--</div></div></div>' +
      '<div class="nav__detail">' + esc(st[2]) + '</div>';
  }

  // ---------------------------------------------------------------- home
  function renderHome() {
    var wb = currentWorkbook();
    var total = wb ? wb.totalSheets : 0;
    var out = [];
    out.push('<section class="hero"><div class="eyebrow eyebrow--light">Executive dashboard</div>' +
      '<h1 class="hero__title">Rehearse under exam conditions</h1>' +
      '<p class="hero__desc">Attach an Excel question bank, pick a paket soal and train in quiz or flashcard mode with timers and analytics — fully offline.</p>' +
      '<div class="tiles tiles--2">' +
      tile('Workbooks', String(A.workbooks.length), 'Stored in the app', 'brand') +
      tile('Paket soal', fmtNum(total), wb ? wb.name : 'No workbook yet', 'info') +
      tile('Saved sessions', String(A.sessions.length), 'In the archive', 'success') +
      tile('Sheet capacity', fmtNum(E.MAX_SHEETS), 'Per workbook', 'amber') +
      '</div></section>');
    if (!ST.persistent) {
      out.push(banner('Storage is unavailable on this device — imported workbooks and results will not be kept after the app closes.', 'warn', '!'));
    }
    var err = A.ui.errors.home;
    if (err) { out.push(systemAlert(err[0], err[1], 'VALIDATION', 'warn')); delete A.ui.errors.home; }
    out.push('<div class="tabs" role="tablist">' +
      '<button type="button" class="tabs__tab' + (A.homeTab === 'new' ? ' is-on' : '') + '" data-act="tab" data-tab="new" role="tab">◆ New Assessment</button>' +
      '<button type="button" class="tabs__tab' + (A.homeTab === 'history' ? ' is-on' : '') + '" data-act="tab" data-tab="history" role="tab">◷ Historical Telemetry</button></div>');
    out.push(A.homeTab === 'history' ? renderHistoryTab() : renderSetupTab());
    out.push('<footer class="foot">Quiz Bank' + (A.version ? ' v' + esc(A.version) : '') + ' · works offline · data stays on this phone</footer>');
    return '<div class="stack">' + out.join('') + '</div>';
  }

  function importingCard() {
    var im = A.ui.importing;
    if (!im) return '';
    return card('<div class="importing"><div class="spinner"></div><div><div class="importing__name">' + esc(im.name) + '</div>' +
      '<div class="importing__step" id="qb-import-step">' + esc(im.step) + '</div></div></div>', { tight: true });
  }

  function renderSetupTab() {
    var out = [importingCard()];
    var wb = currentWorkbook();
    if (!wb) {
      out.push(card(systemAlert('No question bank detected',
        'Attach an .xlsx workbook (11 columns: Nomor, Soal, Pilihan A–D, Jawaban Benar, Pembahasan jika Pilihan A–D), or generate the demo bank.',
        'DATA-404', 'warn') +
        '<div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>' +
        '<div class="btn-col">' + btn('Attach Excel file', 'attach', { variant: 'primary', icon: 'upload', disabled: !!A.ui.importing }) +
        btn('Generate demo question bank', 'demo', { variant: 'info', icon: 'spark', disabled: !!A.ui.importing }) + '</div>' +
        '<p class="muted small">Every sheet in the workbook becomes a <b>Paket Soal</b>. Up to 1,000 sheets per workbook are indexed.</p>',
      { accent: true }));
      return out.join('');
    }
    var entry = selectedSheetEntry();
    var result = entry && entry.status === 'ok' ? entry.result : null;
    var timer = timerOk();
    var isFlash = A.prefs.mode === E.MODE_FLASHCARD;

    var setup = [];
    setup.push(cardHead('01 · Data source', 'Assessment configuration', 'Select the question bank, study mode and examination conditions.',
      chip(plural(A.workbooks.length, 'workbook'), 'info')));
    setup.push('<div class="field"><label class="field__label" for="qb-wb-select">Workbook</label><div class="field-row"><div class="select-wrap"><select id="qb-wb-select" class="select">' +
      A.workbooks.map(function (w) {
        return '<option value="' + esc(w.id) + '"' + (w.id === wb.id ? ' selected' : '') + '>' + esc(w.name) + '</option>';
      }).join('') + '</select>' + icon('chevron', 'select-wrap__chev') + '</div>' +
      '<button type="button" class="icon-btn icon-btn--brand" data-act="attach" aria-label="Attach another Excel file"' +
      (A.ui.importing ? ' disabled' : '') + '>' + icon('upload') + '</button></div></div>');
    if (!wb.sheetNames.length) {
      setup.push(systemAlert('Workbook unreadable', 'The selected workbook has no readable sheets. Re-save it as .xlsx in Excel.', 'DATA-422'));
      out.push(card(setup.join(''), { accent: true }));
      out.push(renderManageCard());
      return out.join('');
    }
    var sheetIndex = wb.sheetNames.indexOf(A.prefs.sheet) + 1;
    setup.push('<div class="field"><span class="field__label">Paket Soal</span><button type="button" class="picker" data-act="sheet-open">' +
      '<span class="picker__value">' + esc(A.prefs.sheet || '—') + '</span><span class="picker__meta">' + sheetIndex + ' / ' +
      fmtNum(wb.sheetNames.length) + '</span>' + icon('search') + '</button></div>');
    if (wb.totalSheets > E.MAX_SHEETS) {
      setup.push(banner('This workbook has ' + fmtNum(wb.totalSheets) + ' sheets; the first ' + fmtNum(E.MAX_SHEETS) + ' are indexed.', 'warn', '!'));
    }
    if (entry && entry.status === 'error') {
      var ei = errInfo(entry.error);
      setup.push(systemAlert(ei[0], ei[1], entry.error && entry.error.kind || 'ERROR'));
    }
    setup.push('<hr class="divider">');
    setup.push('<div class="eyebrow">02 · Study mode</div>');
    setup.push(segmented('mode', [['quiz', 'Quiz Mode'], ['flashcard', 'Flashcard Mode']], A.prefs.mode));
    setup.push('<div class="toggles">' +
      toggleRow('allow_prev', 'Allow previous question', 'Enables backwards navigation, the question navigator and review flags.', A.prefs.allow_prev) +
      toggleRow('shuffle', 'Shuffle options', 'Randomises A–D order per question; explanations still map to the chosen option.', A.prefs.shuffle) +
      toggleRow('shuffle_q', 'Shuffle questions', 'Randomises the question order for every new session or retake; the original sheet Nomor is kept for review and export.', A.prefs.shuffle_q) +
      (isFlash ? '<div class="toggles__note">' + chip('Reveal-on-demand built in', 'info') + '</div>'
        : toggleRow('feedback', 'Direct feedback', 'Reveal the option-specific explanation right after each submission.', A.prefs.feedback)) +
      '</div>');
    setup.push('<hr class="divider">');
    setup.push('<div class="eyebrow">03 · Examination clock</div>');
    setup.push(segmented('timer-mode', [['none', 'No Timer'], ['total', 'Total Time'], ['per_question', 'Per Question']], A.prefs.timer_mode));
    var noTimer = A.prefs.timer_mode === 'none';
    setup.push('<label class="field"><span class="field__label">Duration (HH:MM:SS)</span><input id="qb-timer-input" class="input mono" type="text" ' +
      'inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="8" placeholder="00:30:00" value="' +
      esc(A.prefs.timer_value) + '"' + (noTimer ? ' disabled' : '') + '></label>');
    if (!noTimer) {
      setup.push('<div class="presets">' + TIMER_PRESETS[A.prefs.timer_mode].map(function (p) {
        return '<button type="button" class="preset' + (p === A.prefs.timer_value ? ' is-on' : '') + '" data-act="timer-preset" data-value="' + p + '">' + p + '</button>';
      }).join('') + '</div>');
    }
    setup.push('<div id="qb-timer-hint">' + timerHintHtml(result) + '</div>');
    setup.push('<hr class="divider">');
    var ready = !!(result && result.questions.length) && timer.ok && !A.ui.importing;
    setup.push('<div id="qb-launch-wrap">' + btn(isFlash ? 'Launch flashcard drill' : 'Launch assessment', 'launch',
      { variant: 'launch', icon: 'play', disabled: !ready }) + '</div>');
    var le = A.ui.errors.launch;
    if (le) setup.push(systemAlert(le[0], le[1], 'VALIDATION', 'warn'));
    out.push(card(setup.join(''), { accent: true }));
    out.push(renderBlueprint(entry, timer.ok ? timer.seconds : 0));
    out.push(renderManageCard());
    return out.join('');
  }

  function timerHintHtml(result) {
    var mode = A.prefs.timer_mode;
    if (mode === 'none') return '';
    var count = result ? result.questions.length : 0;
    try {
      var seconds = E.parseHHMMSS(A.prefs.timer_value);
      var hint;
      if (mode === 'total' && count) {
        hint = 'Total budget ' + E.formatHHMMSS(seconds) + ' · ≈ ' + E.formatDurationShort(seconds / count) + ' per question';
      } else {
        hint = E.formatHHMMSS(seconds) + ' per question · total ≈ ' + E.formatHHMMSS(seconds * Math.max(count, 1));
        if (mode === 'total') hint = 'Total budget ' + E.formatHHMMSS(seconds);
      }
      return banner(hint, 'info', '◷');
    } catch (e) {
      return banner(e.title + ': ' + e.detail, 'danger', '!');
    }
  }

  function updateTimerHint() {
    var entry = selectedSheetEntry();
    var result = entry && entry.status === 'ok' ? entry.result : null;
    var hintEl = doc.getElementById('qb-timer-hint');
    if (hintEl) hintEl.innerHTML = timerHintHtml(result);
    var timer = timerOk();
    var ready = !!(result && result.questions.length) && timer.ok && !A.ui.importing;
    var launchBtn = doc.querySelector('#qb-launch-wrap button');
    if (launchBtn) launchBtn.disabled = !ready;
    doc.querySelectorAll('.preset').forEach(function (p) {
      p.classList.toggle('is-on', p.getAttribute('data-value') === A.prefs.timer_value);
    });
  }

  function renderBlueprint(entry, timerSeconds) {
    var inner = [cardHead('Session blueprint', 'Dataset health', 'Validation runs every time a sheet is opened.')];
    if (!entry || entry.status === 'loading') {
      inner.push('<div class="importing"><div class="spinner"></div><div class="muted">Loading sheet…</div></div>');
      return card(inner.join(''));
    }
    if (entry.status !== 'ok') {
      inner.push(banner('Sheet could not be parsed.', 'danger', '!'));
      return card(inner.join(''));
    }
    var r = entry.result;
    var valid = r.questions.length;
    var layoutName = r.layout.split('-')[0];
    inner.push('<div class="tiles tiles--2">' +
      tile('Valid questions', String(valid), 'of ' + r.rows_scanned + ' rows scanned', 'success') +
      tile('Rejected rows', String(E.errorCount(r)), 'Blocking errors', 'danger') +
      tile('Warnings', String(E.warningCount(r)), 'Non-blocking', 'amber') +
      tile('Column mapping', layoutName.charAt(0).toUpperCase() + layoutName.slice(1),
        r.layout.indexOf('headerless') >= 0 ? 'Header-less sheet' : 'Header detected', 'info') + '</div>');
    var mode = A.prefs.mode;
    var tm = A.prefs.timer_mode;
    inner.push(kvList([
      ['Paket soal', A.prefs.sheet || '—'],
      ['Mode', E.MODE_LABELS[mode]],
      ['Navigation', A.prefs.allow_prev ? 'Free (back + flags)' : 'Linear (forward only)'],
      ['Option order', A.prefs.shuffle ? 'Shuffled' : 'As authored'],
      ['Question order', A.prefs.shuffle_q ? 'Shuffled' : 'As authored'],
      ['Feedback', mode === E.MODE_FLASHCARD ? 'Reveal per card' : (A.prefs.feedback ? 'Immediate' : 'At the end')],
      ['Clock', E.TIMER_LABELS[tm] + (tm !== 'none' && timerSeconds ? ' · ' + E.formatHHMMSS(timerSeconds) : '')]
    ]));
    if (valid === 0) inner.push(banner('No valid questions in this sheet — fix the issues below before launching.', 'danger', '!'));
    if (r.issues.length) {
      var list = '<ul class="issues">' + r.issues.map(function (i) {
        return '<li class="issues__item issues__item--' + i.severity + '"><div class="issues__meta"><span class="mono">Row ' + i.row +
          '</span>' + (i.nomor ? '<span>Nomor ' + esc(i.nomor) + '</span>' : '') + chip(i.severity.toUpperCase(), i.severity === 'error' ? 'danger' : 'amber') +
          '</div><div class="issues__msg">' + esc(i.message) + '</div></li>';
      }).join('') + '</ul>';
      inner.push(disclosure('dq', 'Data-quality report · ' + plural(r.issues.length, 'finding'), list, 'rule'));
    }
    if (r.questions.length) {
      var first = r.questions[0];
      var preview = JSON.parse(JSON.stringify(first));
      preview.display_order = E.LETTERS.filter(function (l) { return l in preview.options; });
      inner.push(disclosure('preview', 'Preview first question',
        '<div class="md">' + MD.render(first.text) + '</div>' + optionListHtml(preview, true), 'eye'));
    }
    return card(inner.join(''));
  }

  function renderManageCard() {
    var rows = A.workbooks.map(function (w) {
      var active = w.id === A.prefs.workbookId;
      return '<li class="wblist__item' + (active ? ' is-active' : '') + '"><div class="wblist__main"><div class="wblist__name">' + esc(w.name) +
        '</div><div class="wblist__meta">' + plural(w.sheetNames.length, 'sheet') + (w.size ? ' · ' + fmtBytes(w.size) : '') +
        ' · ' + fmtDateTime(w.importedAt / 1000) + (w.source === 'demo' ? ' · demo' : '') + '</div></div>' +
        '<button type="button" class="icon-btn icon-btn--danger" data-act="wb-delete" data-id="' + esc(w.id) + '" aria-label="Delete ' + esc(w.name) + '">' +
        icon('trash') + '</button></li>';
    }).join('');
    var body = '<div class="btn-col">' + btn('Attach Excel file', 'attach', { variant: 'primary', icon: 'upload', disabled: !!A.ui.importing }) +
      btn('Regenerate demo question bank', 'demo', { variant: 'ghost', icon: 'spark', disabled: !!A.ui.importing }) + '</div>' +
      (rows ? '<ul class="wblist">' + rows + '</ul>' : '');
    return card(disclosure('manage', 'Import or manage workbooks', body, 'folder'), { tight: true });
  }

  function sheetListHtml() {
    var wb = currentWorkbook();
    if (!wb) return '';
    var q = (A.ui.sheetSearch || '').trim().toLowerCase();
    var items = [];
    wb.sheetNames.forEach(function (name, i) {
      if (q && name.toLowerCase().indexOf(q) < 0) return;
      items.push('<li><button type="button" class="sheetlist__item' + (name === A.prefs.sheet ? ' is-on' : '') +
        '" data-act="sheet-pick" data-name="' + esc(name) + '"><span class="sheetlist__idx mono">' + (i + 1) + '</span><span class="sheetlist__name">' +
        esc(name) + '</span></button></li>');
    });
    if (!items.length) return '<li class="muted sheetlist__empty">No paket soal matches “' + esc(A.ui.sheetSearch) + '”.</li>';
    return items.join('');
  }

  function renderSheetPicker() {
    var wb = currentWorkbook();
    return '<div class="modal modal--sheet" role="dialog" aria-modal="true"><div class="modal__backdrop" data-act="sheet-close"></div>' +
      '<div class="modal__panel modal__panel--sheet"><div class="modal__title">Choose a Paket Soal</div>' +
      '<div class="modal__sub">' + esc(wb ? wb.name : '') + ' · ' + plural(wb ? wb.sheetNames.length : 0, 'sheet') + '</div>' +
      '<div class="search">' + icon('search') + '<input id="qb-sheet-search" class="input" type="search" placeholder="Type to search" autocomplete="off" value="' +
      esc(A.ui.sheetSearch) + '"></div><ul class="sheetlist" id="qb-sheet-list">' + sheetListHtml() + '</ul>' +
      '<div class="modal__actions">' + btn('Close', 'sheet-close', { variant: 'secondary' }) + '</div></div></div>';
  }

  function optionListHtml(question, highlightCorrect) {
    return '<div class="optlist">' + question.display_order.map(function (letter, i) {
      var correct = highlightCorrect && letter === question.correct;
      return '<div class="optlist__item' + (correct ? ' optlist__item--correct' : '') + '"><span class="optlist__key">' + E.LETTERS[i] +
        '</span><span class="optlist__text">' + MD.renderInline(question.options[letter]) + '</span></div>';
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------- history
  function renderHistoryTab() {
    var out = [];
    var he = A.ui.errors.hist;
    if (he) { out.push(systemAlert(he[0], he[1], 'VALIDATION', 'warn')); delete A.ui.errors.hist; }
    var summary = E.summarizeSessions(A.sessions.map(function (s) { return { name: s.name, record: s.record, savedAt: s.savedAt / 1000 }; }));
    var rows = summary.rows;
    if (!rows.length) {
      out.push(card('<div class="empty"><div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>' +
        '<div class="empty__title">No saved sessions yet</div><div class="empty__body">Complete an assessment and use “Save result” on the analytics dashboard. ' +
        'Artifacts appear here as &lt;Sheet&gt;_Session_&lt;N&gt;.json.</div></div>' +
        '<div class="btn-col">' + btn('Import session JSON', 'attach-json', { variant: 'ghost', icon: 'json' }) + '</div>'));
      return out.join('');
    }
    var totalTime = 0, sumAcc = 0;
    var sheets = {};
    rows.forEach(function (r) {
      totalTime += r.durationS;
      sumAcc += r.accuracy;
      sheets[r.sheet] = true;
    });
    // Like pandas idxmax: the first maximum in table order (newest first).
    var best = rows.reduce(function (b, r) { return r.accuracy > b.accuracy ? r : b; }, rows[0]);
    out.push('<div class="tiles tiles--2">' +
      tile('Sessions archived', String(rows.length), Object.keys(sheets).length + ' distinct paket soal', 'brand') +
      tile('Mean accuracy', E.fixed(sumAcc / rows.length, 1) + '<small>%</small>', 'Across all artifacts', 'info') +
      tile('Best accuracy', E.fixed(best.accuracy, 1) + '<small>%</small>', best.file, 'success') +
      tile('Study time logged', E.formatHHMMSS(totalTime), 'Wall-clock duration', 'amber') + '</div>');
    out.push(card(cardHead('Trajectory', 'Accuracy over time', 'One line per paket soal; shaded band marks ≥ 80%.') +
      '<div class="chart-box">' + CH.historyTrend(rows) + '</div>'));
    if (!A.ui.histSel || !rows.some(function (r) { return r.file === A.ui.histSel; })) A.ui.histSel = rows[0].file;
    var list = rows.map(function (r) {
      var on = r.file === A.ui.histSel;
      var tone = r.accuracy >= 80 ? 'success' : (r.accuracy >= 60 ? 'amber' : 'danger');
      return '<li><button type="button" class="hist' + (on ? ' is-on' : '') + '" data-act="hist-select" data-name="' + esc(r.file) + '">' +
        '<span class="hist__radio"></span><span class="hist__main"><span class="hist__file mono">' + esc(r.file) + '</span>' +
        '<span class="hist__meta">' + esc(r.sheet) + ' · ' + esc(r.mode) + ' · ' + esc(r.timer) + '</span>' +
        '<span class="hist__meta">' + fmtDateTime(r.finished) + ' · ' + r.correct + '/' + r.questions + ' · ' + esc(r.duration) + ' · ' + E.fixed(r.avg, 1) + 's/Q</span></span>' +
        '<span class="hist__acc">' + chip(E.fixed(r.accuracy, 1) + '%', tone) + '</span></button></li>';
    }).join('');
    out.push(card(cardHead('Archive', 'Saved session artifacts', 'Select an artifact, then hydrate the full analytics dashboard.') +
      '<ul class="histlist">' + list + '</ul>' +
      '<div class="btn-grid">' + btn('Hydrate dashboard', 'hydrate', { variant: 'primary', icon: 'chart' }) +
      btn('Delete', 'hist-delete', { variant: 'danger-ghost', icon: 'trash' }) + '</div>' +
      '<div class="btn-col">' + btn('Import session JSON', 'attach-json', { variant: 'ghost', icon: 'json' }) + '</div>'));
    if (summary.broken.length) {
      out.push(banner('Skipped ' + summary.broken.length + ' unreadable file(s): ' + summary.broken.slice(0, 5).join(', '), 'warn', '!'));
    }
    return out.join('');
  }

  // ---------------------------------------------------------------- countdown
  function renderCountdown() {
    var s = A.state;
    var cfg = s.config;
    var count = E.questionCount(s);
    var timed = cfg.timer_mode !== 'none';
    var armedAt = (s.telemetry && s.telemetry.armed_at) || now();
    var elapsed = Math.max(0, now() - armedAt);
    var delay = function (k) { return (k - elapsed).toFixed(2) + 's'; };
    var frames = [['3', 0], ['2', 1], ['1', 2], ['GO', 3]].map(function (f) {
      return '<span class="countdown__num' + (f[0] === 'GO' ? ' countdown__num--go' : '') + '" style="animation-delay:' + delay(f[1]) + '">' + f[0] + '</span>';
    }).join('');
    return '<div class="stack">' + card(cardHead('Pre-flight · arming session', cfg.sheet, cfg.workbook + ' · ' + plural(count, 'question'),
      chip('Telemetry armed', 'amber', true)) +
      '<div class="tiles tiles--2">' +
      tile('Mode', E.MODE_LABELS[cfg.mode].replace(' Mode', ''), null, 'brand') +
      tile('Questions', String(count), null, 'info') +
      tile('Clock', timed ? E.formatHHMMSS(cfg.timer_seconds) : 'Untimed', E.TIMER_LABELS[cfg.timer_mode], 'amber') +
      tile('Navigation', cfg.allow_previous ? 'Free' : 'Linear', null, 'success') + '</div>' +
      '<div class="countdown"><div class="countdown__ring"><span></span><span></span><span></span></div>' +
      '<div class="countdown__stage">' + frames + '</div><div class="countdown__caption">Session begins in</div>' +
      '<div class="countdown__bar"><span style="animation-delay:' + delay(0) + '"></span></div></div>', { accent: true }) + '</div>';
  }

  // ---------------------------------------------------------------- session
  function nomorLabel(q, cfg) {
    return (cfg.shuffle_questions ? 'Source Nomor ' : 'Nomor ') + q.nomor;
  }

  function renderSession() {
    var s = A.state;
    var cfg = s.config;
    var idx = s.cursor;
    var q = s.questions[idx];
    var snap = E.progressSnapshot(s);
    var statuses = s.questions.map(function (x, i) { return E.questionStatus(s, i); });
    var pct = snap.total ? Math.round(100 * snap.answered / snap.total) : 0;
    var third = cfg.allow_previous ? tile('Flagged', String(snap.flagged), 'Marked for review', 'amber')
      : tile('Remaining', String(snap.unanswered), 'Not yet answered', 'amber');
    var top = '<div class="session-top" id="qb-session-top">' + timerWidgetHtml() +
      '<div class="tiles tiles--4 tiles--compact">' +
      tile('Question', pad2(snap.position) + '<small> / ' + pad2(snap.total) + '</small>', nomorLabel(q, cfg), 'brand') +
      tile('Answered', snap.answered + '<small> / ' + snap.total + '</small>', pct + '% complete', 'info') + third +
      tile('Mode', cfg.mode === E.MODE_FLASHCARD ? 'Flashcards' : 'Quiz', E.TIMER_LABELS[cfg.timer_mode], 'success') + '</div>' +
      progressHtml(snap, statuses) + '</div>';
    var main = cfg.mode === E.MODE_FLASHCARD ? renderFlashcard(q, idx, cfg) : renderQuizQuestion(q, idx, cfg);
    return '<div class="stack">' + top + main + renderFinishConfirmation(snap) + renderControlRail(cfg, statuses, snap) + '</div>';
  }

  function timerWidgetHtml() {
    return '<div class="timer" id="qb-timer"><svg class="timer__ring" viewBox="0 0 48 48" aria-hidden="true">' +
      '<circle class="timer__track" cx="24" cy="24" r="20"></circle><circle class="timer__bar" cx="24" cy="24" r="20"></circle></svg>' +
      '<div class="timer__meta"><div class="timer__label" data-part="label">Timer</div><div class="timer__digits" data-part="digits">--:--:--</div>' +
      '<div class="timer__status" data-part="status">Initialising…</div></div></div>';
  }

  function progressHtml(snap, statuses) {
    var pPos = snap.total ? 100 * snap.position / snap.total : 0;
    var pAns = snap.total ? 100 * snap.answered / snap.total : 0;
    var ticks = '';
    if (snap.total <= 120) {
      ticks = '<div class="progress__ticks">' + statuses.map(function (st) { return '<span class="progress__tick progress__tick--' + st + '"></span>'; }).join('') + '</div>';
    }
    return '<div class="progress"><div class="progress__meta"><span class="progress__label">Session progress</span><span class="progress__count">' +
      snap.position + ' <span>/ ' + snap.total + '</span></span></div><div class="progress__track"><div class="progress__answered" style="width:' +
      pAns.toFixed(2) + '%"></div><div class="progress__fill" style="width:' + pPos.toFixed(2) + '%"></div></div>' + ticks + '</div>';
  }

  function questionHeader(q, idx, cfg) {
    var s = A.state;
    var chips = [chip(nomorLabel(q, cfg), 'neutral')];
    if (E.has(s.expired, idx)) chips.push(chip('Time expired', 'danger'));
    else if (E.isLocked(s, idx)) chips.push(chip('Locked', 'info'));
    if (E.has(s.flags, idx)) chips.push(chip('Flagged', 'amber'));
    return '<div class="qhead"><div class="qhead__left"><span class="qnum">Q' + pad2(idx + 1) + '</span>' + chips.join('') + '</div>' +
      '<div class="eyebrow qhead__sheet">' + esc(cfg.sheet) + '</div></div>';
  }

  function flagToggle(idx, cfg) {
    if (!cfg.allow_previous) return '';
    var on = E.has(A.state.flags, idx);
    return '<button type="button" class="check' + (on ? ' is-on' : '') + '" role="checkbox" aria-checked="' + on + '" data-act="flag" data-idx="' + idx + '">' +
      '<span class="check__box">' + icon('check') + '</span><span>Mark for review</span></button>';
  }

  function shuffledSourceLabel(q, source) {
    var original = source.split(' ').pop();
    if (E.LETTERS.indexOf(original) >= 0) {
      var shown = E.displayLetter(q, original);
      if (shown !== '—' && shown !== original) return source + ' (sheet column) · shown here as option ' + shown;
    }
    return source;
  }

  function feedbackPanel(kind, title, source, explanation, answerHtml) {
    var glyph = { ok: '✓', bad: '✕', info: '◆' }[kind] || '◆';
    return '<div class="fb fb--' + kind + '"><div class="fb__title">' + glyph + ' ' + esc(title) + '</div>' + (answerHtml || '') +
      '<div class="fb__source">Source · ' + esc(source) + '</div><div class="md fb__body">' + MD.render(explanation) + '</div></div>';
  }

  function renderQuizQuestion(q, idx, cfg) {
    var s = A.state;
    var locked = E.isLocked(s, idx);
    var order = q.display_order;
    var selection = E.currentSelection(s, idx);
    var showFeedback = cfg.direct_feedback && (E.has(s.submitted, idx) || E.has(s.expired, idx));
    var chosen = E.getMap(s.answers, idx) || null;
    var opts = '<div class="options" role="radiogroup" aria-label="Select your answer">' + order.map(function (letter, i) {
      var cls = 'opt';
      if (letter === selection) cls += ' is-selected';
      if (showFeedback && letter === q.correct) cls += ' opt--correct';
      if (showFeedback && chosen && chosen !== q.correct && letter === chosen) cls += ' opt--wrong';
      return '<button type="button" class="' + cls + '" role="radio" aria-checked="' + (letter === selection) + '" data-act="select" data-idx="' + idx +
        '" data-letter="' + letter + '"' + (locked ? ' disabled' : '') + '><span class="opt__key">' + E.LETTERS[i] + '</span><span class="opt__text">' +
        MD.renderInline(q.options[letter]) + '</span></button>';
    }).join('') + '</div>';
    var fb = '';
    if (showFeedback) {
      var correctLabel = E.displayLetter(q, q.correct) + '. ' + q.options[q.correct];
      var ex = E.resolveExplanation(q, chosen);
      var source = shuffledSourceLabel(q, ex[1]);
      if (!chosen) {
        fb = feedbackPanel('info', 'Time expired — no answer recorded', source, ex[0],
          '<div class="fb__answer">Correct answer: <b>' + MD.renderInline(correctLabel) + '</b></div>');
      } else if (chosen === q.correct) {
        fb = feedbackPanel('ok', 'Correct', source, ex[0], '<div class="fb__answer">You selected <b>' + MD.renderInline(correctLabel) + '</b></div>');
      } else {
        var chosenLabel = E.displayLetter(q, chosen) + '. ' + q.options[chosen];
        fb = feedbackPanel('bad', 'Incorrect', source, ex[0], '<div class="fb__answer">You selected <b class="txt-danger">' + MD.renderInline(chosenLabel) +
          '</b> · Correct answer: <b>' + MD.renderInline(correctLabel) + '</b></div>');
      }
    } else if (E.has(s.expired, idx)) {
      fb = banner('Time expired for this question. Your last selection (if any) was recorded.', 'warn', '◷');
    }
    return card(questionHeader(q, idx, cfg) + '<div class="md qtext">' + MD.render(q.text) + '</div>' + flagToggle(idx, cfg) + opts + fb +
      quizNavigation(idx, cfg, locked, selection), { cls: 'qcard' });
  }

  function quizNavigation(idx, cfg, locked, selection) {
    var last = idx === E.questionCount(A.state) - 1;
    var needsSubmit = cfg.direct_feedback && !locked;
    var parts = [];
    if (cfg.allow_previous) parts.push(btn('Previous', 'prev', { icon: 'left', data: { idx: idx }, disabled: idx === 0, variant: 'secondary' }));
    if (needsSubmit && !last) parts.push(btn('Skip', 'next', { icon: 'skip', data: { idx: idx }, variant: 'ghost' }));
    if (needsSubmit) parts.push(btn('Submit answer', 'submit', { icon: 'check', data: { idx: idx }, variant: 'primary', disabled: !selection }));
    else if (last) parts.push(btn('Finish & analyze', 'finish-request', { icon: 'flag', variant: 'success' }));
    else parts.push(btn('Next question', 'next', { icon: 'right', iconRight: true, data: { idx: idx }, variant: 'primary' }));
    var html = '<div class="qnav qnav--' + parts.length + '">' + parts.join('') + '</div>';
    if (needsSubmit && last) html += '<div class="qnav qnav--1">' + btn('Finish without submitting', 'finish-request', { icon: 'flag', variant: 'ghost' }) + '</div>';
    return html;
  }

  function renderFlashcard(q, idx, cfg) {
    var s = A.state;
    var expired = E.has(s.expired, idx);
    var revealed = E.has(s.revealed, idx) || expired;
    var grade = E.getMap(s.grades, idx);
    var last = idx === E.questionCount(s) - 1;
    var navPrev = cfg.allow_previous ? btn('Previous', 'prev', { icon: 'left', data: { idx: idx }, disabled: idx === 0 }) : '';
    if (!revealed) {
      return card(questionHeader(q, idx, cfg) + '<div class="flash__side">' + chip('Front · prompt', 'brand') + '</div>' +
        '<div class="md qtext">' + MD.render(q.text) + '</div>' + optionListHtml(q, false) + flagToggle(idx, cfg) +
        '<div class="flash__hint">⟲ Recall the answer, then flip the card to verify.</div>' +
        '<div class="qnav qnav--' + (navPrev ? 2 : 1) + '">' + navPrev + btn('Reveal answer', 'reveal', { icon: 'flip', variant: 'info', data: { idx: idx } }) + '</div>',
      { cls: 'qcard flash flash--front' });
    }
    var correct = q.correct;
    var ex = E.resolveExplanation(q, correct);
    var source = shuffledSourceLabel(q, ex[1]);
    var all = q.display_order.map(function (letter) {
      var text = E.resolveExplanation(q, letter)[0];
      var mark = letter === correct ? '✓' : '·';
      return '<div class="allopt' + (letter === correct ? ' allopt--correct' : '') + '"><div class="allopt__head">' + mark + ' ' + E.displayLetter(q, letter) + '. ' +
        MD.renderInline(q.options[letter]) + '</div><div class="md">' + MD.render(text) + '</div></div>';
    }).join('');
    var grading = expired
      ? banner('Time expired for this card — it was recorded as not graded.', 'warn', '◷')
      : '<div class="eyebrow">Self-assessment</div><div class="qnav qnav--2">' +
        btn('I knew it', 'grade', { icon: 'up', variant: grade === true ? 'success-solid' : 'success', data: { idx: idx, knew: '1' }, pressed: grade === true }) +
        btn('Review again', 'grade', { icon: 'restart', variant: grade === false ? 'danger-solid' : 'danger', data: { idx: idx, knew: '0' }, pressed: grade === false }) + '</div>';
    var nextBtn = last ? btn('Finish & analyze', 'finish-request', { icon: 'flag', variant: 'success' })
      : btn('Next card', 'next', { icon: 'right', iconRight: true, variant: 'primary', data: { idx: idx } });
    return card(questionHeader(q, idx, cfg) + '<div class="flash__side">' + chip('Back · answer', 'info') + '</div>' +
      '<div class="md qtext">' + MD.render(q.text) + '</div>' +
      '<div class="flash__answer"><div class="flash__answer-label">Correct answer · option ' + E.displayLetter(q, correct) + '</div>' +
      '<div class="flash__answer-text">' + MD.renderInline(q.options[correct]) + '</div></div>' +
      feedbackPanel('info', 'Why this is correct', source, ex[0], '') +
      disclosure('allopts-' + idx, 'All options with their explanations', all, 'list') +
      flagToggle(idx, cfg) + grading +
      '<div class="qnav qnav--' + (navPrev ? 2 : 1) + '">' + navPrev + nextBtn + '</div>', { cls: 'qcard flash flash--back' });
  }

  function renderFinishConfirmation(snap) {
    if (!A.state.confirm_finish) return '';
    var parts = [];
    if (snap.unanswered) parts.push(snap.unanswered + ' unanswered question(s)');
    if (snap.flagged) parts.push(snap.flagged + ' flagged for review');
    return card(banner('You still have ' + parts.join(' and ') + '. Submit the session anyway?', 'warn', '!') +
      '<div class="btn-grid">' + btn('Keep working', 'finish-cancel', { icon: 'undo' }) +
      btn('Submit session', 'finish-confirm', { icon: 'task', variant: 'success' }) + '</div>', { tight: true, id: 'qb-confirm-finish' });
  }

  function renderControlRail(cfg, statuses, snap) {
    var total = Math.max(snap.total, 1);
    var out = [cardHead('Control rail', 'Session telemetry')];
    out.push(kvList([
      ['Paket soal', cfg.sheet],
      ['Options', cfg.shuffle_options ? 'Shuffled' : 'As authored'],
      ['Questions', cfg.shuffle_questions ? 'Shuffled' : 'As authored'],
      ['Feedback', cfg.mode === E.MODE_FLASHCARD ? 'Reveal per card' : (cfg.direct_feedback ? 'Immediate' : 'At the end')],
      ['Navigation', cfg.allow_previous ? 'Free' : 'Linear']
    ]));
    out.push('<div class="meter"><div class="meter__track"><div class="meter__seg" style="width:' + (100 * snap.answered / total).toFixed(1) +
      '%;background:#008FFB"></div><div class="meter__seg" style="width:' + (100 * snap.flagged / total).toFixed(1) + '%;background:#FFB020"></div></div>' +
      '<div class="meter__legend"><span><i style="background:#008FFB"></i>Answered</span><span><i style="background:#FFB020"></i>Flagged</span></div></div>');
    if (cfg.allow_previous) {
      out.push('<hr class="divider"><div class="eyebrow">Question navigator</div>');
      out.push('<div class="navgrid' + (statuses.length > 30 ? ' navgrid--scroll' : '') + '">' + statuses.map(function (st, i) {
        return '<button type="button" class="navbtn navbtn--' + st + '" data-act="jump" data-idx="' + i + '" aria-label="Question ' + (i + 1) + ' (' + st + ')">' +
          pad2(i + 1) + '</button>';
      }).join('') + '</div>');
      out.push('<div class="chips">' + chip('Current', 'brand') + chip('Answered', 'info') + chip('Flagged', 'amber') + chip('Expired', 'danger') + '</div>');
    }
    out.push('<hr class="divider">');
    out.push(btn('Submit session', 'finish-request', { icon: 'task', variant: 'success' }));
    out.push(btn(A.ui.confirmAbort ? 'Cancel abort' : 'Abort session', 'abort-request', { icon: 'close', variant: 'ghost' }));
    if (A.ui.confirmAbort) {
      out.push(banner('Aborting discards this session without analytics.', 'danger', '!'));
      out.push(btn('Confirm abort', 'abort-confirm', { icon: 'trash', variant: 'danger' }));
    }
    return card(out.join(''), { tight: true, cls: 'rail' });
  }

  // ---------------------------------------------------------------- results
  function renderResults() {
    var s = A.state;
    var record = s.result;
    var summary = record.summary || {};
    var config = record.config || {};
    var timeline = record.timeline || {};
    var accuracy = Number(summary.accuracy_pct || 0);
    var band = E.performanceBand(accuracy);
    var finished = String(timeline.finished_at || '').replace('T', ' ').slice(0, 16);
    var out = [];
    out.push('<section class="section-head"><div class="eyebrow">Post-mortem analytics · diagnostic dashboard</div>' +
      '<h1 class="section-head__title">' + esc(record.sheet) + '</h1><div class="section-head__sub">' +
      esc((E.MODE_LABELS[config.mode] || '') + ' · ' + (E.TIMER_LABELS[config.timer_mode] || '') + ' · ' + (record.workbook || '') + ' · finished ' + finished) +
      '</div></section>');
    if (s.result_source === 'history') out.push(banner('Hydrated from the archive · ' + (s.saved_path || ''), 'info', '◷'));
    if (timeline.finish_reason === E.FINISH_TIME_UP) {
      out.push(banner('The clock expired — the session was auto-submitted with the answers recorded so far.', 'warn', '◷'));
    }
    var re = A.ui.errors.results;
    if (re) { out.push(systemAlert(re[0], re[1], 'VALIDATION', 'warn')); delete A.ui.errors.results; }
    out.push(renderSummaryCard(summary, accuracy, band));
    out.push(renderTimeCard(summary));
    out.push(card(cardHead('Outcome mix', 'Distribution') + '<div class="donut">' + CH.outcomeDonut(summary) +
      '<div class="donut__legend"><span><i style="background:#00E396"></i>Correct · ' + (summary.correct || 0) + '</span><span><i style="background:#FF003F"></i>Incorrect · ' +
      (summary.wrong || 0) + '</span><span><i style="background:#64748B"></i>Skipped · ' + (summary.skipped || 0) + '</span></div></div>'));
    var items = record.items || [];
    var stats = E.computeTimeStatistics(items.map(function (i) { return i.time_spent_s; }));
    var chartRows = items.map(function (it, k) {
      return { label: 'Q' + it.position, time: Number(it.time_spent_s), status: it.status, excerpt: MD.plain(it.question, 90), isOutlier: !!stats.outlier_mask[k] };
    });
    A.chartRows = chartRows;
    out.push(card(cardHead('Chronological telemetry', 'Time spent per question',
      'Active solve time; bars outlined in azure exceed μ + 1σ (statistical outliers).',
      chip('μ ' + E.fixed(stats.mean, 1) + 's', 'neutral') + chip('σ ' + E.fixed(stats.std, 1) + 's', 'neutral') +
      chip(stats.outlier_mask.filter(Boolean).length + ' outlier(s)', 'info')) +
      '<div class="chart-scroll">' + CH.timePerQuestion(chartRows, stats) + '</div>' +
      '<div class="chart-legend"><span><i style="background:#00E396"></i>Correct</span><span><i style="background:#FF003F"></i>Incorrect</span>' +
      '<span><i style="background:#64748B"></i>Skipped</span><span><i class="ring"></i>Outlier</span></div>' +
      '<div class="chart-tip" id="qb-chart-tip">' + chartTipHtml() + '</div>'));
    out.push(renderReviewCard(record));
    out.push(renderExportCard(record));
    return '<div class="stack">' + out.join('') + '</div>';
  }

  function chartTipHtml() {
    var rows = A.chartRows || [];
    var r = rows[A.ui.chartTip];
    if (!r) return '<span class="muted small">Tap a bar to see the question.</span>';
    var label = { correct: 'Correct', wrong: 'Incorrect', skipped: 'Skipped' }[r.status];
    return '<b>' + esc(r.label) + '</b> · ' + E.fixed(r.time, 1) + 's · ' + label + (r.isOutlier ? ' · outlier' : '') + '<br><span class="muted">' + esc(r.excerpt) + '</span>';
  }

  function renderChartTip() {
    var el = doc.getElementById('qb-chart-tip');
    if (el) el.innerHTML = chartTipHtml();
  }

  function renderSummaryCard(summary, accuracy, band) {
    var total = Math.max(parseInt(summary.total || 0, 10), 1);
    var perfect = summary.correct === summary.total && summary.total > 0;
    var color = E.accuracyColor(accuracy);
    return card(cardHead('Executive summary', 'Score & accuracy', null, chip(band[0], band[1], true)) +
      (perfect ? '<div class="confetti" aria-hidden="true">' + new Array(14).join('<i></i>') + '</div>' : '') +
      '<div class="kpi" style="--kpi-color:' + color + '"><div class="kpi__label">Accuracy rate</div><div class="kpi__value">' +
      E.fixed(accuracy, 1) + '<small>%</small></div></div>' +
      '<div class="tiles tiles--3">' +
      tile('Score', (summary.correct || 0) + '<small> / ' + (summary.total || 0) + '</small>', null, 'success') +
      tile('On attempted', E.fixed(Number(summary.attempted_accuracy_pct || 0), 0) + '<small>%</small>', (summary.answered || 0) + ' answered', 'info') +
      tile('Flagged', String(summary.flagged || 0), (summary.expired || 0) + ' expired', 'amber') + '</div>' +
      '<div class="meter"><div class="meter__track">' +
      '<div class="meter__seg" style="width:' + (100 * (summary.correct || 0) / total).toFixed(2) + '%;background:#00E396"></div>' +
      '<div class="meter__seg" style="width:' + (100 * (summary.wrong || 0) / total).toFixed(2) + '%;background:#FF003F"></div>' +
      '<div class="meter__seg" style="width:' + (100 * (summary.skipped || 0) / total).toFixed(2) + '%;background:#64748B"></div></div>' +
      '<div class="meter__legend"><span><i style="background:#00E396"></i>' + (summary.correct || 0) + ' correct</span><span><i style="background:#FF003F"></i>' +
      (summary.wrong || 0) + ' incorrect</span><span><i style="background:#64748B"></i>' + (summary.skipped || 0) + ' skipped</span></div></div>',
    { accent: true });
  }

  function renderTimeCard(summary) {
    var allocated = summary.allocated_time_s;
    var right = allocated ? chip('Budgeted', 'amber') : chip('Untimed', 'neutral');
    return card(cardHead('Time performance', 'Taken vs allocated', null, right) +
      '<div class="kpi" style="--kpi-color:#F1F5F9"><div class="kpi__label">Total time taken</div><div class="kpi__value kpi__value--mono">' +
      E.formatHHMMSS(summary.total_time_s) + '</div><div class="tile__hint">Allocated · <b>' + (allocated ? E.formatHHMMSS(allocated) : 'No budget') + '</b></div></div>' +
      (allocated ? '<div class="gauge">' + CH.timeGauge(summary) + '</div>' : '') +
      '<div class="tiles tiles--3">' +
      tile('Mean / Q', E.formatDurationShort(summary.avg_time_s), null, 'info') +
      tile('Median', E.formatDurationShort(summary.median_time_s), null, 'info') +
      tile('Slowest', E.formatDurationShort(summary.max_time_s), (summary.outlier_count || 0) + ' outlier(s)', 'brand') + '</div>');
  }

  function renderReviewCard(record) {
    var rows = E.buildReviewRows(record);
    var filtered = E.filterReview(rows, A.ui.reviewFilter);
    var head = cardHead('Diagnostic review matrix', 'Question-level audit trail',
      'Explanations are routed from the exact column of the option you chose. Letters refer to the source sheet (before any shuffling).');
    var seg = '<div class="seg seg--scroll" role="radiogroup">' + E.REVIEW_FILTERS.map(function (f) {
      var n = E.filterReview(rows, f).length;
      return '<button type="button" class="seg__opt' + (f === A.ui.reviewFilter ? ' is-on' : '') + '" data-act="filter" data-value="' + f + '">' +
        esc(f) + ' <span class="seg__count">' + n + '</span></button>';
    }).join('') + '</div>';
    if (!filtered.length) return card(head + seg + banner('No questions match this filter.', 'success', '✓'));
    var anyOpen = Object.keys(A.ui.reviewOpen).some(function (k) { return A.ui.reviewOpen[k]; });
    var tools = '<div class="review-tools">' + (anyOpen
      ? btn('Collapse all', 'walk-none', { variant: 'ghost', icon: 'list', block: false })
      : btn('Rich-text walkthrough · ' + Math.min(filtered.length, WALKTHROUGH_LIMIT) + ' question(s)', 'walk-all', { variant: 'ghost', icon: 'list', block: false })) + '</div>';
    var list = '<ul class="review">' + filtered.map(function (r) {
      var open = !!A.ui.reviewOpen[r.number];
      var tone = r.status === 'correct' ? 'success' : (r.status === 'wrong' ? 'danger' : 'neutral');
      var verdict = { correct: '✓ Correct', wrong: '✕ Incorrect', skipped: '○ Skipped' }[r.status];
      var row = '<button type="button" class="review__row" data-act="review-toggle" data-n="' + r.number + '" aria-expanded="' + open + '">' +
        '<span class="review__num mono">#' + pad2(r.number) + '</span><span class="review__main"><span class="review__q">' + esc(MD.plain(r.question, 120)) + '</span>' +
        '<span class="review__meta">' + chip(r.result, tone) + '<span class="mono">' + E.fixed(r.time, 1) + 's</span>' +
        (r.flagged ? chip('⚑ Flagged', 'amber') : '') + (r.isOutlier ? chip('Outlier', 'info') : '') + (r.expired ? chip('Expired', 'danger') : '') +
        '<span class="muted">Nomor ' + esc(r.nomor) + '</span></span></span>' + icon('chevron', 'review__chev') + '</button>';
      var body = '';
      if (open) {
        var ok = r.status === 'correct';
        body = '<div class="review__body"><div class="review__title">Q' + pad2(r.number) + ' · ' + verdict + ' · ' + E.fixed(r.time, 1) + 's</div>' +
          '<div class="md">' + MD.render(r.question) + '</div><div class="review-cells"><div class="review-cell ' + (ok ? 'review-cell--ok' : 'review-cell--bad') + '">' +
          '<div class="review-cell__label">Your answer</div>' + MD.renderInline(r.yourAnswer) + '</div><div class="review-cell review-cell--ok">' +
          '<div class="review-cell__label">Correct answer</div>' + MD.renderInline(r.correctAnswer) + '</div></div>' +
          '<div class="fb__source">Source · ' + esc(r.explanationSource) + '</div><div class="md">' + MD.render(r.explanation) + '</div></div>';
      }
      return '<li class="review__item review__item--' + r.status + (open ? ' is-open' : '') + '">' + row + body + '</li>';
    }).join('') + '</ul>';
    return card(head + seg + tools + list);
  }

  function renderExportCard(record) {
    var s = A.state;
    var saved = s.saved_path;
    var names = A.sessions.map(function (x) { return x.name; });
    var wbExists = !!workbookByName(String(record.workbook || ''));
    var inner = cardHead('Export & save', 'Persistent artifact generation',
      'Saved in the app archive as <Sheet>_Session_<N>.json — the index auto-increments, never overwrites.');
    inner += saved ? banner('Artifact in archive · ' + saved, 'success', '✓')
      : banner('Next artifact name · ' + E.nextSessionName(record.sheet, names), 'info', '◆');
    inner += '<div class="btn-grid">' +
      btn(saved ? 'Saved' : 'Save result', 'save', { icon: 'save', variant: 'success', disabled: !!saved || s.result_source === 'history' }) +
      btn('Download CSV', 'dl-csv', { icon: 'table' }) +
      btn('Download JSON', 'dl-json', { icon: 'json' }) +
      btn('Retake set', 'retake', { icon: 'restart', variant: 'info', disabled: !wbExists }) + '</div>' +
      btn('New assessment', 'new', { icon: 'plus', variant: 'primary' });
    return card(inner, { accent: true });
  }

  // ================================================================ live updates (timers, clock)
  function updateLive() {
    var clock = doc.getElementById('qb-clock');
    if (clock) {
      var d = new Date();
      clock.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }
    if (A.state.view === E.VIEW_SESSION && !A.fatal) updateTimerWidget();
  }

  function hhmmss(sec) {
    sec = Math.max(0, Math.floor(sec));
    return pad2(Math.floor(sec / 3600)) + ':' + pad2(Math.floor((sec % 3600) / 60)) + ':' + pad2(sec % 60);
  }

  function updateTimerWidget() {
    var root = doc.getElementById('qb-timer');
    if (!root) return;
    var spec = E.timerDisplaySpec(A.state, now());
    var label = root.querySelector('[data-part="label"]');
    var digits = root.querySelector('[data-part="digits"]');
    var status = root.querySelector('[data-part="status"]');
    var bar = root.querySelector('.timer__bar');
    var circ = 2 * Math.PI * 20;
    bar.style.strokeDasharray = circ.toFixed(2);
    var accent = 'ok';
    var ring = 0;
    label.textContent = spec.label;
    var warnAt = Math.max(5, Math.round((spec.total || 0) * 0.25));
    var criticalAt = Math.max(3, Math.min(30, Math.round((spec.total || 0) * 0.1)));
    root.classList.remove('is-frozen');
    if (spec.frozen) {
      root.classList.add('is-frozen');
      digits.textContent = hhmmss(spec.frozen_value || 0);
      ring = spec.total > 0 ? (spec.frozen_value || 0) / spec.total : 0;
      accent = 'frozen';
      status.textContent = (spec.frozen_note || 'Locked') + ' · clock paused';
    } else if (spec.mode === 'stopwatch') {
      var elapsed = Math.max(0, (Date.now() - spec.target_ms) / 1000);
      digits.textContent = hhmmss(elapsed);
      ring = (elapsed % 60) / 60;
      accent = 'good';
      status.textContent = 'Untimed · telemetry live';
    } else {
      var remaining = (spec.target_ms - Date.now()) / 1000;
      digits.textContent = hhmmss(Math.ceil(Math.max(0, remaining)));
      ring = spec.total > 0 ? remaining / spec.total : 0;
      if (remaining <= 0) { accent = 'critical'; status.textContent = 'Time up · auto-advancing'; }
      else if (remaining <= criticalAt) { accent = 'critical'; status.textContent = 'Critical · ' + Math.ceil(remaining) + 's left'; }
      else if (remaining <= warnAt) { accent = 'warn'; status.textContent = 'Under 25% of budget'; }
      else { accent = 'ok'; status.textContent = 'Budget ' + hhmmss(spec.total); }
    }
    ring = Math.max(0, Math.min(1, ring));
    bar.style.strokeDashoffset = (circ * (1 - ring)).toFixed(2);
    root.setAttribute('data-accent', accent);
  }

  function tick() {
    if (!A.booted || A.fatal) return;
    var s = A.state;
    try {
      if (s.view === E.VIEW_COUNTDOWN) {
        var armed = (s.telemetry && s.telemetry.armed_at) || now();
        if (now() - armed >= COUNTDOWN_SECONDS) {
          E.beginExecution(s, now());
          flushLive();
          render();
          return;
        }
      } else if (s.view === E.VIEW_SESSION && s.config && s.config.timer_mode !== 'none') {
        var outcome = E.checkTimeout(s, now());
        if (outcome) {
          if (outcome === E.TIMEOUT_TOTAL) toast('Time is up · session auto-submitted', 'warn');
          else if (s.view === E.VIEW_RESULTS) toast('Final question expired · session submitted', 'warn');
          else toast('Question time expired · moved to the next question', 'warn');
          if (s.view === E.VIEW_RESULTS) { A.ui.reviewOpen = {}; A.ui.reviewFilter = 'All'; }
          A.ui.confirmAbort = false;
          A.ui.modal = null;
          flushLive();
          render();
          return;
        }
      }
      updateLive();
    } catch (e) {
      fatal(e);
    }
  }

  // ================================================================ boot
  function restoreLive(saved) {
    if (!saved || !saved.state || typeof saved.state !== 'object') return;
    var st = saved.state;
    var view = st.view;
    if (view === E.VIEW_SESSION || view === E.VIEW_COUNTDOWN) {
      if (!st.config || !Array.isArray(st.questions) || !st.questions.length || !st.telemetry || !Array.isArray(st.telemetry.time_spent)) return;
    } else if (view === E.VIEW_RESULTS) {
      if (!st.result) return;
    } else {
      return;
    }
    A.state = E.initState(st);
  }

  function start() {
    var view = doc.getElementById('qb-view');
    try {
      A.prefs = Object.assign({}, PREF_DEFAULTS, ST.prefGet('prefs', {}) || {});
      if (['quiz', 'flashcard'].indexOf(A.prefs.mode) < 0) A.prefs.mode = 'quiz';
      if (!(A.prefs.timer_mode in TIMER_DEFAULTS)) A.prefs.timer_mode = 'none';
      if (typeof A.prefs.timer_value !== 'string') A.prefs.timer_value = TIMER_DEFAULTS.total;
      if (g.QuizBankNative && g.QuizBankNative.appVersion) {
        try { A.version = String(g.QuizBankNative.appVersion() || ''); } catch (e) { A.version = ''; }
      }
    } catch (e0) { /* defaults stay */ }

    doc.addEventListener('click', onClick);
    doc.addEventListener('change', onChange);
    doc.addEventListener('input', onInput);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') flushLive();
      else tick();
    });
    g.addEventListener('pagehide', flushLive);
    g.addEventListener('error', function (ev) {
      if (A.booted && !A.fatal && ev && ev.error) fatal(ev.error);
    });
    g.addEventListener('unhandledrejection', function (ev) {
      if (A.booted && !A.fatal && ev && ev.reason) fatal(ev.reason);
    });

    ST.init().then(function () {
      return Promise.all([refreshWorkbooks(), refreshSessions(), ST.kvGet('live').catch(function () { return null; })]);
    }).then(function (res) {
      var fromDb = res[2];
      var fromLs = readLocalLive();
      var newest = fromDb;
      if (fromLs && (!fromDb || (fromLs.savedAt || 0) > (fromDb.savedAt || 0))) newest = fromLs;
      restoreLive(newest);
    }).catch(function (e) {
      A.ui.errors.home = errInfo(e);
    }).then(function () {
      A.booted = true;
      if (view) view.removeAttribute('aria-busy');
      render();
      tick();
      g.setInterval(tick, 250);
      ST.requestPersistence();
    });
  }

  QB.app = { start: start, _A: A, _handle: function (act, data) { handle(act, data || {}, null, A.state, data && data.idx !== undefined ? parseInt(data.idx, 10) : null); } };
})(window);
