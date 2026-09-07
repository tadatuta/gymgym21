import Sortable from 'sortablejs';
import { escapeAttribute, escapeHtml } from '../../utils/safe-html';
import type { PageContext } from '../context';
import { createLifecycle } from '../lifecycle';
export function createSettingsPage(context: PageContext) {
  const { state, dependencies } = context;
  const { storage } = dependencies;
  const { withFormDrafts } = context.actions;
  const lifecycle = createLifecycle();
  function renderSettingsPage() {
    const types = storage.getWorkoutTypes();
    const editingType = state.editingTypeId ? types.find(t => t.id === state.editingTypeId) : null;

    return `
    <div class="page-content">
      <div class="settings-section">
        <h2 class="subtitle">${state.editingTypeId ? 'Редактирование типа' : 'Добавить тип тренировки'}</h2>
        <form class="add-type-form" id="add-type-form" style="margin-bottom: 24px;">
          <div style="display: flex; gap: 8px; flex-direction: column;">
            <input class="input" type="text" id="new-type-name" placeholder="Название (напр. Жим гантелей)" required value="${escapeAttribute(editingType ? editingType.name : '')}">

            <div class="category-switch" style="display: flex; gap: 12px; margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 4px;">
                    <input type="radio" name="new-type-category" value="strength" ${!editingType || editingType.category !== 'time' ? 'checked' : ''}>
                    Силовая
                </label>
                <label style="display: flex; align-items: center; gap: 4px;">
                    <input type="radio" name="new-type-category" value="time" ${editingType && editingType.category === 'time' ? 'checked' : ''}>
                    На время
                </label>
            </div>

            <button class="button" type="submit">${state.editingTypeId ? 'Сохранить' : 'Добавить'}</button>
          </div>
          ${state.editingTypeId ? `<button class="button button_secondary" type="button" id="cancel-edit-type-btn" style="margin-top: 8px; width: 100%;">Отмена</button>` : ''}
        </form>

        <h2 class="subtitle">Типы тренировок</h2>
        <div class="type-list" id="workout-type-list">
          ${types.map(t => `
            <div class="type-item" data-id="${escapeAttribute(t.id)}">
              <span class="drag-handle" style="cursor: grab; margin-right: 12px; opacity: 0.5;">⋮⋮</span>
              <span style="flex-grow: 1;">${escapeHtml(t.name)}</span>
              <div style="display: flex; gap: 8px;">
                <button class="type-item__edit icon-btn" data-id="${escapeAttribute(t.id)}" title="Редактировать">✏️</button>
                <button class="type-item__delete icon-btn" data-id="${escapeAttribute(t.id)}" title="Удалить">×</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  }

  function updateSettingsTypeList() {
    withFormDrafts(renderSettingsTypeUpdate);
  }

  function renderSettingsTypeUpdate() {
    const content = document.querySelector('.content');
    if (!content) return;
    lifecycle.dispose();
    content.innerHTML = renderSettingsPage();
    bindSettingsPageEvents();
  }

  function bindSettingsPageEvents() {
    lifecycle.dispose();
    const form = document.getElementById('add-type-form') as HTMLFormElement;
    lifecycle.listen(form, 'submit', async (e) => {
      e.preventDefault();
      const saved = state.formDrafts?.checkpoint('add-type-form');
      const input = document.getElementById('new-type-name') as HTMLInputElement;
      const category = (document.querySelector('input[name="new-type-category"]:checked') as HTMLInputElement)?.value as 'strength' | 'time' || 'strength';
      if (input.value) {
        if (state.editingTypeId) {
          await storage.updateWorkoutType(state.editingTypeId, input.value, category);
          if (!saved?.()) return;
          state.editingTypeId = null;
        } else {
          await storage.addWorkoutType(input.value, category);
          if (!saved?.()) return;
        }
        updateSettingsTypeList();
      }
    });

    const cancelEditBtn = document.getElementById('cancel-edit-type-btn');
    lifecycle.listen(cancelEditBtn, 'click', () => {
      state.formDrafts?.clear('add-type-form');
      state.editingTypeId = null;
      updateSettingsTypeList();
    });

    document.querySelectorAll('.type-item__edit').forEach(btn => {
      lifecycle.listen(btn, 'click', () => {
        state.formDrafts?.clear('add-type-form');
        state.editingTypeId = btn.getAttribute('data-id');
        updateSettingsTypeList();
        const input = document.getElementById('new-type-name') as HTMLInputElement;
        input?.focus();
      });
    });

    document.querySelectorAll('.type-item__delete').forEach(btn => {
      lifecycle.listen(btn, 'click', async () => {
        const id = btn.getAttribute('data-id');
        if (id && confirm('Удалить этот тип тренировки?')) {
          if (state.editingTypeId === id) {
            state.formDrafts?.clear('add-type-form');
            state.editingTypeId = null;
          }
          await storage.deleteWorkoutType(id);
          updateSettingsTypeList();
        }
      });
    });

    // Sortable for type list
    const typeList = document.getElementById('workout-type-list');
    if (typeList) {
      let active = true;
      const sortable = Sortable.create(typeList, {
        animation: 150,
        handle: '.drag-handle',
        onEnd: async () => {
          if (!active || !typeList.isConnected) return;
          const newOrder = Array.from(typeList.children).map(child => child.getAttribute('data-id') || '').filter(Boolean);
          await storage.updateWorkoutTypeOrder(newOrder);
        }
      });
      lifecycle.own(typeList, () => {
        active = false;
        sortable.destroy();
      });
    }
  }
  function bindEvents() {
    bindSettingsPageEvents();
  }
  return { sweep: lifecycle.sweep, render: renderSettingsPage, refresh: updateSettingsTypeList, mount: bindEvents, dispose: () => lifecycle.dispose() };
}
