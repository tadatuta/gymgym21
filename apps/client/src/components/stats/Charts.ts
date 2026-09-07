import { dayKey, dayLabel } from '../../utils/training-time';
import { sessionDurationSeconds, formatDuration } from '../../utils/duration';
import { escapeHtml, escapeAttribute } from '../../utils/safe-html';
import { WorkoutSet, WorkoutSession } from '../../types';

/**
 * Renders a bar chart for total volume per workout session.
 */
export function renderVolumeChart(logs: WorkoutSet[], timeZone = 'UTC'): string {
    // Group volume by date
    const volumeByDate = new Map<string, number>();
    logs.forEach(log => {
        const date = dayKey(log.date, timeZone);
        const vol = (log.weight || 0) * (log.reps || 0);
        volumeByDate.set(date, (volumeByDate.get(date) || 0) + vol);
    });

    // Sort dates and take last 10 entries for readability
    const sortedDates = Array.from(volumeByDate.keys()).sort().slice(-10);
    if (sortedDates.length < 2) return '<p class="hint">Недостаточно данных для графика объема</p>';

    const dataPoints = sortedDates.map(date => ({
        label: dayLabel(date, { day: 'numeric', month: 'short' }),
        value: volumeByDate.get(date)!
    }));

    return renderBarChart(dataPoints, 'кг');
}

/**
 * Renders a line chart for 1RM progress.
 */
export function render1RMChart(data: Map<string, number>): string {
    const sortedDates = Array.from(data.keys()).sort();
    if (sortedDates.length < 2) return '<p class="hint">Недостаточно данных для графика 1RM</p>';

    const dataPoints = sortedDates.map(date => ({
        label: dayLabel(date, { day: 'numeric', month: 'short' }),
        value: data.get(date)!
    }));

    return renderLineChart(dataPoints, 'кг');
}

/**
 * Renders a line chart for workout duration trends.
 */
export function renderDurationChart(sessions: WorkoutSession[], logs: WorkoutSet[] = [], timeZone = 'UTC'): string {
    const finishedSessions = sessions
        .filter(s => !s.isDeleted && s.status === 'finished' && s.endTime)
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
        .slice(-10);

    if (finishedSessions.length < 2) return '<p class="hint">Недостаточно данных для графика продолжительности</p>';

    const dataPoints = finishedSessions.map(s => {
        const seconds = sessionDurationSeconds(s, logs);
        return { label: dayLabel(dayKey(s.startTime, timeZone), { day: 'numeric', month: 'short' }), value: seconds, formatted: formatDuration(seconds) };

    });

    return renderLineChart(dataPoints, '', formatDuration);
}

// --- Generic Chart Renderers (SVG) ---

interface DataPoint {
    label: string;
    value: number;
    formatted?: string;
}

function renderBarChart(data: DataPoint[], unit: string): string {
    const height = 150;
    const width = 100; // percent
    const maxVal = Math.max(...data.map(d => d.value)) * 1.1; // +10% padding

    const bars = data.map((d, i) => {
        const barHeight = (d.value / maxVal) * 100;
        const x = (i / data.length) * 100;
        const barWidth = (1 / data.length) * 80; // 80% of allocated slot width

        return `
            <rect x="${escapeAttribute(x + 5)}%" y="${escapeAttribute(100 - barHeight)}%" width="${escapeAttribute(barWidth)}%" height="${escapeAttribute(barHeight)}%" fill="var(--color-button)" rx="2" opacity="0.8">
               <title>${escapeHtml(d.label)}: ${escapeHtml(d.formatted ?? d.value)}${escapeHtml(unit)}</title>
            </rect>
            <text x="${escapeAttribute(x + 5 + barWidth / 2)}%" y="95%" font-size="10" text-anchor="middle" fill="var(--color-text)" style="pointer-events: none;">
                ${escapeHtml(d.label)}
            </text>
        `;
    }).join('');

    return `
        <svg width="${escapeAttribute(width)}%" height="${escapeAttribute(height)}" preserveAspectRatio="none">
            ${bars}
        </svg>
    `;
}

function renderLineChart(data: DataPoint[], unit: string, format = (value: number) => String(Math.round(value))): string {
    const height = 150;
    // We'll use fixed viewBox width for simplicity of point calculation, then scale via CSS
    const vbWidth = 400;
    const padding = 20;

    const values = data.map(d => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    // Helper to get coords
    const getX = (i: number) => padding + (i / (data.length - 1)) * (vbWidth - 2 * padding);
    const getY = (val: number) => height - padding - ((val - min) / range) * (height - 2 * padding);

    const points = data.map((d, i) => `${getX(i)},${getY(d.value)}`).join(' ');

    const circles = data.map((d, i) => `
        <circle cx="${escapeAttribute(getX(i))}" cy="${escapeAttribute(getY(d.value))}" r="4" fill="var(--color-bg)" stroke="var(--color-button)" stroke-width="2">
            <title>${escapeHtml(d.label)}: ${escapeHtml(d.formatted ?? d.value)}${escapeHtml(unit)}</title>
        </circle>
    `).join('');

    return `
        <svg viewBox="0 0 ${escapeAttribute(vbWidth)} ${escapeAttribute(height)}" class="chart">
             <polyline
                fill="none"
                stroke="var(--color-button)"
                stroke-width="3"
                stroke-linejoin="round"
                stroke-linecap="round"
                points="${escapeAttribute(points)}"
            />
            ${circles}
        </svg>
        <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px; color: var(--color-hint);">
            <span>${escapeHtml(format(min))}${escapeHtml(unit)}</span>
            <span>${escapeHtml(format(max))}${escapeHtml(unit)}</span>
        </div>
    `;
}
