import './telegram-mock';
import './components/typeahead/typeahead.css';
import { renderTypeahead, bindTypeahead, registerTypeaheadItems, getTypeaheadValue } from './components/typeahead/Typeahead';
import './styles/base.css';
import './styles/components.css';
import './styles/profile.css';
import './components/navigation/navigation.css';
import { storage, SyncStatus } from './storage/storage';
import { WorkoutSet, WorkoutSession, PublicProfileData, WorkoutType } from './types';
import './styles/stats.css';
import { getOneRepMaxByDate, getWorkoutDates, getDurationStats } from './utils/statistics';
import { renderHeatmap } from './components/stats/Heatmap';
import { renderVolumeChart, render1RMChart, renderDurationChart } from './components/stats/Charts';
import {
  MigrationStatus,
  TelegramLoginData,
  addPasskey,
  canUsePasskeyInCurrentContext,
  getCurrentUser,
  getMigrationStatus,
  getTelegramInitData,
  isTelegramMiniApp,
  linkTelegramAccount,
  openBrowserHandoff,
  restoreSession,
  serializeTelegramLoginData,
  signOut,
} from './auth';
import { renderLogin } from './components/auth/Login';
import { registerSW } from 'virtual:pwa-register';
import Sortable from 'sortablejs';
import { downloadFile, generateMarkdown } from './utils/export';
import { renderProfileStats } from './components/profile/ProfileStats';
import { ProfileStats } from './types';
import { escapeAttribute, escapeHtml, renderSafeAvatarMarkup, replaceAvatarContent, sanitizeUrl } from './utils/safe-html';

const getProfileLink = (identifier: string) => {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('startapp', `profile_${identifier}`);
  return url.toString();
};

// Register Service Worker
registerSW({ immediate: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WEBAPP = (window as any).Telegram?.WebApp;


if (WEBAPP) {
  WEBAPP.ready();
  WEBAPP.expand();
}

type Page = 'main' | 'stats' | 'settings' | 'profile-settings' | 'public-profile';
let currentPage: Page = 'main';
let selectedStatType = 'all';
let editingLogId: string | null = null;
let viewingProfileIdentifier: string | null = null;
let loadedPublicProfile: PublicProfileData | null = null;
let profileLoadFailed = false;
let lastAddedLogId: string | null = null;
let editingTypeId: string | null = null;
let currentStatsTab: 'overview' | 'progress' = 'overview';
let currentProfileTab: 'ai' | 'public' | 'data' = 'ai';
let isFilterEnabled = false;
let authStatus: MigrationStatus | null = null;
const savedAiResults = localStorage.getItem('gym_ai_results');
const aiResults: { general: string | null; plan: string | null } = savedAiResults ? JSON.parse(savedAiResults) : { general: null, plan: null };
let aiLoadingState: 'idle' | 'general' | 'plan' = 'idle';

// Workout UI state
let isStartingWorkout = false;
let editingWorkoutId: string | null = null;

function navigate(page: Page) {
  currentPage = page;
  render();
}

// Toast notification
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string) {
  let toastEl = document.querySelector('.toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl?.classList.remove('visible');
  }, 2000);
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (!getCurrentUser()) {
    return;
  }

  app.innerHTML = `
    <main class="content">
      ${renderPage()}
    </main>
    <nav class="navigation">
      <button class="navigation__item ${currentPage === 'main' ? 'navigation__item_active' : ''}" data-page="main">
        <span class="navigation__icon">🏋️</span>
        <span class="navigation__label">Тренировка</span>
      </button>
      <button class="navigation__item ${currentPage === 'stats' ? 'navigation__item_active' : ''}" data-page="stats">
        <span class="navigation__icon">📊</span>
        <span class="navigation__label">Статистика</span>
      </button>
      <button class="navigation__item ${currentPage === 'profile-settings' ? 'navigation__item_active' : ''}" data-page="profile-settings">
        <span class="navigation__icon">👤</span>
        <span class="navigation__label">Профиль</span>
      </button>
      <button class="navigation__item ${currentPage === 'settings' ? 'navigation__item_active' : ''}" data-page="settings">
        <span class="navigation__icon">⚙️</span>
        <span class="navigation__label">Настройки</span>
      </button>
    </nav>
    <div id="sync-status" class="sync-status"></div>
  `;

  // Bind events
  app.querySelectorAll('.navigation__item').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.getAttribute('data-page') as Page;
      navigate(page);
    });
  });

  bindPageEvents();
  manageWorkoutTimer();
}

// Sync Status Logic
let syncStatus: SyncStatus = 'idle';
storage.onSyncStatusChange((status) => {
  syncStatus = status;
  updateSyncStatusUI();
});

// Handle unauthorized errors - show login screen immediately
storage.onUnauthorized(() => {
  authStatus = null;
  const app = document.getElementById('app');
  if (app) {
    renderLogin(app, () => {
      location.reload();
    });
  }
});

function updateSyncStatusUI() {
  const statusEl = document.getElementById('sync-status');
  if (!statusEl) return;

  statusEl.className = 'sync-status';
  let text = '';
  let icon = '';

  switch (syncStatus) {
    case 'saving':
      text = 'Синхронизация...';
      icon = '🔄';
      statusEl.classList.add('sync-status_saving');
      break;
    case 'success':
      text = 'Сохранено';
      icon = '✅';
      statusEl.classList.add('sync-status_success');
      break;
    case 'error':
      text = 'Ошибка синхронизации';
      icon = '⚠️';
      statusEl.classList.add('sync-status_error');
      break;
    case 'idle':
      if (!navigator.onLine) {
        text = 'Оффлайн';
        icon = '📡';
        statusEl.classList.add('sync-status_offline');
      } else {
        return; // Hide if idle and online
      }
      break;
  }

  statusEl.innerHTML = `${icon} ${text}`;
}

// Listen to network status
window.addEventListener('online', () => {
  storage.sync();
  updateSyncStatusUI();
});
window.addEventListener('offline', () => updateSyncStatusUI());

function getPreferredDisplayName(profileDisplayName?: string) {
  return profileDisplayName || getCurrentUser()?.name || WEBAPP?.initDataUnsafe?.user?.first_name || '';
}

function renderPage() {
  switch (currentPage) {
    case 'main':
      return renderMainPage();
    case 'stats':
      return renderStatsPage();
    case 'settings':
      return renderSettingsPage();
    case 'profile-settings':
      return renderProfileSettingsPage();
    case 'public-profile':
      return renderPublicProfilePage();
    default:
      return '';
  }
}



function renderWorkoutControls() {
  const activeWorkout = storage.getActiveWorkout();

  if (activeWorkout) {
    const isPaused = activeWorkout.status === 'paused';
    return `
      <div class="workout-controls card">
        <div class="workout-controls__header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="workout-status ${isPaused ? 'workout-status_paused' : ''}">
              ${isPaused ? '⏸️ Пауза' : '🔥 Тренировка активна'}
            </span>
            <span class="workout-timer">00:00</span>
          </div>
          ${activeWorkout.name ? `<span class="workout-name">${activeWorkout.name}</span>` : ''}
        </div>
        <div class="workout-controls__actions">
          ${isPaused
        ? `<button class="button" id="resume-workout-btn">Продолжить</button>`
        : `<button class="button button_secondary" id="pause-workout-btn">Пауза</button>`
      }
          <button class="button button_destructive" id="finish-workout-btn">Завершить</button>
        </div>
      </div>
    `;
  }

  if (isStartingWorkout) {
    return `
      <div class="workout-controls card">
        <h3 class="subtitle" style="margin-top: 0">Начало тренировки</h3>
        <form id="start-workout-form" style="display: flex; flex-direction: column; gap: 12px;">
          <input class="input" type="text" name="workoutName" placeholder="Название (опционально)">
          <div style="display: flex; gap: 8px;">
            <button class="button" type="submit">Начать</button>
            <button class="button button_secondary" type="button" id="cancel-start-workout-btn">Отмена</button>
          </div>
        </form>
      </div>
    `;
  }

  return `
    <button class="button" id="start-workout-btn" style="margin-bottom: 24px;">▶️ Начать тренировку</button>
  `;
}

let workoutTimerInterval: ReturnType<typeof setInterval> | null = null;

