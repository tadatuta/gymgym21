import { AppData, WorkoutSet } from '../types';
import { accountTimeZone, dayKey, dayLabel } from './training-time';
import { formatDuration } from './duration';

export function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function generateMarkdown(data: AppData): string {
    const { profile, workoutTypes, workouts, logs } = data;
    const lines: string[] = [];
    const timeZone = accountTimeZone(profile?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    const dateLabel = (date: string) => dayLabel(dayKey(date, timeZone), { year: 'numeric', month: '2-digit', day: '2-digit' });

    // 1. Header & Profile
    lines.push(`# История тренировок`);
    if (profile) {
        lines.push(`\n## Профиль`);
        lines.push(`- **Имя:** ${profile.displayName || 'Не указано'}`);
        if (profile.telegramUsername) lines.push(`- **Username:** @${profile.telegramUsername}`);
        lines.push(`- **ID:** ${profile.id}`);
        lines.push(`- **Дата регистрации:** ${dateLabel(profile.createdAt)}`);
    }

    // 2. Workout Types
    lines.push(`\n## Типы упражнений`);
    const activeTypes = workoutTypes.filter(t => !t.isDeleted);
    if (activeTypes.length > 0) {
        activeTypes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach(type => {
            lines.push(`- ${type.name} (${type.category === 'time' ? 'На время' : 'Силовое'})`);
        });
    } else {
        lines.push(`_Нет активных типов упражнений_`);
    }

    // 3. History
    lines.push(`\n## История`);

    if (!logs.some(log => !log.isDeleted)) {
        lines.push(`_История пуста_`);
        return lines.join('\n');
    }

    // Group logs by date
    const logsByDay = new Map<string, WorkoutSet[]>();
    const sortedLogs = [...logs].filter(l => !l.isDeleted).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    sortedLogs.forEach(log => {
        const dateKey = dayKey(log.date, timeZone);
        if (!logsByDay.has(dateKey)) logsByDay.set(dateKey, []);
        logsByDay.get(dateKey)!.push(log);
    });

    logsByDay.forEach((dayLogs, dateLabel) => {
        lines.push(`\n### ${dayLabel(dateLabel, { year: 'numeric', month: '2-digit', day: '2-digit' })}`);

        // Group by workout within the day
        const dayWorkoutIds = Array.from(new Set(dayLogs.map(l => l.workoutId || '')));


        dayWorkoutIds.forEach(workoutId => {
            const workout = workouts.find(w => w.id === workoutId);
            const workoutLogs = dayLogs.filter(l => (l.workoutId || '') === workoutId);

            lines.push(`\n#### ${workout?.name || (workout ? 'Тренировка' : workoutId ? 'Неизвестная тренировка' : 'Без тренировки')}`);

            // Group by exercise type
            const exerciseGroups = new Map<string, WorkoutSet[]>();
            workoutLogs.forEach(log => {
                if (!exerciseGroups.has(log.workoutTypeId)) {
                    exerciseGroups.set(log.workoutTypeId, []);
                }
                exerciseGroups.get(log.workoutTypeId)!.push(log);
            });

            exerciseGroups.forEach((sets, typeId) => {
                const type = workoutTypes.find(t => t.id === typeId);
                const typeName = type?.name || 'Неизвестное упражнение';
                lines.push(`- **${typeName}**: ${sets.map(s => formatSet(s)).join(', ')}`);
            });
        });
    });

    return lines.join('\n');
}

function formatSet(set: WorkoutSet): string {
    if (set.duration !== undefined || set.durationSeconds !== undefined) {
        return formatDuration((set.duration ?? 0) * 60 + (set.durationSeconds ?? 0));
    }
    return `${set.weight}кг × ${set.reps}`;
}
