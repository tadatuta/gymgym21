import type { PoolClient } from 'pg';
import type { SyncPushReceipt, SyncReceiptRow } from './rows.js';

export function parseSyncReceiptPayload(payload: SyncPushReceipt | string): SyncPushReceipt {
  return typeof payload === 'string'
    ? JSON.parse(payload) as SyncPushReceipt
    : payload;
}

export async function readSyncReceipt(client: PoolClient, storageKey: string, batchId: string): Promise<SyncPushReceipt | undefined> {
  const receiptResult = await client.query<SyncReceiptRow>(
    `
      SELECT response_payload
      FROM storage_sync_receipts
      WHERE storage_key = $1 AND batch_id = $2
      LIMIT 1
    `,
    [storageKey, batchId],
  );
  if (receiptResult.rows[0]) {
    // Legacy full-response receipts are compatible: use only their push outcome.
    return parseSyncReceiptPayload(receiptResult.rows[0].response_payload);
  }
}

export async function writeSyncReceipt(client: PoolClient, storageKey: string, batchId: string, receipt: SyncPushReceipt): Promise<void> {
  await client.query(
    `
      INSERT INTO storage_sync_receipts (storage_key, batch_id, response_payload)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (storage_key, batch_id) DO NOTHING
    `,
    [storageKey, batchId, JSON.stringify(receipt)],
  );
  await client.query(
    `
      DELETE FROM storage_sync_receipts
      WHERE storage_key = $1
        AND created_at < NOW() - INTERVAL '30 days'
    `,
    [storageKey],
  );
}
