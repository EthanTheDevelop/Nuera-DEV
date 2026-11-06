import { describe, expect, it } from 'vitest';
import { SESSION_STREAM_PROBE_AFTER, sessionStreamProbeVerdict } from './useSessionStream';

describe('session stream probe', () => {
  it('refreshes only on a permanent refusal of the stream (signed out, foreign or gone session)', () => {
    expect(SESSION_STREAM_PROBE_AFTER).toBe(3);
    for (const status of [401, 403, 404]) expect(sessionStreamProbeVerdict(status), String(status)).toBe('refresh');
  });

  it('keeps retrying when nothing proves a refusal (runner down, server error, no network)', () => {
    for (const status of [200, 429, 500, 502, 503, null]) expect(sessionStreamProbeVerdict(status), String(status)).toBe('retry');
  });
});
