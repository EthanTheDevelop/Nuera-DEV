import { afterEach, describe, expect, it } from 'vitest';
import { db } from './db';

/** The lazy singleton never connects by itself (postgres.js opens connections on the first query). */
const holder = globalThis as { __nueraWebDb?: { $client: { end: (options?: { timeout?: number }) => Promise<void> } } };

afterEach(async () => {
  await holder.__nueraWebDb?.$client.end({ timeout: 1 }).catch(() => undefined);
  delete holder.__nueraWebDb;
});

describe('db (singleton paresseux)', () => {
  it("ne se crée qu'au premier usage et explique une DATABASE_URL absente", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(holder.__nueraWebDb).toBeUndefined();
      expect(() => db.select).toThrow(/DATABASE_URL manquant/);
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });

  it('garde les méthodes du client postgres.js et lie celles de Drizzle', async () => {
    process.env.DATABASE_URL = 'postgres://nuera:nuera@127.0.0.1:1/nuera_auth_unit_never_used';
    expect(typeof db.select).toBe('function');
    expect(typeof db.transaction).toBe('function');
    // `$client` is callable AND carries methods: the proxy must hand it over untouched.
    expect(typeof db.$client.end).toBe('function');
    expect(typeof db.$client.unsafe).toBe('function');
    const { select } = db;
    expect(() => select()).not.toThrow();
    await db.$client.end({ timeout: 1 });
  });
});
