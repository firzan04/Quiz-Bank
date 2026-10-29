/*
 * Minimal, dependency-free .xlsx / .xlsm reader.
 *
 * Reads the ZIP container, inflates entries (native DecompressionStream when
 * available, otherwise a built-in RFC 1951 decoder), and converts every
 * worksheet into a grid of strings that follows the same cell normalisation
 * rules as pandas + openpyxl in the desktop app:
 *   - text cells keep their raw text (trimmed later by the engine),
 *   - integral numbers lose ".0", other numbers use Python's '.15g' format,
 *   - date-formatted numbers become "YYYY-MM-DD[ HH:MM:SS]",
 *   - booleans become TRUE / FALSE, error cells become empty.
 */
(function (g) {
  'use strict';

  var QB = (g.QB = g.QB || {});

  function XlsxError(title, detail) {
    this.name = 'WorkbookReadError';
    this.kind = 'WorkbookReadError';
    this.title = title;
    this.detail = detail;
    this.message = title + ': ' + detail;
  }
  XlsxError.prototype = Object.create(Error.prototype);
  XlsxError.prototype.constructor = XlsxError;

  // ------------------------------------------------------------------ inflate (RFC 1951)
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
    4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildHuffman(lengths, n) {
    var counts = new Uint16Array(16);
    var i;
    for (i = 0; i < n; i++) counts[lengths[i]]++;
    counts[0] = 0;
    var offs = new Uint16Array(16);
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
    var symbols = new Uint16Array(n);
    for (i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { counts: counts, symbols: symbols };
  }

  function inflateRaw(input) {
    var src = input;
    var pos = 0;
    var bitBuf = 0;
    var bitCnt = 0;
    var out = new Uint8Array(Math.max(1024, src.length * 4));
    var outLen = 0;

    function need(len) {
      if (outLen + len <= out.length) return;
      var size = out.length * 2;
      while (size < outLen + len) size *= 2;
      var bigger = new Uint8Array(size);
      bigger.set(out.subarray(0, outLen));
      out = bigger;
    }
    function bits(n) {
      while (bitCnt < n) {
        if (pos >= src.length) throw new XlsxError('Workbook is corrupted', 'A compressed part of the file ends unexpectedly.');
        bitBuf |= src[pos++] << bitCnt;
        bitCnt += 8;
      }
      var v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCnt -= n;
      return v;
    }
    function decode(h) {
      var code = 0, first = 0, index = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1);
        var count = h.counts[len];
        if (code - count < first) return h.symbols[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
      }
      throw new XlsxError('Workbook is corrupted', 'Invalid compressed data (bad Huffman code).');
    }
    var fixedLit = null, fixedDist = null;
    function fixedTables() {
      if (fixedLit) return;
      var l = new Uint8Array(288);
      var i;
      for (i = 0; i < 144; i++) l[i] = 8;
      for (; i < 256; i++) l[i] = 9;
      for (; i < 280; i++) l[i] = 7;
      for (; i < 288; i++) l[i] = 8;
      fixedLit = buildHuffman(l, 288);
      var d = new Uint8Array(30);
      for (i = 0; i < 30; i++) d[i] = 5;
      fixedDist = buildHuffman(d, 30);
    }
    function inflateBlock(lit, dist) {
      for (;;) {
        var sym = decode(lit);
        if (sym < 256) {
          need(1);
          out[outLen++] = sym;
        } else if (sym === 256) {
          return;
        } else {
          sym -= 257;
          if (sym >= 29) throw new XlsxError('Workbook is corrupted', 'Invalid compressed data (length code).');
          var length = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
          var dsym = decode(dist);
          if (dsym >= 30) throw new XlsxError('Workbook is corrupted', 'Invalid compressed data (distance code).');
          var distance = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
          if (distance > outLen) throw new XlsxError('Workbook is corrupted', 'Invalid compressed data (distance too far).');
          need(length);
          var from = outLen - distance;
          for (var k = 0; k < length; k++) out[outLen++] = out[from + k];
        }
      }
    }
    var last;
    do {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitBuf = 0;
        bitCnt = 0;
        if (pos + 4 > src.length) throw new XlsxError('Workbook is corrupted', 'Truncated stored block.');
        var len = src[pos] | (src[pos + 1] << 8);
        var nlen = src[pos + 2] | (src[pos + 3] << 8);
        pos += 4;
        if ((len ^ 0xffff) !== nlen) throw new XlsxError('Workbook is corrupted', 'Stored block length mismatch.');
        if (pos + len > src.length) throw new XlsxError('Workbook is corrupted', 'Truncated stored block.');
        need(len);
        out.set(src.subarray(pos, pos + len), outLen);
        outLen += len;
        pos += len;
      } else if (type === 1) {
        fixedTables();
        inflateBlock(fixedLit, fixedDist);
      } else if (type === 2) {
        var hlit = bits(5) + 257;
        var hdist = bits(5) + 1;
        var hclen = bits(4) + 4;
        var clLens = new Uint8Array(19);
        for (var i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = bits(3);
        var clH = buildHuffman(clLens, 19);
        var lens = new Uint8Array(hlit + hdist);
        var n = 0;
        while (n < hlit + hdist) {
          var s = decode(clH);
          if (s < 16) {
            lens[n++] = s;
          } else {
            var rep, val = 0;
            if (s === 16) {
              if (n === 0) throw new XlsxError('Workbook is corrupted', 'Invalid code length repeat.');
              val = lens[n - 1];
              rep = 3 + bits(2);
            } else if (s === 17) {
              rep = 3 + bits(3);
            } else {
              rep = 11 + bits(7);
            }
            if (n + rep > hlit + hdist) throw new XlsxError('Workbook is corrupted', 'Too many code lengths.');
            while (rep--) lens[n++] = val;
          }
        }
        var litH = buildHuffman(lens.subarray(0, hlit), hlit);
        var distH = buildHuffman(lens.subarray(hlit), hdist);
        inflateBlock(litH, distH);
      } else {
        throw new XlsxError('Workbook is corrupted', 'Invalid compressed block type.');
      }
    } while (!last);
    return out.slice(0, outLen);
  }

  function hasNativeInflate() {
    return typeof g.DecompressionStream === 'function' && typeof g.Response === 'function' && typeof g.Blob === 'function';
  }

  function inflateNative(bytes) {
    var ds = new g.DecompressionStream('deflate-raw');
    var stream = new g.Blob([bytes]).stream().pipeThrough(ds);
    return new g.Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  var forceJsInflate = false;

  function inflate(bytes) {
    if (!forceJsInflate && hasNativeInflate()) {
      return inflateNative(bytes).catch(function () { return inflateRaw(bytes); });
    }
    return Promise.resolve().then(function () { return inflateRaw(bytes); });
  }

  // ------------------------------------------------------------------ ZIP container
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function readZipDirectory(bytes) {
    var min = Math.max(0, bytes.length - 65557);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= min; i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) {
      throw new XlsxError('Workbook is corrupted', 'This is not a valid .xlsx archive. Re-save it from Excel as .xlsx.');
    }
    var count = u16(bytes, eocd + 10);
    var cdOffset = u32(bytes, eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      throw new XlsxError('Workbook too large', 'ZIP64 workbooks are not supported. Save a smaller workbook.');
    }
    var entries = {};
    var p = cdOffset;
    for (var k = 0; k < count; k++) {
      if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) {
        throw new XlsxError('Workbook is corrupted', 'The archive directory is damaged.');
      }
      var flags = u16(bytes, p + 8);
      var method = u16(bytes, p + 10);
      var csize = u32(bytes, p + 20);
      var usize = u32(bytes, p + 24);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var localOffset = u32(bytes, p + 42);
      var nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      var name = (flags & 0x800) ? utf8(nameBytes) : latin1(nameBytes);
      entries[name.replace(/\\/g, '/')] = { method: method, csize: csize, usize: usize, offset: localOffset, flags: flags };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function latin1(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  var decoder = typeof g.TextDecoder === 'function' ? new g.TextDecoder('utf-8') : null;
  function utf8(b) {
    if (decoder) return decoder.decode(b);
    // Fallback decoder (very old engines only).
    var s = '';
    for (var i = 0; i < b.length; i++) s += '%' + (b[i] < 16 ? '0' : '') + b[i].toString(16);
    try { return decodeURIComponent(s); } catch (e) { return latin1(b); }
  }

  function readEntry(bytes, entry) {
    var o = entry.offset;
    if (u32(bytes, o) !== 0x04034b50) {
      return Promise.reject(new XlsxError('Workbook is corrupted', 'A file inside the archive is damaged.'));
    }
    if (entry.flags & 1) {
      return Promise.reject(new XlsxError('Workbook is protected', 'Encrypted workbooks are not supported. Remove the password in Excel and save again.'));
    }
    var start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    var data = bytes.subarray(start, start + entry.csize);
    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method === 8) return inflate(data);
    return Promise.reject(new XlsxError('Workbook could not be read', 'Unsupported compression method ' + entry.method + '.'));
  }

  // ------------------------------------------------------------------ XML helpers
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, function (m, e) {
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'amp') return '&';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      var code = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (x) { return ''; }
    });
  }

  // OOXML escapes control characters as _xHHHH_ (openpyxl unescapes them).
  function unescapeOoxml(s) {
    if (s.indexOf('_x') < 0) return s;
    return s.replace(/_x([0-9A-Fa-f]{4})_/g, function (m, hex) { return String.fromCharCode(parseInt(hex, 16)); });
  }

  function attrs(tag) {
    var out = {};
    var re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    var m;
    while ((m = re.exec(tag))) out[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
    return out;
  }

  function localName(name) {
    var i = name.indexOf(':');
    return i >= 0 ? name.slice(i + 1) : name;
  }

  /** Concatenate the text of <t> elements, skipping phonetic runs (<rPh>). */
  function textOfRich(xml) {
    var cleaned = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
    var out = '';
    var re = /<(?:\w+:)?t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
    var m;
    while ((m = re.exec(cleaned))) {
      if (m[1] !== undefined) out += decodeEntities(m[1]);
    }
    return unescapeOoxml(out);
  }

  // ------------------------------------------------------------------ number formats
  var BUILTIN_FORMATS = {
    14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
    20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0'
  };
  var CJK_DATE_IDS = { 27: 1, 28: 1, 29: 1, 30: 1, 31: 1, 32: 1, 33: 1, 34: 1, 35: 1, 36: 1,
    50: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };

  function isDateFormat(code) {
    if (!code) return false;
    var stripped = code.replace(/"[^"]*"/g, '').replace(/\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g, '');
    return /(^|[^_\\])[dmhysDMHYS]/.test(stripped);
  }

  function isTimeOnlyFormat(code) {
    if (!code) return false;
    var stripped = code.replace(/"[^"]*"/g, '').replace(/\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g, '');
    return !/(^|[^_\\])[dyDY]/.test(stripped) && /(^|[^_\\])[hsHS]/.test(stripped);
  }

  function isTimedeltaFormat(code) {
    return /\[(hh?|mm?|ss?)\]/i.test(code || '');
  }

  function excelSerialToParts(serial, date1904) {
    // Excel's 1900 system treats 1900 as a leap year; openpyxl compensates below day 60.
    var days = serial;
    if (!date1904 && days < 60) days += 1;
    var epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    var ms = Math.round(days * 86400000);
    var d = new Date(epoch + ms);
    return d;
  }

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  function formatDateValue(serial, code, date1904) {
    var d = excelSerialToParts(serial, date1904);
    var hh = pad(d.getUTCHours(), 2), mi = pad(d.getUTCMinutes(), 2), ss = pad(d.getUTCSeconds(), 2);
    if (isTimedeltaFormat(code)) {
      // timedelta -> Python str(timedelta): "H:MM:SS" or "N day(s), H:MM:SS"
      var totalSec = Math.round(serial * 86400);
      var dayCount = Math.floor(totalSec / 86400);
      var rest = totalSec - dayCount * 86400;
      var t = Math.floor(rest / 3600) + ':' + pad(Math.floor(rest % 3600 / 60), 2) + ':' + pad(rest % 60, 2);
      return dayCount ? dayCount + (Math.abs(dayCount) === 1 ? ' day, ' : ' days, ') + t : t;
    }
    if (serial < 1 && serial >= 0 && isTimeOnlyFormat(code)) {
      return hh + ':' + mi + ':' + ss;
    }
    var datePart = pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2);
    var time = hh + ':' + mi + ':' + ss;
    return time === '00:00:00' ? datePart : datePart + ' ' + time;
  }

  function normalizeNumberText(text) {
    var t = String(text).trim();
    if (/^-?\d+$/.test(t)) {
      try { return BigInt(t).toString(); } catch (e) { return String(parseInt(t, 10)); }
    }
    var x = Number(t);
    if (!isFinite(x)) return t;
    if (Number.isInteger(x)) {
      try { return BigInt(x).toString(); } catch (e2) { return String(x); }
    }
    return QB.engine ? QB.engine.formatG15(x) : String(x);
  }

  // ------------------------------------------------------------------ workbook parts
  function resolveTarget(base, target) {
    if (!target) return null;
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = base.split('/');
    parts.pop();
    target.split('/').forEach(function (seg) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    });
    return parts.join('/');
  }

  function parseRels(xml, basePath) {
    var map = {};
    var re = /<(?:\w+:)?Relationship\b[^>]*>/g;
    var m;
    while ((m = re.exec(xml))) {
      var a = attrs(m[0]);
      if (a.TargetMode === 'External') continue;
      map[a.Id] = { target: resolveTarget(basePath, a.Target), type: a.Type || '' };
    }
    return map;
  }

  function parseSharedStrings(xml) {
    var out = [];
    var re = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
    var m;
    while ((m = re.exec(xml))) out.push(m[1] === undefined ? '' : textOfRich(m[1]));
    return out;
  }

  function parseStyles(xml) {
    var custom = {};
    var nf = /<(?:\w+:)?numFmt\b[^>]*>/g;
    var m;
    while ((m = nf.exec(xml))) {
      var a = attrs(m[0]);
      custom[parseInt(a.numFmtId, 10)] = a.formatCode || '';
    }
    var dateStyle = [];
    var codes = [];
    var cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
    if (cellXfs) {
      var xf = /<(?:\w+:)?xf\b[^>]*>/g;
      while ((m = xf.exec(cellXfs[1]))) {
        var x = attrs(m[0]);
        var id = parseInt(x.numFmtId || '0', 10);
        var code = custom[id] !== undefined ? custom[id] : (BUILTIN_FORMATS[id] || '');
        var isDate = CJK_DATE_IDS[id] ? true : isDateFormat(code);
        dateStyle.push(isDate);
        codes.push(code || (CJK_DATE_IDS[id] ? 'yyyy-mm-dd' : ''));
      }
    }
    return { dateStyle: dateStyle, codes: codes };
  }

  function colIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var c = ref.charCodeAt(i);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
      else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
      else break;
    }
    return n - 1;
  }

  function parseSheet(xml, shared, styles, date1904) {
    var grid = [];
    var sheetData = /<(?:\w+:)?sheetData\b[^>]*?(?:\/>|>([\s\S]*)<\/(?:\w+:)?sheetData>)/.exec(xml);
    if (!sheetData || sheetData[1] === undefined) return grid;
    var body = sheetData[1];
    var rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
    var cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    var vRe = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;
    var isRe = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/;
    var m, rowNo = 0;
    while ((m = rowRe.exec(body))) {
      var ra = attrs(m[1]);
      rowNo = ra.r ? parseInt(ra.r, 10) : rowNo + 1;
      var r = rowNo - 1;
      if (r < 0 || r > 1048575) continue;
      var row = [];
      var content = m[2] || '';
      var c, colNo = -1;
      cellRe.lastIndex = 0;
      while ((c = cellRe.exec(content))) {
        var ca = attrs(c[1]);
        colNo = ca.r ? colIndex(ca.r) : colNo + 1;
        if (colNo < 0 || colNo > 16383) continue;
        var inner = c[2] || '';
        var type = ca.t || 'n';
        var value = '';
        if (type === 'inlineStr') {
          var is = isRe.exec(inner);
          value = is ? textOfRich(is[1]) : '';
        } else {
          var v = vRe.exec(inner);
          var raw = v ? decodeEntities(v[1]) : null;
          if (raw === null) {
            value = '';
          } else if (type === 's') {
            var idx = parseInt(raw, 10);
            value = shared[idx] !== undefined ? shared[idx] : '';
          } else if (type === 'str') {
            value = unescapeOoxml(raw);
          } else if (type === 'b') {
            value = raw.trim() === '1' || raw.trim().toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
          } else if (type === 'e') {
            value = '';
          } else if (type === 'd') {
            value = raw.trim().replace('T', ' ').replace(/ 00:00:00(\.0+)?$/, '').replace(/\.\d+$/, '');
          } else {
            var s = ca.s ? parseInt(ca.s, 10) : 0;
            var num = Number(raw);
            if (raw.trim() !== '' && isFinite(num) && styles.dateStyle[s]) {
              value = formatDateValue(num, styles.codes[s], date1904);
            } else if (raw.trim() === '') {
              value = '';
            } else {
              value = normalizeNumberText(raw);
            }
          }
        }
        if (value !== '') {
          while (row.length < colNo) row.push('');
          row[colNo] = value;
        }
      }
      if (row.length) {
        while (grid.length < r) grid.push([]);
        grid[r] = row;
      }
    }
    return grid;
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new XlsxError('Workbook could not be read', 'Unsupported input.');
  }

  /**
   * Open a workbook. Returns a promise of
   *   {sheetNames, totalSheets, readSheet(name) -> Promise<grid>, readAll(onProgress) -> Promise<{name: grid}>}
   */
  function openWorkbook(input) {
    var bytes;
    try { bytes = toBytes(input); } catch (e) { return Promise.reject(e); }
    if (bytes.length < 4 || u32(bytes, 0) !== 0x04034b50) {
      var head = latin1(bytes.subarray(0, 8));
      if (head.indexOf('\xd0\xcf\x11\xe0') === 0) {
        return Promise.reject(new XlsxError('Unsupported file',
          'This looks like an old .xls (Excel 97-2003) file. Open it in Excel and save it as .xlsx.'));
      }
      return Promise.reject(new XlsxError('Workbook is corrupted',
        'This is not a valid .xlsx archive. Re-save it from Excel as .xlsx.'));
    }
    var entries;
    try { entries = readZipDirectory(bytes); } catch (e2) { return Promise.reject(e2); }
    function text(path) {
      var entry = entries[path];
      if (!entry) return Promise.resolve(null);
      return readEntry(bytes, entry).then(utf8);
    }
    var wbPath = 'xl/workbook.xml';
    return text('_rels/.rels').then(function (rootRels) {
      if (rootRels) {
        var rels = parseRels(rootRels, '');
        Object.keys(rels).forEach(function (id) {
          if (/officeDocument$/.test(rels[id].type) && entries[rels[id].target]) wbPath = rels[id].target;
        });
      }
      return Promise.all([text(wbPath), text(resolveTarget(wbPath, '_rels/' + wbPath.split('/').pop() + '.rels'))]);
    }).then(function (res) {
      var wbXml = res[0];
      if (!wbXml) throw new XlsxError('Workbook is corrupted', 'The workbook part is missing. Re-save it from Excel as .xlsx.');
      var rels = res[1] ? parseRels(res[1], wbPath) : {};
      var date1904 = /<(?:\w+:)?workbookPr\b[^>]*date1904\s*=\s*["'](1|true)["']/i.test(wbXml);
      var sheets = [];
      var sheetRe = /<(?:\w+:)?sheet\b[^>]*>/g;
      var m;
      while ((m = sheetRe.exec(wbXml))) {
        var a = attrs(m[0]);
        var rid = a['r:id'];
        if (!rid) {
          Object.keys(a).forEach(function (k) { if (localName(k) === 'id' && k !== 'sheetId') rid = a[k]; });
        }
        var rel = rels[rid] || null;
        sheets.push({ name: a.name, path: rel ? rel.target : null, chart: rel ? /chartsheet$/.test(rel.type) : false });
      }
      var ssPath = null, stylesPath = null;
      Object.keys(rels).forEach(function (id) {
        if (/sharedStrings$/.test(rels[id].type)) ssPath = rels[id].target;
        if (/styles$/.test(rels[id].type)) stylesPath = rels[id].target;
      });
      ssPath = ssPath || (entries['xl/sharedStrings.xml'] ? 'xl/sharedStrings.xml' : null);
      stylesPath = stylesPath || (entries['xl/styles.xml'] ? 'xl/styles.xml' : null);
      return Promise.all([ssPath ? text(ssPath) : null, stylesPath ? text(stylesPath) : null]).then(function (parts) {
        var shared = parts[0] ? parseSharedStrings(parts[0]) : [];
        var styles = parts[1] ? parseStyles(parts[1]) : { dateStyle: [], codes: [] };
        var maxSheets = (QB.engine && QB.engine.MAX_SHEETS) || 1000;
        var listed = sheets.slice(0, maxSheets);
        function readSheet(name) {
          var info = null;
          for (var i = 0; i < listed.length; i++) if (listed[i].name === name) { info = listed[i]; break; }
          if (!info) return Promise.reject(new XlsxError('Sheet not found', "Sheet '" + name + "' does not exist."));
          if (info.chart || !info.path || !entries[info.path]) return Promise.resolve([]);
          return text(info.path).then(function (xml) { return parseSheet(xml || '', shared, styles, date1904); });
        }
        function readAll(onProgress) {
          var result = {};
          var i = 0;
          function step() {
            if (i >= listed.length) return Promise.resolve(result);
            var name = listed[i].name;
            return readSheet(name).then(function (grid) {
              result[name] = grid;
              i++;
              if (onProgress) onProgress(i, listed.length, name);
              return step();
            });
          }
          return step();
        }
        return {
          sheetNames: listed.map(function (s) { return s.name; }),
          totalSheets: sheets.length,
          readSheet: readSheet,
          readAll: readAll
        };
      });
    });
  }

  QB.xlsx = {
    openWorkbook: openWorkbook,
    inflateRaw: inflateRaw,
    XlsxError: XlsxError,
    isDateFormat: isDateFormat,
    normalizeNumberText: normalizeNumberText,
    setForceJsInflate: function (v) { forceJsInflate = !!v; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
