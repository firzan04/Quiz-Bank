/*
 * Markdown + LaTeX renderer for question text, options and explanations.
 *
 * Behaves like Streamlit's st.markdown for the content found in quiz banks:
 * raw HTML is escaped, **bold** / *italic* / `code` / ~~strike~~, headings,
 * lists, block quotes, tables and rules are supported, and $...$ / $$...$$
 * (or \( \) / \[ \]) are typeset with KaTeX. Soft line breaks collapse to a
 * space; two trailing spaces or a backslash force a line break.
 */
(function (g) {
  'use strict';

  var QB = (g.QB = g.QB || {});
  var OPEN = '';
  var CLOSE = '';

  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function Store() { this.items = []; }
  Store.prototype.put = function (html) {
    this.items.push(html);
    return OPEN + (this.items.length - 1) + CLOSE;
  };
  Store.prototype.restore = function (text) {
    var self = this;
    var re = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');
    // Placeholders may nest (e.g. math inside a link label): restore until stable.
    for (var guard = 0; guard < 5 && re.test(text); guard++) {
      re.lastIndex = 0;
      text = text.replace(re, function (m, i) { return self.items[+i]; });
    }
    return text;
  };

  function katexHtml(tex, display) {
    var k = g.katex;
    if (!k || typeof k.renderToString !== 'function') {
      return '<code class="md-math-raw">' + esc((display ? '$$' : '$') + tex + (display ? '$$' : '$')) + '</code>';
    }
    try {
      return k.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' });
    } catch (e) {
      return '<code class="md-math-raw">' + esc(tex) + '</code>';
    }
  }

  // ------------------------------------------------------------------ protection pass
  function protect(src, store) {
    var text = src;
    // Fenced code blocks.
    text = text.replace(/(^|\n)( {0,3})(```+|~~~+)[^\n]*\n([\s\S]*?)(\n {0,3}\3[ \t]*(?=\n|$)|$)/g,
      function (m, lead, indent, fence, body) {
        return lead + store.put('<pre class="md-pre"><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>') + '\n';
      });
    // Inline code spans (their content is never treated as math or markup).
    text = text.replace(/(^|[^\\`])(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/g, function (m, lead, ticks, body) {
      var inner = body;
      if (/^ .* $/.test(inner) && /[^ ]/.test(inner)) inner = inner.slice(1, -1);
      return lead + store.put('<code class="md-code">' + esc(inner.replace(/\n/g, ' ')) + '</code>');
    });
    // Display math: $$...$$ and \[...\] (an escaped \$ never opens math).
    text = text.replace(/(^|[^\\])\$\$([\s\S]+?)\$\$/g, function (m, lead, tex) {
      return lead + store.put(katexHtml(tex.trim(), true));
    });
    text = text.replace(/(^|[^\\])\\\[([\s\S]+?)\\\]/g, function (m, lead, tex) {
      return lead + store.put(katexHtml(tex.trim(), true));
    });
    // Inline math: \(...\) and $...$ on one paragraph.
    text = text.replace(/(^|[^\\])\\\(([\s\S]+?)\\\)/g, function (m, lead, tex) {
      return lead + store.put(katexHtml(tex.trim(), false));
    });
    text = text.replace(/(^|[^\\$])\$((?:\\[\s\S]|[^\\$\n])(?:\\[\s\S]|[^\\$])*?)\$(?!\$)/g, function (m, lead, tex) {
      if (/\n\s*\n/.test(tex) || !tex.trim()) return m;
      return lead + store.put(katexHtml(tex.trim(), false));
    });
    // Backslash escapes of markdown punctuation (\$ \* \_ ...) in the remaining text.
    text = text.replace(/\\([\\`*_{}[\]()#+\-.!|~$<>"'])/g, function (m, ch) { return store.put(esc(ch)); });
    return text;
  }

  // ------------------------------------------------------------------ inline formatting
  function safeUrl(url) {
    var u = String(url).trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    return null;
  }

  function inline(text, store) {
    var t = esc(text);
    // Autolinks <https://...> (already escaped as &lt;...&gt;).
    t = t.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/gi, function (m, url) {
      return store.put('<a href="' + url + '" rel="noopener">' + url + '</a>');
    });
    // Images: show the alt text only (the app is offline).
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (m, alt) { return alt; });
    // Links.
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (m, label, url) {
      var safe = safeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return label;
      return store.put('<a href="' + esc(safe) + '" rel="noopener">') + label + store.put('</a>');
    });
    // Strong, emphasis, strikethrough (no nesting across placeholders needed).
    t = t.replace(/\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^\w])__(?=[^\s_])([\s\S]*?[^\s_])__(?=$|[^\w])/g, '$1<strong>$2</strong>');
    t = t.replace(/(^|[^*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w_])_(?=[^\s_])([^_]*?[^\s_])_(?=$|[^\w_])/g, '$1<em>$2</em>');
    t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    return t;
  }

  function paragraphInline(lines, store) {
    var parts = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var isLast = i === lines.length - 1;
      var hard = !isLast && (/ {2,}$/.test(line) || /\\$/.test(line));
      var content = line.replace(/\\$/, '').replace(/[ \t]+$/, '');
      if (i > 0) content = content.replace(/^[ \t]+/, '');
      parts.push(inline(content, store) + (isLast ? '' : (hard ? '<br>' : ' ')));
    }
    return parts.join('');
  }

  // ------------------------------------------------------------------ blocks
  var RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  var RE_BULLET = /^( {0,3})([-*+])[ \t]+(.*)$/;
  var RE_ORDERED = /^( {0,3})(\d{1,9})([.)])[ \t]+(.*)$/;
  var RE_QUOTE = /^ {0,3}>[ ]?(.*)$/;
  var RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function blocks(src, store) {
    var lines = src.split('\n');
    var out = [];
    var i = 0;
    function isBlank(l) { return /^\s*$/.test(l); }
    function startsBlock(l, next) {
      return RE_HR.test(l) || RE_HEADING.test(l) || RE_BULLET.test(l) || RE_ORDERED.test(l) || RE_QUOTE.test(l) ||
        (l.indexOf('|') >= 0 && next !== undefined && RE_TABLE_SEP.test(next) && next.indexOf('-') >= 0);
    }
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }
      if (new RegExp('^\\s*' + OPEN + '\\d+' + CLOSE + '\\s*$').test(line) && /<pre/.test(store.restore(line.trim()))) {
        out.push(line.trim());
        i++;
        continue;
      }
      var h = RE_HEADING.exec(line);
      if (h) {
        var level = h[1].length;
        out.push('<h' + level + ' class="md-h">' + inline(h[2] || '', store) + '</h' + level + '>');
        i++;
        continue;
      }
      if (RE_HR.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
      if (RE_QUOTE.test(line)) {
        var q = [];
        while (i < lines.length && !isBlank(lines[i]) && (RE_QUOTE.test(lines[i]) || q.length)) {
          var qm = RE_QUOTE.exec(lines[i]);
          q.push(qm ? qm[1] : lines[i]);
          i++;
        }
        out.push('<blockquote class="md-quote">' + blocks(q.join('\n'), store) + '</blockquote>');
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          var l = c.charAt(0) === ':';
          var r = c.charAt(c.length - 1) === ':';
          return l && r ? 'center' : (r ? 'right' : (l ? 'left' : ''));
        });
        i += 2;
        var body = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) { body.push(splitRow(lines[i])); i++; }
        var cell = function (tag, text, k) {
          var a = aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '';
          return '<' + tag + a + '>' + inline(text || '', store) + '</' + tag + '>';
        };
        var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
          head.map(function (c, k) { return cell('th', c, k); }).join('') + '</tr></thead><tbody>' +
          body.map(function (row) {
            var cells = [];
            for (var k = 0; k < head.length; k++) cells.push(cell('td', row[k], k));
            return '<tr>' + cells.join('') + '</tr>';
          }).join('') + '</tbody></table></div>';
        out.push(html);
        continue;
      }
      var bullet = RE_BULLET.exec(line);
      var ordered = RE_ORDERED.exec(line);
      if (bullet || ordered) {
        var isOrdered = !!ordered;
        var startNum = isOrdered ? parseInt(ordered[2], 10) : 1;
        var items = [];
        var current = null;
        while (i < lines.length) {
          var l = lines[i];
          var bm = RE_BULLET.exec(l);
          var om = RE_ORDERED.exec(l);
          var sameKind = isOrdered ? om : bm;
          if (sameKind && sameKind[1].length <= 3) {
            current = [isOrdered ? om[4] : bm[3]];
            items.push(current);
            i++;
            continue;
          }
          if (isBlank(l)) {
            var nxt = lines[i + 1];
            if (nxt !== undefined && (/^\s{2,}\S/.test(nxt) || (isOrdered ? RE_ORDERED.test(nxt) : RE_BULLET.test(nxt)))) {
              if (current) current.push('');
              i++;
              continue;
            }
            break;
          }
          if (/^\s{2,}\S/.test(l) || (current && !startsBlock(l, lines[i + 1]))) {
            if (current) current.push(l.replace(/^\s{1,4}/, ''));
            i++;
            continue;
          }
          break;
        }
        var lis = items.map(function (it) {
          var inner = it.join('\n');
          var hasBlocks = /\n\s*\n/.test(inner) || it.slice(1).some(function (x, idx) { return startsBlock(x, it[idx + 2]); });
          return '<li>' + (hasBlocks ? blocks(inner, store) : paragraphInline(it.filter(function (x) { return x !== ''; }), store)) + '</li>';
        });
        out.push(isOrdered
          ? '<ol class="md-list"' + (startNum !== 1 ? ' start="' + startNum + '"' : '') + '>' + lis.join('') + '</ol>'
          : '<ul class="md-list">' + lis.join('') + '</ul>');
        continue;
      }
      // Paragraph (with setext heading detection).
      var para = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i])) {
          var lvl = lines[i].trim().charAt(0) === '=' ? 1 : 2;
          out.push('<h' + lvl + ' class="md-h">' + paragraphInline(para, store) + '</h' + lvl + '>');
          para = null;
          i++;
          break;
        }
        if (para.length && startsBlock(lines[i], lines[i + 1])) break;
        para.push(lines[i]);
        i++;
      }
      if (para && para.length) out.push('<p>' + paragraphInline(para, store) + '</p>');
    }
    return out.join('');
  }

  /** Render block-level Markdown. */
  function render(src) {
    var store = new Store();
    var text = String(src === null || src === undefined ? '' : src).replace(/\r\n?/g, '\n');
    text = protect(text, store);
    return store.restore(blocks(text, store));
  }

  /** Render a short label (options, answers) without paragraph wrappers. */
  function renderInline(src) {
    var store = new Store();
    var text = String(src === null || src === undefined ? '' : src).replace(/\r\n?/g, '\n');
    text = protect(text, store);
    var lines = text.split('\n').filter(function (l) { return !/^\s*$/.test(l); });
    return store.restore(paragraphInline(lines, store));
  }

  /** Plain-text excerpt (for charts, lists and file names). */
  function plain(src, limit) {
    var s = String(src === null || src === undefined ? '' : src)
      .replace(/\$\$?([^$]*)\$\$?/g, '$1')
      .replace(/[*_`#>~]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (limit && s.length > limit) s = s.slice(0, limit - 1).trim() + '…';
    return s;
  }

  QB.md = { render: render, renderInline: renderInline, plain: plain, esc: esc };
})(typeof window !== 'undefined' ? window : globalThis);
