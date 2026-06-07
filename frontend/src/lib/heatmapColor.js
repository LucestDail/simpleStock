/**
 * 등락률(%) → 히트맵 배경·텍스트 색 (저자극 그라데이션)
 */
export function heatmapStyleFromChangePct(changePct, { maxAbs = 5 } = {}) {
  if (changePct == null || !Number.isFinite(Number(changePct))) {
    return {
      background: 'var(--heatmap-neutral-bg)',
      color: 'var(--heatmap-neutral-fg)',
      borderColor: 'var(--color-hairline)',
    };
  }

  const pct = Math.max(-maxAbs, Math.min(maxAbs, Number(changePct)));
  const intensity = Math.abs(pct) / maxAbs;

  if (pct >= 0) {
    const alpha = 0.12 + intensity * 0.38;
    return {
      background: `rgba(74, 158, 120, ${alpha})`,
      color: intensity > 0.35 ? '#e8f5ef' : 'var(--color-ink)',
      borderColor: `rgba(74, 158, 120, ${0.15 + intensity * 0.35})`,
    };
  }

  const alpha = 0.12 + intensity * 0.38;
  return {
    background: `rgba(184, 90, 98, ${alpha})`,
    color: intensity > 0.35 ? '#fcecee' : 'var(--color-ink)',
    borderColor: `rgba(184, 90, 98, ${0.15 + intensity * 0.35})`,
  };
}

export function formatChangePct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
