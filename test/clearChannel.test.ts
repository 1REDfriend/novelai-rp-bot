import { describe, expect, it } from 'vitest';
import { type ClearableChannel, clearChannel } from '../src/clearChannel.js';

const NOW = Date.UTC(2026, 9, 31);
const DAY = 24 * 60 * 60 * 1000;

/** A fake channel holding messages newest first, paged like Discord. */
class FakeChannel implements ClearableChannel {
  bulkCalls: string[][] = [];
  singleCalls: string[] = [];
  constructor(
    public messages: { id: string; createdTimestamp: number }[],
    private pageSize = 100,
    private undeletable = new Set<string>(),
  ) {}

  async fetchPage(before: string | undefined) {
    const start = before === undefined ? 0 : this.messages.findIndex((m) => m.id === before) + 1;
    return this.messages.slice(start, start + this.pageSize);
  }

  async bulkDelete(ids: string[]) {
    this.bulkCalls.push(ids);
  }

  async deleteOne(id: string) {
    if (this.undeletable.has(id)) throw new Error('Cannot delete');
    this.singleCalls.push(id);
  }
}

const message = (id: string, ageDays: number) => ({ id, createdTimestamp: NOW - ageDays * DAY });

describe('clearChannel', () => {
  it('bulk deletes recent messages and deletes old ones one at a time', async () => {
    const channel = new FakeChannel([message('4', 0), message('3', 1), message('2', 20), message('1', 30)]);
    expect(await clearChannel(channel, NOW)).toEqual({ deleted: 4, skipped: 0 });
    expect(channel.bulkCalls).toEqual([['4', '3']]);
    expect(channel.singleCalls).toEqual(['2', '1']);
  });

  it('deletes a lone recent message singly, since a bulk delete needs at least two', async () => {
    const channel = new FakeChannel([message('2', 0), message('1', 20)]);
    await clearChannel(channel, NOW);
    expect(channel.bulkCalls).toEqual([]);
    expect(channel.singleCalls).toEqual(['2', '1']);
  });

  it('walks every page until the channel is empty', async () => {
    const channel = new FakeChannel([message('5', 0), message('4', 0), message('3', 0), message('2', 0), message('1', 0)], 2);
    expect(await clearChannel(channel, NOW)).toEqual({ deleted: 5, skipped: 0 });
    expect(channel.bulkCalls).toEqual([['5', '4'], ['3', '2']]);
    expect(channel.singleCalls).toEqual(['1']);
  });

  it('skips messages Discord will not delete instead of looping forever', async () => {
    const channel = new FakeChannel([message('2', 20), message('1', 20)], 100, new Set(['1']));
    expect(await clearChannel(channel, NOW)).toEqual({ deleted: 1, skipped: 1 });
  });

  it('stops on a failed bulk delete, which means a missing permission', async () => {
    const channel = new FakeChannel([message('2', 0), message('1', 0)]);
    channel.bulkDelete = async () => {
      throw new Error('Missing Permissions');
    };
    await expect(clearChannel(channel, NOW)).rejects.toThrow('Missing Permissions');
  });
});