function updateWorkoutTimer() {
  const activeWorkout = storage.getActiveWorkout();
  const timerEl = document.querySelector('.workout-timer');

  if (!activeWorkout || !timerEl) {
    if (workoutTimerInterval) {
      clearInterval(workoutTimerInterval);
      workoutTimerInterval = null;
    }
    return;
  }

  const start = new Date(activeWorkout.startTime).getTime();
  const now = Date.now();
  let totalTime = now - start;

  activeWorkout.pauseIntervals.forEach(interval => {
    const pStart = new Date(interval.start).getTime();
    const pEnd = interval.end ? new Date(interval.end).getTime() : (activeWorkout.status === 'paused' ? now : now);
    if (pEnd > pStart) {
      totalTime -= (pEnd - pStart);
    }
  });

  const totalSeconds = Math.floor(Math.max(0, totalTime) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Start/Stop timer based on workout state
function manageWorkoutTimer() {
  const activeWorkout = storage.getActiveWorkout();

  // Update once immediately to set initial state
  updateWorkoutTimer();

  if (activeWorkout && activeWorkout.status === 'active') {
    if (!workoutTimerInterval) {
      workoutTimerInterval = setInterval(updateWorkoutTimer, 1000);
    }
  } else {
    if (workoutTimerInterval) {
      clearInterval(workoutTimerInterval);
      workoutTimerInterval = null;
    }
  }
}

let currentWeekOffset = 0;
let lastCalendarValue = '';

function getWeekRange(offset: number) {
  const now = new Date();
  // Adjust to start of today (00:00:00)
  now.setHours(0, 0, 0, 0);

  // Calculate start of the "current" week window based on offset
  // offset 0: last 7 days (today - 6 days) to today
  // offset 1: (today - 13 days) to (today - 7 days)
  const end = new Date(now);
  end.setDate(now.getDate() - (offset * 7));
  // Set end time to end of day
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(end.getDate() - 6); // 7 day window
  start.setHours(0, 0, 0, 0);

  return {
    start,
    end,
    label: `${start.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} - ${end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`
  };
}

function renderMainPage() {
  const types = storage.getWorkoutTypes();
  const logs = storage.getLogs();
  const lastLog = logs[logs.length - 1];
  const lastTypeId = lastLog?.workoutTypeId;

  const editingLog = editingLogId ? logs.find(l => l.id === editingLogId) : null;
  const { label } = getWeekRange(currentWeekOffset);

  return `
    <div class="page-content" id="main-content">
      ${renderWorkoutControls()}
      <h1 class="title">${editingLogId ? 'Редактирование подхода' : 'Новый подход'}</h1>
      <form class="workout-form" id="log-form">
        <div class="form-group">
          <label class="label">Тип тренировки</label>
          ${types.length > 10
      ? renderTypeahead({
        items: types.map(t => ({ id: t.id, name: t.name })),
        selectedId: editingLogId ? editingLog?.workoutTypeId : lastTypeId,
        name: 'typeId',
        inputId: 'workout-type-select',
        placeholder: 'Начните вводить название...'
      })
      : `<select class="select" name="typeId" id="workout-type-select" required>
                ${types.map(t => `<option value="${t.id}" ${(editingLogId ? (editingLog && t.id === editingLog.workoutTypeId) : (t.id === lastTypeId)) ? 'selected' : ''}>${t.name}</option>`).join('')}
              </select>`
    }
        </div>
        
        <div id="strength-inputs" style="display: none;">
            <div class="form-row">
              <div class="form-group">
                <label class="label">Вес (кг)</label>
                <input class="input" type="number" name="weight" step="0.5" placeholder="0" value="${editingLogId && editingLog ? (editingLog.weight ?? '') : ''}">

              </div>
              <div class="form-group">
                <label class="label">Повторений</label>
                <input class="input" type="number" name="reps" placeholder="0" value="${editingLogId && editingLog ? (editingLog.reps ?? '') : ''}">

              </div>
            </div>
        </div>

        <div id="time-inputs" style="display: none;">
            <div class="form-row">
                <div class="form-group">
                    <label class="label">Часы</label>
                    <input class="input" type="number" name="duration_hours" placeholder="0" value="${editingLogId && editingLog && editingLog.duration !== undefined ? Math.floor(editingLog.duration / 60) : ''}">
                </div>
                <div class="form-group">
                    <label class="label">Минуты</label>
                    <input class="input" type="number" name="duration_minutes" placeholder="0" value="${editingLogId && editingLog && editingLog.duration !== undefined ? (editingLog.duration % 60) : ''}">
                </div>
                <div class="form-group">
                    <label class="label">Секунды</label>
                    <input class="input" type="number" name="duration_seconds" placeholder="0" value="${editingLogId && editingLog && editingLog.durationSeconds !== undefined ? editingLog.durationSeconds : ''}">
                </div>
            </div>
        </div>

        ${editingLogId && editingLog ? `
        <div class="form-group">
          <label class="label">Дата и время</label>
          <input class="input" type="datetime-local" name="date" required value="${toLocalDatetimeValue(editingLog.date)}">
        </div>
        ` : ''}

        <button class="button" type="submit">${editingLogId ? 'Сохранить изменения' : 'Зафиксировать'}</button>
        ${editingLogId ? `<button class="button button_secondary" type="button" id="cancel-edit-btn" style="margin-top: 12px;">Отмена</button>` : ''}
        ${!editingLogId && lastLog ? `<button class="button button_secondary" type="button" id="duplicate-last-btn" style="margin-top: 12px;">Повторить: ${types.find(t => t.id === lastLog.workoutTypeId)?.name} ${lastLog.weight !== undefined ? `${lastLog.weight}кг × ${lastLog.reps}` : `${lastLog.duration || 0} мин${lastLog.durationSeconds ? ` ${lastLog.durationSeconds} сек` : ''}`}</button>` : ''}

      </form>
      <div class="recent-logs">
        <div class="recent-logs__header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
           <button class="icon-btn" id="prev-week-btn">◀️</button>
           <div id="week-label-container" style="display: flex; align-items: center; gap: 8px; position: relative;">
             <span style="font-size: 18px; position: relative; display: inline-block;">
               📅
               <input type="date" id="calendar-input" value="${lastCalendarValue}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;">
             </span>
             <h2 class="subtitle" style="margin: 0;">${currentWeekOffset === 0 ? 'Последние 7 дней' : label}</h2>
             <label class="filter-toggle" title="Фильтр по типу упражнения">
               <input type="checkbox" id="filter-toggle-input" ${isFilterEnabled ? 'checked' : ''}>
               <span class="filter-toggle__icon">🔍</span>
             </label>
           </div>
           <button class="icon-btn" id="next-week-btn" ${currentWeekOffset === 0 ? 'disabled' : ''} style="${currentWeekOffset === 0 ? 'opacity: 0.3; cursor: default;' : ''}">▶️</button>
        </div>
        <div id="logs-list">
          ${renderLogsList()}
        </div>
      </div>
    </div>
  `;
}

function renderLogsList() {
  const allLogs = storage.getLogs();
  const types = storage.getWorkoutTypes();
  const { start, end } = getWeekRange(currentWeekOffset);

  let weekLogs = allLogs.filter(log => {
    const logDate = new Date(log.date);
    return logDate >= start && logDate <= end;
  });

  // Apply filter by selected exercise type if enabled
  if (isFilterEnabled) {
    const selectedTypeId = getTypeaheadValue();
    if (selectedTypeId) {
      weekLogs = weekLogs.filter(log => log.workoutTypeId === selectedTypeId);
    }
  }

  return generateLogsListHtml(weekLogs, types, true);
}

function updateWeekView() {
  const logsListEl = document.getElementById('logs-list');
  const weekLabelEl = document.querySelector('#week-label-container .subtitle');

  if (logsListEl) {
    logsListEl.innerHTML = renderLogsList();
    // Re-bind log item events
    bindLogItemEvents();
  }

  if (weekLabelEl) {
    const { label } = getWeekRange(currentWeekOffset);
    weekLabelEl.textContent = currentWeekOffset === 0 ? 'Последние 7 дней' : label;
  }

  // Update next button state
  const nextWeekBtn = document.getElementById('next-week-btn') as HTMLButtonElement;
  if (nextWeekBtn) {
    nextWeekBtn.disabled = currentWeekOffset === 0;
    nextWeekBtn.style.opacity = currentWeekOffset === 0 ? '0.3' : '';
    nextWeekBtn.style.cursor = currentWeekOffset === 0 ? 'default' : '';
  }
}

// Bind events for log items (edit, delete, share buttons)
function bindLogItemEvents() {
  document.querySelectorAll('.log-set__delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (id) {
        if (editingLogId === id) editingLogId = null;
        await storage.deleteLog(id);
        updateWeekView();
      }
    });
  });

  document.querySelectorAll('.log-set__edit').forEach(btn => {
    btn.addEventListener('click', () => {
      editingLogId = btn.getAttribute('data-id');
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  document.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dateStr = btn.getAttribute('data-date');
      if (dateStr) {
        shareWorkout(dateStr);
      }
    });
  });

  // Workout edit buttons
  document.querySelectorAll('.workout-header__edit').forEach(btn => {
    btn.addEventListener('click', () => {
      editingWorkoutId = btn.getAttribute('data-workout-id');
      updateWeekView();
    });
  });

  // Workout edit form
  const editForm = document.getElementById('workout-edit-form') as HTMLFormElement;
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!editingWorkoutId) return;
      const formData = new FormData(editForm);
      const name = (formData.get('workoutName') as string) || '';
      const startTimeLocal = formData.get('startTime') as string;
      const endTimeLocal = formData.get('endTime') as string;

      const updates: { name?: string; startTime?: string; endTime?: string } = { name };
      if (startTimeLocal) updates.startTime = new Date(startTimeLocal).toISOString();
      if (endTimeLocal) updates.endTime = new Date(endTimeLocal).toISOString();

      await storage.updateWorkout(editingWorkoutId, updates);
      editingWorkoutId = null;
      updateWeekView();
      showToast('Тренировка обновлена');
    });

    const cancelBtn = document.getElementById('cancel-edit-workout-btn');
    cancelBtn?.addEventListener('click', () => {
      editingWorkoutId = null;
      updateWeekView();
    });
  }

  document.querySelectorAll('.log-exercise__name').forEach(el => {
    el.addEventListener('click', () => {
      if (editingLogId) return;
      const typeId = el.getAttribute('data-type-id');
      if (typeId) {
        setWorkoutTypeInForm(typeId);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  document.querySelectorAll('.log-set').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.log-set__actions')) return;
      if (editingLogId) return;

      const logId = el.getAttribute('data-id');
      if (logId) {
        const log = storage.getLogs().find(l => l.id === logId);
        if (log) {
          setWorkoutTypeInForm(log.workoutTypeId);

          if (log.weight !== undefined) {
            const weightInput = document.querySelector('input[name="weight"]') as HTMLInputElement;
            if (weightInput) weightInput.value = String(log.weight);
          }
          if (log.reps !== undefined) {
            const repsInput = document.querySelector('input[name="reps"]') as HTMLInputElement;
            if (repsInput) repsInput.value = String(log.reps);
          }
          if (log.duration !== undefined) {
            const hInput = document.querySelector('input[name="duration_hours"]') as HTMLInputElement;
            const mInput = document.querySelector('input[name="duration_minutes"]') as HTMLInputElement;
            if (hInput) hInput.value = String(Math.floor(log.duration / 60));
            if (mInput) mInput.value = String(log.duration % 60);
          }
          if (log.durationSeconds !== undefined) {
            const sInput = document.querySelector('input[name="duration_seconds"]') as HTMLInputElement;
            if (sInput) sInput.value = String(log.durationSeconds);
          }

          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    });
  });
}

function setWorkoutTypeInForm(typeId: string) {
  const types = storage.getWorkoutTypes();
  const type = types.find(t => t.id === typeId);
  if (!type) return;

  const selectOrHidden = document.getElementById('workout-type-select') as HTMLInputElement | HTMLSelectElement;
  if (selectOrHidden) {
    selectOrHidden.value = typeId;
    if (selectOrHidden.tagName === 'INPUT' && selectOrHidden.type === 'hidden') {
      const wrapper = selectOrHidden.closest('[data-typeahead]');
      if (wrapper) {
        const visibleInput = wrapper.querySelector('[data-typeahead-input]') as HTMLInputElement;
        if (visibleInput) visibleInput.value = type.name;
      }
    }
    selectOrHidden.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function toLocalDatetimeValue(isoString: string): string {
  const d = new Date(isoString);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderWorkoutEditForm(workout: WorkoutSession): string {
  const startVal = toLocalDatetimeValue(workout.startTime);
  const endVal = workout.endTime ? toLocalDatetimeValue(workout.endTime) : '';

  return `
    <div class="workout-edit-form card">
      <form id="workout-edit-form">
        <div class="form-group">
          <label class="label">Название</label>
          <input class="input" type="text" name="workoutName" placeholder="Название (опционально)" value="${workout.name || ''}">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="label">Начало</label>
            <input class="input" type="datetime-local" name="startTime" value="${startVal}" required>
          </div>
          <div class="form-group">
            <label class="label">Конец</label>
            <input class="input" type="datetime-local" name="endTime" value="${endVal}">
          </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="button" type="submit">Сохранить</button>
          <button class="button button_secondary" type="button" id="cancel-edit-workout-btn">Отмена</button>
        </div>
      </form>
    </div>
  `;
}

function generateLogsListHtml(logs: WorkoutSet[], types: WorkoutType[], isEditable: boolean) {
  if (logs.length === 0) return '<p class="hint">Нет записей за этот период</p>';

  const logsByDay = new Map<string, WorkoutSet[]>();
  // Sort logs by date descending
  [...logs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).forEach(log => {
    const d = new Date(log.date);
    const dateKey = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    if (!logsByDay.has(dateKey)) logsByDay.set(dateKey, []);
    logsByDay.get(dateKey)!.push(log);
  });

  const workouts = storage.getWorkouts();
  let html = '';

  logsByDay.forEach((dayLogs, dateLabel) => {
    const dayDateStr = dayLogs[0]?.date.split('T')[0] || '';

    // Identify workouts in this day
    const dayWorkouts = new Set<string>();
    dayLogs.forEach(l => {
      if (l.workoutId) dayWorkouts.add(l.workoutId);
    });

    // Sort workouts by time (using stored workout or log time)
    const sortedWorkoutIds = Array.from(dayWorkouts).sort((a, b) => {
      const wA = workouts.find(w => w.id === a);
      const wB = workouts.find(w => w.id === b);
      const timeA = wA?.startTime || dayLogs.find(l => l.workoutId === a)?.date || '';
      const timeB = wB?.startTime || dayLogs.find(l => l.workoutId === b)?.date || '';
      // Descending order for display? Usually logs are descending.
      return new Date(timeB).getTime() - new Date(timeA).getTime();
    });

    const singleWorkoutId = sortedWorkoutIds.length === 1 ? sortedWorkoutIds[0] : null;
    const singleWorkout = singleWorkoutId ? workouts.find(w => w.id === singleWorkoutId) : null;
    const showNameInHeader = singleWorkout && singleWorkout.name;
    const singleWorkoutDuration = singleWorkout ? Math.round(storage.getWorkoutDuration(singleWorkout)) : 0;

    html += `<div class="log-day">`;
    html += `<div class="log-day__header">
      <span>${dateLabel}${showNameInHeader ? ` • ${singleWorkout.name}` : ''}${singleWorkout ? ` • ${singleWorkoutDuration} мин` : ''}</span>
      <div class="log-day__header-actions">
        ${isEditable && singleWorkout ? `<button class="workout-header__edit" data-workout-id="${singleWorkout.id}" title="Редактировать тренировку">✏️</button>` : ''}
        ${isEditable ? `<button class="share-btn" data-date="${dayDateStr}" title="Поделиться">📤</button>` : ''}
      </div>
    </div>`;

    // Inline edit form for single workout
    if (isEditable && singleWorkout && editingWorkoutId === singleWorkout.id) {
      html += renderWorkoutEditForm(singleWorkout);
    }

    // Render each workout group
    sortedWorkoutIds.forEach(workoutId => {
      const workout = workouts.find(w => w.id === workoutId);
      const workoutLogs = dayLogs.filter(l => l.workoutId === workoutId);

      const hideSubheader = sortedWorkoutIds.length === 1 && (showNameInHeader || !workout?.name);

      if (!hideSubheader) {
        const duration = workout ? Math.round(storage.getWorkoutDuration(workout)) : 0;

        html += `<h3 class="workout-subheader">
                <span>${workout?.name || 'Тренировка'}</span>
                <div class="workout-subheader__actions">
                  <span class="workout-subheader__time">${duration} мин</span>
                  ${isEditable && workout ? `<button class="workout-header__edit" data-workout-id="${workout.id}" title="Редактировать тренировку">✏️</button>` : ''}
                </div>
            </h3>`;

        // Inline edit form for multi-workout subheader
        if (isEditable && workout && editingWorkoutId === workout.id) {
          html += renderWorkoutEditForm(workout);
        }
      }

      // Group by exercise within workout
      const exerciseGroups: Map<string, WorkoutSet[]> = new Map();
      workoutLogs.forEach(log => {
        if (!exerciseGroups.has(log.workoutTypeId)) {
          exerciseGroups.set(log.workoutTypeId, []);
        }
        exerciseGroups.get(log.workoutTypeId)!.push(log);
      });

      exerciseGroups.forEach((sets, typeId) => {
        const type = types.find(t => t.id === typeId);
        html += `
            <div class="log-exercise">
              <div class="log-exercise__name" data-type-id="${type?.id || ''}" style="cursor: pointer;">${type?.name || 'Удалено'}</div>
              <div class="log-exercise__sets">
                ${sets.map(set => `
                  <div class="log-set ${set.id === editingLogId ? 'log-set_active-edit' : ''} ${set.id === lastAddedLogId ? 'log-set_new' : ''}" data-id="${set.id}" style="cursor: pointer;">
                    <div class="log-set__info">
                      ${set.weight !== undefined && set.reps !== undefined ? `
                        <span class="log-set__weight">${set.weight} кг</span>
                        <span class="log-set__times">×</span>
                        <span class="log-set__reps">${set.reps}</span>
                      ` : `
                        <span class="log-set__reps">⏱ ${set.duration || 0} мин${set.durationSeconds ? ` ${set.durationSeconds} сек` : ''}</span>
                      `}
                    </div>
                    ${isEditable ? `
                    <div class="log-set__actions">
                      <button class="log-set__edit" data-id="${set.id}">✏️</button>
                      <button class="log-set__delete" data-id="${set.id}">×</button>
                    </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
          `;
      });
    });

    // Render orphan logs (without workoutId)
    const orphanLogs = dayLogs.filter(l => !l.workoutId);
    if (orphanLogs.length > 0) {
      const exerciseGroups: Map<string, WorkoutSet[]> = new Map();
      orphanLogs.forEach(log => {
        if (!exerciseGroups.has(log.workoutTypeId)) {
          exerciseGroups.set(log.workoutTypeId, []);
        }
        exerciseGroups.get(log.workoutTypeId)!.push(log);
      });

      exerciseGroups.forEach((sets, typeId) => {
        const type = types.find(t => t.id === typeId);
        html += `
            <div class="log-exercise">
              <div class="log-exercise__name" data-type-id="${type?.id || ''}" style="cursor: pointer;">${type?.name || 'Удалено'}</div>
              <div class="log-exercise__sets">
                ${sets.map(set => `
                  <div class="log-set ${set.id === editingLogId ? 'log-set_active-edit' : ''} ${set.id === lastAddedLogId ? 'log-set_new' : ''}" data-id="${set.id}" style="cursor: pointer;">
                    <div class="log-set__info">
                      ${set.weight !== undefined && set.reps !== undefined ? `
                        <span class="log-set__weight">${set.weight} кг</span>
                        <span class="log-set__times">×</span>
                        <span class="log-set__reps">${set.reps}</span>
                      ` : `
                        <span class="log-set__reps">⏱ ${set.duration || 0} мин${set.durationSeconds ? ` ${set.durationSeconds} сек` : ''}</span>
                      `}
                    </div>
                    ${isEditable ? `
                    <div class="log-set__actions">
                      <button class="log-set__edit" data-id="${set.id}">✏️</button>
                      <button class="log-set__delete" data-id="${set.id}">×</button>
                    </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
          `;
      });
    }

    html += `</div>`;
  });

  return html;
}

function renderSettingsPage() {
  const types = storage.getWorkoutTypes();
  const editingType = editingTypeId ? types.find(t => t.id === editingTypeId) : null;

  return `
    <div class="page-content">
      <h1 class="title">Настройки</h1>
      <div class="settings-section">
        <h2 class="subtitle">${editingTypeId ? 'Редактирование типа' : 'Добавить тип тренировки'}</h2>
        <form class="add-type-form" id="add-type-form" style="margin-bottom: 24px;">
          <div style="display: flex; gap: 8px; flex-direction: column;">
            <input class="input" type="text" id="new-type-name" placeholder="Название (напр. Жим гантелей)" required value="${editingType ? editingType.name : ''}">
            
            <div class="category-switch" style="display: flex; gap: 12px; margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 4px;">
                    <input type="radio" name="new-type-category" value="strength" ${!editingType || editingType.category !== 'time' ? 'checked' : ''}>
                    Силовое
                </label>
                <label style="display: flex; align-items: center; gap: 4px;">
                    <input type="radio" name="new-type-category" value="time" ${editingType && editingType.category === 'time' ? 'checked' : ''}>
                    На время
                </label>
            </div>

            <button class="button" type="submit">${editingTypeId ? 'Сохранить' : 'Добавить'}</button>
          </div>
          ${editingTypeId ? `<button class="button button_secondary" type="button" id="cancel-edit-type-btn" style="margin-top: 8px; width: 100%;">Отмена</button>` : ''}
        </form>

        <h2 class="subtitle">Типы тренировок</h2>
        <div class="type-list" id="workout-type-list">
          ${types.map(t => `
            <div class="type-item" data-id="${t.id}">
              <span class="drag-handle" style="cursor: grab; margin-right: 12px; opacity: 0.5;">⋮⋮</span>
              <span style="flex-grow: 1;">${t.name}</span>
              <div style="display: flex; gap: 8px;">
                <button class="type-item__edit icon-btn" data-id="${t.id}" title="Редактировать">✏️</button>
                <button class="type-item__delete icon-btn" data-id="${t.id}" title="Удалить">×</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// Render only the content of the profile tab (for partial updates)
function renderProfileTabContent(tab: 'ai' | 'public' | 'data'): string {
  const profile = storage.getProfile();
  const isPublic = profile?.isPublic ?? false;
  const displayName = getPreferredDisplayName(profile?.displayName);
  const identifier = storage.getProfileIdentifier();
  const profileUrl = identifier ? getProfileLink(identifier) : '';
  const safeDisplayName = escapeAttribute(displayName);
  const safeProfileUrl = escapeAttribute(profileUrl);
  const safeProfileUrlText = escapeHtml(profileUrl);
  const safeBirthDate = escapeAttribute(profile?.birthDate || '');
  const safeHeight = escapeAttribute(profile?.height || '');
  const safeWeight = escapeAttribute(profile?.weight || '');
  const safeAdditionalInfo = escapeHtml(profile?.additionalInfo || '');

  if (tab === 'public') {
    return `${profile?.friends && profile.friends.length > 0 ? `
      <div class="settings-section">
          <div class="settings-section-title">Друзья (${profile.friends.length})</div>
          <div class="friends-list">
              ${profile.friends.map((f) => `
                  <a href="${escapeAttribute(getProfileLink(f.identifier))}" class="friend-item" style="display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-color); cursor: pointer; text-decoration: none; color: inherit;">
                      <div class="friend-avatar" style="width: 40px; height: 40px; border-radius: 50%; background: var(--surface-color-alt); display: flex; align-items: center; justify-content: center; overflow: hidden;">
                          ${renderSafeAvatarMarkup(f.displayName, f.photoUrl, 'style="width: 100%; height: 100%; object-fit: cover;"')}
                      </div>
                      <div class="friend-info" style="flex-grow: 1;">
                          <div class="friend-name" style="font-weight: 500;">${escapeHtml(f.displayName)}</div>
                      </div>
                      <div class="friend-arrow">›</div>
                  </a>
              `).join('')}
          </div>
      </div>
      ` : ''}
      <div class="settings-section">
        <div class="settings-section-title">Видимость</div>
        <div class="toggle-row">
          <div class="toggle-label">
            <span class="toggle-label-text">Публичный профиль</span>
            <span class="toggle-label-hint">Другие смогут видеть вашу статистику</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="profile-public-toggle" ${isPublic ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="toggle-row" style="margin-top: 12px;">
          <div class="toggle-label">
            <span class="toggle-label-text">Показывать все упражнения</span>
            <span class="toggle-label-hint">Подробный список упражнений в публичном профиле</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="profile-history-toggle" ${profile?.showFullHistory ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Имя</div>
        <input class="input" type="text" id="profile-display-name" value="${safeDisplayName}" placeholder="Ваше имя">
      </div>

      ${isPublic && identifier ? `
        <div class="settings-section">
          <div class="settings-section-title">Ссылка на профиль</div>
          <div class="profile-link-section">
            <a href="${safeProfileUrl}" target="_blank" class="profile-link-url">${safeProfileUrlText}</a>
            <div class="profile-link-actions">
              <button class="button button_secondary" id="copy-profile-link">Копировать</button>
              <button class="button" id="share-profile-link">Поделиться</button>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="settings-section">
        <div class="settings-section-title">Превью статистики</div>
        ${(function () {
        const logs = storage.getLogs();
        const workoutTypes = storage.getWorkoutTypes();

        // Calculate stats
        const totalVolume = logs.reduce((acc, l) => acc + ((l.weight || 0) * (l.reps || 0)), 0);
        const uniqueDaysSet = new Set(logs.map(l => l.date.split('T')[0]));
        const totalWorkouts = uniqueDaysSet.size;

        const lastWorkoutDate = logs.length > 0 ? [...logs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0].date : undefined;

        // Favorite exercise
        const typeCounts = new Map<string, number>();
        logs.forEach(l => {
          typeCounts.set(l.workoutTypeId, (typeCounts.get(l.workoutTypeId) || 0) + 1);
        });
        let favoriteExercise = undefined;
        let maxCount = 0;
        typeCounts.forEach((count, typeId) => {
          if (count > maxCount) {
            maxCount = count;
            const type = workoutTypes.find(t => t.id === typeId);
            if (type) favoriteExercise = type.name;
          }
        });

        const stats: ProfileStats = {
          totalWorkouts,
          totalVolume,
          favoriteExercise,
          lastWorkoutDate
        };

        return renderProfileStats(stats, uniqueDaysSet);
      })()}
      </div>

      <button class="button" id="save-profile-btn" style="margin-top: 12px;">Сохранить</button>
    `;
  }

  if (tab === 'ai') {
    return `
      <div class="settings-section">
            <div class="settings-section-title">AI Рекомендации</div>
            
            <div class="ai-controls" style="display: flex; flex-direction: column; gap: 12px;">
                <button class="button" id="ai-general-btn" ${aiLoadingState !== 'idle' ? 'disabled' : ''}>
                    ${aiLoadingState === 'general' ? 'Анализ...' : '✨ Общий анализ'}
                </button>

                <div id="ai-general-result" class="ai-result" style="margin-top: 24px; background: var(--surface-color-alt); padding: 16px; border-radius: 12px; ${aiResults.general ? '' : 'display: none;'}">
                    <div class="markdown-body" style="font-family: inherit;">${aiResults.general || ''}</div>
                </div>

                <div class="ai-plan-section">
                    <h3 class="workout-subheader" style="margin-bottom: 8px;">План тренировок</h3>
                    <div class="form-group">
                        <select class="select" id="ai-plan-period">
                            <option value="day">На сегодня</option>
                            <option value="week">На неделю</option>
                        </select>
                    </div>
                      
                    <div class="toggle-row toggle-row--clean" style="margin-top: 12px;">
                      <div class="toggle-label">
                          <span class="toggle-label-text">Рекомендовать новые упражнения</span>
                      </div>
                      <label class="toggle-switch">
                          <input type="checkbox" id="ai-allow-new">
                          <span class="toggle-slider"></span>
                      </label>
                    </div>
                    <button class="button" id="ai-plan-btn" ${aiLoadingState !== 'idle' ? 'disabled' : ''} style="margin-top: 8px;">
                        ${aiLoadingState === 'plan' ? 'Генерация...' : '📅 Создать план'}
                    </button>

                    <div id="ai-plan-result" class="ai-result" style="margin-top: 12px; background: var(--surface-color-alt); padding: 16px; border-radius: 12px; ${aiResults.plan ? '' : 'display: none;'}">
                        <div class="markdown-body" style="font-family: inherit;">${aiResults.plan || ''}</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Личные данные (Приватно)</div>
            <p class="hint" style="margin-bottom: 12px; font-size: 0.9em;">Эти данные используются только для персонализации советов от AI и не видны другим пользователям.</p>
            
            <div class="form-row">
              <div class="form-group">
                  <label class="label">Пол</label>
                  <select class="select" id="profile-gender">
                      <option value="" ${!profile?.gender ? 'selected' : ''}>Не указано</option>
                      <option value="male" ${profile?.gender === 'male' ? 'selected' : ''}>Мужской</option>
                      <option value="female" ${profile?.gender === 'female' ? 'selected' : ''}>Женский</option>
                  </select>
              </div>
              <div class="form-group">
                  <label class="label">Дата рождения</label>
                  <input class="input" type="date" id="profile-birthdate" value="${safeBirthDate}">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                  <label class="label">Рост (см)</label>
                  <input class="input" type="number" id="profile-height" placeholder="180" value="${safeHeight}">
              </div>
              <div class="form-group">
                  <label class="label">Вес (кг)</label>
                  <input class="input" type="number" id="profile-weight" placeholder="75" value="${safeWeight}">
              </div>
            </div>

            <div class="form-group">
               <label class="label">Дополнительная информация</label>
               <textarea class="input" id="profile-additional-info" rows="3" placeholder="Укажите травмы, ограничения, цели или любую другую информацию, которая поможет AI давать более точные советы...">${safeAdditionalInfo}</textarea>
            </div>
            <button class="button" id="save-profile-btn" style="margin-top: 12px;">Сохранить</button>
        </div>
    `;
  }

  if (tab === 'data') {
    return `
      <div class="settings-section">
        <div class="settings-section-title">Аккаунт</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div><strong>Email:</strong> ${getCurrentUser()?.email || '—'}</div>
          <div><strong>Username:</strong> ${getCurrentUser()?.username || authStatus?.suggestedUsername || 'не задан'}</div>
          <div><strong>Telegram:</strong> ${authStatus?.hasTelegram ? 'подключен' : 'не подключен'}</div>
          <div><strong>Passkey:</strong> ${authStatus?.hasPasskey ? 'добавлен' : 'не добавлен'}</div>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px; margin-top:16px;">
          <button class="button button_secondary" id="add-passkey-btn">${canUsePasskeyInCurrentContext() ? 'Добавить Passkey' : 'Открыть браузер для Passkey'}</button>
          ${authStatus?.hasTelegram
            ? '<div style="padding:12px 14px; border-radius:14px; background:var(--surface-color-alt); color:var(--text-color-secondary);">Telegram уже привязан к этому аккаунту.</div>'
            : isTelegramMiniApp()
              ? '<button class="button button_secondary" id="link-telegram-btn">Привязать текущий Telegram</button>'
              : '<div id="link-telegram-widget" style="display:flex; justify-content:center;"></div>'}
          <button class="button button_secondary" id="sign-out-btn">Выйти</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Управление данными</div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <button class="button button_secondary" id="export-json-btn">Экспорт JSON (Backup)</button>
          <button class="button button_secondary" id="export-md-btn">Экспорт Markdown</button>
          <button class="button button_secondary" id="import-json-btn">Импорт JSON (Restore)</button>
          <input type="file" id="import-file-input" style="display: none" accept=".json">
        </div>
      </div>
    `;
  }

  return '';
}

function renderProfileSettingsPage() {
  const profile = storage.getProfile();
  const isPublic = profile?.isPublic ?? false;
  const displayName = getPreferredDisplayName(profile?.displayName);
  const safeDisplayName = escapeHtml(displayName);

  return `
    <div class="page-content profile-page">
      <h1 class="title">Профиль</h1>
      
      <div class="profile-header">
        <div class="profile-avatar">
          ${renderSafeAvatarMarkup(displayName, profile?.photoUrl)}
        </div>
        <div class="profile-name">${safeDisplayName}</div>
        <div class="profile-subtitle">${isPublic ? 'Публичный профиль' : 'Приватный профиль'}</div>
      </div>

      <div class="stats-tabs">
        <button class="stats-tab profile-tab ${currentProfileTab === 'ai' ? 'active' : ''}" data-tab="ai">AI</button>
        <button class="stats-tab profile-tab ${currentProfileTab === 'public' ? 'active' : ''}" data-tab="public">Публичное</button>
        <button class="stats-tab profile-tab ${currentProfileTab === 'data' ? 'active' : ''}" data-tab="data">Данные</button>
      </div>

      <div class="profile-settings" id="profile-tab-content">
        ${renderProfileTabContent(currentProfileTab)}
      </div>
    </div>
  `;
}

// Partial update for profile tabs - updates only the tab content and active state
function updateProfileTabContent() {
  const container = document.getElementById('profile-tab-content');
  if (container) {
    container.innerHTML = renderProfileTabContent(currentProfileTab);
    bindProfileSettingsEvents();
  }
  // Update profile header
  const profile = storage.getProfile();
  const displayName = getPreferredDisplayName(profile?.displayName);
  const isPublic = profile?.isPublic ?? false;

  const nameEl = document.querySelector('.profile-page .profile-name');
  if (nameEl) nameEl.textContent = displayName;

  const subtitleEl = document.querySelector('.profile-page .profile-subtitle');
  if (subtitleEl) subtitleEl.textContent = isPublic ? 'Публичный профиль' : 'Приватный профиль';

  const avatarEl = document.querySelector('.profile-page .profile-avatar');
  if (avatarEl) {
    replaceAvatarContent(avatarEl, displayName, profile?.photoUrl);
  }

  // Update active tab state
  document.querySelectorAll('.profile-tab').forEach(tab => {
    const tabId = tab.getAttribute('data-tab');
    tab.classList.toggle('active', tabId === currentProfileTab);
  });
}

// Partial update for stats page - re-renders stats content without full page rebuild
function updateStatsContent() {
  const content = document.querySelector('.content');
  if (!content) return;
  content.innerHTML = renderStatsPage();
  bindStatsPageEvents();
}

// Bind stats page specific events
function bindStatsPageEvents() {
  const tabs = document.querySelectorAll('.stats-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');
      if (tabId === 'overview' || tabId === 'progress') {
        currentStatsTab = tabId;
        updateStatsContent();
      }
    });
  });

  const typeSelect = document.getElementById('stat-type-select');
  typeSelect?.addEventListener('change', (e) => {
    selectedStatType = (e.target as HTMLSelectElement).value;
    updateStatsContent();
  });
}

// Partial update for settings page - re-renders type list and form
function updateSettingsTypeList() {
  const content = document.querySelector('.content');
  if (!content) return;
  content.innerHTML = renderSettingsPage();
  bindSettingsPageEvents();
}

// Bind settings page specific events
function bindSettingsPageEvents() {
  const form = document.getElementById('add-type-form') as HTMLFormElement;
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-type-name') as HTMLInputElement;
    const category = (document.querySelector('input[name="new-type-category"]:checked') as HTMLInputElement)?.value as 'strength' | 'time' || 'strength';
    if (input.value) {
      if (editingTypeId) {
        await storage.updateWorkoutType(editingTypeId, input.value, category);
        editingTypeId = null;
      } else {
        await storage.addWorkoutType(input.value, category);
      }
      updateSettingsTypeList();
    }
  });

  const cancelEditBtn = document.getElementById('cancel-edit-type-btn');
  cancelEditBtn?.addEventListener('click', () => {
    editingTypeId = null;
    updateSettingsTypeList();
  });

  document.querySelectorAll('.type-item__edit').forEach(btn => {
    btn.addEventListener('click', () => {
      editingTypeId = btn.getAttribute('data-id');
      updateSettingsTypeList();
      const input = document.getElementById('new-type-name') as HTMLInputElement;
      input?.focus();
    });
  });

  document.querySelectorAll('.type-item__delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (id && confirm('Удалить этот тип тренировки?')) {
        if (editingTypeId === id) editingTypeId = null;
        await storage.deleteWorkoutType(id);
        updateSettingsTypeList();
      }
    });
  });

  // Sortable for type list
  const typeList = document.getElementById('workout-type-list');
  if (typeList) {
    Sortable.create(typeList, {
      animation: 150,
      handle: '.drag-handle',
      onEnd: async () => {
        const newOrder = Array.from(typeList.children).map(child => child.getAttribute('data-id') || '').filter(Boolean);
        await storage.updateWorkoutTypeOrder(newOrder);
      }
    });
  }
}

// Partial update for workout controls - updates only the workout control section
function updateWorkoutControls() {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;

  const workoutControlsHtml = renderWorkoutControls();

  // Find the first child element (where workout controls are)
  const firstChild = mainContent.firstElementChild;

  if (firstChild) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = workoutControlsHtml;
    const newElement = tempDiv.firstElementChild;

    if (newElement) {
      // If there's an existing workout control element, replace it
      if (firstChild.classList.contains('workout-controls') ||
        firstChild.id === 'start-workout-btn') {
        firstChild.replaceWith(newElement);
      } else if (mainContent.querySelector('.workout-controls')) {
        mainContent.querySelector('.workout-controls')?.replaceWith(newElement);
      } else if (mainContent.querySelector('#start-workout-btn')) {
        mainContent.querySelector('#start-workout-btn')?.replaceWith(newElement);
      } else {
        // Insert at beginning
        mainContent.insertBefore(newElement, mainContent.firstChild);
      }
      bindWorkoutControlEvents();
    }
  }
  manageWorkoutTimer();
}

// Bind events for workout controls
function bindWorkoutControlEvents() {
  const startWorkoutBtn = document.getElementById('start-workout-btn');
  startWorkoutBtn?.addEventListener('click', () => {
    isStartingWorkout = true;
    updateWorkoutControls();
  });

  const cancelStartWorkoutBtn = document.getElementById('cancel-start-workout-btn');
  cancelStartWorkoutBtn?.addEventListener('click', () => {
    isStartingWorkout = false;
    updateWorkoutControls();
  });

  const startWorkoutForm = document.getElementById('start-workout-form') as HTMLFormElement;
  startWorkoutForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(startWorkoutForm);
    const name = formData.get('workoutName') as string;
    await storage.startWorkout(name);
    isStartingWorkout = false;
    updateWorkoutControls();
  });

  const pauseWorkoutBtn = document.getElementById('pause-workout-btn');
  pauseWorkoutBtn?.addEventListener('click', async () => {
    await storage.pauseWorkout();
    updateWorkoutControls();
  });

  const resumeWorkoutBtn = document.getElementById('resume-workout-btn');
  resumeWorkoutBtn?.addEventListener('click', async () => {
    await storage.resumeWorkout();
    updateWorkoutControls();
  });

  const finishWorkoutBtn = document.getElementById('finish-workout-btn');
  finishWorkoutBtn?.addEventListener('click', async () => {
    if (confirm('Завершить тренировку?')) {
      await storage.finishWorkout();
      updateWorkoutControls();
    }
  });
}

// Bind events specific to profile settings tabs
function bindProfileSettingsEvents() {
  const saveBtn = document.getElementById('save-profile-btn');
  saveBtn?.addEventListener('click', async () => {
    const publicToggle = document.getElementById('profile-public-toggle') as HTMLInputElement;
    const historyToggle = document.getElementById('profile-history-toggle') as HTMLInputElement;
    const nameInput = document.getElementById('profile-display-name') as HTMLInputElement;

    const genderInput = document.getElementById('profile-gender') as HTMLSelectElement;
    const birthDateInput = document.getElementById('profile-birthdate') as HTMLInputElement;
    const heightInput = document.getElementById('profile-height') as HTMLInputElement;
    const weightInput = document.getElementById('profile-weight') as HTMLInputElement;
    const additionalInfoInput = document.getElementById('profile-additional-info') as HTMLTextAreaElement;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = {};

    if (publicToggle) updates.isPublic = publicToggle.checked;
    if (historyToggle) updates.showFullHistory = historyToggle.checked;
    if (nameInput) updates.displayName = nameInput.value;

    if (genderInput) updates.gender = genderInput.value || undefined;
    if (birthDateInput) updates.birthDate = birthDateInput.value;
    if (heightInput) updates.height = heightInput.value ? Number(heightInput.value) : undefined;
    if (weightInput) updates.weight = weightInput.value ? Number(weightInput.value) : undefined;
    if (additionalInfoInput) updates.additionalInfo = additionalInfoInput.value;

    await storage.updateProfileSettings(updates);
    showToast('Профиль сохранен');
    // No re-render needed - data is saved
  });

  // AI Buttons
  const aiGeneralBtn = document.getElementById('ai-general-btn') as HTMLButtonElement | null;
  const aiPlanBtn = document.getElementById('ai-plan-btn') as HTMLButtonElement | null;

  const setAiButtonsLoading = (state: 'idle' | 'general' | 'plan') => {
    aiLoadingState = state;
    if (aiGeneralBtn) {
      aiGeneralBtn.disabled = state !== 'idle';
      aiGeneralBtn.textContent = state === 'general' ? 'Анализ...' : '✨ Общий анализ';
    }
    if (aiPlanBtn) {
      aiPlanBtn.disabled = state !== 'idle';
      aiPlanBtn.textContent = state === 'plan' ? 'Генерация...' : '📅 Создать план';
    }
  };

  const updateAiResult = (type: 'general' | 'plan', result: string) => {
    aiResults[type] = result;
    localStorage.setItem('gym_ai_results', JSON.stringify(aiResults));
    const containerId = type === 'general' ? 'ai-general-result' : 'ai-plan-result';
    const container = document.getElementById(containerId);
    if (container) {
      container.style.display = '';
      const body = container.querySelector('.markdown-body');
      if (body) body.innerHTML = result;
    }
  };

  if (aiGeneralBtn) {
    aiGeneralBtn.addEventListener('click', async () => {
      setAiButtonsLoading('general');
      try {
        const result = await storage.getAIRecommendation('general');
        updateAiResult('general', result);
      } catch (e) {
        showToast('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        setAiButtonsLoading('idle');
      }
    });
  }

  if (aiPlanBtn) {
    aiPlanBtn.addEventListener('click', async () => {
      const period = (document.getElementById('ai-plan-period') as HTMLSelectElement).value as 'day' | 'week';
      const allowNew = (document.getElementById('ai-allow-new') as HTMLInputElement).checked;

      setAiButtonsLoading('plan');
      try {
        const result = await storage.getAIRecommendation('plan', { period, allowNewExercises: allowNew });
        updateAiResult('plan', result);
      } catch (e) {
        showToast('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        setAiButtonsLoading('idle');
      }
    });
  }

  const copyBtn = document.getElementById('copy-profile-link');
  copyBtn?.addEventListener('click', () => {
    const identifier = storage.getProfileIdentifier();
    if (identifier) {
      const profileUrl = getProfileLink(identifier);
      navigator.clipboard.writeText(profileUrl).then(() => {
        showToast('Ссылка скопирована');
      });
    }
  });

  const shareBtn = document.getElementById('share-profile-link');
  shareBtn?.addEventListener('click', () => {
    const identifier = storage.getProfileIdentifier();
    if (identifier) {
      const profileUrl = getProfileLink(identifier);
      if (WEBAPP?.openTelegramLink) {
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(profileUrl)}&text=${encodeURIComponent('Мой профиль тренировок 💪')}`;
        WEBAPP.openTelegramLink(shareUrl);
      } else {
        navigator.clipboard.writeText(profileUrl).then(() => {
          showToast('Ссылка скопирована');
        });
      }
    }
  });

  document.getElementById('add-passkey-btn')?.addEventListener('click', async () => {
    try {
      if (!canUsePasskeyInCurrentContext()) {
        openBrowserHandoff();
        return;
      }

      await addPasskey('Gym Gym 21');
      authStatus = await getMigrationStatus();
      updateProfileTabContent();
      showToast('Passkey добавлен');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось добавить Passkey');
    }
  });

  document.getElementById('link-telegram-btn')?.addEventListener('click', async () => {
    const initData = getTelegramInitData();
    if (!initData) {
      showToast('Откройте приложение в Telegram, чтобы привязать аккаунт');
      return;
    }

    try {
      await linkTelegramAccount(initData);
      authStatus = await getMigrationStatus();
      await storage.sync();
      updateProfileTabContent();
      showToast('Telegram привязан');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось привязать Telegram');
    }
  });

  const linkTelegramWidget = document.getElementById('link-telegram-widget');
  if (linkTelegramWidget) {
    const widgetWindow = window as typeof window & { onTelegramLinkBetter?: (user: TelegramLoginData) => void };
    widgetWindow.onTelegramLinkBetter = async (user: TelegramLoginData) => {
      try {
        await linkTelegramAccount(serializeTelegramLoginData(user));
        authStatus = await getMigrationStatus();
        await storage.sync();
        updateProfileTabContent();
        showToast('Telegram привязан');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось привязать Telegram');
      }
    };

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', 'gymgym21bot');
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '12');
    script.setAttribute('data-onauth', 'onTelegramLinkBetter(user)');
    script.setAttribute('data-request-access', 'write');
    linkTelegramWidget.appendChild(script);
  }

  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    try {
      await signOut();
      location.reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось выйти');
    }
  });

  // Export/Import Logic
  document.getElementById('export-json-btn')?.addEventListener('click', async () => {
    try {
      const data = await storage.exportData();
      const filename = `gym_backup_${new Date().toISOString().split('T')[0]}.json`;
      downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
      showToast('Экспорт выполнен');
    } catch (e) {
      console.error(e);
      showToast('Ошибка экспорта');
    }
  });

  document.getElementById('export-md-btn')?.addEventListener('click', async () => {
    try {
      const data = await storage.exportData();
      const markdown = generateMarkdown(data);
      const filename = `gym_history_${new Date().toISOString().split('T')[0]}.md`;
      downloadFile(markdown, filename, 'text/markdown');
      showToast('Экспорт выполнен');
    } catch (e) {
      console.error(e);
      showToast('Ошибка экспорта');
    }
  });

  document.getElementById('import-json-btn')?.addEventListener('click', () => {
    document.getElementById('import-file-input')?.click();
  });

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = event.target?.result as string;
        const data = JSON.parse(json);

        if (confirm('Внимание! Все текущие данные будут заменены данными из файла. Продолжить?')) {
          await storage.importData(data);
          showToast('Данные успешно импортированы');
          setTimeout(() => location.reload(), 1000);
        }
      } catch (err) {
        console.error(err);
        showToast('Ошибка импорта: Неверный формат файла');
      }
    };
    reader.readAsText(file);
    (e.target as HTMLInputElement).value = '';
  });
}

