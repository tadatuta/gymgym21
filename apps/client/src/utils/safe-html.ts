function getBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location?.href) {
        return window.location.href;
    }

    return 'https://localhost/';
}

export function escapeHtml(value: string | number | null | undefined): string {
    const input = value == null ? '' : String(value);

    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const escapeAttribute = escapeHtml;

export function sanitizeUrl(value: string | null | undefined, baseUrl = getBaseUrl()): string | null {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('//')) {
        return null;
    }

    try {
        const parsed = new URL(trimmed, baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }

        return parsed.toString();
    } catch {
        return null;
    }
}

export function getDisplayInitial(value: string | null | undefined): string {
    const trimmed = value?.trim();
    const initial = trimmed ? Array.from(trimmed)[0] : '';
    return (initial || '?').toUpperCase();
}

export function renderSafeAvatarMarkup(
    displayName: string | null | undefined,
    photoUrl: string | null | undefined,
    imageAttributes = 'class="profile-avatar-img"',
): string {
    const safeUrl = sanitizeUrl(photoUrl);
    if (!safeUrl) {
        return escapeHtml(getDisplayInitial(displayName));
    }

    return `<img src="${escapeAttribute(safeUrl)}" alt="${escapeAttribute(displayName)}" ${imageAttributes}>`;
}

export function replaceAvatarContent(
    container: Element,
    displayName: string | null | undefined,
    photoUrl: string | null | undefined,
    imageClassName = 'profile-avatar-img',
): void {
    container.replaceChildren();

    const safeUrl = sanitizeUrl(photoUrl);
    if (!safeUrl) {
        container.textContent = getDisplayInitial(displayName);
        return;
    }

    const img = container.ownerDocument.createElement('img');
    img.src = safeUrl;
    img.alt = displayName ?? '';
    img.className = imageClassName;
    container.append(img);
}
