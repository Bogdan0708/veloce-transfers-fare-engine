// Extracted from the Veloce Transfers site @ 6b8bf12 (private). Tariff figures are illustrative.
/**
 * Zone-aware time helpers built on Intl (available in every target browser and Node 22).
 * Pickup times are wall-clock values in the tariff's zone; instants are epoch milliseconds.
 */

export interface LocalResolution {
  epochMs: number;
  /** unique: normal; ambiguous: the wall time occurs twice (autumn change), first occurrence chosen;
   *  nonexistent: the wall time is skipped (spring change) — epochMs is the best guess, do not price. */
  kind: 'unique' | 'ambiguous' | 'nonexistent';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  return f;
}

/** Wall clock of an instant in a zone, as { date: 'YYYY-MM-DD', time: 'HH:MM' }. */
export function zoneWallClock(epochMs: number, zone: string): { date: string; time: string } {
  const parts = formatter(zone).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** Offset (minutes east of UTC) of a zone at an instant. */
function offsetAt(epochMs: number, zone: string): number {
  const w = zoneWallClock(epochMs, zone);
  const [y, mo, d] = w.date.split('-').map(Number);
  const [h, mi] = w.time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  return Math.round((asUtc - Math.floor(epochMs / 60000) * 60000) / 60000);
}

/** Resolve a wall-clock date/time in a zone to an instant, detecting DST gaps and overlaps. */
export function localToInstant(date: string, time: string, zone: string): LocalResolution {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Candidate offsets: the zone's offset a day before and a day after (covers any single transition).
  const offsets = Array.from(new Set([offsetAt(naive - 86400000, zone), offsetAt(naive + 86400000, zone), offsetAt(naive, zone)]));
  const valid = offsets
    .map((off) => naive - off * 60000)
    .filter((epoch) => {
      const w = zoneWallClock(epoch, zone);
      return w.date === date && w.time === time;
    })
    .sort((a, b) => a - b);
  if (valid.length === 1) return { epochMs: valid[0], kind: 'unique' };
  if (valid.length > 1) return { epochMs: valid[0], kind: 'ambiguous' };
  // Gap: no offset reproduces the wall time. Best guess uses the pre-transition offset.
  return { epochMs: naive - Math.max(...offsets) * 60000, kind: 'nonexistent' };
}
