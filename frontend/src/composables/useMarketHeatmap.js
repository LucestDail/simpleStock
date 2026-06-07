import { computed } from 'vue';
import { usePortfolio } from './usePortfolio';
import { portfolioRevision } from './usePortfolioSync';
import { getHoldingQuoteLabel, isKrHolding } from '../lib/holdingDisplay';

function isUsEquity(holding) {
  const details = holding?.details || {};
  const market = String(details.market || '').toUpperCase();
  const currency = String(details.currency || '').toUpperCase();
  return market === 'US' || currency === 'USD';
}

function sessionLabel(state) {
  if (state === 'open') return '개장';
  if (state === 'pre') return '개장 전';
  if (state === 'closed') return '마감';
  return state || '—';
}

function sessionTone(state) {
  if (state === 'open') return 'open';
  if (state === 'pre') return 'pre';
  return 'closed';
}

export function useMarketHeatmap() {
  const { holdings, system, currentUsdKrwRate, busyState, refreshMarket } = usePortfolio();

  function amountKrw(holding) {
    const details = holding?.details || {};
    const nativeAmount = Number(details.nativeAmount);
    const rate = Number(currentUsdKrwRate.value);
    if (String(details.currency || '').toUpperCase() === 'USD' && Number.isFinite(nativeAmount) && rate > 0) {
      return Math.round(nativeAmount * rate);
    }
    return Number(holding.amount) || 0;
  }

  function resolveQuote(holding) {
    const details = holding.details || {};
    const ticker = String(details.ticker || '').trim();
    if (!ticker) return null;
    const marketKey = isKrHolding(holding) ? 'KR' : 'US';
    const quoteKey = `${marketKey}:${ticker}`;
    return system.value.market?.quotes?.[quoteKey] || null;
  }

  const equityHoldings = computed(() =>
    holdings.value.filter((holding) => {
      const ticker = String(holding?.details?.ticker || '').trim();
      return ticker && (holding.category === 'stock' || isUsEquity(holding) || isKrHolding(holding));
    })
  );

  function buildCell(holding) {
    const quote = resolveQuote(holding);
    const details = holding.details || {};
    const { label, sub } = getHoldingQuoteLabel(holding, quote);
    const price = details.lastQuote ?? details.currentPrice ?? quote?.price;
    const changePct = details.priceChangePct ?? quote?.changePct ?? null;
    const currency = String(details.currency || quote?.currency || '').toUpperCase();
    let priceLabel = '';
    if (Number.isFinite(Number(price))) {
      priceLabel =
        currency === 'USD'
          ? `$${Number(price).toFixed(2)}`
          : `${Math.round(Number(price)).toLocaleString('ko-KR')}`;
    }

    return {
      id: holding.id,
      holdingId: holding.id,
      label,
      sub,
      changePct,
      priceLabel,
      weight: Math.max(amountKrw(holding), 1),
      updatedAt: details.lastQuoteAt || quote?.updatedAt || null,
    };
  }

  function buildGroup(marketId, label, sessionKey, filterFn) {
    const cells = equityHoldings.value.filter(filterFn).map(buildCell);
    if (!cells.length) return null;

    const totalWeight = cells.reduce((sum, cell) => sum + cell.weight, 0);
    const withSpan = cells.map((cell) => ({
      ...cell,
      weightPct: totalWeight ? Math.round((cell.weight / totalWeight) * 100) : 0,
      flexGrow: Math.max(1, Math.round((cell.weight / totalWeight) * 100)),
    }));

    const avgChange =
      withSpan.filter((c) => c.changePct != null).length > 0
        ? withSpan.reduce((sum, c) => sum + (Number(c.changePct) || 0), 0) /
          withSpan.filter((c) => c.changePct != null).length
        : null;

    const session = system.value.market?.sessions?.[sessionKey] || {};

    return {
      id: marketId,
      label,
      sessionLabel: sessionLabel(session.state),
      sessionTone: sessionTone(session.state),
      avgChange,
      cells: withSpan.sort((a, b) => b.weight - a.weight),
    };
  }

  const marketGroups = computed(() => {
    portfolioRevision.value;
    const kr = buildGroup('KR', '한국 (KRX)', 'kr', isKrHolding);
    const us = buildGroup('US', '미국', 'us', (h) => isUsEquity(h) && !isKrHolding(h));
    return [kr, us].filter(Boolean);
  });

  const hasHeatmap = computed(() => marketGroups.value.length > 0);

  const marketRefreshLabel = computed(() => {
    const at = system.value.market?.lastSuccessAt || system.value.market?.lastRefreshAt;
    if (!at) return '';
    return new Intl.DateTimeFormat('ko-KR', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(at));
  });

  return {
    marketGroups,
    hasHeatmap,
    marketRefreshLabel,
    busyState,
    refreshMarket,
    equityCount: computed(() => equityHoldings.value.length),
  };
}
