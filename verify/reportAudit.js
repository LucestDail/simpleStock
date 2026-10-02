/**
 * 분석 보고서 감사 — **"이 숫자가 우리가 준 것인가"** (2026-10-02)
 *
 * 프롬프트는 *"제공된 숫자를 그대로 인용합니다. 근거 없는 수치는 쓰지 않습니다"* 를
 * 요구한다. 그런데 **그게 지켜졌는지 확인하는 장치가 없었다** — 지시는 있고 검증이 없으면
 * 그건 *"선언한 안전망이 실재하는지 확인하지 않은"* 그 자리다.
 *
 * ## 🔴 이 자가 내는 것은 "거짓말" 이 아니라 **세 갈래**다
 * ```
 * 그대로   프롬프트에 그 숫자가 있다            → 인용이다
 * 반올림   자릿수만 다르다(96.54 ↔ 96.5)        → 인용이다(표기 차이)
 * 못 찾음  프롬프트에 없다                       → 🔴 **지어냈거나 계산한 것** — 사람이 본다
 * ```
 * ⚠️ **못 찾음을 곧바로 "거짓" 이라 부르지 않는다.** 모델이 `300주 × $9.6 ≈ $2,880` 처럼
 *    **정당하게 유도**할 수 있다. 자가 단정하면 멀쩡한 보고서를 의심하게 만든다.
 *    ⇒ 판정은 사람이 하고, 자는 **어디를 봐야 하는지**만 좁힌다.
 *
 * ## ⚠️ 자가 아무것도 안 보는 상태를 막는다
 * 추출한 숫자가 너무 적으면 **통과가 아니라 실패**다 — 0건을 "완벽" 으로 읽는 것이
 * 이 저장소가 가장 여러 번 밟은 실패 모드다.
 *
 * 사용: `node verify/reportAudit.js [--json]`
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const REPORT_FILE = process.env.ANALYST_LAST_FILE || path.join(DATA, 'analyst-last.json');
const PROMPT_FILE = process.env.ANALYST_LAST_PROMPT_FILE || path.join(DATA, 'analyst-last-prompt.txt');

/** 산문에서 **수치**만 뽑는다. ⚠️ 연도·순번은 근거가 아니므로 거른다 */
function numbersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0];
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    // 연도(1900~2100 정수)·한 자리 순번은 근거 수치가 아니다
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue;
    if (Math.abs(n) < 2 && Number.isInteger(n)) continue;
    out.push({ raw, n });
  }
  return out;
}

/** 프롬프트 안의 수치 집합 — 한 번만 만든다 */
function promptNumbers(prompt) {
  const set = new Set();
  for (const { n } of numbersIn(prompt)) {
    set.add(n);
    set.add(Math.round(n * 100) / 100);
    set.add(Math.round(n * 10) / 10);
    set.add(Math.round(n));
  }
  return set;
}

/**
 * 한 수치의 판정.
 * ⚠️ **부호를 벗겨서도 본다** — 프롬프트가 `-24.06` 을 주고 보고서가 `24.06%` 라 쓰면
 *    그건 인용이지 날조가 아니다.
 */
function verdictOf(n, set) {
  const cands = [n, -n];
  for (const c of cands) {
    if (set.has(c)) return 'exact';
    if (set.has(Math.round(c * 100) / 100)) return 'exact';
  }
  for (const c of cands) {
    if (set.has(Math.round(c * 10) / 10) || set.has(Math.round(c))) return 'rounded';
  }
  return 'missing';
}

/** 보고서에서 **모델이 쓴 산문**만 모은다(코드가 만든 값은 감사 대상이 아니다) */
function proseOf(report) {
  const out = [];
  const push = (where, t) => { if (t) out.push({ where, text: String(t) }); };
  push('marketView', report.marketView);
  push('momentumRead', report.momentumRead);
  for (const p of report.positions || []) {
    // ⚠️ 코드가 채운 자리는 모델이 쓴 글이 아니다 — 감사 대상에서 뺀다
    if (p._codeFilled) continue;
    push(`${p.symbol}.rationale`, p.rationale);
    push(`${p.symbol}.risk`, p.risk);
    push(`${p.symbol}.scenarioUp`, p.scenarioUp);
    push(`${p.symbol}.scenarioDown`, p.scenarioDown);
    for (const e of p.evidence || []) push(`${p.symbol}.evidence`, e);
  }
  for (const pr of report.proposals || []) push(`제안 ${pr.symbol}`, pr.reason);
  return out;
}