function renderPublicProfilePage() {

  if (!viewingProfileIdentifier) {
    return `
      <div class="page-content">
        <div class="profile-not-found">
          <div class="profile-not-found-icon">🔍</div>
          <div class="profile-not-found-text">Профиль не найден</div>
        </div>
      </div>
    `;
  }

  if (!loadedPublicProfile) {
    if (profileLoadFailed) {
      return `
        <div class="page-content">
          <div class="profile-not-found">
            <div class="profile-not-found-icon">🔒</div>
            <div class="profile-not-found-text">Профиль скрыт или не существует</div>
          </div>
        </div>
      `;
    }
    return `
      <div class="page-content">
        <div class="profile-loading">Загрузка профиля...</div>
      </div>
    `;
  }

  const profile = loadedPublicProfile;
  const safeDisplayName = escapeHtml(profile.displayName);
  const safeIdentifier = escapeHtml(profile.identifier);
  const safeFriendIdentifier = escapeAttribute(profile.identifier);
  const safeFriendName = escapeAttribute(profile.displayName);
  const safeFriendPhoto = escapeAttribute(sanitizeUrl(profile.photoUrl) ?? '');
  // Filter out deleted items
  if (profile.logs) {
    profile.logs = profile.logs.filter(l => !l.isDeleted);
  }
  if (profile.workoutTypes) {
    profile.workoutTypes = profile.workoutTypes.filter(t => !t.isDeleted);
  }
  return `
    <div class="page-content profile-page">
      <div class="profile-header">
        <div class="profile-avatar">
          ${renderSafeAvatarMarkup(profile.displayName, profile.photoUrl)}
        </div>
        <div class="profile-name">${safeDisplayName}</div>
        ${profile.identifier.startsWith('id_') ? '' : `<div class="profile-subtitle">@${safeIdentifier}</div>`}
	        ${(function () {
	      const myProfile = storage.getProfile();
	      const isMe = myProfile && (
	        myProfile.username === profile.identifier ||
	        myProfile.telegramUsername === profile.identifier ||
	        (myProfile.telegramUserId ? `id_${myProfile.telegramUserId}` === profile.identifier : false)
	      );
	      if (isMe) return '';

      const isFriend = storage.isFriend(profile.identifier);
      return `
                <button class="button ${isFriend ? 'button_secondary' : ''}" id="friend-action-btn" data-id="${safeFriendIdentifier}" data-name="${safeFriendName}" data-photo="${safeFriendPhoto}" style="margin-top: 12px; height: 36px; font-size: 14px; display: flex; align-items: center; justify-content: center;">
                    ${isFriend ? 'Удалить из друзей' : 'Добавить в друзья'}
                </button>
            `;
    })()}
      </div>

      ${(function () {
      let calculatedVolume = 0;
      if (profile.logs) {
        calculatedVolume = profile.logs.reduce((acc, l) => acc + ((l.weight || 0) * (l.reps || 0)), 0);
      }
      const totalVolume = Math.max(profile.stats.totalVolume, calculatedVolume);

      const stats: ProfileStats = {
        ...profile.stats,
        totalVolume
      };

      const logDates = profile.logs ? new Set(profile.logs.map(l => l.date.split('T')[0])) : new Set<string>();
      return renderProfileStats(stats, logDates);
    })()}

      ${profile.recentActivity.length > 0 ? `
        <div class="activity-list">
          <h2 class="subtitle">Недавняя активность</h2>
          ${profile.recentActivity.map(a => `
            <div class="activity-item">
              <span class="activity-date">${new Date(a.date).toLocaleDateString()}</span>
              <span class="activity-count">${a.exerciseCount} упражнений</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${profile.logs && profile.logs.length > 0 && profile.workoutTypes ? `
        <div class="recent-logs">
          <h2 class="subtitle">История тренировок</h2>
          <div id="logs-list">
            ${generateLogsListHtml(profile.logs, profile.workoutTypes, false)}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderStatsPage() {
  const logs = storage.getLogs();
  const workouts = storage.getWorkouts();
  const types = storage.getWorkoutTypes();

  if (logs.length === 0) {
    return `
      <div class="page-content">
        <h1 class="title">Статистика</h1>
        <p class="hint">Недостаточно данных для статистики</p>
      </div>
    `;
  }

  // Calculate generic stats
  const totalVolume = logs.reduce((acc, l) => acc + ((l.weight || 0) * (l.reps || 0)), 0);
  const totalReps = logs.reduce((acc, l) => acc + (l.reps || 0), 0);
  const durationStats = getDurationStats(workouts);

  let html = `
    <div class="page-content">
      <h1 class="title">Статистика</h1>
      <div class="stats-tabs">
        <button class="stats-tab ${currentStatsTab === 'overview' ? 'active' : ''}" data-tab="overview">Обзор</button>
        <button class="stats-tab ${currentStatsTab === 'progress' ? 'active' : ''}" data-tab="progress">Прогресс</button>
      </div>
  `;

  if (currentStatsTab === 'overview') {
    const dates = getWorkoutDates(workouts, logs);

    html += `
        <div class="stats-section">
            <h2 class="subtitle">Активность</h2>
            ${renderHeatmap(dates)}
        </div>

        <div class="stats-summary">
            <div class="stat-metric">
                <div class="stat-metric__label">Всего тренировок</div>
                <div class="stat-metric__value">${dates.size}</div>
            </div>
            <div class="stat-metric">
                <div class="stat-metric__label">Сред. длительность</div>
                <div class="stat-metric__value">${durationStats.averageMinutes}<span class="stat-metric__unit">мин</span></div>
            </div>
             <div class="stat-metric">
                <div class="stat-metric__label">Общий объем</div>
                <div class="stat-metric__value">${Math.round(totalVolume / 1000)}<span class="stat-metric__unit">т</span></div>
            </div>
            <div class="stat-metric">
                <div class="stat-metric__label">Всего повторений</div>
                <div class="stat-metric__value">${totalReps}</div>
            </div>
        </div>

        <div class="charts-section">
            <h2 class="subtitle">Длительность тренировок</h2>
            <div class="chart-container">
                ${renderDurationChart(workouts)}
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
                ${types.map(t => `<option value="${t.id}" ${selectedStatType === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
            </select>
        </div>
    `;

    if (selectedStatType === 'all') {
      html += `
            <div class="charts-section">
                <h2 class="subtitle">Общий объем по дням</h2>
                <div class="chart-container">
                    ${renderVolumeChart(logs)}
                </div>
            </div>
        `;
    } else {
      const typeLogs = logs.filter(l => l.workoutTypeId === selectedStatType);
      const oneRepMaxData = getOneRepMaxByDate(typeLogs, selectedStatType);

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
                    ${renderVolumeChart(typeLogs)}
                </div>
            </div>
        `;
    }
  }

  html += `</div>`;
  return html;
}


function formatWorkoutForShare(dateStr: string): string {
  const allLogs = storage.getLogs();
  const types = storage.getWorkoutTypes();

  // Get logs for the specific date
  const dayLogs = allLogs.filter(log => log.date.startsWith(dateStr));
  if (dayLogs.length === 0) return '';

  // Format the date for display
  const dateObj = new Date(dayLogs[0].date);
  const dateLabel = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  // Group by exercise
  const exerciseGroups: Map<string, WorkoutSet[]> = new Map();
  dayLogs.forEach(log => {
    if (!exerciseGroups.has(log.workoutTypeId)) {
      exerciseGroups.set(log.workoutTypeId, []);
    }
    exerciseGroups.get(log.workoutTypeId)!.push(log);
  });

  let text = `🏋️ Тренировка ${dateLabel}\n\n`;

  exerciseGroups.forEach((sets, typeId) => {
    const type = types.find(t => t.id === typeId);
    text += `${type?.name || 'Упражнение'}:\n`;
    sets.forEach(set => {
      if (set.duration) {
        text += `  ⏱ ${set.duration} мин\n`;
      } else {
        text += `  ${set.weight} кг × ${set.reps}\n`;
      }
    });
    text += '\n';
  });

  // Calculate total volume
  const totalVolume = dayLogs.reduce((acc, l) => acc + (l.weight && l.reps ? (l.weight * l.reps) : 0), 0);
  if (totalVolume) {
    text += `💪 Общий объём: ${Math.round(totalVolume)} кг`;
  }

  return text;
}

function shareWorkout(dateStr: string) {
  const text = formatWorkoutForShare(dateStr);
  if (!text) return;

  if (WEBAPP?.openTelegramLink) {
    // Use Telegram share URL
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent('https://t.me/gymgym21bot')}&text=${encodeURIComponent(text)}`;
    WEBAPP.openTelegramLink(shareUrl);
  } else {
    // Fallback: copy to clipboard
    navigator.clipboard.writeText(text).then(() => {
      alert('Текст скопирован в буфер обмена');
    });
  }
}

function bindPageEvents() {
  if (currentPage === 'main') {
    // Workout controls events - use partial update
    bindWorkoutControlEvents();

    const form = document.getElementById('log-form') as HTMLFormElement;

    // Helper to update visibility
    const updateFormVisibility = () => {
      const types = storage.getWorkoutTypes();
      const selectedId = getTypeaheadValue(form);
      const selectedType = types.find(t => t.id === selectedId);

      const strengthInputs = document.getElementById('strength-inputs');
      const timeInputs = document.getElementById('time-inputs');

      if (selectedType && selectedType.category === 'time') {
        if (strengthInputs) strengthInputs.style.display = 'none';
        if (timeInputs) timeInputs.style.display = 'block';

        // Required attributes management
        form.querySelectorAll('input[name="weight"], input[name="reps"]').forEach(el => el.removeAttribute('required'));
        // Optional hours/minutes, default to 0 if empty
        form.querySelectorAll('input[name="duration_hours"], input[name="duration_minutes"], input[name="duration_seconds"]').forEach(el => el.removeAttribute('required'));
      } else {
        if (strengthInputs) strengthInputs.style.display = 'block';
        if (timeInputs) timeInputs.style.display = 'none';

        form.querySelectorAll('input[name="weight"], input[name="reps"]').forEach(el => el.setAttribute('required', 'true'));
        form.querySelectorAll('input[name="duration_hours"], input[name="duration_minutes"], input[name="duration_seconds"]').forEach(el => el.removeAttribute('required'));
      }
    };

    // Initial check
    updateFormVisibility();

    // Bind typeahead if present
    const typeaheadEl = form?.querySelector('[data-typeahead]');
    if (typeaheadEl) {
      registerTypeaheadItems(form, storage.getWorkoutTypes().map(t => ({ id: t.id, name: t.name })));
      bindTypeahead(form);
    }

    // Listen for changes (works for both <select> and typeahead hidden input)
    const typeSelect = document.getElementById('workout-type-select');
    typeSelect?.addEventListener('change', updateFormVisibility);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(form);
      const typeId = formData.get('typeId') as string;
      const types = storage.getWorkoutTypes();
      const type = types.find(t => t.id === typeId);

      const logData: Partial<WorkoutSet> & { workoutTypeId: string } = {
        workoutTypeId: typeId,
      };

      if (type?.category === 'time') {
        const hours = parseInt(formData.get('duration_hours') as string, 10) || 0;
        const minutes = parseInt(formData.get('duration_minutes') as string, 10) || 0;
        const seconds = parseInt(formData.get('duration_seconds') as string, 10) || 0;
        logData.duration = (hours * 60) + minutes;

        // Only set durationSeconds if it's > 0, to keep data clean if they only typed minutes
        if (seconds > 0) {
          logData.durationSeconds = seconds;
        } else {
          delete logData.durationSeconds;
        }
      } else {
        logData.weight = parseFloat(formData.get('weight') as string);
        logData.reps = parseInt(formData.get('reps') as string, 10);
      }

      if (editingLogId) {
        const logs = storage.getLogs();
        const existingLog = logs.find(l => l.id === editingLogId);
        if (existingLog) {
          const dateStr = formData.get('date') as string;
          let newDate = existingLog.date;
          if (dateStr) {
            if (dateStr.includes('T')) {
              // datetime-local input provides 'YYYY-MM-DDTHH:mm'
              const localDate = new Date(dateStr);
              // preserve seconds and ms from original date
              const oldDate = new Date(existingLog.date);
              localDate.setSeconds(oldDate.getSeconds(), oldDate.getMilliseconds());
              newDate = localDate.toISOString();
            } else {
              // fallback for simple date input
              const oldDate = new Date(existingLog.date);
              const [year, month, day] = dateStr.split('-').map(Number);
              oldDate.setFullYear(year, month - 1, day);
              newDate = oldDate.toISOString();
            }
          }

          await storage.updateLog({
            ...existingLog,
            ...logData,
            date: newDate
          });
          editingLogId = null;
          // Need full render to reset the form
          render();
        }
      } else {
        const newLog = await storage.addLog(logData);
        lastAddedLogId = newLog.id;
        // Use partial update for new logs
        updateWeekView();
        lastAddedLogId = null;
      }
    });

    const duplicateBtn = document.getElementById('duplicate-last-btn');
    duplicateBtn?.addEventListener('click', async () => {
      const logs = storage.getLogs();
      const lastLog = logs[logs.length - 1];
      if (lastLog) {
        const newLog = await storage.addLog({
          workoutTypeId: lastLog.workoutTypeId,
          weight: lastLog.weight,
          reps: lastLog.reps,
          duration: lastLog.duration,
          durationSeconds: lastLog.durationSeconds
        });
        lastAddedLogId = newLog.id;
        // Use partial update instead of full render
        updateWeekView();
        lastAddedLogId = null;
      }
    });

    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    cancelEditBtn?.addEventListener('click', () => {
      editingLogId = null;
      render();
    });

    bindLogItemEvents();

    const prevWeekBtn = document.getElementById('prev-week-btn');
    prevWeekBtn?.addEventListener('click', () => {
      currentWeekOffset++;
      updateWeekView();
    });

    const nextWeekBtn = document.getElementById('next-week-btn');
    nextWeekBtn?.addEventListener('click', () => {
      if (currentWeekOffset > 0) {
        currentWeekOffset--;
        updateWeekView();
      }
    });

    // Calendar navigation
    const calendarInput = document.getElementById('calendar-input') as HTMLInputElement;

    calendarInput?.addEventListener('change', () => {
      // Only process if value actually changed and is not empty
      if (!calendarInput.value || calendarInput.value === lastCalendarValue) {
        return;
      }
      lastCalendarValue = calendarInput.value;

      const selectedDate = new Date(calendarInput.value);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Calculate the week offset for the selected date
      const diffTime = today.getTime() - selectedDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      currentWeekOffset = Math.max(0, Math.floor(diffDays / 7));

      // Use partial update instead of full render
      updateWeekView();
    });

    // Filter toggle
    const filterToggle = document.getElementById('filter-toggle-input') as HTMLInputElement;
    filterToggle?.addEventListener('change', () => {
      isFilterEnabled = filterToggle.checked;
      updateWeekView();
    });
  }

  if (currentPage === 'settings') {
    bindSettingsPageEvents();
  }

  // stats type select handled in bindPageEvents stats block below

  if (currentPage === 'profile-settings') {
    // Tab switching - use partial update instead of full render
    const tabs = document.querySelectorAll('.profile-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabId = tab.getAttribute('data-tab');
        if (tabId === 'ai' || tabId === 'public' || tabId === 'data') {
          currentProfileTab = tabId;
          updateProfileTabContent();
        }
      });
    });

    const saveBtn = document.getElementById('save-profile-btn');
    saveBtn?.addEventListener('click', async () => {
      // Gather fields from all tabs (only those currently present in DOM will be found)
      const publicToggle = document.getElementById('profile-public-toggle') as HTMLInputElement;
      const historyToggle = document.getElementById('profile-history-toggle') as HTMLInputElement;
      const nameInput = document.getElementById('profile-display-name') as HTMLInputElement;

      const genderInput = document.getElementById('profile-gender') as HTMLSelectElement;
      const birthDateInput = document.getElementById('profile-birthdate') as HTMLInputElement;
      const heightInput = document.getElementById('profile-height') as HTMLInputElement;
      const weightInput = document.getElementById('profile-weight') as HTMLInputElement;
      const additionalInfoInput = document.getElementById('profile-additional-info') as HTMLTextAreaElement;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates: any = {};

      if (publicToggle) updates.isPublic = publicToggle.checked;
      if (historyToggle) updates.showFullHistory = historyToggle.checked;
      if (nameInput) updates.displayName = nameInput.value;

      if (genderInput) updates.gender = genderInput.value || undefined;
      if (birthDateInput) updates.birthDate = birthDateInput.value;
      if (heightInput) updates.height = heightInput.value ? Number(heightInput.value) : undefined;
      if (weightInput) updates.weight = weightInput.value ? Number(weightInput.value) : undefined;
      if (additionalInfoInput) updates.additionalInfo = additionalInfoInput.value;

      await storage.updateProfileSettings(updates);
      showToast('Профиль сохранен');
      // No re-render needed - data is already saved
    });

    // AI Buttons - update DOM directly to avoid full re-render
    const aiGeneralBtn = document.getElementById('ai-general-btn') as HTMLButtonElement | null;
    const aiPlanBtn = document.getElementById('ai-plan-btn') as HTMLButtonElement | null;

    const setAiButtonsLoading = (state: 'idle' | 'general' | 'plan') => {
      aiLoadingState = state;
      if (aiGeneralBtn) {
        aiGeneralBtn.disabled = state !== 'idle';
        aiGeneralBtn.textContent = state === 'general' ? 'Анализ...' : '✨ Общий анализ';
      }
      if (aiPlanBtn) {
        aiPlanBtn.disabled = state !== 'idle';
        aiPlanBtn.textContent = state === 'plan' ? 'Генерация...' : '📅 Создать план';
      }
    };

    const updateAiResult = (type: 'general' | 'plan', result: string) => {
      aiResults[type] = result;
      localStorage.setItem('gym_ai_results', JSON.stringify(aiResults));
      const containerId = type === 'general' ? 'ai-general-result' : 'ai-plan-result';
      const container = document.getElementById(containerId);
      if (container) {
        container.style.display = '';
        const body = container.querySelector('.markdown-body');
        if (body) body.innerHTML = result;
      }
    };

    if (aiGeneralBtn) {
      aiGeneralBtn.addEventListener('click', async () => {
        setAiButtonsLoading('general');
        try {
          const result = await storage.getAIRecommendation('general');
          updateAiResult('general', result);
        } catch (e) {
          showToast('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
        } finally {
          setAiButtonsLoading('idle');
        }
      });
    }

    if (aiPlanBtn) {
      aiPlanBtn.addEventListener('click', async () => {
        const period = (document.getElementById('ai-plan-period') as HTMLSelectElement).value as 'day' | 'week';
        const allowNew = (document.getElementById('ai-allow-new') as HTMLInputElement).checked;

        setAiButtonsLoading('plan');
        try {
          const result = await storage.getAIRecommendation('plan', { period, allowNewExercises: allowNew });
          updateAiResult('plan', result);
        } catch (e) {
          showToast('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
        } finally {
          setAiButtonsLoading('idle');
        }
      });
    }

    const copyBtn = document.getElementById('copy-profile-link');
    copyBtn?.addEventListener('click', () => {
      const identifier = storage.getProfileIdentifier();
      if (identifier) {
        const profileUrl = getProfileLink(identifier);
        navigator.clipboard.writeText(profileUrl).then(() => {
          showToast('Ссылка скопирована');
        });
      }
    });

    const shareBtn = document.getElementById('share-profile-link');
    /*eslint no-empty: "error"*/
    shareBtn?.addEventListener('click', () => {
      const identifier = storage.getProfileIdentifier();
      if (identifier) {
        const profileUrl = getProfileLink(identifier);
        if (WEBAPP?.openTelegramLink) {
          const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(profileUrl)}&text=${encodeURIComponent('Мой профиль тренировок 💪')}`;
          WEBAPP.openTelegramLink(shareUrl);
        } else {
          navigator.clipboard.writeText(profileUrl).then(() => {
            showToast('Ссылка скопирована');
          });
        }
      }
    });

    // Export/Import Logic
    document.getElementById('export-json-btn')?.addEventListener('click', async () => {
      try {
        const data = await storage.exportData();
        const filename = `gym_backup_${new Date().toISOString().split('T')[0]}.json`;
        downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
        showToast('Экспорт выполнен');
      } catch (e) {
        console.error(e);
        showToast('Ошибка экспорта');
      }
    });

    document.getElementById('export-md-btn')?.addEventListener('click', async () => {
      try {
        const data = await storage.exportData();
        const markdown = generateMarkdown(data);
        const filename = `gym_history_${new Date().toISOString().split('T')[0]}.md`;
        downloadFile(markdown, filename, 'text/markdown');
        showToast('Экспорт выполнен');
      } catch (e) {
        console.error(e);
        showToast('Ошибка экспорта');
      }
    });

    document.getElementById('import-json-btn')?.addEventListener('click', () => {
      document.getElementById('import-file-input')?.click();
    });

    document.getElementById('import-file-input')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const json = event.target?.result as string;
          const data = JSON.parse(json);

          if (confirm('Внимание! Все текущие данные будут заменены данными из файла. Продолжить?')) {
            await storage.importData(data);
            showToast('Данные успешно импортированы');
            setTimeout(() => location.reload(), 1000);
          }
        } catch (err) {
          console.error(err);
          showToast('Ошибка импорта: Неверный формат файла');
        }
      };
      reader.readAsText(file);
      // Clear input so same file can be selected again if needed
      (e.target as HTMLInputElement).value = '';
    });
  }

  if (currentPage === 'stats') {
    bindStatsPageEvents();
  }

  if (currentPage === 'public-profile') {
    const friendBtn = document.getElementById('friend-action-btn');
    friendBtn?.addEventListener('click', async () => {
      const id = friendBtn.getAttribute('data-id');
      const name = friendBtn.getAttribute('data-name');
      const photo = friendBtn.getAttribute('data-photo');

      if (id && name) {
        const isFriend = storage.isFriend(id);
        if (isFriend) {
          if (confirm('Удалить пользователя из друзей?')) {
            await storage.removeFriend(id);
            // Note: removeFriend already calls sync() internally
          }
        } else {
          await storage.addFriend({
            identifier: id,
            displayName: name,
            photoUrl: photo || undefined
          });
          // Note: addFriend already calls sync() internally
          showToast('Пользователь добавлен в друзья');
        }
        render();
      }
    });
  }
}


