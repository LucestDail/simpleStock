export function isKrHolding(holding) {
  const details = holding?.details || {};
  const market = String(details.market || '').toUpperCase();
  const currency = String(details.currency || '').toUpperCase();
  const ticker = String(details.ticker || '').trim();
  return market === 'KR' || (currency === 'KRW' && /^\d{6,9}[A-Z]?$/.test(ticker));
}

function isUsHolding(holding) {
  const details = holding?.details || {};
  const market = String(details.market || '').toUpperCase();
  const currency = String(details.currency || '').toUpperCase();
  return market === 'US' || currency === 'USD';
}

/**
 * 시세 티커·목록용 표시 라벨 (한국 종목은 종목명 우선).
 */
export function getHoldingQuoteLabel(holding, quote = null) {
  const details = holding?.details || {};
  const ticker = String(details.ticker || quote?.symbol || '').trim();
  const name = String(holding?.name || quote?.shortName || '').trim();
  const isKr = isKrHolding(holding) || String(quote?.currency || '').toUpperCase() === 'KRW';

  if (isKr) {
    return {
      label: name || ticker || '—',
      sub: ticker && name && ticker !== name ? ticker : '',
    };
  }

  if (isUsHolding(holding)) {
    return {
      label: ticker || name || '—',
      sub: name && name !== ticker ? name.slice(0, 24) : '',
    };
  }

  return {
    label: name || ticker || '—',
    sub: ticker && name && ticker !== name ? ticker : '',
  };
}

export function formatHoldingMetaLine(holding) {
  const { label, sub } = getHoldingQuoteLabel(holding);
  const details = holding?.details || {};
  const parts = [label];
  if (sub) parts.push(sub);
  if (details.account) parts.push(details.account);
  if (Number.isFinite(Number(details.quantity))) parts.push(`${details.quantity}주`);
  return parts.filter(Boolean).join(' · ');
}