function audit({ report, prompt }) {
  const set = promptNumbers(prompt);
  const rows = [];
  for (const { where, text } of proseOf(report)) {
    for (const { raw, n } of numbersIn(text)) {
      rows.push({ where, raw, n, verdict: verdictOf(n, set) });
    }
  }
  const by = (v) => rows.filter((r) => r.verdict === v);
  return {
    promptChars: String(prompt || '').length,
    promptNumbers: set.size,
    checked: rows.length,
    exact: by('exact').length,
    rounded: by('rounded').length,
    missing: by('missing'),
    // 🔴 **자가 아무것도 안 본 상태**는 통과가 아니다
    usable: rows.length >= 8 && set.size >= 20,
  };
}

/** 타당성 — 제안이 **발동 매뉴얼의 도구상자** 안에서 나왔는가 */
function proposalSanity(report, prompt) {
  const notes = [];
  const judged = new Set((report.positions || []).filter((p) => !p._codeFilled)
    .map((p) => String(p.symbol || '').toUpperCase()));
  const acted = new Set((report.proposals || []).map((p) => String(p.symbol || '').toUpperCase()));
  for (const p of report.positions || []) {
    if (p._codeFilled) continue;
    const st = String(p.stance || '').toUpperCase();
    const sym = String(p.symbol || '').toUpperCase();
    if (/^(BUY|SELL)$/.test(st) && !acted.has(sym)) {
      notes.push(`🔴 ${sym} 는 stance=${st} 인데 제안이 없다 (수량·가격을 못 정한 것)`);
    }
  }
  for (const pr of report.proposals || []) {
    const sym = String(pr.symbol || '').toUpperCase();
    // ⚠️ 도구상자는 프롬프트의 "## 도구상자" 절에 **티커로** 실린다
    const box = (String(prompt).match(/## 도구상자[\s\S]*?(?=\n## |$)/) || [''])[0];
    if (box && !new RegExp(`\\b${sym}\\b`).test(box) && !judged.has(sym)) {
      notes.push(`🔴 제안 ${sym} 이 도구상자에도 보유에도 없다 (매뉴얼 밖 종목)`);
    }
    if (!(Number(pr.quantity) > 0) || !(Number(pr.price) > 0)) {
      notes.push(`🔴 제안 ${sym} 의 수량/가격이 비었다`);
    }
  }
  return notes;
}

function main() {
  let report; let prompt;
  try { report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')); }
  catch (e) { console.log(`🔴 보고서를 못 읽었다: ${e.message}`); process.exit(2); }
  try { prompt = fs.readFileSync(PROMPT_FILE, 'utf8'); }
  catch {
    // ⚠️ **판정 불가를 통과로 보여주지 않는다**
    console.log('🔴 프롬프트가 없다 — 이 회차는 감사할 수 없다(판정 불가).');
    console.log('   `savePrompt` 가 붙은 뒤의 회차부터 가능하다.');
    process.exit(2);
  }

  const a = audit({ report, prompt });
  const sanity = proposalSanity(report, prompt);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...a, sanity }, null, 1));
    return;
  }
  console.log(`보고서 ${report.at || '(시각 없음)'}`);
  console.log(`프롬프트 ${a.promptChars}자 · 수치 ${a.promptNumbers}종`);
  if (!a.usable) {
    console.log(`🔴 **판정 불가** — 검사한 수치 ${a.checked}건(최소 8) · 프롬프트 수치 ${a.promptNumbers}종(최소 20).`);
    console.log('   자가 거의 아무것도 안 봤다. 이것은 통과가 아니다.');
    process.exit(2);
  }
  const pct = (n) => `${Math.round((n / a.checked) * 1000) / 10}%`;
  console.log(`근거 ${a.checked}건 — 그대로 ${a.exact}(${pct(a.exact)}) · 반올림 ${a.rounded}(${pct(a.rounded)}) · 못 찾음 ${a.missing.length}(${pct(a.missing.length)})`);
  if (a.missing.length) {
    console.log('\n🔴 프롬프트에 없는 수치 (지어냈거나 모델이 계산한 것 — 사람이 가른다):');
    for (const m of a.missing.slice(0, 20)) console.log(`   ${m.where}: ${m.raw}`);
    if (a.missing.length > 20) console.log(`   … 외 ${a.missing.length - 20}건`);
  }
  console.log('\n타당성:');
  if (!sanity.length) console.log('   어긋난 항목 없음');
  else for (const n of sanity) console.log(`   ${n}`);
}

if (require.main === module) main();
module.exports = { audit, proposalSanity, numbersIn, promptNumbers, verdictOf, proseOf };
