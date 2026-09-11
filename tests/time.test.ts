// Extracted from the Veloce Transfers site @ 6b8bf12 (private). Tariff figures are illustrative.
import { describe, expect, test } from 'vitest';
import { localToInstant, zoneWallClock } from '../src/time';

describe('zone-aware time helpers', () => {
  test('Zurich summer wall clock 10:00 is 08:00Z', () => {
    expect(localToInstant('2026-10-10', '10:00', 'Europe/Zurich')).toEqual({ epochMs: Date.UTC(2026, 9, 10, 8, 0), kind: 'unique' });
  });
  test('Zurich winter wall clock 10:00 is 09:00Z', () => {
    expect(localToInstant('2026-12-10', '10:00', 'Europe/Zurich').epochMs).toBe(Date.UTC(2026, 11, 10, 9, 0));
  });
  test('spring-forward gap is reported as nonexistent', () => {
    expect(localToInstant('2027-03-28', '02:30', 'Europe/Zurich').kind).toBe('nonexistent');
  });
  test('autumn overlap is reported as ambiguous and resolves to the first occurrence', () => {
    const r = localToInstant('2026-10-25', '02:30', 'Europe/Zurich');
    expect(r.kind).toBe('ambiguous');
    expect(r.epochMs).toBe(Date.UTC(2026, 9, 25, 0, 30)); // first 02:30 is CEST (UTC+2)
  });
  test('wall clock of an instant in Zurich is independent of the process zone', () => {
    expect(zoneWallClock(Date.UTC(2026, 9, 10, 10, 0), 'Europe/Zurich')).toEqual({ date: '2026-10-10', time: '12:00' });
  });
});
