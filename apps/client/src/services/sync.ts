import { Table } from 'dexie';
import { authorizedApiFetch } from '../auth';
import { db } from '../db';
import { AppData, SyncItem } from '../types';

export class SyncService {
  static async sync() {
    if (!navigator.onLine) {
      throw new Error('Offline');
    }

    const response = await authorizedApiFetch('/me/storage', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Unauthorized');
      }
      throw new Error('Sync failed');
    }

    const remoteData: AppData = await response.json();
    await this.mergeData(remoteData);

    const localData = await this.readAll();
    const saveResponse = await authorizedApiFetch('/me/storage', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(localData),
    });

    if (!saveResponse.ok) {
      if (saveResponse.status === 401) {
        throw new Error('Unauthorized');
      }
      throw new Error('Sync failed');
    }
  }

  private static async mergeData(remote: AppData) {
    await db.transaction('rw', db.workouts, db.logs, db.workoutTypes, db.profile, async () => {
      await this.mergeTable(db.workouts, remote.workouts);
      await this.mergeTable(db.logs, remote.logs);
      await this.mergeTable(db.workoutTypes, remote.workoutTypes);

      if (remote.profile) {
        const profileWithId = { ...remote.profile, id: 'me' };
        await this.mergeTable(db.profile, [profileWithId]);
      }
    });
  }

  private static async mergeTable<T extends SyncItem & { id: string }>(table: Table<T, string>, remoteItems: T[] = []) {
    const localItems = await table.toArray();
    const localMap = new Map(localItems.map((item) => [item.id, item]));

    for (const remoteItem of remoteItems) {
      const localItem = localMap.get(remoteItem.id);
      if (!localItem) {
        await table.put(remoteItem);
        continue;
      }

      const remoteDate = new Date(remoteItem.updatedAt).getTime();
      const localDate = new Date(localItem.updatedAt).getTime();

      if (remoteDate > localDate) {
        await table.put(remoteItem);
      }
    }
  }

  static async readAll(): Promise<AppData> {
    return {
      workouts: await db.workouts.toArray(),
      logs: await db.logs.toArray(),
      workoutTypes: await db.workoutTypes.toArray(),
      profile: (await db.profile.toArray())[0],
    };
  }
}
