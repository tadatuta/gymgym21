/** All-history statistics use UTC training days; deleted logs are excluded.
 * Historical logs remain counted when their exercise type has been removed.
 */
export function getTrainingActivity(logs: { date: string; isDeleted?: boolean }[]): Map<string, number> {
  const activity = new Map<string, number>();
  for (const log of logs) {
    if (log.isDeleted) continue;
    const date = new Date(log.date);
    if (!Number.isFinite(date.getTime())) continue;
    const day = date.toISOString().slice(0, 10);
    activity.set(day, (activity.get(day) ?? 0) + 1);
  }
  return activity;
}
