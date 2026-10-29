/*
 * Lightweight SVG charts (no external library):
 *   timePerQuestion  — bars by outcome, outliers outlined, μ and μ+1σ lines
 *   outcomeDonut     — correct / incorrect / skipped
 *   timeGauge        — time used vs allocated budget
 *   historyTrend     — accuracy over time, one line per paket soal
 */
(function (g) {
  'use strict';

  var QB = (g.QB = g.QB || {});
  var P = {
    void: '#0B0F19', border: '#2A344A', brand2: '#FF5722', success: '#00E396', danger: '#FF003F',
    info: '#008FFB', amber: '#FFB020', text: '#F1F5F9', muted: '#94A3B8', subtle: '#64748B'
  };
  var STATUS_COLORS = { correct: P.success, wrong: P.danger, skipped: P.subtle };
  var MONO = "'JetBrains Mono', ui-monospace, monospace";

  function esc(s) { return QB.md ? QB.md.esc(s) : String(s); }
  function f1(x) { return QB.engine ? QB.engine.fixed(x, 1) : Number(x).toFixed(1); }

  function niceStep(max, ticks) {
    var raw = max / Math.max(1, ticks);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function timePerQuestion(rows, stats) {
    if (!rows.length) return '<div class="chart-empty">No timing data.</div>';
    var n = rows.length;
    var left = 50, right = 20, top = 26, bottom = 30;
    var barSlot = 18;
    var minPlot = 300;
    var plotW = Math.max(minPlot, n * barSlot);
    var width = left + plotW + right;
    var height = 250;
    var plotH = height - top - bottom;
    var maxT = 0;
    rows.forEach(function (r) { maxT = Math.max(maxT, r.time); });
    var yMax = Math.max(1, maxT * 1.18, stats.threshold * 1.08);
    var step = niceStep(yMax, 4);
    yMax = Math.ceil(yMax / step) * step;
    function y(v) { return top + plotH - (v / yMax) * plotH; }
    var slot = plotW / n;
    var bw = Math.max(4, Math.min(28, slot * 0.68));
    var parts = [];
    parts.push('<svg class="chart chart--bars" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Time spent per question">');
    for (var t = 0; t <= yMax + 1e-9; t += step) {
      var yy = y(t);
      parts.push('<line x1="' + left + '" x2="' + (left + plotW) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + P.border + '" stroke-width="1" opacity=".55"/>');
      parts.push('<text x="' + (left - 6) + '" y="' + (yy + 3.5) + '" text-anchor="end" font-size="9.5" fill="' + P.subtle + '" font-family="' + MONO + '">' + (step < 1 ? f1(t) : Math.round(t)) + 's</text>');
    }
    var every = Math.max(1, Math.ceil(n / Math.max(1, plotW / 30)));
    rows.forEach(function (r, i) {
      var cx = left + slot * i + slot / 2;
      var h = Math.max(r.time > 0 ? 1.5 : 0, (r.time / yMax) * plotH);
      var color = STATUS_COLORS[r.status] || P.subtle;
      var stroke = r.isOutlier ? ' stroke="' + P.info + '" stroke-width="2.5"' : '';
      parts.push('<g class="chart__bar" data-act="chart-bar" data-i="' + i + '"><rect x="' + (cx - slot / 2) + '" y="' + top + '" width="' + slot + '" height="' + plotH + '" fill="transparent"/>' +
        '<rect x="' + (cx - bw / 2) + '" y="' + (y(0) - h) + '" width="' + bw + '" height="' + h + '" rx="3" fill="' + color + '" opacity=".88"' + stroke + '/>' +
        '<title>' + esc(r.label + ' · ' + f1(r.time) + 's · ' + r.excerpt) + '</title></g>');
      if (r.isOutlier) {
        var my = y(r.time) - 9;
        parts.push('<path d="M' + cx + ' ' + (my - 5) + ' L' + (cx + 5) + ' ' + my + ' L' + cx + ' ' + (my + 5) + ' L' + (cx - 5) + ' ' + my + ' Z" fill="' + P.info + '" stroke="#fff" stroke-width="1"/>');
      }
      if (i % every === 0) {
        parts.push('<text x="' + cx + '" y="' + (height - bottom + 15) + '" text-anchor="middle" font-size="9.5" fill="' + P.muted + '" font-family="' + MONO + '">' + esc(r.label) + '</text>');
      }
    });
    if (stats.mean > 0) {
      var ym = y(stats.mean);
      parts.push('<line x1="' + left + '" x2="' + (left + plotW) + '" y1="' + ym + '" y2="' + ym + '" stroke="' + P.muted + '" stroke-width="1" stroke-dasharray="5 4"/>');
      parts.push('<text x="' + (left + plotW - 2) + '" y="' + (ym + 12) + '" text-anchor="end" font-size="10" fill="' + P.muted + '" font-family="' + MONO + '">μ ' + f1(stats.mean) + 's</text>');
    }
    if (stats.std > 0) {
      var yt = y(stats.threshold);
      parts.push('<line x1="' + left + '" x2="' + (left + plotW) + '" y1="' + yt + '" y2="' + yt + '" stroke="' + P.info + '" stroke-width="1" stroke-dasharray="2 3"/>');
      parts.push('<text x="' + (left + plotW - 2) + '" y="' + (yt - 5) + '" text-anchor="end" font-size="10" fill="' + P.info + '" font-family="' + MONO + '">μ+1σ ' + f1(stats.threshold) + 's</text>');
    }
    parts.push('<text x="10" y="' + (top + plotH / 2) + '" transform="rotate(-90 10 ' + (top + plotH / 2) + ')" text-anchor="middle" font-size="10" fill="' + P.subtle + '">Active seconds</text>');
    parts.push('</svg>');
    return parts.join('');
  }

  function arcPath(cx, cy, r, a0, a1) {
    var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    var large = a1 - a0 > Math.PI ? 1 : 0;
    return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
  }

  function outcomeDonut(summary) {
    var values = [summary.correct || 0, summary.wrong || 0, summary.skipped || 0];
    var colors = [P.success, P.danger, P.subtle];
    var total = values[0] + values[1] + values[2];
    var size = 190, cx = 95, cy = 95, r = 74, w = 18;
    var parts = ['<svg class="chart chart--donut" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Outcome mix">'];
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(42,52,74,.55)" stroke-width="' + w + '"/>');
    if (total > 0) {
      var a = -Math.PI / 2;
      values.forEach(function (v, i) {
        if (!v) return;
        var span = (v / total) * Math.PI * 2;
        if (span >= Math.PI * 2 - 1e-6) {
          parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + colors[i] + '" stroke-width="' + w + '"/>');
        } else {
          var gap = total > v ? 0.025 : 0;
          parts.push('<path d="' + arcPath(cx, cy, r, a + gap, a + span - gap) + '" fill="none" stroke="' + colors[i] + '" stroke-width="' + w + '" stroke-linecap="butt"/>');
        }
        a += span;
      });
    }
    parts.push('<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="26" font-weight="700" fill="' + P.text + '" font-family="' + MONO + '">' + (summary.correct || 0) + '/' + (summary.total || 0) + '</text>');
    parts.push('<text x="' + cx + '" y="' + (cy + 24) + '" text-anchor="middle" font-size="10" letter-spacing="2" fill="' + P.muted + '" font-family="' + MONO + '">CORRECT</text>');
    parts.push('</svg>');
    return parts.join('');
  }

  function timeGauge(summary) {
    var used = Number(summary.total_time_s || 0);
    var allocated = Number(summary.allocated_time_s || 1);
    var pct = allocated ? 100 * used / allocated : 0;
    var axisMax = Math.max(100, Math.ceil(pct / 10) * 10);
    var color = pct < 75 ? P.success : (pct < 95 ? P.amber : P.danger);
    var w = 240, h = 140, cx = 120, cy = 118, r = 92, sw = 20;
    function ang(v) { return Math.PI + (Math.min(v, axisMax) / axisMax) * Math.PI; }
    var parts = ['<svg class="chart chart--gauge" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Time utilisation">'];
    parts.push('<path d="' + arcPath(cx, cy, r, Math.PI, 2 * Math.PI) + '" fill="none" stroke="rgba(42,52,74,.45)" stroke-width="' + sw + '"/>');
    [[0, 75, 'rgba(0,227,150,.10)'], [75, 95, 'rgba(255,176,32,.12)'], [95, 100, 'rgba(255,0,63,.16)']].forEach(function (s) {
      parts.push('<path d="' + arcPath(cx, cy, r + sw / 2 + 4, ang(s[0]), ang(s[1])) + '" fill="none" stroke="' + s[2] + '" stroke-width="5"/>');
    });
    if (pct > 0) {
      parts.push('<path d="' + arcPath(cx, cy, r, Math.PI, Math.max(Math.PI + 0.01, ang(pct))) + '" fill="none" stroke="' + color + '" stroke-width="' + (sw * 0.62) + '" stroke-linecap="round"/>');
    }
    var ta = ang(100);
    parts.push('<line x1="' + (cx + (r - sw / 2 - 2) * Math.cos(ta)).toFixed(2) + '" y1="' + (cy + (r - sw / 2 - 2) * Math.sin(ta)).toFixed(2) + '" x2="' + (cx + (r + sw / 2 + 2) * Math.cos(ta)).toFixed(2) + '" y2="' + (cy + (r + sw / 2 + 2) * Math.sin(ta)).toFixed(2) + '" stroke="' + P.text + '" stroke-width="2"/>');
    parts.push('<text x="' + cx + '" y="' + (cy - 14) + '" text-anchor="middle" font-size="30" font-weight="700" fill="' + P.text + '" font-family="' + MONO + '">' + f1(pct) + '%</text>');
    parts.push('<text x="' + (cx - r) + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="9" fill="' + P.subtle + '" font-family="' + MONO + '">0</text>');
    parts.push('<text x="' + (cx + r) + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="9" fill="' + P.subtle + '" font-family="' + MONO + '">' + axisMax + '</text>');
    parts.push('</svg>');
    return parts.join('');
  }

  function historyTrend(rows) {
    if (!rows.length) return '<div class="chart-empty">No sessions yet.</div>';
    var palette = [P.brand2, P.info, P.success, P.amber, '#B57CFF', '#FF7AB6'];
    var ordered = rows.slice().sort(function (a, b) { return a.finished - b.finished; });
    var groups = [];
    var byName = {};
    ordered.forEach(function (r) {
      if (!byName[r.sheet]) { byName[r.sheet] = { name: r.sheet, pts: [] }; groups.push(byName[r.sheet]); }
      byName[r.sheet].pts.push(r);
    });
    var tMin = ordered[0].finished, tMax = ordered[ordered.length - 1].finished;
    if (tMax - tMin < 1800) { var c = (tMin + tMax) / 2; tMin = c - 43200; tMax = c + 43200; }
    var w = 360, h = 220, left = 38, right = 12, top = 12, bottom = 38;
    var pw = w - left - right, ph = h - top - bottom;
    function x(t) { return left + ((t - tMin) / (tMax - tMin)) * pw; }
    function y(v) { return top + ph - (Math.max(0, Math.min(105, v)) / 105) * ph; }
    var parts = ['<svg class="chart chart--trend" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Accuracy over time">'];
    parts.push('<rect x="' + left + '" y="' + y(100) + '" width="' + pw + '" height="' + (y(80) - y(100)) + '" fill="rgba(0,227,150,.06)"/>');
    [0, 20, 40, 60, 80, 100].forEach(function (v) {
      parts.push('<line x1="' + left + '" x2="' + (left + pw) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + P.border + '" opacity=".5"/>');
      parts.push('<text x="' + (left - 6) + '" y="' + (y(v) + 3.5) + '" text-anchor="end" font-size="9.5" fill="' + P.subtle + '" font-family="' + MONO + '">' + v + '%</text>');
    });
    for (var k = 0; k <= 3; k++) {
      var t = tMin + (tMax - tMin) * (k / 3);
      var d = new Date(t * 1000);
      var label = d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      var hm = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
      var anchor = k === 0 ? 'start' : (k === 3 ? 'end' : 'middle');
      parts.push('<text x="' + x(t) + '" y="' + (h - bottom + 15) + '" text-anchor="' + anchor + '" font-size="9.5" fill="' + P.muted + '" font-family="' + MONO + '">' + label + '</text>');
      parts.push('<text x="' + x(t) + '" y="' + (h - bottom + 27) + '" text-anchor="' + anchor + '" font-size="9" fill="' + P.subtle + '" font-family="' + MONO + '">' + hm + '</text>');
    }
    groups.forEach(function (gr, i) {
      var color = palette[i % palette.length];
      var dpath = gr.pts.map(function (p, j) { return (j ? 'L' : 'M') + x(p.finished).toFixed(1) + ' ' + y(p.accuracy).toFixed(1); }).join(' ');
      if (gr.pts.length > 1) parts.push('<path d="' + dpath + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round"/>');
      gr.pts.forEach(function (p) {
        parts.push('<circle cx="' + x(p.finished).toFixed(1) + '" cy="' + y(p.accuracy).toFixed(1) + '" r="4.5" fill="' + color + '" stroke="' + P.void + '" stroke-width="2"><title>' +
          esc(p.file + ' · ' + f1(p.accuracy) + '% · ' + p.duration) + '</title></circle>');
      });
    });
    parts.push('</svg>');
    var legend = '<div class="chart-legend">' + groups.map(function (gr, i) {
      return '<span><i style="background:' + palette[i % palette.length] + '"></i>' + esc(gr.name) + '</span>';
    }).join('') + '</div>';
    return parts.join('') + legend;
  }

  QB.charts = { timePerQuestion: timePerQuestion, outcomeDonut: outcomeDonut, timeGauge: timeGauge,
    historyTrend: historyTrend, STATUS_COLORS: STATUS_COLORS, PALETTE: P };
})(typeof window !== 'undefined' ? window : globalThis);
