import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AIRequest } from '../ai.js';
import type { AuthenticatedRequestContext } from '../auth.js';
import type { PublicProfileData, StorageData } from '../storage.js';

export type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface AppDependencies {
  authHandler: NodeRequestHandler;
  resolveRequestContext: (headers: Headers) => Promise<AuthenticatedRequestContext | null>;
  generateRecommendation: (request: AIRequest) => Promise<string>;
  findPublicProfile: (identifier: string) => Promise<PublicProfileData | null>;
  readStorage: (storageKey: string | number) => Promise<StorageData>;
  writeStorage: (storageKey: string | number, data: StorageData) => Promise<void>;
}
