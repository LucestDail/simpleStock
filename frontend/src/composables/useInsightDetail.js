import { computed } from 'vue';
import {
  CATEGORIES,
  formatKRW,
  usePortfolio,
} from './usePortfolio';
import { useWorkspace } from './useWorkspace';
import { formatRunLabel, getNextRunDate } from '../lib/cronSchedule';

const TONE_LABELS = {
  positive: '양호',
  warning: '주의',
  primary: '핵심',
  default: '참고',
};

function formatBriefTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatSnapshotDate(date) {
  if (!date) return '';
  const [, month, day] = String(date).split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}

function sessionLabel(state) {
  if (state === 'open') return '개장';
  if (state === 'pre') return '개장 전';
  if (state === 'closed') return '마감';
  return state || '—';
}

export function useInsightDetail() {
  const {
    total,
    categoryShares,
    dayOverDay,
    lastSnapshot,
    sortedSnapshots,
    holdings,
    manager,
    system,
    currentUsdKrwRate,
  } = usePortfolio();
  const { generatedInsights } = useWorkspace();

  const visibleCategories = computed(() =>
    categoryShares.value.filter((item) => Number(item.amount) > 0)
  );

  const dominantCategory = computed(() => {
    const rows = [...visibleCategories.value].sort((a, b) => b.amount - a.amount);
    return rows[0] || null;
  });

  const concentrationTone = computed(() =>
    dominantCategory.value && dominantCategory.value.pct >= 55 ? 'warning' : 'positive'
  );

  const portfolioSignalCard = computed(() => {
    const dominant = dominantCategory.value;
    return {
      id: 'portfolio-signal',
      title: '포트폴리오 시그널',
      tone: concentrationTone.value,
      toneLabel: TONE_LABELS[concentrationTone.value] || TONE_LABELS.default,
      summary: dominant
        ? `${dominant.label} 비중 ${dominant.pct}%로 가장 큽니다.`
        : '등록된 자산이 없어 시그널을 계산할 수 없습니다.',
      metrics: [
        { label: '총 자산', value: formatKRW(total.value) },
        {
          label: '직전 스냅샷 대비',
          value: dayOverDay.value
            ? `${dayOverDay.value.delta >= 0 ? '+' : ''}${formatKRW(dayOverDay.value.delta)}${
                dayOverDay.value.pct != null ? ` (${dayOverDay.value.pct >= 0 ? '+' : ''}${dayOverDay.value.pct}%)` : ''
              }`
            : '기록 없음 (브리핑·수동 저장 후 표시)',
        },
        {
          label: '최근 스냅샷',
          value: lastSnapshot.value
            ? `${formatSnapshotDate(lastSnapshot.value.date)} · ${formatKRW(lastSnapshot.value.total)}`
            : '없음',
        },
        {
          label: '환율',
          value: currentUsdKrwRate.value
            ? `USD/KRW ${Number(currentUsdKrwRate.value).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`
            : '—',
        },
      ],
      bullets: [
        dominant && dominant.pct >= 55
          ? `${dominant.label} 집중도가 높습니다. 분산·리밸런싱 여부를 점검하세요.`
          : dominant
            ? `카테고리 분산이 비교적 고른 편입니다. ${dominant.label} 흐름을 우선 관찰하세요.`
            : '대화로 자산을 등록하면 비중·시그널이 채워집니다.',
        'Quant Manager 브리핑이 실행될 때마다 당일 스냅샷이 자동 저장됩니다.',
      ],
    };
  });

  const holdingsByCategory = computed(() => {
    const rate = currentUsdKrwRate.value;
    const map = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
    for (const holding of holdings.value) {
      if (!map[holding.category]) continue;
      const details = holding.details || {};
      const currency = String(details.currency || '').toUpperCase();
      const nativeAmount = Number(details.nativeAmount);
      let amountKrw = Number(holding.amount) || 0;
      if (currency === 'USD' && Number.isFinite(nativeAmount) && nativeAmount > 0 && rate > 0) {
        amountKrw = Math.round(nativeAmount * rate);
      }
      map[holding.category].push({
        id: holding.id,
        name: holding.name,
        amountKrw,
        ticker: details.ticker || '',
        market: details.market || '',
        priceChangePct: details.priceChangePct,
      });
    }
    return CATEGORIES.map((category) => ({
      ...category,
      rows: (map[category.id] || [])
        .sort((a, b) => b.amountKrw - a.amountKrw)
        .slice(0, 6),
      total: visibleCategories.value.find((item) => item.id === category.id)?.amount || 0,
      pct: visibleCategories.value.find((item) => item.id === category.id)?.pct || 0,
    })).filter((item) => item.total > 0);
  });

  const snapshotTrend = computed(() => {
    const rows = [...sortedSnapshots.value]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 8)
      .map((snapshot, index, list) => {
        const prev = list[index + 1];
        const current = Number(snapshot.total) || 0;
        const previous = Number(prev?.total) || 0;
        let deltaLabel = '—';
        if (prev && previous > 0) {
          const delta = current - previous;
          const pct = Math.round((delta / previous) * 1000) / 10;
          deltaLabel = `${delta >= 0 ? '+' : ''}${formatKRW(delta)} (${pct >= 0 ? '+' : ''}${pct}%)`;
        }
        return {
          date: snapshot.date,
          dateLabel: formatSnapshotDate(snapshot.date),
          total: formatKRW(current),
          deltaLabel,
          byCategory: snapshot.byCategory || {},
        };
      });
    return rows;
  });

  const latestManagerReport = computed(() => manager.value?.latestReport || null);

  const managerBriefSection = computed(() => {
    const report = latestManagerReport.value;
    if (!report) {
      return {
        available: false,
        emptyMessage: '아직 브리핑이 없습니다. 예약 작업 또는 「브리핑 생성」 후 여기에 표시됩니다.',
      };
    }
    return {
      available: true,
      summary: report.summary,
      targetDate: report.targetDate,
      createdAtLabel: formatBriefTime(report.createdAt),
      trigger: report.trigger,
      dailyObjective: report.dailyObjective,
      actionItems: report.actionItems || [],
      riskChecks: report.riskChecks || [],
      allocationNotes: report.allocationNotes || [],
      conversationInsights: report.conversationInsights || [],
    };
  });

  const marketPulse = computed(() => {
    const sessions = system.value.market?.sessions || {};
    const fx = system.value.market?.fx?.USDKRW;
    return {
      kr: sessionLabel(sessions.kr?.state),
      us: sessionLabel(sessions.us?.state),
      fxRate: fx?.rate ? Number(fx.rate).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—',
      fxChangePct:
        fx?.changePct != null
          ? `${Number(fx.changePct) >= 0 ? '+' : ''}${Number(fx.changePct).toFixed(2)}%`
          : '—',
    };
  });

  const nextManagerBrief = computed(() => {
    const tasks = (system.value.scheduledTasks || []).filter(
      (task) => task.enabled && task.taskType === 'managerBrief' && task.cronExpression
    );
    const timezone = system.value.timezone || 'Asia/Seoul';
    let nearest = null;
    for (const task of tasks) {
      const nextRun = getNextRunDate(task.cronExpression, timezone);
      if (!nextRun) continue;
      if (!nearest || nextRun.getTime() < nearest.nextRun.getTime()) {
        nearest = { task, nextRun };
      }
    }
    if (!nearest) return null;
    return {
      title: nearest.task.title,
      label: formatRunLabel(nearest.nextRun, timezone),
    };
  });

  const aiInsightCards = computed(() =>
    (generatedInsights.value || []).map((card) => ({
      ...card,
      toneLabel: TONE_LABELS[card.tone] || TONE_LABELS.default,
    }))
  );

  return {
    TONE_LABELS,
    portfolioSignalCard,
    visibleCategories,
    holdingsByCategory,
    snapshotTrend,
    managerBriefSection,
    latestManagerReport,
    marketPulse,
    nextManagerBrief,
    aiInsightCards,
    formatKRW,
  };
}
