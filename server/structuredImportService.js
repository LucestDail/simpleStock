const USD_KRW_FALLBACK_RATE = Math.max(1000, Math.round(Number(process.env.USD_KRW_FALLBACK_RATE) || 1360));

function normalizeText(value) {
  return String(value || '').trim();
}

function parseNumber(value) {
  const raw = normalizeText(value).replace(/[^0-9.-]/g, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractNumericToken(value) {
  const match = normalizeText(value).match(/-?\$?\s*[\d,]+(?:\.\d+)?/);
  return match ? match[0] : '';
}

function parseKrw(value) {
  const parsed = parseNumber(extractNumericToken(value));
  return parsed == null ? null : Math.round(parsed);
}

function parseUsd(value) {
  const parsed = parseNumber(extractNumericToken(value));
  return parsed == null ? null : Math.round(parsed * 100) / 100;
}

function convertUsdToKrw(amountUsd) {
  return Math.round((Number(amountUsd) || 0) * USD_KRW_FALLBACK_RATE);
}

function inferCategoryFromName(name) {
  const normalized = normalizeText(name).toLowerCase();
  if (!normalized) return 'deposit';
  if (/(irp|연금)/i.test(normalized)) return 'pension';
  if (/(펀드|신탁|인덱스)/i.test(normalized)) return 'fund';
  if (/(청약|도약|적금)/i.test(normalized)) return 'installment';
  if (/(주식|etf|tiger|ace|qld|jepi)/i.test(normalized)) return 'stock';
  return 'deposit';
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
  const quantityMatch = quantityLine.match(/보유 수량:\s*([\d,]+(?:\.\d+)?)/);
  const quantity = quantityMatch ? parseNumber(quantityMatch[1]) : null;
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
      market: sectionLabel === 'usd' ? 'US' : 'KR',
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
      market: sectionLabel === 'usd' ? 'US' : 'KR',
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
      { id: 'overview', column: 'left', span: 'md', priority: 10, visible: true },
      { id: 'holdings', column: 'left', span: 'xl', priority: 20, visible: true },
      { id: 'profile', column: 'right', span: 'md', priority: 40, visible: true },
      { id: 'managerBrief', column: 'right', span: 'xs', priority: 10, visible: false },
      { id: 'snapshots', column: 'right', span: 'xs', priority: 20, visible: false },
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
  const source = String(content || '');
  if (!/\[Portfolio Baseline & Rules\]/.test(source)) {
    return buildSimpleAssetImportPlan(source);
  }

  const lines = source
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

function buildSimpleAssetImportPlan(content) {
  const source = String(content || '').trim();
  if (!source || !/(반영|추가|저장|등록|업데이트)/.test(source)) {
    return null;
  }

  const actions = [];
  const parsedNames = [];
  const amountPattern = /([\d,]+(?:\.\d+)?)\s*(원|USD|usd|달러|\$)/g;
  let previousEnd = 0;

  for (const match of source.matchAll(amountPattern)) {
    const rawSegment = source.slice(previousEnd, match.index);
    previousEnd = match.index + match[0].length;
    const rawName = normalizeText(
      rawSegment
        .replace(/^(다음 정보를 현재 포트폴리오와 설정에 즉시 반영해줘\.?\s*가능하면 자산, 계좌 현황, 규칙, 목표 비중, 고정 루틴까지 저장하고 반영 결과를 요약해줘\.?\s*)/i, '')
        .replace(/^(자산|계좌|현황)\s+/i, '')
        .replace(/\s*(자산\s*)?(반영해줘|추가해줘|저장해줘|등록해줘)\s*$/i, '')
    );
    const unit = String(match[2] || '').toUpperCase();
    const amount = unit === 'USD' || unit === '$' || /달러/i.test(match[2] || '')
      ? convertUsdToKrw(parseUsd(match[1]))
      : parseKrw(match[1]);

    if (!rawName || amount == null) continue;

    actions.push(
      buildHoldingAction({
        name: rawName,
        category: inferCategoryFromName(rawName),
        amount,
        rationale: `${rawName} 금액 표현을 읽어 자산으로 반영했습니다.`,
        details: {
          currency: unit === 'USD' || unit === '$' || /달러/i.test(match[2] || '') ? 'USD' : 'KRW',
          nativeAmount:
            unit === 'USD' || unit === '$' || /달러/i.test(match[2] || '')
              ? parseUsd(match[1])
              : parseKrw(match[1]),
          fxRate:
            unit === 'USD' || unit === '$' || /달러/i.test(match[2] || '')
              ? USD_KRW_FALLBACK_RATE
              : null,
          summary:
            unit === 'USD' || unit === '$' || /달러/i.test(match[2] || '')
              ? `${rawName} ${match[1]} USD`
              : `${rawName} ${amount.toLocaleString('ko-KR')}원`,
          orders: [],
        },
      })
    );
    parsedNames.push(rawName);
  }

  if (!actions.length) {
    return null;
  }

  return {
    actions,
    answer: [
      '입력한 자산 정보를 구조화해 반영했습니다.',
      '',
      `반영 자산: ${parsedNames.join(', ')}`,
      '필요하면 같은 형식으로 추가 자산도 계속 반영할 수 있습니다.',
    ].join('\n'),
    workspacePatch: buildWorkspacePatch(),
    usedFallback: true,
  };
}

module.exports = {
  USD_KRW_FALLBACK_RATE,
  buildStructuredImportPlan,
};
