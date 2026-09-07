import { renderProfileStats } from '../../components/profile/ProfileStats';
import {
  type AppRoute
} from '../../router';
import { PublicProfileUnavailableError } from '../../storage/storage';
import { PublicProfileData } from '../../types';
import { escapeAttribute, escapeHtml, renderSafeAvatarMarkup, sanitizeUrl } from '../../utils/safe-html';
import { getTrainingActivity } from '../../utils/training-activity';
import { accountTimeZone, dayLabel } from '../../utils/training-time';
import type { PageContext } from '../context';
import { createLifecycle } from '../lifecycle';
export function createPublicPage(context: PageContext) {
  const { state, dependencies } = context;
  const { storage, getCurrentUser } = dependencies;
  const { render, showToast, generateLogsListHtml } = context.actions;
  const lifecycle = createLifecycle();
  function clearPublicProfileState() {
    state.loadedPublicProfile = null;
    state.loadedPublicProfileIdentifier = null;
    state.profileLoadFailed = false;
    state.publicProfileLoadError = null;
  }

  function shouldReloadPublicProfile(route: AppRoute) {
    return (
      route.name === 'public-profile' && (
        state.loadedPublicProfileIdentifier !== route.identifier ||
        state.loadedPublicProfile === null ||
        state.profileLoadFailed
      )
    );
  }

  async function loadPublicProfile(identifier: string) {
    const requestId = ++state.publicProfileRequestId;
    state.loadedPublicProfile = null;
    state.loadedPublicProfileIdentifier = identifier;
    state.profileLoadFailed = false;
    state.publicProfileLoadError = null;
    render();

    let profile: PublicProfileData | null;
    try {
      profile = await storage.getPublicProfile(identifier);
    } catch (error) {
      if (requestId === state.publicProfileRequestId && state.currentRoute.name === 'public-profile' &&
        state.currentRoute.identifier === identifier && error instanceof PublicProfileUnavailableError) {
        state.publicProfileLoadError = error.message;
        render();
      }
      return;
    }
    if (requestId !== state.publicProfileRequestId) {
      return;
    }

    if (state.currentRoute.name !== 'public-profile' || state.currentRoute.identifier !== identifier) {
      return;
    }

    state.loadedPublicProfile = profile;
    state.profileLoadFailed = !profile;
    render();
  }

  function renderPublicProfilePage() {
    if (state.currentRoute.name !== 'public-profile') {
      return `
      <div class="page-content">
        <div class="profile-not-found">
          <div class="profile-not-found-icon">🔍</div>
          <div class="profile-not-found-text">Профиль не найден</div>
        </div>
      </div>
    `;
    }

    if (!state.loadedPublicProfile) {
      if (state.publicProfileLoadError) return `<div class="page-content"><p role="alert">${escapeHtml(state.publicProfileLoadError)}</p>
      <button class="button button_secondary" id="public-profile-retry">Повторить</button></div>`;
      if (state.profileLoadFailed) {
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

    const profile = state.loadedPublicProfile;
    const safeDisplayName = escapeHtml(profile.displayName);
    const safeIdentifier = escapeHtml(profile.identifier);
    const safeFriendIdentifier = escapeAttribute(profile.identifier);
    const safeFriendName = escapeAttribute(profile.displayName);
    const safeFriendPhoto = escapeAttribute(sanitizeUrl(profile.photoUrl) ?? '');
    return `
    <div class="page-content profile-page">
      ${profile.cacheMetadata?.cached ? `
        <div class="hint" style="margin-bottom:12px; padding:10px 12px; border-radius:12px; background:var(--surface-color-alt);">
          Оффлайн-копия от ${escapeHtml(new Date(profile.cacheMetadata.cachedAt).toLocaleString())}
        </div>
      ` : ''}
      <div class="profile-header">
        <div class="profile-avatar">
          ${renderSafeAvatarMarkup(profile.displayName, profile.photoUrl)}
        </div>
        <div class="profile-name">${safeDisplayName}</div>
        ${profile.identifier.startsWith('id_') ? '' : `<div class="profile-subtitle">@${safeIdentifier}</div>`}
	        ${(function() {
        if (!getCurrentUser()) return '';
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

      ${(function() {
        const logDates = profile.logs ? new Set(getTrainingActivity(profile.logs, accountTimeZone(profile.timeZone)).keys()) : new Set<string>();
        return renderProfileStats(profile.stats, logDates, accountTimeZone(profile.timeZone));
      })()}

      ${profile.recentActivity.length > 0 ? `
        <div class="activity-list">
          <h2 class="subtitle">Недавняя активность</h2>
          ${profile.recentActivity.map(a => `
            <div class="activity-item">
              <span class="activity-date">${escapeHtml(dayLabel(a.date))}</span>
              <span class="activity-count">${escapeHtml(a.exerciseCount)} упражнений</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${profile.logs && profile.logs.length > 0 && profile.workoutTypes ? `
        <div class="recent-logs">
          <h2 class="subtitle">История тренировок</h2>
          <div id="logs-list">
            ${generateLogsListHtml(profile.logs, profile.workoutTypes, false, accountTimeZone(profile.timeZone))}
          </div>
        </div>
      ` : ''}
    </div>
  `;
  }
  function bindEvents() {
    lifecycle.listen(document.getElementById('public-profile-retry'), 'click', () => {
      if (state.currentRoute.name === 'public-profile') void loadPublicProfile(state.currentRoute.identifier);
    });
    const friendBtn = document.getElementById('friend-action-btn');
    lifecycle.listen(friendBtn, 'click', async () => {
      const id = friendBtn?.getAttribute('data-id');
      const name = friendBtn?.getAttribute('data-name');
      const photo = friendBtn?.getAttribute('data-photo');

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
  return { sweep: lifecycle.sweep, render: renderPublicProfilePage, refresh: render, mount: bindEvents, dispose: () => lifecycle.dispose(), loadPublicProfile, shouldReloadPublicProfile, clearPublicProfileState };
}
