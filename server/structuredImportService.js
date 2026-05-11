const USD_KRW_FALLBACK_RATE = Math.max(1000, Math.round(Number(process.env.USD_KRW_FALLBACK_RATE) || 1360));

function normalizeText(value) {
  return String(value || '').trim();
}

function parseNumber(value) {
  const raw = normalizeText(value).replace(/[^0-9.-]/g, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKrw(value) {
  const parsed = parseNumber(value);
  return parsed == null ? null : Math.round(parsed);
}

function parseUsd(value) {
  const parsed = parseNumber(value);
  return parsed == null ? null : Math.round(parsed * 100) / 100;
}

function convertUsdToKrw(amountUsd) {
  return Math.round((Number(amountUsd) || 0) * USD_KRW_FALLBACK_RATE);
}

function buildHoldingAction({
  name,
  category,
  amount,
  details,
  rationale,
}) {
  return {
    type: 'upsertHolding',
    rationale,
    holding: {
      name,
      category,
      amount,
      details,
    },
  };
}

function parseOrderLines(lines) {
  return lines
    .filter((line) => /거미줄/.test(line))
    .map((line) => line.replace(/^-+\s*/, '').trim())
    .filter(Boolean);
}

function parseAssetBlock(sectionLabel, header, lines) {
  const headerMatch = header.match(/^(.+?)(?:\s+\(([^)]+)\))?:$/);
  if (!headerMatch) return null;

  const name = normalizeText(headerMatch[1]);
  const ticker = normalizeText(headerMatch[2]);
  const quantityLine = lines.find((line) => /보유 수량/.test(line)) || '';
  const averagePriceLine = lines.find((line) => /평단가/.test(line)) || '';
  const currentPriceLine = lines.find((line) => /현재가/.test(line)) || '';
  const quantity = parseNumber(quantityLine);
  const averagePrice = sectionLabel === 'usd' ? parseUsd(averagePriceLine) : parseKrw(averagePriceLine);
  const currentPrice = sectionLabel === 'usd' ? parseUsd(currentPriceLine) : parseKrw(currentPriceLine);
  const orders = parseOrderLines(lines);

  if (!name || quantity == null || currentPrice == null) return null;

  const nativeAmount = sectionLabel === 'usd'
    ? Math.round(quantity * currentPrice * 100) / 100
    : Math.round(quantity * currentPrice);
  const amount = sectionLabel === 'usd' ? convertUsdToKrw(nativeAmount) : nativeAmount;

  return buildHoldingAction({
    name,
    category: 'stock',
    amount,
    rationale: `${name} 자산 블록에서 보유 수량과 현재가를 읽어 평가 금액을 계산했습니다.`,
    details: {
      account: sectionLabel === 'usd' ? '미국 계좌' : '한국 계좌',
      currency: sectionLabel === 'usd' ? 'USD' : 'KRW',
      ticker: ticker || name,
      quantity,
      averagePrice,
      currentPrice,
      nativeAmount,
      fxRate: sectionLabel === 'usd' ? USD_KRW_FALLBACK_RATE : null,
      orders,
      summary:
        sectionLabel === 'usd'
          ? `${quantity}주 · 현재가 $${currentPrice} · 평가 $${nativeAmount.toFixed(2)}`
          : `${quantity}주 · 현재가 ${currentPrice.toLocaleString('ko-KR')}원`,
    },
  });
}

function parseCashHolding(line, sectionLabel) {
  const match = line.match(/^(.+?예수금):\s*(.+)$/);
  if (!match) return null;
  const name = normalizeText(match[1]);
  const rawAmount = normalizeText(match[2]);
  const nativeAmount = sectionLabel === 'usd' ? parseUsd(rawAmount) : parseKrw(rawAmount);
  if (nativeAmount == null) return null;

  const amount = sectionLabel === 'usd' ? convertUsdToKrw(nativeAmount) : nativeAmount;
  return buildHoldingAction({
    name,
    category: 'deposit',
    amount,
    rationale: `${name} 현금 보유액을 자산으로 반영했습니다.`,
    details: {
      account: sectionLabel === 'usd' ? '미국 계좌' : '한국 계좌',
      currency: sectionLabel === 'usd' ? 'USD' : 'KRW',
      nativeAmount,
      fxRate: sectionLabel === 'usd' ? USD_KRW_FALLBACK_RATE : null,
      summary:
        sectionLabel === 'usd'
          ? `예수금 $${nativeAmount.toLocaleString('en-US')}`
          : `예수금 ${amount.toLocaleString('ko-KR')}원`,
      orders: [],
    },
  });
}

function buildProfileAction(content) {
  const strategy = content.match(/투자 전략:\s*(.+)/)?.[1] || '';
  const usTarget = content.match(/미국 계좌 목표 비중:\s*(.+)/)?.[1] || '';
  const krTarget = content.match(/한국 계좌 목표 비중:\s*(.+)/)?.[1] || '';
  const routine = content.match(/고정 루틴:\s*(.+)/)?.[1] || '';

  const notes = [
    strategy ? `투자 전략: ${strategy}` : '',
    usTarget ? `미국 계좌 목표 비중: ${usTarget}` : '',
    krTarget ? `한국 계좌 목표 비중: ${krTarget}` : '',
    routine ? `고정 루틴: ${routine}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    type: 'updateProfile',
    rationale: '포트폴리오 기준선과 운용 규칙을 사용자 프로필에 저장합니다.',
    profileChanges: {
      investorType: strategy ? strategy.replace(/\s*\(.+\)\s*$/, '') : '바벨 전략',
      investmentGoal: usTarget || krTarget ? '목표 비중 기반 자산 운용' : '자산 현황 관리',
      riskTolerance: strategy || '공격 및 방어 혼합',
      focusAreas: [usTarget, krTarget].filter(Boolean).join(' / '),
      notes,
    },
  };
}

function buildWorkspacePatch() {
  return {
    focusMode: 'balanced',
    highlightPanelIds: ['overview', 'holdings', 'profile', 'activity'],
    openDrawer: {
      type: 'assetDetail',
      entityId: '',
      title: '가져온 자산 요약',
    },
    reason: '구조화된 자산 입력을 반영해 포트폴리오, 보유 자산, 프로필 패널을 갱신했습니다.',
    panelPatches: [
      { id: 'overview', column: 'left', span: 'sm', priority: 10, visible: true },
      { id: 'holdings', column: 'left', span: 'xl', priority: 20, visible: true },
      { id: 'profile', column: 'right', span: 'sm', priority: 40, visible: true },
    ],
    generatedInsights: [
      {
        id: 'structured-import',
        title: '자산 기준선 반영',
        summary: '대화에 포함된 포트폴리오 기준선과 계좌 자산을 구조화해 즉시 반영했습니다.',
        tone: 'primary',
        metrics: [],
        bullets: [
          `USD 자산은 화면 집계용으로 1 USD = ${USD_KRW_FALLBACK_RATE.toLocaleString('ko-KR')} KRW 환산을 사용했습니다.`,
          '목표 비중과 고정 루틴은 프로필 메모에 함께 저장했습니다.',
        ],
      },
    ],
  };
}

function buildStructuredImportPlan(content) {
  if (!/\[Portfolio Baseline & Rules\]/.test(String(content || ''))) {
    return null;
  }

  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const actions = [];
  const parsedNames = [];
  let sectionLabel = '';
  let currentHeader = '';
  let currentLines = [];

  function flushAsset() {
    if (!currentHeader) return;
    const action = parseAssetBlock(sectionLabel, currentHeader, currentLines);
    if (action) {
      actions.push(action);
      parsedNames.push(action.holding.name);
    }
    currentHeader = '';
    currentLines = [];
  }

  for (const line of lines) {
    if (/^\[Korean Account/i.test(line)) {
      flushAsset();
      sectionLabel = 'krw';
      continue;
    }
    if (/^\[American Account/i.test(line)) {
      flushAsset();
      sectionLabel = 'usd';
      continue;
    }
    if (/^\[Portfolio Baseline & Rules\]/i.test(line)) {
      flushAsset();
      sectionLabel = 'rules';
      continue;
    }

    if (/예수금:/.test(line) && (sectionLabel === 'krw' || sectionLabel === 'usd')) {
      flushAsset();
      const action = parseCashHolding(line, sectionLabel);
      if (action) {
        actions.push(action);
        parsedNames.push(action.holding.name);
      }
      continue;
    }

    if (/:$/.test(line) && !/^[-[]/.test(line) && (sectionLabel === 'krw' || sectionLabel === 'usd')) {
      flushAsset();
      currentHeader = line;
      currentLines = [];
      continue;
    }

    if (currentHeader) {
      currentLines.push(line);
    }
  }

  flushAsset();

  if (!actions.length) {
    return null;
  }

  actions.push(buildProfileAction(content));

  const answer = [
    '입력한 자산 기준선과 계좌 정보를 구조화해 반영했습니다.',
    '',
    `반영 자산: ${parsedNames.join(', ')}`,
    `USD 자산은 화면 집계용으로 1 USD = ${USD_KRW_FALLBACK_RATE.toLocaleString('ko-KR')} KRW 환산을 사용했습니다.`,
    '투자 전략, 목표 비중, 고정 루틴은 프로필 메모에 저장했습니다.',
    '현재 Gemini API 키가 유효하지 않아 AI 해석 대신 구조화 import fallback으로 처리했습니다.',
  ].join('\n');

  return {
    actions,
    answer,
    workspacePatch: buildWorkspacePatch(),
    usedFallback: true,
  };
}

module.exports = {
  USD_KRW_FALLBACK_RATE,
  buildStructuredImportPlan,
};
