export { validTimeZone, accountTimeZone, dayKey, dayLabel } from '@gym21/contracts/training-time';

/** datetime-local contains wall-clock minutes in the account zone, never the viewer zone. */
export function datetimeValue(instant: string, timeZone: string): string {
    const date = new Date(instant);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
export function parseDatetimeValue(value: string, timeZone: string, original?: string): string {
    // An unchanged ambiguous minute retains its original instant, seconds and milliseconds.
    if (original && datetimeValue(original, timeZone) === value) return original;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Некорректная дата');
    const wall = Date.parse(`${value}:00Z`);
    const candidates = new Set<number>();
    // Collect offsets on both sides of a possible DST transition, then verify every candidate.
    for (let hours = -36; hours <= 36; hours += 6) {
        const probe = wall + hours * 3600000;
        const offset = Date.parse(`${datetimeValue(new Date(probe).toISOString(), timeZone)}:00Z`) - probe;
        const candidate = wall - offset;
        if (datetimeValue(new Date(candidate).toISOString(), timeZone) === value) candidates.add(candidate);
    }
    if (candidates.size !== 1) throw new Error(candidates.size ? 'Это время повторяется при переводе часов. Выберите другое время.' : 'Такого времени нет при переводе часов. Выберите другое время.');
    const remainder = original ? ((Date.parse(original) % 60000) + 60000) % 60000 : 0;
    return new Date([...candidates][0] + remainder).toISOString();
}
