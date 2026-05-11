import { ref, computed } from 'vue';

export const CATEGORIES = [
  { id: 'deposit', label: '예금' },
  { id: 'installment', label: '적금' },
  { id: 'stock', label: '주식' },
  { id: 'fund', label: '펀드' },
  { id: 'pension', label: '연금' },
];

const holdings = ref([]);
const snapshots = ref([]);
const loading = ref(false);
const error = ref(null);

export function formatKRW(n) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(n || 0);
}

export function usePortfolio() {
  const total = computed(() =>
    holdings.value.reduce((s, h) => s + (Number(h.amount) || 0), 0)
  );

  const byCategory = computed(() => {
    const m = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
    for (const h of holdings.value) {
      if (m[h.category] != null) m[h.category] += Number(h.amount) || 0;
    }
    return m;
  });

  const categoryShares = computed(() => {
    const t = total.value;
    if (!t) return CATEGORIES.map((c) => ({ ...c, amount: 0, pct: 0 }));
    return CATEGORIES.map((c) => ({
      ...c,
      amount: byCategory.value[c.id],
      pct: Math.round((byCategory.value[c.id] / t) * 1000) / 10,
    }));
  });

  async function fetchPortfolio() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/portfolio');
      if (!res.ok) throw new Error('불러오기 실패');
      const data = await res.json();
      holdings.value = data.holdings || [];
      snapshots.value = data.snapshots || [];
    } catch (e) {
      error.value = e.message || '오류';
    } finally {
      loading.value = false;
    }
  }

  async function saveHoldings(list) {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/portfolio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: list }),
      });
      if (!res.ok) throw new Error('저장 실패');
      const data = await res.json();
      holdings.value = data.holdings || [];
      snapshots.value = data.snapshots || [];
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function addSnapshot(date) {
    const res = await fetch('/api/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(date ? { date } : {}),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || '스냅샷 저장 실패');
    }
    await fetchPortfolio();
  }

  async function deleteSnapshot(date) {
    const res = await fetch(`/api/snapshots/${encodeURIComponent(date)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('삭제 실패');
    await fetchPortfolio();
  }

  const sortedSnapshots = computed(() =>
    [...snapshots.value].sort((a, b) => b.date.localeCompare(a.date))
  );

  const lastSnapshot = computed(() => {
    const s = [...snapshots.value].sort((a, b) => b.date.localeCompare(a.date));
    return s[0] || null;
  });

  const dayOverDay = computed(() => {
    const sorted = [...snapshots.value].sort((a, b) => b.date.localeCompare(a.date));
    if (sorted.length < 2) return null;
    const [latest, prev] = sorted;
    return {
      delta: latest.total - prev.total,
      pct:
        prev.total > 0
          ? Math.round(((latest.total - prev.total) / prev.total) * 1000) / 10
          : null,
    };
  });

  return {
    holdings,
    snapshots,
    sortedSnapshots,
    loading,
    error,
    total,
    byCategory,
    categoryShares,
    lastSnapshot,
    dayOverDay,
    fetchPortfolio,
    saveHoldings,
    addSnapshot,
    deleteSnapshot,
  };
}
