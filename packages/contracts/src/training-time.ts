/** Legacy accounts use UTC until the owner selects a time zone. */
export function validTimeZone(value: string): boolean {
    if (!value || /^[+-]/.test(value)) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
export function accountTimeZone(value?: string): string {
    return value && validTimeZone(value) ? value : 'UTC';
}
export function dayKey(instant: string | number | Date, timeZone = 'UTC'): string {
    const date = new Date(instant);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en', { timeZone: accountTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}
export function dayLabel(key: string, options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }): string {
    return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}
