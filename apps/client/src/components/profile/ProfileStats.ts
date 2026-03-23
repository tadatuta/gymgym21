import { ProfileStats } from '../../types';
import { renderHeatmap } from '../stats/Heatmap';

export function renderProfileStats(stats: ProfileStats, logDates?: Set<string>): string {
  const totalVolume = stats.totalVolume;
  let volumeDisplay = '';

  if (totalVolume < 1000) {
    volumeDisplay = `${Math.round(totalVolume)}кг`;
  } else if (totalVolume < 10000) {
    volumeDisplay = `${(totalVolume / 1000).toFixed(1)}т`;
  } else {
    volumeDisplay = `${Math.round(totalVolume / 1000)}т`;
  }

  return `
      <div class="profile-stats">
        <div class="stat-card">
          <div class="stat-value">${stats.totalWorkouts}</div>
          <div class="stat-label">Тренировок</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${volumeDisplay}</div>
          <div class="stat-label">Общий объём</div>
        </div>
        ${stats.favoriteExercise ? `
          <div class="stat-card">
            <div class="stat-value" style="font-size: 1rem;">${stats.favoriteExercise}</div>
            <div class="stat-label">Любимое упражнение</div>
          </div>
        ` : ''}
        ${stats.lastWorkoutDate ? `
          <div class="stat-card">
            <div class="stat-value" style="font-size: 1rem;">${new Date(stats.lastWorkoutDate).toLocaleDateString()}</div>
            <div class="stat-label">Последняя тренировка</div>
          </div>
        ` : ''}
      </div>

      ${logDates && logDates.size > 0 ? `
        <div class="activity-list">
          <h2 class="subtitle">Активность</h2>
          ${renderHeatmap(logDates)}
        </div>
      ` : ''}
    `;
}
