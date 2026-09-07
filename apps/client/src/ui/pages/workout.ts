import type { PublicLog, PublicWorkoutType } from '@gym21/contracts';
import { bindTypeahead, getTypeaheadValue, registerTypeaheadItems, renderTypeahead } from '../../components/typeahead/Typeahead';
import { WorkoutSession, WorkoutSet } from '../../types';
import { formatDuration } from '../../utils/duration';
import { getLatestLog } from '../../utils/latest-log';
import { escapeAttribute, escapeHtml, renderOption } from '../../utils/safe-html';
import { datetimeValue, dayKey, dayLabel, parseDatetimeValue } from '../../utils/training-time';
import type { PageContext } from '../context';
import { createLifecycle } from '../lifecycle';
export function createWorkoutPage(context: PageContext) {
  const { state, dependencies } = context;
  const { storage } = dependencies;
  const { render, showToast, withFormDrafts } = context.actions;
  const lifecycle = createLifecycle();
  let workoutTimerInterval: ReturnType<typeof setInterval> | null = null;
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
          ${activeWorkout.name ? `<span class="workout-name">${escapeHtml(activeWorkout.name)}</span>` : ''}
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

    if (state.isStartingWorkout) {
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

  function getWeekRange(offset: number) {
    // Calendar-only UTC arithmetic avoids viewer-zone and DST shifts of account day keys.
    const end = new Date(`${dayKey(Date.now(), storage.getTimeZone())}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - offset * 7);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    return { start, end, label: `${dayLabel(dayKey(start), { day: 'numeric', month: 'short' })} - ${dayLabel(dayKey(end), { day: 'numeric', month: 'short' })}` };

  }

  function renderMainPage() {
    const types = storage.getWorkoutTypes();
    const logs = storage.getLogs();
    const lastLog = getLatestLog(logs);
    const lastTypeId = types.find(t => !t.isDeleted && t.id === lastLog?.workoutTypeId)?.id;
    const editingLog = state.editingLogId ? logs.find(l => l.id === state.editingLogId) : null;
    const selectedWorkoutTypeId = state.editingLogId
      ? editingLog?.workoutTypeId
      : lastTypeId;
    const duplicateWorkoutTypeName = escapeHtml(types.find(t => t.id === lastLog?.workoutTypeId)?.name || '');
    const { label } = getWeekRange(state.currentWeekOffset);

    return `
    <div class="page-content" id="main-content">
      ${renderWorkoutControls()}
      <h1 class="title">${state.editingLogId ? 'Редактирование подхода' : 'Новый подход'}</h1>
      <form class="workout-form" id="log-form">
        <div class="form-group">
          <label class="label">Тип тренировки</label>
          ${types.length > 10
        ? renderTypeahead({
          items: types.map(t => ({ id: t.id, name: t.name })),
          selectedId: selectedWorkoutTypeId,
          name: 'typeId',
          inputId: 'workout-type-select',
          placeholder: 'Начните вводить название...'
        })
        : `<select class="select" name="typeId" id="workout-type-select" required>
                ${types.map(t => renderOption(
          t.id,
          t.name,
          t.id === selectedWorkoutTypeId,
        )).join('')}
              </select>`
      }
        </div>

        <div id="strength-inputs" style="display: none;">
            <div class="form-row">
              <div class="form-group">
                <label class="label">Вес (кг)</label>
                <input class="input" type="number" name="weight" step="0.5" placeholder="0" value="${escapeAttribute(state.editingLogId && editingLog ? (editingLog.weight ?? '') : '')}">

              </div>
              <div class="form-group">
                <label class="label">Повторений</label>
                <input class="input" type="number" name="reps" placeholder="0" value="${escapeAttribute(state.editingLogId && editingLog ? (editingLog.reps ?? '') : '')}">

              </div>
            </div>
        </div>

        <div id="time-inputs" style="display: none;">
            <div class="form-row">
                <div class="form-group">
                    <label class="label">Часы</label>
                    <input class="input" type="number" name="duration_hours" placeholder="0" value="${escapeAttribute(state.editingLogId && editingLog && editingLog.duration !== undefined ? Math.floor(editingLog.duration / 60) : '')}">
                </div>
                <div class="form-group">
                    <label class="label">Минуты</label>
                    <input class="input" type="number" name="duration_minutes" placeholder="0" value="${escapeAttribute(state.editingLogId && editingLog && editingLog.duration !== undefined ? (editingLog.duration % 60) : '')}">
                </div>
                <div class="form-group">
                    <label class="label">Секунды</label>
                    <input class="input" type="number" name="duration_seconds" placeholder="0" value="${escapeAttribute(state.editingLogId && editingLog && editingLog.durationSeconds !== undefined ? editingLog.durationSeconds : '')}">
                </div>
            </div>
        </div>

        ${state.editingLogId && editingLog ? `
        <div class="form-group">
          <label class="label">Дата и время</label>
          <input class="input" type="datetime-local" name="date" required value="${escapeAttribute(toLocalDatetimeValue(editingLog.date))}">
        </div>
        ` : ''}

        <button class="button" type="submit">${state.editingLogId ? 'Сохранить изменения' : 'Зафиксировать'}</button>
        ${state.editingLogId ? `<button class="button button_secondary" type="button" id="cancel-edit-btn" style="margin-top: 12px;">Отмена</button>` : ''}
        ${!state.editingLogId && lastLog && lastTypeId ? `<button class="button button_secondary" type="button" id="duplicate-last-btn" style="margin-top: 12px;">Повторить: ${duplicateWorkoutTypeName} ${lastLog.weight !== undefined ? `${escapeHtml(lastLog.weight)}кг × ${escapeHtml(lastLog.reps)}` : `${escapeHtml(lastLog.duration || 0)} мин${lastLog.durationSeconds ? ` ${escapeHtml(lastLog.durationSeconds)} сек` : ''}`}</button>` : ''}

      </form>
      <div class="recent-logs">
        <div class="recent-logs__header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
           <button class="icon-btn" id="prev-week-btn">◀️</button>
           <div id="week-label-container" style="display: flex; align-items: center; gap: 8px; position: relative;">
             <span style="font-size: 18px; position: relative; display: inline-block;">
               📅
               <input type="date" id="calendar-input" value="${escapeAttribute(state.lastCalendarValue)}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;">
             </span>
             <h2 class="subtitle" style="margin: 0;">${escapeHtml(state.currentWeekOffset === 0 ? 'Последние 7 дней' : label)}</h2>
             <label class="filter-toggle" title="Фильтр по типу упражнения">
               <input type="checkbox" id="filter-toggle-input" ${state.isFilterEnabled ? 'checked' : ''}>
               <span class="filter-toggle__icon">🔍</span>
             </label>
           </div>
           <button class="icon-btn" id="next-week-btn" ${state.currentWeekOffset === 0 ? 'disabled' : ''} style="${state.currentWeekOffset === 0 ? 'opacity: 0.3; cursor: default;' : ''}">▶️</button>
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
    const { start, end } = getWeekRange(state.currentWeekOffset);

    let weekLogs = allLogs.filter(log => {
      const key = dayKey(log.date, storage.getTimeZone());
      return key >= dayKey(start) && key <= dayKey(end);
    });

    // Apply filter by selected exercise type if enabled
    if (state.isFilterEnabled) {
      const selectedTypeId = getTypeaheadValue();
      if (selectedTypeId) {
        weekLogs = weekLogs.filter(log => log.workoutTypeId === selectedTypeId);
      }
    }

    return generateLogsListHtml(weekLogs, types, true);
  }

  function updateWeekView() {
    withFormDrafts(renderWeekUpdate);
  }

  function renderWeekUpdate() {
    const logsListEl = document.getElementById('logs-list');
    const weekLabelEl = document.querySelector('#week-label-container .subtitle');

    if (logsListEl) {
      logsListEl.innerHTML = renderLogsList();
      // Re-bind log item events
      bindLogItemEvents();
    }

    if (weekLabelEl) {
      const { label } = getWeekRange(state.currentWeekOffset);
      weekLabelEl.textContent = state.currentWeekOffset === 0 ? 'Последние 7 дней' : label;
    }

    // Update next button state
    const nextWeekBtn = document.getElementById('next-week-btn') as HTMLButtonElement;
    if (nextWeekBtn) {
      nextWeekBtn.disabled = state.currentWeekOffset === 0;
      nextWeekBtn.style.opacity = state.currentWeekOffset === 0 ? '0.3' : '';
      nextWeekBtn.style.cursor = state.currentWeekOffset === 0 ? 'default' : '';
    }
  }

  function bindLogItemEvents() {
    document.querySelectorAll('.log-set__delete').forEach(btn => {
      lifecycle.listen(btn, 'click', async () => {
        const id = btn.getAttribute('data-id');
        if (id) {
          if (state.editingLogId === id) {
            state.formDrafts?.clear('log-form');
            state.editingLogId = null;
          }
          await storage.deleteLog(id);
          updateWeekView();
        }
      });
    });

    document.querySelectorAll('.log-set__edit').forEach(btn => {
      lifecycle.listen(btn, 'click', () => {
        state.formDrafts?.clear('log-form');
        state.editingLogId = btn.getAttribute('data-id');
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    document.querySelectorAll('.share-btn').forEach(btn => {
      lifecycle.listen(btn, 'click', () => {
        const dateStr = btn.getAttribute('data-date');
        if (dateStr) {
          shareWorkout(dateStr);
        }
      });
    });

    // Workout edit buttons
    document.querySelectorAll('.workout-header__edit').forEach(btn => {
      lifecycle.listen(btn, 'click', () => {
        state.formDrafts?.clear('workout-edit-form');
        state.editingWorkoutId = btn.getAttribute('data-workout-id');
        updateWeekView();
      });
    });

    // Workout edit form
    const editForm = document.getElementById('workout-edit-form') as HTMLFormElement;
    if (editForm) {
      lifecycle.listen(editForm, 'submit', async (e) => {
        e.preventDefault();
        if (!state.editingWorkoutId) return;
        const saved = state.formDrafts?.checkpoint('workout-edit-form');
        const formData = new FormData(editForm);
        const name = (formData.get('workoutName') as string) || '';
        const startTimeLocal = formData.get('startTime') as string;
        const endTimeLocal = formData.get('endTime') as string;

        const updates: { name?: string; startTime?: string; endTime?: string } = { name };
        const original = storage.getWorkouts().find(w => w.id === state.editingWorkoutId);
        try {
          if (startTimeLocal) updates.startTime = parseDatetimeValue(startTimeLocal, storage.getTimeZone(), original?.startTime);
          if (endTimeLocal) updates.endTime = parseDatetimeValue(endTimeLocal, storage.getTimeZone(), original?.endTime);
        } catch (error) { showToast((error as Error).message); return; }

        await storage.updateWorkout(state.editingWorkoutId, updates);
        if (!saved?.()) return;
        state.editingWorkoutId = null;
        updateWeekView();
        showToast('Тренировка обновлена');
      });

      const cancelBtn = document.getElementById('cancel-edit-workout-btn');
      lifecycle.listen(cancelBtn, 'click', () => {
        state.formDrafts?.clear('workout-edit-form');
        state.editingWorkoutId = null;
        updateWeekView();
      });
    }

    document.querySelectorAll('.log-exercise__name').forEach(el => {
      lifecycle.listen(el, 'click', () => {
        if (state.editingLogId) return;
        const typeId = el.getAttribute('data-type-id');
        if (typeId) {
          setWorkoutTypeInForm(typeId);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    });

    document.querySelectorAll('.log-set').forEach(el => {
      lifecycle.listen(el, 'click', (e) => {
        if ((e.target as HTMLElement).closest('.log-set__actions')) return;
        if (state.editingLogId) return;

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
    return datetimeValue(isoString, storage.getTimeZone());
  }

  function renderWorkoutEditForm(workout: WorkoutSession): string {
    const startVal = toLocalDatetimeValue(workout.startTime);
    const endVal = workout.endTime ? toLocalDatetimeValue(workout.endTime) : '';

    return `
    <div class="workout-edit-form card">
      <form id="workout-edit-form">
        <div class="form-group">
          <label class="label">Название</label>
          <input class="input" type="text" name="workoutName" placeholder="Название (опционально)" value="${escapeAttribute(workout.name || '')}">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="label">Начало</label>
            <input class="input" type="datetime-local" name="startTime" value="${escapeAttribute(startVal)}" required>
          </div>
          <div class="form-group">
            <label class="label">Конец</label>
            <input class="input" type="datetime-local" name="endTime" value="${escapeAttribute(endVal)}">
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

  function generateLogsListHtml(logs: PublicLog[], types: PublicWorkoutType[], isEditable: boolean, timeZone = storage.getTimeZone()) {
    if (logs.length === 0) return '<p class="hint">Нет записей за этот период</p>';

    const logsByDay = new Map<string, PublicLog[]>();
    // Sort logs by date descending
    [...logs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).forEach(log => {
      const dateKey = dayKey(log.date, timeZone);
      if (!logsByDay.has(dateKey)) logsByDay.set(dateKey, []);
      logsByDay.get(dateKey)!.push(log);
    });

    const workouts = isEditable ? storage.getWorkouts() : [];
    let html = '';

    logsByDay.forEach((dayLogs, dayDateStr) => {
      const dateLabel = dayLabel(dayDateStr);

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
      const singleWorkoutDuration = singleWorkout ? formatDuration(storage.getWorkoutDuration(singleWorkout) * 60) : 0;

      html += `<div class="log-day">`;
      html += `<div class="log-day__header">
      <span>${escapeHtml(dateLabel)}${showNameInHeader ? ` • ${escapeHtml(singleWorkout.name || '')}` : ''}${singleWorkout ? ` • ${escapeHtml(singleWorkoutDuration)}` : ''}</span>
      <div class="log-day__header-actions">
        ${isEditable && singleWorkout ? `<button class="workout-header__edit" data-workout-id="${escapeAttribute(singleWorkout.id)}" title="Редактировать тренировку">✏️</button>` : ''}
        ${isEditable ? `<button class="share-btn" data-date="${escapeAttribute(dayDateStr)}" title="Поделиться">📤</button>` : ''}
      </div>
    </div>`;

      // Inline edit form for single workout
      if (isEditable && singleWorkout && state.editingWorkoutId === singleWorkout.id) {
        html += renderWorkoutEditForm(singleWorkout);
      }

      // Render each workout group
      sortedWorkoutIds.forEach(workoutId => {
        const workout = workouts.find(w => w.id === workoutId);
        const workoutLogs = dayLogs.filter(l => l.workoutId === workoutId);

        const hideSubheader = sortedWorkoutIds.length === 1 && (showNameInHeader || !workout?.name);

        if (!hideSubheader) {
          const duration = workout ? formatDuration(storage.getWorkoutDuration(workout) * 60) : 0;

          html += `<h3 class="workout-subheader">
                <span>${escapeHtml(workout?.name || 'Тренировка')}</span>
                <div class="workout-subheader__actions">
                  <span class="workout-subheader__time">${escapeHtml(duration)}</span>
                  ${isEditable && workout ? `<button class="workout-header__edit" data-workout-id="${escapeAttribute(workout.id)}" title="Редактировать тренировку">✏️</button>` : ''}
                </div>
            </h3>`;

          // Inline edit form for multi-workout subheader
          if (isEditable && workout && state.editingWorkoutId === workout.id) {
            html += renderWorkoutEditForm(workout);
          }
        }

        // Group by exercise within workout
        const exerciseGroups: Map<string, PublicLog[]> = new Map();
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
              <div class="log-exercise__name" data-type-id="${escapeAttribute(type?.id || '')}" style="cursor: pointer;">${escapeHtml(type?.name || 'Удалено')}</div>
              <div class="log-exercise__sets">
                ${sets.map(set => `
                  <div class="log-set ${set.id === state.editingLogId ? 'log-set_active-edit' : ''} ${set.id === state.lastAddedLogId ? 'log-set_new' : ''}" data-id="${escapeAttribute(set.id)}" style="cursor: pointer;">
                    <div class="log-set__info">
                      ${set.weight !== undefined && set.reps !== undefined ? `
                        <span class="log-set__weight">${escapeHtml(set.weight)} кг</span>
                        <span class="log-set__times">×</span>
                        <span class="log-set__reps">${escapeHtml(set.reps)}</span>
                      ` : `
                        <span class="log-set__reps">⏱ ${escapeHtml(set.duration || 0)} мин${set.durationSeconds ? ` ${escapeHtml(set.durationSeconds)} сек` : ''}</span>
                      `}
                    </div>
                    ${isEditable ? `
                    <div class="log-set__actions">
                      <button class="log-set__edit" data-id="${escapeAttribute(set.id)}">✏️</button>
                      <button class="log-set__delete" data-id="${escapeAttribute(set.id)}">×</button>
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
        const exerciseGroups: Map<string, PublicLog[]> = new Map();
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
              <div class="log-exercise__name" data-type-id="${escapeAttribute(type?.id || '')}" style="cursor: pointer;">${escapeHtml(type?.name || 'Удалено')}</div>
              <div class="log-exercise__sets">
                ${sets.map(set => `
                  <div class="log-set ${set.id === state.editingLogId ? 'log-set_active-edit' : ''} ${set.id === state.lastAddedLogId ? 'log-set_new' : ''}" data-id="${escapeAttribute(set.id)}" style="cursor: pointer;">
                    <div class="log-set__info">
                      ${set.weight !== undefined && set.reps !== undefined ? `
                        <span class="log-set__weight">${escapeHtml(set.weight)} кг</span>
                        <span class="log-set__times">×</span>
                        <span class="log-set__reps">${escapeHtml(set.reps)}</span>
                      ` : `
                        <span class="log-set__reps">⏱ ${escapeHtml(set.duration || 0)} мин${set.durationSeconds ? ` ${escapeHtml(set.durationSeconds)} сек` : ''}</span>
                      `}
                    </div>
                    ${isEditable ? `
                    <div class="log-set__actions">
                      <button class="log-set__edit" data-id="${escapeAttribute(set.id)}">✏️</button>
                      <button class="log-set__delete" data-id="${escapeAttribute(set.id)}">×</button>
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

  function updateWorkoutControls() {
    withFormDrafts(renderWorkoutControlUpdate);
  }

  function renderWorkoutControlUpdate() {
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

  function bindWorkoutControlEvents() {
    const startWorkoutBtn = document.getElementById('start-workout-btn');
    lifecycle.listen(startWorkoutBtn, 'click', () => {
      state.isStartingWorkout = true;
      updateWorkoutControls();
    });

    const cancelStartWorkoutBtn = document.getElementById('cancel-start-workout-btn');
    lifecycle.listen(cancelStartWorkoutBtn, 'click', () => {
      state.formDrafts?.clear('start-workout-form');
      state.isStartingWorkout = false;
      updateWorkoutControls();
    });

    const startWorkoutForm = document.getElementById('start-workout-form') as HTMLFormElement;
    lifecycle.listen(startWorkoutForm, 'submit', async (e) => {
      e.preventDefault();
      const saved = state.formDrafts?.checkpoint('start-workout-form');
      const formData = new FormData(startWorkoutForm);
      const name = formData.get('workoutName') as string;
      await storage.startWorkout(name);
      if (!saved?.()) return;
      state.isStartingWorkout = false;
      updateWorkoutControls();
    });

    const pauseWorkoutBtn = document.getElementById('pause-workout-btn');
    lifecycle.listen(pauseWorkoutBtn, 'click', async () => {
      await storage.pauseWorkout();
    });

    const resumeWorkoutBtn = document.getElementById('resume-workout-btn');
    lifecycle.listen(resumeWorkoutBtn, 'click', async () => {
      await storage.resumeWorkout();
    });

    const finishWorkoutBtn = document.getElementById('finish-workout-btn');
    lifecycle.listen(finishWorkoutBtn, 'click', async () => {
      if (confirm('Завершить тренировку?')) {
        await storage.finishWorkout();
      }
    });
  }

  function formatWorkoutForShare(dateStr: string): string {
    const allLogs = storage.getLogs();
    const types = storage.getWorkoutTypes();

    // Get logs for the specific date
    const dayLogs = allLogs.filter(log => dayKey(log.date, storage.getTimeZone()) === dateStr);
    if (dayLogs.length === 0) return '';

    // Format the date for display
    const dateLabel = dayLabel(dateStr);

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

    navigator.clipboard.writeText(text).then(() => {
      alert('Текст скопирован в буфер обмена');
    });
  }
  function bindEvents() {
    bindWorkoutControlEvents();
    const form = document.getElementById('log-form') as HTMLFormElement;
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
    updateFormVisibility();
    const typeaheadEl = form?.querySelector('[data-typeahead]');
    if (typeaheadEl) {
      registerTypeaheadItems(form, storage.getWorkoutTypes().map(t => ({ id: t.id, name: t.name })));
      bindTypeahead(form);
    }
    const typeSelect = document.getElementById('workout-type-select');
    lifecycle.listen(typeSelect, 'change', updateFormVisibility);
    lifecycle.listen(form, 'draftrestore', updateFormVisibility);
    lifecycle.listen(form, 'submit', e => { void submitLog(form, e); });
    const duplicateBtn = document.getElementById('duplicate-last-btn');
    lifecycle.listen(duplicateBtn, 'click', async () => {
      const logs = storage.getLogs();
      const lastLog = getLatestLog(logs);
      if (lastLog && storage.getWorkoutTypes().some(type => !type.isDeleted && type.id === lastLog.workoutTypeId)) {
        const newLog = await storage.addLog({
          workoutTypeId: lastLog.workoutTypeId,
          weight: lastLog.weight,
          reps: lastLog.reps,
          duration: lastLog.duration,
          durationSeconds: lastLog.durationSeconds
        });
        state.lastAddedLogId = newLog.id;
        // Use partial update instead of full render
        updateWeekView();
        state.lastAddedLogId = null;
      }
    });
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    lifecycle.listen(cancelEditBtn, 'click', () => {
      state.formDrafts?.clear('log-form');
      state.editingLogId = null;
      render();
    });
    bindLogItemEvents();
    const prevWeekBtn = document.getElementById('prev-week-btn');
    lifecycle.listen(prevWeekBtn, 'click', () => {
      state.currentWeekOffset++;
      updateWeekView();
    });
    const nextWeekBtn = document.getElementById('next-week-btn');
    lifecycle.listen(nextWeekBtn, 'click', () => {
      if (state.currentWeekOffset > 0) {
        state.currentWeekOffset--;
        updateWeekView();
      }
    });
    const calendarInput = document.getElementById('calendar-input') as HTMLInputElement;
    lifecycle.listen(calendarInput, 'change', () => {
      // Only process if value actually changed and is not empty
      if (!calendarInput.value || calendarInput.value === state.lastCalendarValue) {
        return;
      }
      state.lastCalendarValue = calendarInput.value;

      const selectedDate = new Date(calendarInput.value);
      const today = new Date(`${dayKey(Date.now(), storage.getTimeZone())}T00:00:00Z`);

      // Calculate the week offset for the selected date
      const diffTime = today.getTime() - selectedDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      state.currentWeekOffset = Math.max(0, Math.floor(diffDays / 7));

      // Use partial update instead of full render
      updateWeekView();
    });
    const filterToggle = document.getElementById('filter-toggle-input') as HTMLInputElement;
    lifecycle.listen(filterToggle, 'change', () => {
      state.isFilterEnabled = filterToggle.checked;
      updateWeekView();
    });
  }
  async function submitLog(form: HTMLFormElement, e: Event) {
    e.preventDefault();
    const saved = state.formDrafts?.checkpoint('log-form');
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

    if (state.editingLogId) {
      const logs = storage.getLogs();
      const existingLog = logs.find(l => l.id === state.editingLogId);
      if (existingLog) {
        const dateStr = formData.get('date') as string;
        let newDate = existingLog.date;
        try {
          if (dateStr) newDate = parseDatetimeValue(dateStr, storage.getTimeZone(), existingLog.date);
        } catch (error) { showToast((error as Error).message); return; }


        await storage.updateLog({
          ...existingLog,
          reps: undefined, weight: undefined, duration: undefined, durationSeconds: undefined,
          ...logData,
          date: newDate
        });
        if (!saved?.()) return;
        state.editingLogId = null;
        // Need full render to reset the form
        render();
      }
    } else {
      const newLog = await storage.addLog(logData);
      if (!saved?.()) return;
      state.lastAddedLogId = newLog.id;
      render();
      state.lastAddedLogId = null;
    }
  }

  return { sweep: lifecycle.sweep, render: renderMainPage, refresh: render, mount() { bindEvents(); manageWorkoutTimer(); }, dispose() { lifecycle.dispose(); if (workoutTimerInterval) clearInterval(workoutTimerInterval); workoutTimerInterval = null; }, generateLogsListHtml, submitLog, renderWorkoutEditForm, renderWorkoutControls };
}
