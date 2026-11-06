import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedRunnerHosts, normaliseRunnerUrl } from './servers';

/** NUERA_RUNNER_HOSTS: hosts allowed for a server's internal URL, documented where it is configured. */

const repo = path.resolve(import.meta.dirname, '../../../../..');

describe('NUERA_RUNNER_HOSTS', () => {
  it('lists host names or host:port, lower case; empty means any host', () => {
    expect(allowedRunnerHosts({ NUERA_RUNNER_HOSTS: ' Runner-VPS-4, runner-vps-5:4100 ,,' })).toEqual(['runner-vps-4', 'runner-vps-5:4100']);
    expect(allowedRunnerHosts({})).toEqual([]);
    expect(normaliseRunnerUrl('http://10.0.0.8:4100/', {})).toBe('http://10.0.0.8:4100');
    expect(() => normaliseRunnerUrl('http://10.0.0.8:4100', { NUERA_RUNNER_HOSTS: 'runner-vps-4' })).toThrow(/Hôte non autorisé/);
    expect(() => normaliseRunnerUrl('http://runner-vps-5:4200', { NUERA_RUNNER_HOSTS: 'runner-vps-5:4100' })).toThrow(/Hôte non autorisé/);
  });

  it('is documented in .env.example and passed to the web service by deploy/docker-compose.yml', async () => {
    const example = await readFile(path.join(repo, '.env.example'), 'utf8');
    expect(example).toMatch(/^# NUERA_RUNNER_HOSTS=$/m);
    const compose = await readFile(path.join(repo, 'deploy/docker-compose.yml'), 'utf8');
    expect(compose).toContain('NUERA_RUNNER_HOSTS: ${NUERA_RUNNER_HOSTS:-}');
  });
});
