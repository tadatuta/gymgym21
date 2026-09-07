import { render1RMChart, renderDurationChart, renderVolumeChart } from '../../components/stats/Charts';
import { renderHeatmap } from '../../components/stats/Heatmap';
import { formatDuration } from '../../utils/duration';
import { escapeHtml, renderOption } from '../../utils/safe-html';
import { getDurationStats, getOneRepMaxByDate } from '../../utils/statistics';
import { getTrainingActivity } from '../../utils/training-activity';
import type { PageContext } from '../context';
import { createLifecycle } from '../lifecycle';
export function createStatsPage(context: PageContext) {
  const { state, dependencies } = context;
  const { storage } = dependencies;
  const lifecycle = createLifecycle();
  function updateStatsContent() {
    const content = document.querySelector('.content');
    if (!content) return;
    content.innerHTML = renderStatsPage();
    bindStatsPageEvents();
    lifecycle.sweep();
  }

  function bindStatsPageEvents() {
    const tabs = document.querySelectorAll('.stats-tab');
    tabs.forEach(tab => {
      lifecycle.listen(tab, 'click', () => {
        const tabId = tab.getAttribute('data-tab');
        if (tabId === 'overview' || tabId === 'progress') {
          state.currentStatsTab = tabId;
          updateStatsContent();
        }
      });
    });

    const typeSelect = document.getElementById('stat-type-select');
    lifecycle.listen(typeSelect, 'change', (e) => {
      state.selectedStatType = (e.target as HTMLSelectElement).value;
      updateStatsContent();
    });
  }

  function renderStatsPage() {
    const logs = storage.getLogs();
    const workouts = storage.getWorkouts();
    const types = storage.getWorkoutTypes();

    if (logs.length === 0) {
      return `
      <div class="page-content">
        <p class="hint">Недостаточно данных для статистики</p>
      </div>
    `;
    }

    // Calculate generic stats
    const totalVolume = logs.reduce((acc, l) => acc + ((l.weight || 0) * (l.reps || 0)), 0);
    const totalReps = logs.reduce((acc, l) => acc + (l.reps || 0), 0);
    const durationStats = getDurationStats(workouts, logs);

    let html = `
    <div class="page-content">
      <div class="stats-tabs">
        <button class="stats-tab ${state.currentStatsTab === 'overview' ? 'active' : ''}" data-tab="overview">Обзор</button>
        <button class="stats-tab ${state.currentStatsTab === 'progress' ? 'active' : ''}" data-tab="progress">Прогресс</button>
      </div>
  `;

    if (state.currentStatsTab === 'overview') {
      const dates = new Set(getTrainingActivity(logs, storage.getTimeZone()).keys());

      html += `
        <div class="stats-section">
            <h2 class="subtitle">Активность</h2>
            ${renderHeatmap(dates, 6, storage.getTimeZone())}
        </div>

        <div class="stats-summary">
            <div class="stat-metric">
                <div class="stat-metric__label">Тренировочных дней</div>
                <div class="stat-metric__value">${escapeHtml(dates.size)}</div>
            </div>
            <div class="stat-metric">
                <div class="stat-metric__label">Сред. длительность</div>
                <div class="stat-metric__value">${escapeHtml(formatDuration(durationStats.averageSeconds))}</div>
            </div>
             <div class="stat-metric">
                <div class="stat-metric__label">Общий объем</div>
                <div class="stat-metric__value">${escapeHtml(Math.round(totalVolume / 1000))}<span class="stat-metric__unit">т</span></div>
            </div>
            <div class="stat-metric">
                <div class="stat-metric__label">Всего повторений</div>
                <div class="stat-metric__value">${escapeHtml(totalReps)}</div>
            </div>
        </div>

        <div class="charts-section">
            <h2 class="subtitle">Длительность тренировок</h2>
            <div class="chart-container">
                ${renderDurationChart(workouts, logs, storage.getTimeZone())}
            </div>
        </div>
     `;
    } else {
      // Progress Tab
      html += `
        <div class="form-group">
            <label class="label">Упражнение</label>
            <select class="select" id="stat-type-select">
                <option value="all">Все упражнения (Объем)</option>
                ${types.map(t => renderOption(t.id, t.name, state.selectedStatType === t.id)).join('')}
            </select>
        </div>
    `;

      if (state.selectedStatType === 'all') {
        html += `
            <div class="charts-section">
                <h2 class="subtitle">Общий объем по дням</h2>
                <div class="chart-container">
                    ${renderVolumeChart(logs, storage.getTimeZone())}
                </div>
            </div>
        `;
      } else {
        const typeLogs = logs.filter(l => l.workoutTypeId === state.selectedStatType);
        const oneRepMaxData = getOneRepMaxByDate(typeLogs, state.selectedStatType, storage.getTimeZone());

        html += `
             <div class="charts-section">
                <h2 class="subtitle">Прогресс силовых (1RM)</h2>
                <div class="chart-container">
                    ${render1RMChart(oneRepMaxData)}
                </div>
            </div>

            <div class="charts-section" style="margin-top: 24px;">
                <h2 class="subtitle">Объем нагрузки</h2>
                 <div class="chart-container">
                    ${renderVolumeChart(typeLogs, storage.getTimeZone())}
                </div>
            </div>
        `;
      }
    }

    html += `</div>`;
    return html;
  }
  function bindEvents() {
    bindStatsPageEvents();
  }
  return { sweep: lifecycle.sweep, render: renderStatsPage, refresh: updateStatsContent, mount: bindEvents, dispose: () => lifecycle.dispose() };
}
