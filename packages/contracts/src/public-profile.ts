import { z } from 'zod';
import { id, timestamp, log, workoutType, profile } from './entities.js';

export const publicLogSchema = log.pick({
  id: true, workoutTypeId: true, workoutId: true, reps: true, weight: true,
  duration: true, durationSeconds: true, date: true,
});
export const publicWorkoutTypeSchema = workoutType.pick({ id: true, name: true, category: true });
export const profileStatsSchema = z.object({
  totalWorkouts: z.number(), totalVolume: z.number(),
  favoriteExercise: z.string().optional(), lastWorkoutDate: timestamp.optional(),
});
export const publicProfileSchema = z.object({
  timeZone: profile.shape.timeZone, displayName: z.string(), identifier: id,
  photoUrl: z.string().optional(), stats: profileStatsSchema,
  recentActivity: z.array(z.object({ date: z.iso.date(), exerciseCount: z.number() })),
  logs: z.array(publicLogSchema).optional(), workoutTypes: z.array(publicWorkoutTypeSchema).optional(),
});
export type PublicLog = z.infer<typeof publicLogSchema>;
export type PublicWorkoutType = z.infer<typeof publicWorkoutTypeSchema>;
export type ProfileStats = z.infer<typeof profileStatsSchema>;
export type PublicProfileData = z.infer<typeof publicProfileSchema>;
