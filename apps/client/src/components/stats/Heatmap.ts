import { dayKey } from '../../utils/training-time';
import { escapeAttribute } from '../../utils/safe-html';
/**
 * Renders a contribution heatmap similar to GitHub's.
 * @param dateSet Set of date strings (YYYY-MM-DD) where workouts occurred.
 * @param months Number of months to show (default 6).
 */
export function renderHeatmap(dateSet: Set<string>, months: number = 6, timeZone = 'UTC'): string {
    const today = new Date(`${dayKey(Date.now(), timeZone)}T12:00:00Z`);
    // Start from 'months' ago
    const startDate = new Date(today);
    startDate.setUTCMonth(today.getUTCMonth() - months);
    // Align to the previous Sunday to keep the grid aligned
    startDate.setUTCDate(startDate.getUTCDate() - startDate.getUTCDay());

    let html = '<div class="heatmap-container"><div class="heatmap-grid">';

    // Generate cells day by day until today
    const currentDate = new Date(startDate);
    const endDate = new Date(today);

    while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const hasWorkout = dateSet.has(dateStr);
        // Simplistic level: 0 or 4 (if workout exists). 
        // Could be improved to show intensity based on volume if we passed a Map instead of Set.
        // For now, let's distinct levels if we want, but binary is fine for consistency.
        const level = hasWorkout ? 4 : 0;

        const cssClass = `heatmap-cell level-${level}`;
        const title = `${dateStr}: ${hasWorkout ? 'Workout' : 'No workout'}`;

        html += `<div class="${escapeAttribute(cssClass)}" title="${escapeAttribute(title)}"></div>`;

        // Next day
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    html += '</div>';

    // Legend
    html += `
        <div class="heatmap-legend">
            Less <div class="heatmap-cell level-0"></div>
            <div class="heatmap-cell level-4"></div> More
        </div>
    `;

    html += '</div>';

    return html;
}
