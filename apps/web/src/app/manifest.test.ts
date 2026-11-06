import { describe, expect, it } from 'vitest';
import manifest from './manifest';

describe('manifest', () => {
  it("describes the app for any account's server, never a fixed server name", () => {
    const value = manifest();
    expect(value.description).toBe(
      "Retrouver, depuis n'importe quel appareil, les projets de votre serveur et les sessions Claude Code qui y travaillent.",
    );
    expect(JSON.stringify(value)).not.toMatch(/VPS-3|’/);
    expect(value).toMatchObject({ name: 'Nuera Dev', lang: 'fr', start_url: '/', display: 'standalone' });
  });
});
