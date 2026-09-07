import type { AppRoute } from '../router';
import type { PublicLog, PublicWorkoutType } from '@gym21/contracts';
import type { UiDependencies } from './dependencies';
import type { UiState } from './state';

/** Shared account/route state and explicit calls back into the application shell.
 * Page modules never import the application or another page instance. */
export interface PageContext {
  state: UiState;
  dependencies: UiDependencies;
  actions: {
    render(): void;
    navigate(route: AppRoute, options?: { replace?: boolean }): void;
    showToast(message: string): void;
    withFormDrafts(update: () => void): void;
    bindRouteLinks(root?: ParentNode): void;
    generateLogsListHtml(logs: PublicLog[], types: PublicWorkoutType[], editable: boolean, timeZone?: string): string;
    getPreferredDisplayName(value?: string): string;
    loadPublicProfile(identifier: string): Promise<void>;
  };
}
