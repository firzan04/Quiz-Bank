/*
 * Demo question bank: the curated seed sheets plus a synthetic
 * "Stress_Test_Synthetic" sheet (port of core_engine._synthetic_questions).
 */
(function (g) {
  'use strict';

  var QB = (g.QB = g.QB || {});
  var DEMO_NAME = 'question_bank.xlsx';

  function fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function syntheticRows(count, seed) {
    var E = QB.engine;
    var rng = E.rngFromSeed('demo-' + (seed || 2026));
    var names = ['Northwind Ltd', 'Contoso Group', 'Fabrikam Inc', 'Litware Plc', 'Tailspin Co',
      'Adventure Works', 'Proseware Corp', 'Woodgrove Bank', 'Alpine Ski House', 'Lucerne Publishing'];
    function randrange(a, b) { return a + Math.floor(rng() * (b - a)); }
    var rows = [];
    var guard = 0;
    while (rows.length < count && guard++ < count * 20) {
      var number = rows.length + 1;
      var name = names[Math.floor(rng() * names.length)];
      var values, question, reasons;
      if (number % 2) {
        var revenue = randrange(400, 2000) * 1000;
        var expenses = randrange(150, Math.floor(revenue / 1000) - 50) * 1000;
        var correct = revenue - expenses;
        var margin = E.pyRound(correct / revenue * 100, 1);
        values = [['correct', fmtInt(correct)], ['sum', fmtInt(revenue + expenses)],
          ['half', fmtInt(Math.floor(correct / 2))], ['margin', String(margin)]];
        E.shuffleInPlace(values, rng);
        question = '**' + name + '** reported revenue of **' + fmtInt(revenue) + '** and total expenses of **' +
          fmtInt(expenses) + '**. What is its net income?';
        reasons = {
          correct: 'Correct. Net income = revenue − expenses = ' + fmtInt(revenue) + ' − ' + fmtInt(expenses) + ' = ' + fmtInt(correct) + '.',
          sum: 'This adds expenses to revenue. Expenses reduce profit, so they must be subtracted.',
          half: 'This halves the true figure — no tax or split was stated in the question.',
          margin: 'This is the net margin in percent, not net income in currency units.'
        };
      } else {
        var cogsPct = randrange(35, 80);
        var sales = randrange(200, 900) * 1000;
        var cogs = Math.floor(sales * cogsPct / 100);
        var gm = E.pyRound((sales - cogs) / sales * 100, 1);
        values = [['correct', gm + '%'], ['inverse', E.pyRound(cogs / sales * 100, 1) + '%'],
          ['markup', E.pyRound((sales - cogs) / cogs * 100, 1) + '%'], ['abs', fmtInt(sales - cogs)]];
        E.shuffleInPlace(values, rng);
        question = '**' + name + '** generated sales of **' + fmtInt(sales) + '** with cost of goods sold of **' +
          fmtInt(cogs) + '**. What is its gross margin $\\left(\\frac{\\text{Sales} - \\text{COGS}}{\\text{Sales}}\\right)$?';
        reasons = {
          correct: 'Correct. (' + fmtInt(sales) + ' − ' + fmtInt(cogs) + ') ÷ ' + fmtInt(sales) + ' = ' + gm + '%.',
          inverse: 'This is COGS as a share of sales — the complement of gross margin.',
          markup: 'This is the mark-up on cost (profit ÷ COGS), not the margin on sales.',
          abs: 'This is gross profit in currency units; the question asks for a percentage.'
        };
      }
      var texts = {};
      var unique = values.every(function (v) { if (texts[v[1]]) return false; texts[v[1]] = true; return true; });
      if (!unique) continue;
      var row = { 'Nomor': String(number), 'Soal': question };
      values.forEach(function (pair, i) {
        var letter = 'ABCD'.charAt(i);
        row['Pilihan ' + letter] = pair[1];
        row['Pembahasan jika Pilihan ' + letter] = reasons[pair[0]];
        if (pair[0] === 'correct') row['Jawaban Benar'] = pair[1];
      });
      rows.push(row);
    }
    return rows;
  }

  function rowsToGrid(rows) {
    var cols = QB.engine.CANONICAL;
    var grid = [cols.slice()];
    rows.forEach(function (r) {
      grid.push(cols.map(function (c) { return r[c] === undefined || r[c] === null ? '' : String(r[c]); }));
    });
    return grid;
  }

  function buildDemoWorkbook() {
    var seed = QB.demoSeed || { sheets: {} };
    var grids = {};
    var names = [];
    Object.keys(seed.sheets).forEach(function (name) {
      var n = name.slice(0, 31);
      grids[n] = rowsToGrid(seed.sheets[name]);
      names.push(n);
    });
    grids.Stress_Test_Synthetic = rowsToGrid(syntheticRows(30, 2026));
    names.push('Stress_Test_Synthetic');
    return { name: DEMO_NAME, sheetNames: names, totalSheets: names.length, grids: grids };
  }

  QB.demo = { build: buildDemoWorkbook, DEMO_NAME: DEMO_NAME, syntheticRows: syntheticRows };
})(typeof window !== 'undefined' ? window : globalThis);
