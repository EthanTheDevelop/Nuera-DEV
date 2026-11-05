import { describe, expect, it } from 'vitest';
import { describeDevice } from './device';

const UA = {
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
};

describe('describeDevice', () => {
  it('labels devices like « Accès ouverts » (Paramètres)', () => {
    expect(describeDevice(UA.macSafari)).toMatchObject({ label: 'Mac · Safari', kind: 'desktop' });
    expect(describeDevice(UA.iphoneSafari)).toMatchObject({ label: 'iPhone · Safari', kind: 'phone' });
    expect(describeDevice(UA.windowsChrome)).toMatchObject({ label: 'PC Windows · Chrome', kind: 'desktop' });
    expect(describeDevice(UA.linuxFirefox)).toMatchObject({ label: 'PC Linux · Firefox', kind: 'desktop' });
    expect(describeDevice(UA.windowsEdge).label).toBe('PC Windows · Edge');
  });

  it('never invents a device it cannot read', () => {
    expect(describeDevice(null)).toEqual({ label: 'Appareil inconnu', kind: 'unknown', device: null, browser: null });
    expect(describeDevice('curl/8.4.0').kind).toBe('unknown');
  });
});
