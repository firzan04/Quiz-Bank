/*
 * Quiz Bank engine — a faithful JavaScript port of core_engine.py.
 *
 * Owns: schema resolution and row validation of a sheet grid, session
 * configuration, the session state machine (navigation, answers, flags,
 * timers, telemetry), post-session analytics and export formats.
 *
 * Every function is pure or operates on a plain JSON-serialisable state
 * object, so the same code runs in the app and in the Node test-suite.
 */
(function (g) {
  'use strict';

  var QB = (g.QB = g.QB || {});

  // ---------------------------------------------------------------- constants
  var ENGINE_NAME = 'BIG4-QAE';
  var SCHEMA_VERSION = 1;
  var MAX_SHEETS = 1000;
  var MAX_TIMER_SECONDS = 99 * 3600 + 59 * 60 + 59;
  var LETTERS = ['A', 'B', 'C', 'D'];

  var COL_NOMOR = 'Nomor';
  var COL_SOAL = 'Soal';
  var COL_OPTIONS = LETTERS.map(function (l) { return 'Pilihan ' + l; });
  var COL_ANSWER = 'Jawaban Benar';
  var COL_EXPLANATIONS = LETTERS.map(function (l) { return 'Pembahasan jika Pilihan ' + l; });
  var CANONICAL = [COL_NOMOR, COL_SOAL].concat(COL_OPTIONS, [COL_ANSWER], COL_EXPLANATIONS);
  var REQUIRED_NAMED = [COL_SOAL, COL_OPTIONS[0], COL_OPTIONS[1], COL_ANSWER];

  // Insertion order matters (mirrors the Python dict).
  var HEADER_ALIASES = [];
  HEADER_ALIASES.push([COL_NOMOR, ['nomor', 'no', 'nomor soal', 'number', 'num', '#', 'id', 'q', 'q no']]);
  HEADER_ALIASES.push([COL_SOAL, ['soal', 'pertanyaan', 'question', 'questions', 'prompt']]);
  HEADER_ALIASES.push([COL_ANSWER, ['jawaban benar', 'jawaban', 'kunci jawaban', 'kunci', 'answer',
    'correct answer', 'correct', 'key']]);
  LETTERS.forEach(function (letter, i) {
    var l = letter.toLowerCase();
    HEADER_ALIASES.push([COL_OPTIONS[i], ['pilihan ' + l, 'opsi ' + l, 'option ' + l, 'jawaban ' + l, 'choice ' + l, l]]);
    HEADER_ALIASES.push([COL_EXPLANATIONS[i], ['pembahasan jika pilihan ' + l, 'pembahasan pilihan ' + l,
      'pembahasan ' + l, 'pembahasan jika ' + l, 'explanation ' + l, 'explanation if ' + l, 'rationale ' + l]]);
  });

  var MODE_QUIZ = 'quiz';
  var MODE_FLASHCARD = 'flashcard';
  var MODE_LABELS = { quiz: 'Quiz Mode', flashcard: 'Flashcard Mode' };

  var TIMER_NONE = 'none';
  var TIMER_TOTAL = 'total';
  var TIMER_PER_QUESTION = 'per_question';
  var TIMER_LABELS = { none: 'No Timer', total: 'Total Time', per_question: 'Time Per Question' };

  var VIEW_HOME = 'home';
  var VIEW_COUNTDOWN = 'countdown';
  var VIEW_SESSION = 'session';
  var VIEW_RESULTS = 'results';

  var FINISH_COMPLETED = 'completed';
  var FINISH_TIME_UP = 'time_up';
  var FINISH_LABELS = { completed: 'Submitted by candidate', time_up: 'Auto-submitted (time expired)' };

  var STATUS_CORRECT = 'correct';
  var STATUS_WRONG = 'wrong';
  var STATUS_SKIPPED = 'skipped';

  var TIMEOUT_TOTAL = 'total';
  var TIMEOUT_QUESTION = 'question';

  var LETTER_ANSWER = /^\(?\s*(?:pilihan|opsi|option|jawaban)?\s*([a-d])\s*[).:]?\s*$/i;
  var INVALID_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]+/g;
  var RESERVED_WINDOWS = { CON: 1, PRN: 1, AUX: 1, NUL: 1 };
  for (var n = 1; n <= 9; n++) { RESERVED_WINDOWS['COM' + n] = 1; RESERVED_WINDOWS['LPT' + n] = 1; }

  // ---------------------------------------------------------------- errors
  function EngineError(kind, title, detail) {
    this.name = kind || 'EngineError';
    this.kind = kind || 'EngineError';
    this.title = title;
    this.detail = detail;
    this.message = title + ': ' + detail;
  }
  EngineError.prototype = Object.create(Error.prototype);
  EngineError.prototype.constructor = EngineError;

  function err(kind, title, detail) { return new EngineError(kind, title, detail); }

  // ---------------------------------------------------------------- numeric helpers
  /** Python-style round-half-even to `digits` decimals (for exact binary ties). */
  function pyRound(x, digits) {
    digits = digits || 0;
    if (!isFinite(x)) return x;
    var m = Math.pow(10, digits);
    var y = x * m;
    var r = Math.round(y);
    if (Math.abs(y % 1) === 0.5) {
      r = 2 * Math.round(y / 2);
    }
    var out = r / m;
    return out === 0 ? 0 : out; // avoid -0
  }

  /** Format with a fixed number of decimals the way Python's f"{x:.Nf}" does. */
  function fixed(x, digits) {
    if (x === null || x === undefined || isNaN(x)) return 'nan';
    var s = Number(x).toFixed(digits);
    var y = Number(x) * Math.pow(10, digits);
    if (Math.abs(y % 1) === 0.5) {
      s = pyRound(Number(x), digits).toFixed(digits);
    }
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
    return s;
  }

  /** Python's format(x, '.15g'). */
  function formatG15(x) {
    if (x === 0) return Object.is(x, -0) ? '-0' : '0';
    if (!isFinite(x)) return x > 0 ? 'inf' : (x < 0 ? '-inf' : 'nan');
    var expStr = x.toExponential(14); // d.dddddddddddddde±x
    var parts = expStr.split('e');
    var exp = parseInt(parts[1], 10);
    if (exp < -4 || exp >= 15) {
      var mant = parts[0].replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      var sign = exp < 0 ? '-' : '+';
      var e = Math.abs(exp);
      return mant + 'e' + sign + (e < 10 ? '0' + e : String(e));
    }
    var decimals = Math.max(0, 14 - exp);
    var s = x.toFixed(decimals);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // ---------------------------------------------------------------- time helpers
  function pad2(v) { return (v < 10 ? '0' : '') + v; }

  function isoLocal(epochSeconds) {
    if (epochSeconds === null || epochSeconds === undefined) return null;
    var d = new Date(Math.floor(epochSeconds) * 1000);
    var offMin = -d.getTimezoneOffset();
    var sign = offMin >= 0 ? '+' : '-';
    var a = Math.abs(offMin);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }

  function nowIso() { return isoLocal(Date.now() / 1000); }

  function parseHHMMSS(text) {
    var raw = String(text === null || text === undefined ? '' : text).trim();
    if (!raw) throw err('ConfigError', 'Timer value missing', 'Enter a duration in HH:MM:SS format, e.g. 00:30:00.');
    var parts = raw.split(':');
    var ok = parts.length <= 3 && parts.every(function (p) { return /^\d+$/.test(p.trim()); });
    if (!ok) throw err('ConfigError', 'Invalid timer format', "'" + raw + "' is not a valid HH:MM:SS duration.");
    var values = parts.map(function (p) { return parseInt(p.trim(), 10); });
    while (values.length < 3) values.unshift(0);
    var h = values[0], m = values[1], s = values[2];
    if (parts.length >= 2 && s > 59) throw err('ConfigError', 'Invalid timer format', 'Seconds must be between 00 and 59.');
    if (parts.length === 3 && m > 59) throw err('ConfigError', 'Invalid timer format', 'Minutes must be between 00 and 59.');
    var total = h * 3600 + m * 60 + s;
    if (total <= 0) throw err('ConfigError', 'Timer value too small', 'The timer must be at least 00:00:01.');
    if (total > MAX_TIMER_SECONDS) throw err('ConfigError', 'Timer value too large', 'The maximum supported timer is 99:59:59.');
    return total;
  }

  function formatHHMMSS(seconds) {
    if (seconds === null || seconds === undefined || (typeof seconds === 'number' && isNaN(seconds))) return '--:--:--';
    var total = Math.max(0, pyRound(Number(seconds)));
    var h = Math.floor(total / 3600);
    var rem = total % 3600;
    var m = Math.floor(rem / 60);
    var s = rem % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function formatDurationShort(seconds) {
    if (seconds === null || seconds === undefined || (typeof seconds === 'number' && isNaN(seconds))) return '—';
    seconds = Number(seconds);
    if (seconds < 60) return fixed(seconds, 1) + 's';
    var total = pyRound(seconds);
    var h = Math.floor(total / 3600);
    var rem = total % 3600;
    var m = Math.floor(rem / 60);
    var s = rem % 60;
    if (h) return h + 'h ' + pad2(m) + 'm';
    return m + 'm ' + pad2(s) + 's';
  }

  function sanitizeFilenameComponent(name) {
    var cleaned = String(name).replace(INVALID_FILENAME_CHARS, '_');
    cleaned = cleaned.replace(/\s+/g, '_').replace(/^[ ._]+|[ ._]+$/g, '');
    cleaned = cleaned.replace(/_+/g, '_');
    if (!cleaned) cleaned = 'Session';
    if (RESERVED_WINDOWS[cleaned.toUpperCase()]) cleaned = cleaned + '_set';
    return cleaned.slice(0, 120);
  }

  // ---------------------------------------------------------------- text helpers
  function normCell(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function normHeader(v) {
    var t = normCell(v).toLowerCase();
    t = t.replace(/[_\-.:/()[\]]+/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function casefold(s) {
    return s.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  }

  function loose(text) {
    return casefold(String(text).replace(/\s+/g, ' ').trim());
  }

  // ---------------------------------------------------------------- schema resolution
  /**
   * Map a raw grid (array of rows of raw cell strings, '' = empty) onto the
   * canonical 11 columns.
   * Returns {rows: [{excelRow, cells: {col: value}}], layout}.
   */
  function resolveLayout(grid) {
    var width = 0;
    var r, c;
    for (r = 0; r < grid.length; r++) width = Math.max(width, grid[r].length);
    // Drop columns that are empty on every row (pandas dropna(axis=1, how='all')).
    var keep = [];
    for (c = 0; c < width; c++) {
      for (r = 0; r < grid.length; r++) {
        var cell = grid[r][c];
        if (cell !== undefined && cell !== null && cell !== '') { keep.push(c); break; }
      }
    }
    // Index of the first row holding any data (the header candidate).
    var first = -1;
    for (r = 0; r < grid.length && first < 0; r++) {
      for (c = 0; c < keep.length; c++) {
        var v = grid[r][keep[c]];
        if (v !== undefined && v !== null && v !== '') { first = r; break; }
      }
    }
    if (!keep.length || first < 0) return { rows: [], layout: 'positional' };

    var row0 = keep.map(function (col) { return normHeader(grid[first][col]); });
    var hits = {};
    var hitCount = 0;
    for (var idx = 0; idx < row0.length; idx++) {
      for (var a = 0; a < HEADER_ALIASES.length; a++) {
        var canonical = HEADER_ALIASES[a][0];
        if (HEADER_ALIASES[a][1].indexOf(row0[idx]) >= 0 && !(canonical in hits)) {
          hits[canonical] = idx;
          hitCount++;
          break;
        }
      }
    }
    var hasHeader = hitCount >= 3;
    var bodyStart = hasHeader ? first + 1 : first;
    var out = [];
    var allRequired = REQUIRED_NAMED.every(function (col) { return col in hits; });
    var layout;
    if (hasHeader && allRequired) {
      layout = 'named';
      for (r = bodyStart; r < grid.length; r++) {
        var named = {};
        for (var k = 0; k < CANONICAL.length; k++) {
          var colName = CANONICAL[k];
          named[colName] = colName in hits ? normCell(grid[r][keep[hits[colName]]]) : '';
        }
        out.push({ excelRow: r + 1, cells: named });
      }
      return { rows: out, layout: layout };
    }
    if (keep.length < 7) {
      throw err('SchemaError', 'Sheet schema mismatch',
        'Each sheet needs at least 7 columns: Nomor, Soal, Pilihan A-D and Jawaban Benar ' +
        '(found ' + keep.length + '). Columns 8-11 (Pembahasan) are optional.');
    }
    layout = hasHeader ? 'positional' : 'positional-headerless';
    for (r = bodyStart; r < grid.length; r++) {
      var cells = {};
      for (var p = 0; p < CANONICAL.length; p++) {
        cells[CANONICAL[p]] = p < keep.length ? normCell(grid[r][keep[p]]) : '';
      }
      out.push({ excelRow: r + 1, cells: cells });
    }
    return { rows: out, layout: layout };
  }

  function resolveAnswer(cells) {
    var answer = cells[COL_ANSWER];
    var i;
    for (i = 0; i < 4; i++) {
      if (cells[COL_OPTIONS[i]] !== '' && answer === cells[COL_OPTIONS[i]]) return { letter: LETTERS[i], method: 'exact' };
    }
    if (answer === '') return { letter: '', method: '' };
    var la = loose(answer);
    for (i = 0; i < 4; i++) {
      if (cells[COL_OPTIONS[i]] !== '' && la === loose(cells[COL_OPTIONS[i]])) return { letter: LETTERS[i], method: 'loose' };
    }
    var m = LETTER_ANSWER.exec(answer);
    if (m) {
      var letter = m[1].toUpperCase();
      if (cells['Pilihan ' + letter] !== '') return { letter: letter, method: 'letter' };
    }
    return { letter: '', method: '' };
  }

  /**
   * Parse and validate one sheet grid into session-ready questions.
   * Mirrors core_engine.load_question_sheet.
   */
  function loadQuestionSheet(sheetName, grid) {
    var resolved = resolveLayout(grid || []);
    var result = { sheet: sheetName, questions: [], issues: [], rows_scanned: 0, layout: resolved.layout };
    var rows = resolved.rows.filter(function (row) {
      return CANONICAL.some(function (col) { return row.cells[col] !== ''; });
    });
    result.rows_scanned = rows.length;
    if (!rows.length) return result;

    var errors = [];
    var warnings1 = [];
    var warnings2 = [];
    var accepted = [];
    function issue(list, row, severity, message) {
      list.push({ row: row.excelRow, nomor: row.cells[COL_NOMOR], severity: severity, message: message });
    }

    var missingQ = [], tooFew = [], missingA = [], unresolved = [], looseW = [], letterW = [], ambiguousW = [], dupW = [];
    rows.forEach(function (row) {
      var cells = row.cells;
      var optionValues = COL_OPTIONS.map(function (c) { return cells[c]; });
      var optionCount = optionValues.filter(function (v) { return v !== ''; }).length;
      var res = resolveAnswer(cells);
      var mq = cells[COL_SOAL] === '';
      var few = optionCount < 2;
      var ma = cells[COL_ANSWER] === '';
      var unr = res.letter === '' && !ma;
      var rejected = mq || few || ma || unr;
      if (mq) missingQ.push(row);
      if (few && !mq) tooFew.push(row);
      if (ma && !mq && !few) missingA.push(row);
      if (unr && !mq && !few) unresolved.push(row);
      if (rejected) return;
      if (res.method === 'loose') looseW.push(row);
      if (res.method === 'letter') letterW.push(row);
      var nonEmpty = optionValues.filter(function (v) { return v !== ''; });
      var unique = {};
      nonEmpty.forEach(function (v) { unique['\u0001' + v] = true; });
      var duplicate = nonEmpty.length !== Object.keys(unique).length;
      var hitsCount = optionValues.filter(function (v) { return v === cells[COL_ANSWER]; }).length;
      var ambiguous = hitsCount > 1;
      if (ambiguous) ambiguousW.push([row, res.letter]);
      else if (duplicate) dupW.push(row);
      accepted.push({ row: row, letter: res.letter });
    });

    missingQ.forEach(function (row) { issue(errors, row, 'error', 'Missing question text (Soal) — row skipped.'); });
    tooFew.forEach(function (row) { issue(errors, row, 'error', 'Fewer than two non-empty options — row skipped.'); });
    missingA.forEach(function (row) { issue(errors, row, 'error', 'Jawaban Benar is empty — row skipped.'); });
    unresolved.forEach(function (row) {
      issue(errors, row, 'error', "Jawaban Benar '" + row.cells[COL_ANSWER] + "' does not match any option — row skipped.");
    });
    looseW.forEach(function (row) { issue(warnings1, row, 'warning', 'Answer matched an option only after ignoring case/whitespace.'); });
    letterW.forEach(function (row) { issue(warnings1, row, 'warning', 'Answer given as an option letter instead of the option text.'); });
    ambiguousW.forEach(function (pair) {
      issue(warnings2, pair[0], 'warning', 'Jawaban Benar matches several identical options; the first match ' +
        '(Pilihan ' + pair[1] + ') is used as the key.');
    });
    dupW.forEach(function (row) { issue(warnings2, row, 'warning', 'Two or more options share identical text.'); });

    accepted.forEach(function (item, position) {
      var cells = item.row.cells;
      var options = {};
      var explanations = {};
      LETTERS.forEach(function (l, i) {
        if (cells[COL_OPTIONS[i]] !== '') options[l] = cells[COL_OPTIONS[i]];
        explanations[l] = cells[COL_EXPLANATIONS[i]];
      });
      result.questions.push({
        qid: position,
        nomor: cells[COL_NOMOR] || String(position + 1),
        text: cells[COL_SOAL],
        options: options,
        correct: item.letter,
        explanations: explanations,
        source_row: item.row.excelRow
      });
    });

    var all = errors.concat(warnings1, warnings2).map(function (it, i) { it._i = i; return it; });
    all.sort(function (a, b) {
      if (a.row !== b.row) return a.row - b.row;
      if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
      return a._i - b._i;
    });
    result.issues = all.map(function (it) { delete it._i; return it; });
    return result;
  }

  function errorCount(result) { return result.issues.filter(function (i) { return i.severity === 'error'; }).length; }
  function warningCount(result) { return result.issues.filter(function (i) { return i.severity === 'warning'; }).length; }

  function resolveExplanation(question, chosen) {
    var ex = question.explanations || {};
    var correct = question.correct;
    if (chosen && String(ex[chosen] || '').trim()) return [ex[chosen], 'Pembahasan jika Pilihan ' + chosen];
    if (String(ex[correct] || '').trim()) return [ex[correct], 'Pembahasan jika Pilihan ' + correct];
    return ['No explanation was provided for this option in the source sheet.', '—'];
  }

  // ---------------------------------------------------------------- configuration
  function buildConfig(o) {
    if (!(o.mode in MODE_LABELS)) throw err('ConfigError', 'Unknown mode', "'" + o.mode + "' is not a supported study mode.");
    if (!(o.timer_mode in TIMER_LABELS)) throw err('ConfigError', 'Unknown timer mode', "'" + o.timer_mode + "' is not supported.");
    if (!o.sheet) throw err('ConfigError', 'No sheet selected', 'Choose a Paket Soal before launching.');
    var seconds = o.timer_mode === TIMER_NONE ? 0 : parseHHMMSS(o.timer_text);
    return {
      workbook: o.workbook,
      sheet: o.sheet,
      mode: o.mode,
      allow_previous: !!o.allow_previous,
      timer_mode: o.timer_mode,
      timer_seconds: seconds,
      shuffle_options: !!o.shuffle_options,
      direct_feedback: o.mode === MODE_FLASHCARD ? true : !!o.direct_feedback,
      shuffle_questions: !!o.shuffle_questions
    };
  }

  var CONFIG_FIELDS = ['workbook', 'sheet', 'mode', 'allow_previous', 'timer_mode', 'timer_seconds',
    'shuffle_options', 'direct_feedback', 'shuffle_questions'];

  function configFromDict(payload) {
    payload = payload || {};
    var required = CONFIG_FIELDS.slice(0, 8);
    required.forEach(function (k) {
      if (!(k in payload)) throw err('ConfigError', 'Retake unavailable', "The saved configuration is missing '" + k + "'.");
    });
    return {
      workbook: payload.workbook,
      sheet: payload.sheet,
      mode: payload.mode,
      allow_previous: !!payload.allow_previous,
      timer_mode: payload.timer_mode,
      timer_seconds: parseInt(payload.timer_seconds, 10) || 0,
      shuffle_options: !!payload.shuffle_options,
      direct_feedback: !!payload.direct_feedback,
      shuffle_questions: !!payload.shuffle_questions
    };
  }

  function allocatedSeconds(config, count) {
    if (config.timer_mode === TIMER_TOTAL) return parseInt(config.timer_seconds, 10);
    if (config.timer_mode === TIMER_PER_QUESTION) return parseInt(config.timer_seconds, 10) * count;
    return null;
  }

  // ---------------------------------------------------------------- randomness
  function randomHex(len) {
    var out = '';
    var cryptoObj = g.crypto && g.crypto.getRandomValues ? g.crypto : null;
    var bytes = new Uint8Array(Math.ceil(len / 2));
    if (cryptoObj) cryptoObj.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < bytes.length; j++) out += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
    return out.slice(0, len);
  }

  /** Small seeded PRNG (mulberry32) so a session's shuffles derive from its nonce. */
  function rngFromSeed(seedText) {
    var h = 2166136261;
    for (var i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
    var a = h >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ---------------------------------------------------------------- session state machine
  function has(setObj, idx) { return !!(setObj && setObj[idx]); }
  function setAdd(setObj, idx) { setObj[idx] = true; }
  function setDel(setObj, idx) { delete setObj[idx]; }
  function setSize(setObj) { return Object.keys(setObj || {}).length; }
  function getMap(mapObj, idx) { return mapObj && Object.prototype.hasOwnProperty.call(mapObj, idx) ? mapObj[idx] : undefined; }

  function initState(state) {
    var defaults = {
      view: VIEW_HOME, config: null, questions: [], cursor: 0, answers: {}, pending: {},
      submitted: {}, revealed: {}, grades: {}, flags: {}, expired: {}, telemetry: {},
      result: null, result_source: null, saved_path: null, session_nonce: randomHex(8),
      confirm_finish: false, last_timeout: null
    };
    Object.keys(defaults).forEach(function (k) { if (!(k in state)) state[k] = defaults[k]; });
    return state;
  }

  function startSession(state, config, questions, now) {
    if (!questions || !questions.length) {
      throw err('ConfigError', 'No valid questions',
        "Sheet '" + config.sheet + "' has no rows that pass validation. Review the data-quality report.");
    }
    var nonce = randomHex(8);
    var rng = rngFromSeed(nonce);
    var sequence = questions.map(function (q, i) { return [i, q]; });
    if (config.shuffle_questions && sequence.length > 1) shuffleInPlace(sequence, rng);
    var prepared = sequence.map(function (pair, position) {
      var q = pair[1];
      var letters = LETTERS.filter(function (l) { return l in q.options; });
      var order = config.shuffle_options ? shuffleInPlace(letters.slice(), rng) : letters;
      var copy = JSON.parse(JSON.stringify(q));
      copy.position = position;
      copy.source_position = pair[0] + 1;
      copy.display_order = order;
      return copy;
    });
    var count = prepared.length;
    state.config = JSON.parse(JSON.stringify(config));
    state.questions = prepared;
    state.cursor = 0;
    state.answers = {};
    state.pending = {};
    state.submitted = {};
    state.revealed = {};
    state.grades = {};
    state.flags = {};
    state.expired = {};
    state.result = null;
    state.result_source = null;
    state.saved_path = null;
    state.confirm_finish = false;
    state.last_timeout = null;
    state.session_nonce = nonce;
    state.telemetry = {
      time_spent: new Array(count).fill(0),
      visits: new Array(count).fill(0),
      enter_ts: null,
      started_at: null,
      ended_at: null,
      deadline: null,
      armed_at: now,
      finish_reason: null
    };
    state.view = VIEW_COUNTDOWN;
  }

  function beginExecution(state, now) {
    var t = state.telemetry;
    var c = state.config;
    t.started_at = now;
    t.enter_ts = now;
    t.visits[0] += 1;
    t.deadline = c.timer_mode === TIMER_TOTAL ? now + c.timer_seconds : null;
    state.cursor = 0;
    state.view = VIEW_SESSION;
  }

  function abortSession(state) {
    state.view = VIEW_HOME;
    state.questions = [];
    state.config = null;
    state.telemetry = {};
    state.confirm_finish = false;
  }

  function questionCount(state) { return (state.questions || []).length; }

  function isLocked(state, idx) {
    var c = state.config;
    if (has(state.expired, idx)) return true;
    if (c.mode === MODE_FLASHCARD) return getMap(state.grades, idx) !== undefined;
    return !!c.direct_feedback && has(state.submitted, idx);
  }

  function isAnswered(state, idx) {
    if (state.config.mode === MODE_FLASHCARD) return getMap(state.grades, idx) !== undefined;
    return getMap(state.answers, idx) !== undefined;
  }

  function currentSelection(state, idx) {
    return getMap(state.answers, idx) || getMap(state.pending, idx) || null;
  }

  function commitTime(state, now) {
    var t = state.telemetry;
    var enter = t.enter_ts;
    if (enter === null || enter === undefined) return;
    var idx = state.cursor;
    if (!isLocked(state, idx)) t.time_spent[idx] += Math.max(0, now - enter);
    t.enter_ts = now;
  }

  function liveTimeOnQuestion(state, now) {
    var t = state.telemetry;
    var idx = state.cursor;
    var spent = t.time_spent[idx];
    if (t.enter_ts !== null && t.enter_ts !== undefined && !isLocked(state, idx)) spent += Math.max(0, now - t.enter_ts);
    return spent;
  }

  function remainingSeconds(state, now) {
    var c = state.config;
    var t = state.telemetry;
    if (c.timer_mode === TIMER_TOTAL && t.deadline !== null && t.deadline !== undefined) return Math.max(0, t.deadline - now);
    if (c.timer_mode === TIMER_PER_QUESTION) return Math.max(0, Number(c.timer_seconds) - liveTimeOnQuestion(state, now));
    return null;
  }

  function timerDisplaySpec(state, now) {
    var c = state.config;
    var t = state.telemetry;
    var idx = state.cursor;
    if (c.timer_mode === TIMER_TOTAL) {
      return { mode: 'countdown', label: 'Time Remaining (Total)', target_ms: Math.floor(t.deadline * 1000),
        total: c.timer_seconds, frozen: false, frozen_value: 0 };
    }
    if (c.timer_mode === TIMER_PER_QUESTION) {
      var budget = Number(c.timer_seconds);
      var locked = isLocked(state, idx);
      var spentBefore = t.time_spent[idx];
      var enter = t.enter_ts === null || t.enter_ts === undefined ? now : t.enter_ts;
      return { mode: 'countdown', label: 'Time Remaining (Current)', target_ms: Math.floor((enter + budget - spentBefore) * 1000),
        total: budget, frozen: locked, frozen_value: pyRound(Math.max(0, budget - spentBefore), 1),
        frozen_note: has(state.expired, idx) ? 'EXPIRED' : 'LOCKED' };
    }
    return { mode: 'stopwatch', label: 'Elapsed (Session)',
      target_ms: Math.floor((t.started_at === null || t.started_at === undefined ? now : t.started_at) * 1000),
      total: 0, frozen: false, frozen_value: 0 };
  }

  function goTo(state, idx, now) {
    var count = questionCount(state);
    if (!count) return;
    idx = Math.max(0, Math.min(count - 1, parseInt(idx, 10)));
    commitTime(state, now);
    state.cursor = idx;
    state.telemetry.enter_ts = now;
    state.telemetry.visits[idx] += 1;
    state.confirm_finish = false;
  }

  function nextQuestion(state, now) {
    if (state.cursor < questionCount(state) - 1) goTo(state, state.cursor + 1, now);
  }

  function previousQuestion(state, now) {
    if (state.config.allow_previous && state.cursor > 0) goTo(state, state.cursor - 1, now);
  }

  function recordSelection(state, idx, letter) {
    if (isLocked(state, idx)) return;
    var target = state.config.direct_feedback ? state.pending : state.answers;
    if (letter === null || letter === undefined) delete target[idx];
    else target[idx] = letter;
  }

  function submitAnswer(state, idx, now) {
    if (isLocked(state, idx)) return false;
    var letter = getMap(state.pending, idx) || getMap(state.answers, idx);
    if (!letter) return false;
    commitTime(state, now);
    state.answers[idx] = letter;
    delete state.pending[idx];
    setAdd(state.submitted, idx);
    return true;
  }

  function revealCard(state, idx) { setAdd(state.revealed, idx); }

  function gradeCard(state, idx, knewIt, now) {
    if (has(state.expired, idx)) return;
    if (getMap(state.grades, idx) === undefined) commitTime(state, now);
    setAdd(state.revealed, idx);
    state.grades[idx] = !!knewIt;
  }

  function setFlag(state, idx, flagged) {
    if (flagged) setAdd(state.flags, idx); else setDel(state.flags, idx);
  }

  function commitPending(state, idx) {
    var pending = getMap(state.pending, idx);
    delete state.pending[idx];
    if (pending && getMap(state.answers, idx) === undefined) {
      state.answers[idx] = pending;
      if (state.config.direct_feedback) setAdd(state.submitted, idx);
    }
  }

  function hasOpenQuestions(state) {
    for (var i = 0; i < questionCount(state); i++) {
      if (!isAnswered(state, i) && !isLocked(state, i)) return true;
    }
    return false;
  }

  function checkTimeout(state, now) {
    if (state.view !== VIEW_SESSION || !state.config) return null;
    var c = state.config;
    var t = state.telemetry;
    if (c.timer_mode === TIMER_TOTAL) {
      if (t.deadline !== null && t.deadline !== undefined && now >= t.deadline) {
        finishSession(state, now, FINISH_TIME_UP);
        state.last_timeout = TIMEOUT_TOTAL;
        return TIMEOUT_TOTAL;
      }
      return null;
    }
    if (c.timer_mode !== TIMER_PER_QUESTION) return null;
    var idx = state.cursor;
    if (isLocked(state, idx)) return null;
    var remaining = remainingSeconds(state, now);
    if (remaining === null || remaining > 0) return null;
    var budget = Number(c.timer_seconds);
    commitTime(state, now);
    t.time_spent[idx] = Math.min(t.time_spent[idx], budget);
    commitPending(state, idx);
    setAdd(state.expired, idx);
    state.last_timeout = TIMEOUT_QUESTION;
    if (idx < questionCount(state) - 1) goTo(state, idx + 1, now);
    else if (c.allow_previous && hasOpenQuestions(state)) t.enter_ts = now;
    else finishSession(state, now, FINISH_TIME_UP);
    return TIMEOUT_QUESTION;
  }

  function finishSession(state, now, reason) {
    var t = state.telemetry;
    var c = state.config;
    var stopAt = now;
    if (reason === FINISH_TIME_UP && c.timer_mode === TIMER_TOTAL && t.deadline !== null && t.deadline !== undefined) {
      stopAt = Math.min(now, t.deadline);
    }
    var idx = state.cursor;
    if (c.mode === MODE_QUIZ && c.direct_feedback && reason === FINISH_TIME_UP) commitPending(state, idx);
    commitTime(state, stopAt);
    t.enter_ts = null;
    t.ended_at = stopAt;
    t.finish_reason = reason;
    var record = buildSessionRecord(state);
    state.result = record;
    state.result_source = 'live';
    state.saved_path = null;
    state.confirm_finish = false;
    state.view = VIEW_RESULTS;
    return record;
  }

  function progressSnapshot(state) {
    var total = questionCount(state);
    var answered = 0;
    for (var i = 0; i < total; i++) if (isAnswered(state, i)) answered++;
    return { position: state.cursor + 1, total: total, answered: answered, flagged: setSize(state.flags),
      expired: setSize(state.expired), unanswered: total - answered };
  }

  function questionStatus(state, idx) {
    if (idx === state.cursor) return 'current';
    if (has(state.flags, idx)) return 'flagged';
    if (has(state.expired, idx) && !isAnswered(state, idx)) return 'expired';
    if (isAnswered(state, idx)) return 'answered';
    return 'todo';
  }

  // ---------------------------------------------------------------- analytics
  function computeTimeStatistics(times) {
    var xs = (times || []).map(Number);
    if (!xs.length) return { mean: 0, std: 0, median: 0, threshold: 0, outlier_mask: [] };
    var sum = 0;
    xs.forEach(function (x) { sum += x; });
    var mean = sum / xs.length;
    var std = 0;
    if (xs.length > 1) {
      var ss = 0;
      xs.forEach(function (x) { ss += (x - mean) * (x - mean); });
      std = Math.sqrt(ss / (xs.length - 1));
      if (isNaN(std)) std = 0;
    }
    var sorted = xs.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    var median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    var threshold = mean + std;
    return { mean: mean, std: std, median: median, threshold: threshold,
      outlier_mask: xs.map(function (x) { return x > threshold && std > 0; }) };
  }

  function buildSessionRecord(state) {
    var c = state.config;
    var questions = state.questions;
    var t = state.telemetry;
    var isFlash = c.mode === MODE_FLASHCARD;
    var items = questions.map(function (q, idx) {
      var correct = q.correct;
      var userLetter, status, userText, ex;
      if (isFlash) {
        var grade = getMap(state.grades, idx);
        userLetter = null;
        status = grade === undefined ? STATUS_SKIPPED : (grade ? STATUS_CORRECT : STATUS_WRONG);
        userText = grade === undefined ? '' : (grade ? 'Self-assessed: Knew it' : 'Self-assessed: Missed');
        ex = resolveExplanation(q, correct);
      } else {
        userLetter = getMap(state.answers, idx);
        if (userLetter === undefined) userLetter = null;
        status = userLetter === null ? STATUS_SKIPPED : (userLetter === correct ? STATUS_CORRECT : STATUS_WRONG);
        userText = userLetter ? (q.options[userLetter] || '') : '';
        ex = resolveExplanation(q, userLetter);
      }
      return {
        position: idx + 1,
        nomor: q.nomor,
        question: q.text,
        options: q.options,
        display_order: q.display_order,
        correct_letter: correct,
        correct_text: q.options[correct],
        user_letter: userLetter,
        user_text: userText,
        status: status,
        is_correct: status === STATUS_CORRECT,
        explanation: ex[0],
        explanation_source: ex[1],
        time_spent_s: pyRound(Number(t.time_spent[idx]), 3),
        visits: parseInt(t.visits[idx], 10) || 0,
        flagged: has(state.flags, idx),
        expired: has(state.expired, idx),
        source_row: q.source_row === undefined ? null : q.source_row
      };
    });
    var times = items.map(function (it) { return it.time_spent_s; });
    var stats = computeTimeStatistics(times);
    var total = items.length;
    var correctN = items.filter(function (i) { return i.status === STATUS_CORRECT; }).length;
    var wrongN = items.filter(function (i) { return i.status === STATUS_WRONG; }).length;
    var skippedN = items.filter(function (i) { return i.status === STATUS_SKIPPED; }).length;
    var answeredN = correctN + wrongN;
    var started = t.started_at;
    var ended = t.ended_at;
    var active = 0;
    times.forEach(function (x) { active += x; });
    var wall = (started !== null && started !== undefined && ended !== null && ended !== undefined) ? ended - started : active;
    if (c.timer_mode === TIMER_PER_QUESTION) wall = Math.min(wall, active);
    var allocated = allocatedSeconds(c, total);
    var summary = {
      total: total,
      answered: answeredN,
      correct: correctN,
      wrong: wrongN,
      skipped: skippedN,
      flagged: items.filter(function (i) { return i.flagged; }).length,
      expired: items.filter(function (i) { return i.expired; }).length,
      accuracy_pct: total ? pyRound(100 * correctN / total, 2) : 0,
      attempted_accuracy_pct: answeredN ? pyRound(100 * correctN / answeredN, 2) : 0,
      total_time_s: pyRound(wall, 3),
      active_time_s: pyRound(active, 3),
      allocated_time_s: allocated,
      time_utilization_pct: allocated ? pyRound(100 * wall / allocated, 2) : null,
      avg_time_s: pyRound(stats.mean, 3),
      median_time_s: pyRound(stats.median, 3),
      std_time_s: pyRound(stats.std, 3),
      outlier_threshold_s: pyRound(stats.threshold, 3),
      outlier_count: stats.outlier_mask.filter(Boolean).length,
      max_time_s: total ? pyRound(Math.max.apply(null, times), 3) : 0
    };
    return {
      schema_version: SCHEMA_VERSION,
      engine: ENGINE_NAME,
      session_id: state.session_nonce || randomHex(8),
      workbook: c.workbook,
      sheet: c.sheet,
      config: JSON.parse(JSON.stringify(c)),
      timeline: {
        started_at: isoLocal(started),
        finished_at: isoLocal(ended),
        finish_reason: t.finish_reason || FINISH_COMPLETED
      },
      summary: summary,
      items: items
    };
  }

  /** Rows of the diagnostic review matrix (mirrors build_review_frame). */
  function buildReviewRows(record) {
    var items = (record && record.items) || [];
    var stats = computeTimeStatistics(items.map(function (i) { return i.time_spent_s; }));
    return items.map(function (it, k) {
      var letter = it.user_letter || '';
      var userText = it.user_text || '';
      var yours = letter ? letter + '. ' + userText : userText;
      if (!String(yours).trim()) yours = '— (no answer)';
      return {
        item: it,
        index: k,
        number: it.position,
        nomor: it.nomor,
        question: it.question,
        status: it.status,
        result: it.status === STATUS_CORRECT ? 'Correct' : (it.status === STATUS_WRONG ? 'Incorrect' : 'Skipped'),
        yourAnswer: yours,
        correctAnswer: it.correct_letter + '. ' + it.correct_text,
        time: pyRound(Number(it.time_spent_s), 1),
        flagged: !!it.flagged,
        expired: !!it.expired,
        isOutlier: !!stats.outlier_mask[k],
        explanation: it.explanation,
        explanationSource: it.explanation_source
      };
    });
  }

  var REVIEW_FILTERS = ['All', 'Incorrect', 'Skipped', 'Flagged', 'Outliers'];

  function filterReview(rows, label) {
    if (!label || label === 'All') return rows;
    return rows.filter(function (r) {
      if (label === 'Incorrect') return r.status === STATUS_WRONG;
      if (label === 'Skipped') return r.status === STATUS_SKIPPED;
      if (label === 'Flagged') return r.flagged;
      if (label === 'Outliers') return r.isOutlier;
      return true;
    });
  }

  // ---------------------------------------------------------------- persistence helpers
  function nextSessionName(sheet, existingNames) {
    var stem = sanitizeFilenameComponent(sheet);
    var esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('^' + esc + '_Session_(\\d+)\\.json$', 'i');
    var max = 0;
    (existingNames || []).forEach(function (name) {
      var m = re.exec(name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return stem + '_Session_' + (max + 1) + '.json';
  }

  function validateRecord(payload, name) {
    var required = ['sheet', 'config', 'summary', 'items'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !required.every(function (k) { return k in payload; })) {
      throw err('SessionFileError', 'Unrecognised session file', "'" + name + "' is not a session artifact produced by this engine.");
    }
    if (!Array.isArray(payload.items)) {
      throw err('SessionFileError', 'Corrupted session file', "'" + name + "' has an invalid 'items' block.");
    }
    return payload;
  }

  function parseIsoToEpoch(text) {
    if (!text) return null;
    var ms = Date.parse(String(text));
    return isNaN(ms) ? null : ms / 1000;
  }

  /** Historical telemetry rows (mirrors summarize_saved_sessions). */
  function summarizeSessions(entries) {
    var rows = [];
    var broken = [];
    (entries || []).forEach(function (entry) {
      var record = entry.record;
      try { validateRecord(record, entry.name); } catch (e) { broken.push(entry.name); return; }
      var summary = record.summary || {};
      var config = record.config || {};
      var timeline = record.timeline || {};
      var finished = parseIsoToEpoch(timeline.finished_at || record.saved_at);
      if (finished === null) finished = entry.savedAt || 0;
      rows.push({
        file: entry.name,
        sheet: record.sheet || '—',
        mode: MODE_LABELS[config.mode] || config.mode || '—',
        timer: TIMER_LABELS[config.timer_mode] || '—',
        finished: finished,
        questions: parseInt(summary.total, 10) || 0,
        correct: parseInt(summary.correct, 10) || 0,
        accuracy: Number(summary.accuracy_pct || 0),
        duration: formatHHMMSS(summary.total_time_s),
        durationS: Number(summary.total_time_s || 0),
        avg: pyRound(Number(summary.avg_time_s || 0), 1)
      });
    });
    rows.sort(function (a, b) { return b.finished - a.finished; });
    return { rows: rows, broken: broken };
  }

  function csvField(v) {
    var s;
    if (v === null || v === undefined) s = '';
    else if (typeof v === 'boolean') s = v ? 'True' : 'False';
    else if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : String(v);
    else s = String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function floatRepr(x) {
    // pandas writes floats with repr(): always keep one decimal for integral values.
    if (Number.isInteger(x)) return x.toFixed(1);
    return String(x);
  }

  function recordToCsv(record) {
    var header = ['#', 'Nomor', 'Question', 'Your Answer', 'Correct Answer', 'Result', 'Time (s)', 'Flagged',
      'Expired', 'Explanation Source', 'Corrective Explanation'];
    var lines = [header.map(csvField).join(',')];
    buildReviewRows(record).forEach(function (r) {
      lines.push([
        csvField(r.number), csvField(r.nomor), csvField(r.question), csvField(r.yourAnswer), csvField(r.correctAnswer),
        csvField(r.result), floatRepr(r.time), csvField(r.flagged), csvField(r.expired),
        csvField(r.explanationSource), csvField(r.explanation)
      ].join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function recordToJson(record) {
    return JSON.stringify(record, null, 2);
  }

  function performanceBand(accuracy) {
    if (Math.abs(accuracy - 100) < 1e-9) return ['Flawless', 'success'];
    if (accuracy >= 80) return ['Distinction', 'success'];
    if (accuracy >= 60) return ['Proficient', 'amber'];
    if (accuracy >= 40) return ['Developing', 'danger'];
    return ['Needs remediation', 'danger'];
  }

  function accuracyColor(accuracy) {
    if (accuracy >= 80) return '#00E396';
    if (accuracy >= 60) return '#FFB020';
    return '#FF003F';
  }

  function displayLetter(question, original) {
    var order = question.display_order || [];
    if (!original || order.indexOf(original) < 0) return '—';
    return LETTERS[order.indexOf(original)];
  }

  QB.engine = {
    ENGINE_NAME: ENGINE_NAME, SCHEMA_VERSION: SCHEMA_VERSION, MAX_SHEETS: MAX_SHEETS, MAX_TIMER_SECONDS: MAX_TIMER_SECONDS,
    LETTERS: LETTERS, CANONICAL: CANONICAL, COL_NOMOR: COL_NOMOR, COL_SOAL: COL_SOAL, COL_OPTIONS: COL_OPTIONS,
    COL_ANSWER: COL_ANSWER, COL_EXPLANATIONS: COL_EXPLANATIONS,
    MODE_QUIZ: MODE_QUIZ, MODE_FLASHCARD: MODE_FLASHCARD, MODE_LABELS: MODE_LABELS,
    TIMER_NONE: TIMER_NONE, TIMER_TOTAL: TIMER_TOTAL, TIMER_PER_QUESTION: TIMER_PER_QUESTION, TIMER_LABELS: TIMER_LABELS,
    VIEW_HOME: VIEW_HOME, VIEW_COUNTDOWN: VIEW_COUNTDOWN, VIEW_SESSION: VIEW_SESSION, VIEW_RESULTS: VIEW_RESULTS,
    FINISH_COMPLETED: FINISH_COMPLETED, FINISH_TIME_UP: FINISH_TIME_UP, FINISH_LABELS: FINISH_LABELS,
    STATUS_CORRECT: STATUS_CORRECT, STATUS_WRONG: STATUS_WRONG, STATUS_SKIPPED: STATUS_SKIPPED,
    TIMEOUT_TOTAL: TIMEOUT_TOTAL, TIMEOUT_QUESTION: TIMEOUT_QUESTION, REVIEW_FILTERS: REVIEW_FILTERS,
    EngineError: EngineError, error: err,
    pyRound: pyRound, fixed: fixed, formatG15: formatG15, isNum: isNum, isoLocal: isoLocal, nowIso: nowIso,
    parseHHMMSS: parseHHMMSS, formatHHMMSS: formatHHMMSS, formatDurationShort: formatDurationShort,
    sanitizeFilenameComponent: sanitizeFilenameComponent, loose: loose, normHeader: normHeader,
    resolveLayout: resolveLayout, loadQuestionSheet: loadQuestionSheet, errorCount: errorCount, warningCount: warningCount,
    resolveExplanation: resolveExplanation, buildConfig: buildConfig, configFromDict: configFromDict,
    allocatedSeconds: allocatedSeconds, randomHex: randomHex, rngFromSeed: rngFromSeed, shuffleInPlace: shuffleInPlace,
    has: has, getMap: getMap, setSize: setSize,
    initState: initState, startSession: startSession, beginExecution: beginExecution, abortSession: abortSession,
    questionCount: questionCount, isLocked: isLocked, isAnswered: isAnswered, currentSelection: currentSelection,
    liveTimeOnQuestion: liveTimeOnQuestion, remainingSeconds: remainingSeconds, timerDisplaySpec: timerDisplaySpec,
    goTo: goTo, nextQuestion: nextQuestion, previousQuestion: previousQuestion, recordSelection: recordSelection,
    submitAnswer: submitAnswer, revealCard: revealCard, gradeCard: gradeCard, setFlag: setFlag,
    hasOpenQuestions: hasOpenQuestions, checkTimeout: checkTimeout, finishSession: finishSession,
    progressSnapshot: progressSnapshot, questionStatus: questionStatus,
    computeTimeStatistics: computeTimeStatistics, buildSessionRecord: buildSessionRecord,
    buildReviewRows: buildReviewRows, filterReview: filterReview, nextSessionName: nextSessionName,
    validateRecord: validateRecord, summarizeSessions: summarizeSessions, parseIsoToEpoch: parseIsoToEpoch,
    recordToCsv: recordToCsv, recordToJson: recordToJson, performanceBand: performanceBand,
    accuracyColor: accuracyColor, displayLetter: displayLetter
  };
})(typeof window !== 'undefined' ? window : globalThis);
