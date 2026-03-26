import { createHmac, createHash } from 'node:crypto';
import { config } from './config.js';

export interface TelegramUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    photo_url?: string;
    language_code?: string;
    is_premium?: boolean;
    allows_write_to_pm?: boolean;
}

export function parseTelegramInitData(initData: string): { user?: TelegramUser } {
    const urlParams = new URLSearchParams(initData);

    // Try Login Widget format (flat fields)
    if (urlParams.has('id')) {
        const id = parseInt(urlParams.get('id') || '0', 10);
        if (id) {
            return {
                user: {
                    id,
                    first_name: urlParams.get('first_name') || '',
                    last_name: urlParams.get('last_name') || undefined,
                    username: urlParams.get('username') || undefined,
                    photo_url: urlParams.get('photo_url') || undefined,
                }
            };
        }
    }

    return {};
}

export function validateTelegramInitData(initData: string): boolean {
    if (!config.TELEGRAM_BOT_TOKEN) return false;

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    const authDate = urlParams.get('auth_date');

    if (!hash || !authDate) return false;

    // 1. Security: Check expiration (24 hours)
    const authTimestamp = parseInt(authDate, 10);
    const nowTimestamp = Math.floor(Date.now() / 1000);
    // Allow for some clock skew (e.g. 5 min future) and 24h past
    if (isNaN(authTimestamp) || (nowTimestamp - authTimestamp) > 86400 || (authTimestamp - nowTimestamp) > 300) {
        return false;
    }

    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    // Verify Login Widget method (SHA256 of token as secret)
    const secretKeyWidget = createHash('sha256')
        .update(config.TELEGRAM_BOT_TOKEN)
        .digest();

    const calculatedHashWidget = createHmac('sha256', secretKeyWidget)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHashWidget === hash) return true;

    return false;
}
