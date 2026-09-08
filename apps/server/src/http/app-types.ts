import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AIRequest } from '../ai.js';
import type { AuthenticatedRequestContext } from '../auth.js';
import type { PublicProfileData, StorageRepository } from '../storage.js';

export type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface AppDependencies {
  rateLimitStore?: import('./middleware/rate-limit-store.js').RateLimitStore;
  isReady?: () => Promise<boolean>;
  authHandler: NodeRequestHandler;
  resolveRequestContext: (headers: Headers) => Promise<AuthenticatedRequestContext | null>;
  generateRecommendation: (request: AIRequest, signal?: AbortSignal) => Promise<string>;
  findPublicProfile: (identifier: string, cursor?: string) => Promise<PublicProfileData | null>;
  storageRepository: StorageRepository;
}
