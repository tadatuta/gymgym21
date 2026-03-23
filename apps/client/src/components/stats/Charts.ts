import { WorkoutSet, WorkoutSession } from '../../types';

/**
 * Renders a bar chart for total volume per workout session.
 */
export function renderVolumeChart(logs: WorkoutSet[]): string {
    // Group volume by date
    const volumeByDate = new Map<string, number>();
    logs.forEach(log => {
        const date = log.date.split('T')[0];
        const vol = (log.weight || 0) * (log.reps || 0);
        volumeByDate.set(date, (volumeByDate.get(date) || 0) + vol);
    });

    // Sort dates and take last 10 entries for readability
    const sortedDates = Array.from(volumeByDate.keys()).sort().slice(-10);
    if (sortedDates.length < 2) return '<p class="hint">Недостаточно данных для графика объема</p>';

    const dataPoints = sortedDates.map(date => ({
        label: new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
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
        label: new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        value: data.get(date)!
    }));

    return renderLineChart(dataPoints, 'кг');
}

/**
 * Renders a line chart for workout duration trends.
 */
export function renderDurationChart(sessions: WorkoutSession[]): string {
    const finishedSessions = sessions
        .filter(s => s.status === 'finished' && s.endTime)
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
        .slice(-10);

    if (finishedSessions.length < 2) return '<p class="hint">Недостаточно данных для графика продолжительности</p>';

    const dataPoints = finishedSessions.map(s => {
        const start = new Date(s.startTime).getTime();
        const end = new Date(s.endTime!).getTime();
        let durationMin = (end - start) / 1000 / 60;

        // Adjust for pauses
        if (s.pauseIntervals) {
            s.pauseIntervals.forEach(p => {
                const pStart = new Date(p.start).getTime();
                const pEnd = p.end ? new Date(p.end).getTime() : end;
                durationMin -= (pEnd - pStart) / 1000 / 60;
            });
        }

        return {
            label: new Date(s.startTime).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
            value: Math.round(durationMin)
        };
    });

    return renderLineChart(dataPoints, 'мин');
}

// --- Generic Chart Renderers (SVG) ---

interface DataPoint {
    label: string;
    value: number;
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
            <rect x="${x + 5}%" y="${100 - barHeight}%" width="${barWidth}%" height="${barHeight}%" fill="var(--color-button)" rx="2" opacity="0.8">
               <title>${d.label}: ${d.value}${unit}</title>
            </rect>
            <text x="${x + 5 + barWidth / 2}%" y="95%" font-size="10" text-anchor="middle" fill="var(--color-text)" style="pointer-events: none;">
                ${d.label}
            </text>
        `;
    }).join('');

    return `
        <svg width="${width}%" height="${height}" preserveAspectRatio="none">
            ${bars}
        </svg>
    `;
}

function renderLineChart(data: DataPoint[], unit: string): string {
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
        <circle cx="${getX(i)}" cy="${getY(d.value)}" r="4" fill="var(--color-bg)" stroke="var(--color-button)" stroke-width="2">
            <title>${d.label}: ${d.value}${unit}</title>
        </circle>
    `).join('');

    return `
        <svg viewBox="0 0 ${vbWidth} ${height}" class="chart">
             <polyline
                fill="none"
                stroke="var(--color-button)"
                stroke-width="3"
                stroke-linejoin="round"
                stroke-linecap="round"
                points="${points}"
            />
            ${circles}
        </svg>
        <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px; color: var(--color-hint);">
            <span>${Math.round(min)}${unit}</span>
            <span>${Math.round(max)}${unit}</span>
        </div>
    `;
}