const syncStatusEl = document.createElement('div');
syncStatusEl.className = 'sync-status';
document.body.appendChild(syncStatusEl);

function updateSyncStatus(status: SyncStatus) {
  syncStatusEl.className = 'sync-status visible ' + status;

  switch (status) {
    case 'saving':
      syncStatusEl.textContent = 'Синхронизация...';
      break;
    case 'success':
      syncStatusEl.textContent = 'Синхронизировано';
      break;
    case 'error':
      syncStatusEl.textContent = 'Ошибка синхронизации';
      break;
    default:
      syncStatusEl.className = 'sync-status'; // Hide
  }
}

storage.onUpdate(() => {
  switch (currentPage) {
    case 'main':
      render();
      break;
    case 'profile-settings':
      updateProfileTabContent();
      break;
    case 'settings':
      updateSettingsTypeList();
      break;
    case 'stats':
      updateStatsContent();
      break;
    default:
      render();
  }
});
storage.onSyncStatusChange(updateSyncStatus);

async function initApp() {
  const session = await restoreSession();
  if (!session) {
    renderLogin(document.getElementById('app')!, () => {
      location.reload();
    });
    return;
  }

  try {
    authStatus = await getMigrationStatus();
  } catch {
    renderLogin(document.getElementById('app')!, () => {
      location.reload();
    });
    return;
  }

  if (authStatus?.needsCompletion) {
    renderLogin(document.getElementById('app')!, () => {
      location.reload();
    });
    return;
  }

  // Check for profile deep link from startapp parameter
  const currentParams = new URLSearchParams(window.location.search);
  const startApp = currentParams.get('startapp') || WEBAPP?.initDataUnsafe?.start_param;

  if (startApp && startApp.startsWith('profile_')) {
    const identifier = startApp.replace('profile_', '');
    viewingProfileIdentifier = identifier;
    currentPage = 'public-profile';
    profileLoadFailed = false;
    render();

    // Load the public profile
    loadedPublicProfile = await storage.getPublicProfile(identifier);
    if (!loadedPublicProfile) {
      profileLoadFailed = true;
    }
    render();
  } else {
    render();
  }
  // Note: storage.init() is called automatically in StorageService constructor
}

initApp();
