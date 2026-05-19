import { computed } from 'vue';
import { usePortfolio } from './usePortfolio';
import { formatRunLabel, getNextRunDate } from '../lib/cronSchedule';

export { formatRunLabel, getNextRunDate, matchesCronExpression } from '../lib/cronSchedule';

export function useScheduledTasks() {
  const { system } = usePortfolio();
  const timezone = computed(() => system.value.timezone || 'Asia/Seoul');

  const displayTasks = computed(() =>
    (system.value.scheduledTasks || []).slice(0, 12).map((task) => {
      if (!task?.enabled) {
        return { ...task, displayRunLabel: '비활성' };
      }
      if (task?.cronExpression) {
        const nextRun = getNextRunDate(task.cronExpression, timezone.value);
        return {
          ...task,
          displayRunLabel: formatRunLabel(nextRun, timezone.value),
        };
      }
      return { ...task, displayRunLabel: task?.nextRunLabel || '대기' };
    })
  );

  return { displayTasks, timezone };
}
