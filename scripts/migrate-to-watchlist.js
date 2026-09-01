#!/usr/bin/env node
// 개인 자산(holdings) → 관심종목(watchlist) 마이그레이션 + 개인 데이터 백업.
// v2(개인 자산 워크스페이스) → v3(종합 트래커) 전환용. 개인 필드(수량·평단가·계좌·금액)는 버리고
// 티커/이름/시장/통화만 추출해 시장별 테마 그룹으로 만든다. 원본은 data/_archive-personal-*/ 로 백업.
// 멱등: watchlist 에 이미 종목이 있으면 변경하지 않는다(--force 로 재생성).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FORCE = process.argv.includes('--force');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function normSym(v) {
  return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
}

function cleanName(name) {
  return (
    String(name || '')
      .replace(/\((?:[^()]*(?:주|株|관찰|관측|watch)[^()]*)\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || '종목'
  );
}

function extractTickers(holdings) {
  const map = new Map();
  for (const h of holdings || []) {
    const ticker = normSym(h?.details?.ticker);
    if (!ticker) continue;
    const market = String(h?.details?.market || '').toUpperCase();
    const currency = String(h?.details?.currency || '').toUpperCase();
    const isUs = market === 'US' || currency === 'USD';
    const mk = isUs ? 'US' : 'KR';
    const key = `${mk}:${ticker}`;
    if (map.has(key)) continue;
    map.set(key, {
      symbol: ticker,
      name: cleanName(h.name),
      market: mk,
      currency: isUs ? 'USD' : 'KRW',
      addedAt: new Date().toISOString(),
    });
  }
  return [...map.values()];
}

function main() {
  const portfolio = readJson('portfolio.json', { holdings: [] });
  const existing = readJson('watchlist.json', { groups: [] });
  if (!FORCE && existing.groups && existing.groups.some((g) => (g.tickers || []).length)) {
    console.log('watchlist 에 이미 종목이 있습니다. --force 로 재생성하세요. (변경 없음)');
    return;
  }

  const tickers = extractTickers(portfolio.holdings);
  const kr = tickers.filter((t) => t.market !== 'US');
  const us = tickers.filter((t) => t.market === 'US');
  const groups = [];
  let order = 0;
  const stamp36 = Date.now().toString(36);
  if (kr.length) groups.push({ id: `grp-kr-${stamp36}`, name: '국내 주식·ETF', order: order++, tickers: kr });
  if (us.length) groups.push({ id: `grp-us-${stamp36}`, name: '미국 주식·ETF', order: order++, tickers: us });
  if (!groups.length) groups.push({ id: `grp-default-${stamp36}`, name: '관심종목', order: 0, tickers: [] });

  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const archiveDir = path.join(DATA_DIR, `_archive-personal-${stamp}`);
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const f of ['portfolio.json', 'profile.json', 'chat.json']) {
    const src = path.join(DATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(archiveDir, f));
  }

  fs.writeFileSync(path.join(DATA_DIR, 'watchlist.json'), `${JSON.stringify({ groups }, null, 2)}\n`);
  console.log(`마이그레이션 완료: 그룹 ${groups.length}개, 티커 ${tickers.length}개. 개인데이터 백업=${archiveDir}`);
}

main();
