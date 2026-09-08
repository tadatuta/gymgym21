import {
  TelegramLoginData
} from '../../auth';
import { renderProfileStats } from '../../components/profile/ProfileStats';
import { buildUrl } from '../../router';
import { ProfileStats } from '../../types';
import { downloadFile, generateMarkdown } from '../../utils/export';
import { escapeAttribute, escapeHtml, renderSafeAvatarMarkup, replaceAvatarContent } from '../../utils/safe-html';
import { replaceMarkdownContent } from '../../utils/safe-markdown';
import { getTrainingActivity } from '../../utils/training-activity';
import { validTimeZone } from '../../utils/training-time';
import type { PageContext } from '../context';
import { createLifecycle } from '../lifecycle';
import type { AiRecommendationType } from '../state';
export function createProfilePage(context: PageContext) {
  const { state, dependencies } = context;
  const { storage, addPasskey, canUsePasskeyInCurrentContext, getCurrentUser, getMigrationStatus, hasVerifiedOnlineAccount, linkTelegramAccount, openBrowserHandoff, serializeTelegramLoginData, signOut, TELEGRAM_BOT_NAME } = dependencies;
  const { showToast, withFormDrafts } = context.actions;
  const lifecycle = createLifecycle();
  let disposeTelegramLink: (() => void) | undefined;
  const getProfileLink = (identifier: string) => new URL(buildUrl({ name: 'public-profile', identifier }), window.location.origin).toString();
  function getAiResultContainerId(type: AiRecommendationType) {
    return type === 'general' ? 'ai-general-result' : 'ai-plan-result';
  }

  function renderAiResult(type: AiRecommendationType) {
    const container = document.getElementById(getAiResultContainerId(type));
    if (!container) {
      return;
    }

    const body = container.querySelector('.markdown-body');
    if (!body) {
      return;
    }

    const markdown = state.aiResults[type];
    container.style.display = markdown ? '' : 'none';
    replaceMarkdownContent(body, markdown);
  }

  function renderAiResults() {
    renderAiResult('general');
    renderAiResult('plan');
  }

  function updateAiResult(type: AiRecommendationType, result: string) {
    state.aiResults[type] = result;
    renderAiResult(type);
  }

  function getPreferredDisplayName(profileDisplayName?: string) {
    return profileDisplayName || getCurrentUser()?.name || '';
  }

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
    const onlineAccountVerified = hasVerifiedOnlineAccount(storage.getStorageKey());

    if (tab === 'public') {
      return `${profile?.friends && profile.friends.length > 0 ? `
      <div class="settings-section">
          <div class="settings-section-title">Друзья (${escapeHtml(profile.friends.length)})</div>
          <div class="friends-list">
              ${profile.friends.map((f) => `
                  <a
                    href="${escapeAttribute(getProfileLink(f.identifier))}"
                    class="friend-item"
                    data-route-kind="public-profile"
                    data-profile-identifier="${escapeAttribute(f.identifier)}"
                    style="display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-color); cursor: pointer; text-decoration: none; color: inherit;"
                  >
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
            <input type="checkbox" id="profile-public-toggle" aria-label="Публичный профиль" ${isPublic ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="form-followup toggle-row">
          <div class="toggle-label">
            <span class="toggle-label-text">Показывать все упражнения</span>
            <span class="toggle-label-hint">Подробный список упражнений в публичном профиле</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="profile-history-toggle" aria-label="Показывать все упражнения" ${profile?.showFullHistory ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="settings-section">
        <label class="label" for="profile-time-zone">Часовой пояс тренировок</label>
        <input class="input" id="profile-time-zone" value="${escapeAttribute(storage.getTimeZone())}" placeholder="Europe/Paris">
        <p class="hint">История и публичная статистика используют этот часовой пояс.</p>
        <label class="settings-section-title" for="profile-display-name">Имя</label>
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
        ${(function() {
          const logs = storage.getLogs();
          const workoutTypes = storage.getWorkoutTypes();

          // Calculate stats
          const totalVolume = logs.reduce((acc, l) => acc + ((l.weight || 0) * (l.reps || 0)), 0);
          const uniqueDaysSet = new Set(getTrainingActivity(logs, storage.getTimeZone()).keys());
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

          return renderProfileStats(stats, uniqueDaysSet, storage.getTimeZone());
        })()}
      </div>

      <button class="form-followup button" id="save-profile-btn">Сохранить</button>
    `;
    }

    if (tab === 'ai') {
      return `
      <div class="settings-section">
            <div class="settings-section-title">AI Рекомендации</div>
            ${onlineAccountVerified ? '' : '<p class="hint" style="margin-bottom:12px;">Оффлайн: сохранённые рекомендации доступны, генерация новых — после подключения.</p>'}

            <div class="form-stack ai-controls">
                <button class="button" id="ai-general-btn" ${state.aiLoadingState !== 'idle' || !onlineAccountVerified ? 'disabled' : ''}>
                    ${state.aiLoadingState === 'general' ? 'Анализ...' : '✨ Общий анализ'}
                </button>

                <div id="ai-general-result" class="ai-result" style="margin-top: 24px; background: var(--surface-color-alt); padding: 16px; border-radius: 12px; ${state.aiResults.general ? '' : 'display: none;'}">
                    <div class="markdown-body" style="font-family: inherit;"></div>
                </div>

                <div class="ai-plan-section">
                    <h3 class="workout-subheader" style="margin-bottom: 8px;">План тренировок</h3>
                    <div class="form-group">
                        <label class="label" for="ai-plan-period">Период плана</label>
                        <select class="select" id="ai-plan-period">
                            <option value="day">На сегодня</option>
                            <option value="week">На неделю</option>
                        </select>
                    </div>

                    <div class="form-followup toggle-row toggle-row--clean">
                      <div class="toggle-label">
                          <span class="toggle-label-text">Рекомендовать новые упражнения</span>
                      </div>
                      <label class="toggle-switch">
                          <input type="checkbox" id="ai-allow-new" aria-label="Разрешить новые упражнения">
                          <span class="toggle-slider"></span>
                      </label>
                    </div>
                    <button class="button" id="ai-plan-btn" ${state.aiLoadingState !== 'idle' || !onlineAccountVerified ? 'disabled' : ''} style="margin-top: 8px;">
                        ${state.aiLoadingState === 'plan' ? 'Генерация...' : '📅 Создать план'}
                    </button>

                    <div id="ai-plan-result" class="ai-result" style="margin-top: 12px; background: var(--surface-color-alt); padding: 16px; border-radius: 12px; ${state.aiResults.plan ? '' : 'display: none;'}">
                        <div class="markdown-body" style="font-family: inherit;"></div>
                    </div>
                </div>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Личные данные (Приватно)</div>
            <p class="hint" style="margin-bottom: 12px; font-size: 0.9em;">Эти данные используются только для персонализации советов от AI и не видны другим пользователям.</p>

            <div class="form-row">
              <div class="form-group">
                  <label class="label" for="profile-gender">Пол</label>
                  <select class="select" id="profile-gender">
                      <option value="" ${!profile?.gender ? 'selected' : ''}>Не указано</option>
                      <option value="male" ${profile?.gender === 'male' ? 'selected' : ''}>Мужской</option>
                      <option value="female" ${profile?.gender === 'female' ? 'selected' : ''}>Женский</option>
                  </select>
              </div>
              <div class="form-group">
                  <label class="label" for="profile-birthdate">Дата рождения</label>
                  <input class="input" type="date" id="profile-birthdate" value="${safeBirthDate}">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                  <label class="label" for="profile-height">Рост (см)</label>
                  <input class="input" type="number" id="profile-height" placeholder="180" value="${safeHeight}">
              </div>
              <div class="form-group">
                  <label class="label" for="profile-weight">Вес (кг)</label>
                  <input class="input" type="number" id="profile-weight" placeholder="75" value="${safeWeight}">
              </div>
            </div>

            <div class="form-group">
               <label class="label" for="profile-additional-info">Дополнительная информация</label>
               <textarea class="input" id="profile-additional-info" rows="3" placeholder="Укажите травмы, ограничения, цели или любую другую информацию, которая поможет AI давать более точные советы...">${safeAdditionalInfo}</textarea>
            </div>
            <button class="form-followup button" id="save-profile-btn">Сохранить</button>
        </div>
    `;
    }

    if (tab === 'data') {
      return `
      <div class="settings-section">
        <div class="settings-section-title">Аккаунт</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div><strong>Email:</strong> ${escapeHtml(getCurrentUser()?.email || '—')}</div>
          <div><strong>Username:</strong> ${escapeHtml(getCurrentUser()?.username || state.authStatus?.suggestedUsername || 'не задан')}</div>
          <div><strong>Telegram:</strong> ${state.authStatus?.hasTelegram ? 'подключен' : 'не подключен'}</div>
          <div><strong>Passkey:</strong> ${state.authStatus?.hasPasskey ? 'добавлен' : 'не добавлен'}</div>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px; margin-top:16px;">
          <button class="button button_secondary" id="add-passkey-btn" ${onlineAccountVerified ? '' : 'disabled'}>${canUsePasskeyInCurrentContext() ? 'Добавить Passkey' : 'Открыть браузер для Passkey'}</button>
          ${!onlineAccountVerified
          ? '<div class="hint">Изменение способов входа требует подключения к интернету.</div>'
          : state.authStatus?.hasTelegram
            ? '<div style="padding:12px 14px; border-radius:14px; background:var(--surface-color-alt); color:var(--text-color-secondary);">Telegram уже привязан к этому аккаунту.</div>'
            : '<div id="link-telegram-widget" style="display:flex; justify-content:center;"></div>'}
        </div>
      </div>

      ${storage.getConflicts().length > 0 ? `
        <div class="settings-section">
          <div class="settings-section-title">Конфликты синхронизации</div>
          <p class="hint" style="margin-bottom:12px;">
            Серверная версия уже применена. Можно вернуть локальное изменение поверх неё или оставить серверную.
          </p>
          <div style="display:flex; flex-direction:column; gap:10px;">
            ${storage.getConflicts().map((conflict) => `
              <div style="padding:12px; border-radius:12px; background:var(--surface-color-alt);">
                <div style="font-weight:600; margin-bottom:8px;">
                  ${escapeHtml(conflict.entityType)} · ${escapeHtml(conflict.entityId)}
                </div>
                <div class="form-actions">
                  <button class="form-actions__button button conflict-restore-btn" data-conflict-key="${escapeAttribute(conflict.key)}">
                    Вернуть локальное
                  </button>
                  <button class="form-actions__button button button_secondary conflict-dismiss-btn" data-conflict-key="${escapeAttribute(conflict.key)}">
                    Оставить серверное
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="settings-section">
        <div class="settings-section-title">Управление данными</div>
        <div class="form-stack">
          <button class="button button_secondary" id="export-json-btn">Экспорт JSON (Backup)</button>
          <button class="button button_secondary" id="export-md-btn">Экспорт Markdown</button>
          <button class="button button_secondary" id="import-json-btn">Импорт JSON</button>
          <label for="import-mode">Режим импорта</label>
          <select id="import-mode">
            <option value="merge">Объединить: обновить записи из файла, сохранить остальные</option>
            <option value="replace">Заменить: удалить отсутствующие в файле записи на всех устройствах (онлайн)</option>
          </select>
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
      <div class="profile-header" style="position: relative;">
        <div class="profile-avatar">
          ${renderSafeAvatarMarkup(displayName, profile?.photoUrl)}
        </div>
        <div class="profile-name">${safeDisplayName}</div>
        <div class="profile-subtitle">${isPublic ? 'Публичный профиль' : 'Приватный профиль'}</div>
        <button class="button button_secondary" id="sign-out-btn">Выйти</button>
      </div>

      <div class="stats-tabs">
        <button class="stats-tab profile-tab ${state.currentProfileTab === 'ai' ? 'active' : ''}" data-tab="ai">AI</button>
        <button class="stats-tab profile-tab ${state.currentProfileTab === 'public' ? 'active' : ''}" data-tab="public">Публичное</button>
        <button class="stats-tab profile-tab ${state.currentProfileTab === 'data' ? 'active' : ''}" data-tab="data">Данные</button>
      </div>

      <div class="profile-settings" id="profile-tab-content">
        ${renderProfileTabContent(state.currentProfileTab)}
      </div>
    </div>
  `;
  }

  function updateProfileTabContent() {
    withFormDrafts(renderProfileTabUpdate);
  }

  function renderProfileTabUpdate() {
    const container = document.getElementById('profile-tab-content');
    if (container) {
      container.innerHTML = renderProfileTabContent(state.currentProfileTab);
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
      tab.classList.toggle('active', tabId === state.currentProfileTab);
    });
  }

  function bindProfileSettingsEvents() {
    disposeTelegramLink?.();
    disposeTelegramLink = undefined;
    renderAiResults();

    document.querySelectorAll<HTMLElement>('.conflict-restore-btn').forEach((button) => {
      lifecycle.listen(button, 'click', async () => {
        const key = button.getAttribute('data-conflict-key');
        if (!key) return;
        await storage.restoreConflictLocal(key);
        showToast('Локальное изменение возвращено в очередь');
      });
    });

    document.querySelectorAll<HTMLElement>('.conflict-dismiss-btn').forEach((button) => {
      lifecycle.listen(button, 'click', async () => {
        const key = button.getAttribute('data-conflict-key');
        if (!key) return;
        await storage.dismissConflict(key);
      });
    });

    const saveBtn = document.getElementById('save-profile-btn');
    lifecycle.listen(saveBtn, 'click', async () => {
      const saved = state.formDrafts?.checkpoint('profile-tab-content', ['ai-plan-period', 'ai-allow-new']);
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
      const timeZoneInput = document.getElementById('profile-time-zone') as HTMLInputElement | null;
      if (timeZoneInput) {
        if (!validTimeZone(timeZoneInput.value)) { showToast('Укажите часовой пояс IANA, например Europe/Paris'); return; }
        updates.timeZone = timeZoneInput.value;
      }

      if (genderInput) updates.gender = genderInput.value || undefined;
      if (birthDateInput) updates.birthDate = birthDateInput.value || undefined;
      if (heightInput) updates.height = heightInput.value ? Number(heightInput.value) : undefined;
      if (weightInput) updates.weight = weightInput.value ? Number(weightInput.value) : undefined;
      if (additionalInfoInput) updates.additionalInfo = additionalInfoInput.value;

      await storage.updateProfileSettings(updates);
      if (saved?.()) updateProfileTabContent();
      showToast('Профиль сохранен');
    });

    // AI Buttons
    const aiGeneralBtn = document.getElementById('ai-general-btn') as HTMLButtonElement | null;
    const aiPlanBtn = document.getElementById('ai-plan-btn') as HTMLButtonElement | null;

    const setAiButtonsLoading = (loading: 'idle' | 'general' | 'plan') => {
      state.aiLoadingState = loading;
      if (aiGeneralBtn) {
        aiGeneralBtn.disabled = loading !== 'idle';
        aiGeneralBtn.textContent = loading === 'general' ? 'Анализ...' : '✨ Общий анализ';
      }
      if (aiPlanBtn) {
        aiPlanBtn.disabled = loading !== 'idle';
        aiPlanBtn.textContent = loading === 'plan' ? 'Генерация...' : '📅 Создать план';
      }
    };

    if (aiGeneralBtn) {
      lifecycle.listen(aiGeneralBtn, 'click', async () => {
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
      lifecycle.listen(aiPlanBtn, 'click', async () => {
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
    lifecycle.listen(copyBtn, 'click', () => {
      const identifier = storage.getProfileIdentifier();
      if (identifier) {
        const profileUrl = getProfileLink(identifier);
        navigator.clipboard.writeText(profileUrl).then(() => {
          showToast('Ссылка скопирована');
        });
      }
    });

    const shareBtn = document.getElementById('share-profile-link');
    lifecycle.listen(shareBtn, 'click', () => {
      const identifier = storage.getProfileIdentifier();
      if (identifier) {
        const profileUrl = getProfileLink(identifier);
        navigator.clipboard.writeText(profileUrl).then(() => {
          showToast('Ссылка скопирована');
        });
      }
    });

    lifecycle.listen(document.getElementById('add-passkey-btn'), 'click', async () => {
      try {
        if (!canUsePasskeyInCurrentContext()) {
          openBrowserHandoff();
          return;
        }

        await addPasskey('Gym Gym 21');
        state.authStatus = await getMigrationStatus();
        updateProfileTabContent();
        showToast('Passkey добавлен');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось добавить Passkey');
      }
    });



    const linkTelegramWidget = document.getElementById('link-telegram-widget');
    if (linkTelegramWidget) {
      const widgetWindow = window as typeof window & { onTelegramLinkBetter?: (user: TelegramLoginData) => void };
      const onTelegramLink = async (user: TelegramLoginData) => {
        if (!linkTelegramWidget.isConnected || widgetWindow.onTelegramLinkBetter !== onTelegramLink) return;
        try {
          await linkTelegramAccount(serializeTelegramLoginData(user));
          state.authStatus = await getMigrationStatus();
          await storage.sync();
          updateProfileTabContent();
          showToast('Telegram привязан');
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Не удалось привязать Telegram');
        }
      };

      widgetWindow.onTelegramLinkBetter = onTelegramLink;
      disposeTelegramLink = () => { if (widgetWindow.onTelegramLinkBetter === onTelegramLink) delete widgetWindow.onTelegramLinkBetter; };

      const script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.async = true;
      script.setAttribute('data-telegram-login', TELEGRAM_BOT_NAME);
      script.setAttribute('data-size', 'large');
      script.setAttribute('data-radius', '12');
      script.setAttribute('data-onauth', 'onTelegramLinkBetter(user)');
      script.setAttribute('data-request-access', 'write');
      linkTelegramWidget.appendChild(script);
    }

    // Export/Import Logic
    lifecycle.listen(document.getElementById('export-json-btn'), 'click', async () => {
      try {
        const data = await storage.exportBackup();
        const filename = `gym_backup_${new Date().toISOString().split('T')[0]}.json`;
        downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
        showToast('Экспорт выполнен');
      } catch (e) {
        console.error(e);
        showToast('Ошибка экспорта');
      }
    });

    lifecycle.listen(document.getElementById('export-md-btn'), 'click', async () => {
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

    lifecycle.listen(document.getElementById('import-json-btn'), 'click', () => {
      document.getElementById('import-file-input')?.click();
    });

    lifecycle.listen(document.getElementById('import-file-input'), 'change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const json = event.target?.result as string;
          const data = JSON.parse(json);

          const mode = (document.getElementById('import-mode') as HTMLSelectElement).value === 'replace' ? 'replace' : 'merge';
          if (mode === 'merge' || confirm('Заменить данные на всех устройствах? Записи, которых нет в файле, будут удалены. Записи с совпадающими ID будут перезаписаны.')) {
            await storage.importData(data, mode);
            showToast(navigator.onLine ? 'Данные импортированы' : 'Объединено локально. После подключения проверьте конфликты синхронизации');
            updateProfileTabContent();
          }
        } catch (err) {
          console.error(err);
          showToast(err instanceof Error ? err.message : 'Ошибка импорта');
        }
      };
      reader.readAsText(file);
      (e.target as HTMLInputElement).value = '';
    });
  }
  function bindEvents() {
    lifecycle.listen(document.getElementById('sign-out-btn'), 'click', async () => {
      try {
        await signOut();
        location.reload();
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось выйти');
      }
    });
    const tabs = document.querySelectorAll('.profile-tab');
    tabs.forEach(tab => {
      lifecycle.listen(tab, 'click', () => {
        const tabId = tab.getAttribute('data-tab');
        if (tabId === 'ai' || tabId === 'public' || tabId === 'data') {
          selectTab(tabId);
        }
      });
    });
    bindProfileSettingsEvents();
  }
  function selectTab(tab: 'ai' | 'public' | 'data') {
    state.currentProfileTab = tab;
    updateProfileTabContent();
  }

  return { sweep: lifecycle.sweep, render: renderProfileSettingsPage, refresh: updateProfileTabContent, mount: bindEvents, dispose() { lifecycle.dispose(); disposeTelegramLink?.(); disposeTelegramLink = undefined; }, getPreferredDisplayName, selectTab };
}
