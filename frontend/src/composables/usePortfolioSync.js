import { ref } from 'vue';
import { usePortfolio } from './usePortfolio';
import { useProfile } from './useProfile';

/** UI 강제 갱신용 — apply 후 computed 재계산 트리거 */
export const portfolioRevision = ref(0);

function bumpRevision() {
  portfolioRevision.value += 1;
}

/**
 * 대화·SSE·수동 저장 후 포트폴리오 상태를 즉시 반영한다.
 * 1) 스트림/SSE 인라인 payload 즉시 적용
 * 2) 액션이 있었으면 서버에서 최신 스냅샷 재조회(이중 확인)
 */
export async function syncPortfolioState({
  portfolio = null,
  profile = null,
  actionResults = [],
  forceFetch = false,
} = {}) {
  const { applyPortfolioPayload, fetchPortfolio } = usePortfolio();
  const { applyProfilePayload, fetchProfile } = useProfile();

  const attempted = Array.isArray(actionResults) && actionResults.length > 0;
  const applied = attempted && actionResults.some((item) => item?.status === 'applied');

  if (portfolio && typeof portfolio === 'object') {
    applyPortfolioPayload(portfolio);
    bumpRevision();
  }

  if (profile && typeof profile === 'object') {
    applyProfilePayload(profile);
  }

  const shouldRefetch = forceFetch || applied || attempted || Boolean(portfolio);

  if (shouldRefetch) {
    await fetchPortfolio();
    bumpRevision();
    if (profile) {
      await fetchProfile();
    }
  }

  return { applied, attempted, revision: portfolioRevision.value };
}

export function handleStreamPortfolioEvent(event = {}) {
  if (!event || event.type !== 'portfolio') return null;
  return syncPortfolioState({
    portfolio: event.portfolio,
    profile: event.profile,
    actionResults: event.actionResults || [],
    forceFetch: Boolean(event.forceFetch),
  });
}
