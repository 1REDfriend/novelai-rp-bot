/** The few channel operations /clear-all needs, so the logic can be tested without Discord. */
export interface ClearableChannel {
  /** Up to 100 messages, newest first, older than `before` when given. */
  fetchPage(before: string | undefined): Promise<{ id: string; createdTimestamp: number }[]>;
  /** Deletes 2-100 messages younger than 14 days in one request. */
  bulkDelete(ids: string[]): Promise<void>;
  deleteOne(id: string): Promise<void>;
}

/** Discord refuses bulk deletes of messages older than 14 days; keep a margin for clock drift. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000;

export interface ClearResult {
  deleted: number;
  /** Messages Discord would not delete, such as some system messages. */
  skipped: number;
}

/**
 * Deletes every message in the channel. Recent messages go in bulk; older ones
 * one at a time, which is slow but the only way Discord allows. A missing
 * permission on a bulk delete is thrown, since nothing else would work either.
 */
export async function clearChannel(channel: ClearableChannel, now = Date.now()): Promise<ClearResult> {
  const result: ClearResult = { deleted: 0, skipped: 0 };
  let before: string | undefined;
  for (;;) {
    const page = await channel.fetchPage(before);
    if (page.length === 0) return result;
    before = page.at(-1)!.id;

    const recent = page.filter((m) => now - m.createdTimestamp < BULK_DELETE_MAX_AGE_MS).map((m) => m.id);
    const single = page.filter((m) => !recent.includes(m.id)).map((m) => m.id);
    if (recent.length >= 2) {
      await channel.bulkDelete(recent);
      result.deleted += recent.length;
    } else {
      single.unshift(...recent);
    }
    for (const id of single) {
      try {
        await channel.deleteOne(id);
        result.deleted++;
      } catch {
        result.skipped++;
      }
    }
  }
}
