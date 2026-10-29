// Usage: node dump_workbook.js <file.xlsx> [--js-inflate]
// Prints the parsed + validated view of every sheet as JSON (for parity tests).
'use strict';
const fs = require('fs');
const path = require('path');
const www = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'www', 'js');
require(path.join(www, 'engine.js'));
require(path.join(www, 'xlsx.js'));
const QB = globalThis.QB;
if (process.argv.includes('--js-inflate')) QB.xlsx.setForceJsInflate(true);

(async () => {
  const file = process.argv[2];
  const out = { file: path.basename(file) };
  try {
    const wb = await QB.xlsx.openWorkbook(fs.readFileSync(file));
    out.sheetNames = wb.sheetNames;
    out.totalSheets = wb.totalSheets;
    out.sheets = {};
    for (const name of wb.sheetNames) {
      try {
        const grid = await wb.readSheet(name);
        const r = QB.engine.loadQuestionSheet(name, grid);
        out.sheets[name] = { layout: r.layout, rows_scanned: r.rows_scanned, issues: r.issues, questions: r.questions };
      } catch (e) {
        out.sheets[name] = { error: [e.kind || e.name, e.title, e.detail] };
      }
    }
  } catch (e) {
    out.error = [e.kind || e.name, e.title, e.detail, String(e.stack || e)];
  }
  process.stdout.write(JSON.stringify(out));
})();
