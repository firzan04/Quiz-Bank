// Usage: node run_session.js <workbook.xlsx> <scenarios.json>
// Replays scripted sessions through the JS engine (parity test helper).
'use strict';
const fs = require('fs');
const path = require('path');
const www = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'www', 'js');
require(path.join(www, 'engine.js'));
require(path.join(www, 'xlsx.js'));
const E = globalThis.QB.engine;

function r6(v) { return typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v; }
function norm(st) {
  const keys = ['view', 'cursor', 'answers', 'pending', 'submitted', 'revealed', 'grades', 'flags', 'expired', 'confirm_finish', 'last_timeout'];
  const setKeys = ['submitted', 'revealed', 'flags', 'expired'];
  const out = {};
  for (const k of keys) {
    let v = st[k];
    if (setKeys.includes(k)) v = Object.keys(v).map(Number).sort((a, b) => a - b);
    else if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).map(Number).sort((a, b) => a - b).forEach((i) => { o[String(i)] = v[i]; });
      v = o;
    }
    out[k] = v === undefined ? null : v;
  }
  const t = st.telemetry || {};
  out.telemetry = {};
  for (const [k, v] of Object.entries(t)) out.telemetry[k] = Array.isArray(v) ? v.map(r6) : r6(v);
  return out;
}

(async () => {
  const wb = await globalThis.QB.xlsx.openWorkbook(fs.readFileSync(process.argv[2]));
  const scen = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const results = {};
  for (const sc of scen) {
    const st = {};
    E.initState(st);
    const r = E.loadQuestionSheet(sc.sheet, await wb.readSheet(sc.sheet));
    const c = sc.config;
    const cfg = E.buildConfig({ workbook: path.basename(process.argv[2]), sheet: sc.sheet, mode: c.mode, allow_previous: c.allow_previous,
      timer_mode: c.timer_mode, timer_text: c.timer_text, shuffle_options: c.shuffle_options, direct_feedback: c.direct_feedback,
      shuffle_questions: c.shuffle_questions });
    E.startSession(st, cfg, r.questions, sc.steps[0][1] > 1000 ? 1000.0 : sc.steps[0][1] - 3.6);
    const trace = [];
    for (const step of sc.steps) {
      const op = step[0];
      if (op === 'begin') E.beginExecution(st, step[1]);
      else if (op === 'select') E.recordSelection(st, step[1], step[2]);
      else if (op === 'submit') trace.push(['submit', E.submitAnswer(st, step[1], step[2])]);
      else if (op === 'next') E.nextQuestion(st, step[1]);
      else if (op === 'prev') E.previousQuestion(st, step[1]);
      else if (op === 'goto') E.goTo(st, step[1], step[2]);
      else if (op === 'flag') E.setFlag(st, step[1], step[2]);
      else if (op === 'reveal') E.revealCard(st, step[1]);
      else if (op === 'grade') E.gradeCard(st, step[1], step[2], step[3]);
      else if (op === 'tick') trace.push(['tick', E.checkTimeout(st, step[1])]);
      else if (op === 'finish') { if (st.view === 'session') E.finishSession(st, step[1], step[2]); }
      const snap = norm(st);
      if (st.view === 'session') snap.remaining = null;
      trace.push([op, snap]);
    }
    let rec = st.result ? JSON.parse(JSON.stringify(st.result)) : null;
    if (rec) delete rec.session_id;
    results[sc.name] = { trace, record: rec, config: cfg };
  }
  process.stdout.write(JSON.stringify(results));
})();
