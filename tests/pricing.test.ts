// Extracted from the Veloce Transfers site @ 6b8bf12 (private). Tariff figures are illustrative.
import { describe, expect, test } from 'vitest';
import { estimate, formatChf, type EstimateInput } from '../src/engine';
import tariff from '../src/tariffs.json';

const T = tariff as any;
const day = { date: '2026-10-10', time: '10:00' };
const base = (o: Partial<EstimateInput>): EstimateInput => ({
  from: 'lugano', to: 'malpensa', category: 'sedan', passengers: 2, pickup: day, ...o,
});
const total = (o: Partial<EstimateInput>) => estimate(base(o), T);

describe('published daytime fares (F01–F06)', () => {
  const rows: Array<[string, number, number]> = [
    ['malpensa', 22000, 25000], ['linate', 25000, 28000], ['centrale', 25000, 28000],
    ['bergamo', 30000, 35000], ['chiasso', 12000, 15000], ['mendrisio', 8000, 10000],
  ];
  for (const [to, sedan, van] of rows) {
    test(`Lugano → ${to} sedan = ${sedan}`, () => {
      const r = total({ to, category: 'sedan' });
      expect(r.status).toBe('estimate');
      expect(r.totalMinor).toBe(sedan);
      expect(r.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(sedan);
    });
    test(`Lugano → ${to} van = ${van}`, () => {
      const r = total({ to, category: 'van' });
      expect(r.status).toBe('estimate');
      expect(r.totalMinor).toBe(van);
    });
  }
  test('result carries currency and tariff version', () => {
    const r = total({});
    expect(r.currency).toBe('CHF');
    expect(r.tariffVersion).toBe('2026-09-07');
  });
});

describe('reverse and unknown routes', () => {
  test('Malpensa → Lugano sedan is the same fare (P03)', () => {
    expect(total({ from: 'malpensa', to: 'lugano' }).totalMinor).toBe(22000);
  });
  test('Zurich is request-only with no total', () => {
    const r = total({ to: 'zurich' });
    expect(r.status).toBe('request_only');
    expect(r.totalMinor).toBeNull();
    expect(r.reasons).toContain('request_only_destination');
  });
  test('unknown place id is invalid', () => {
    const r = total({ to: 'atlantis' });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('unknown_place');
  });
  test('two non-Lugano fixed places without distance is request-only', () => {
    const r = total({ from: 'chiasso', to: 'malpensa' });
    expect(r.status).toBe('request_only');
  });
});

describe('night supplement (P06–P09)', () => {
  test('22:00 pickup adds 15% on base: 220 → 253', () => {
    const r = total({ pickup: { date: '2026-10-10', time: '22:00' } });
    expect(r.totalMinor).toBe(25300);
    expect(r.lines.map((l) => l.code)).toEqual(['route_fare', 'night']);
    expect(r.lines[1].amountMinor).toBe(3300);
  });
  test('van 250 at night → 287.50 rounded to whole franc 288', () => {
    const r = total({ category: 'van', pickup: { date: '2026-10-10', time: '23:30' } });
    expect(r.totalMinor).toBe(28800);
    expect(r.lines.find((l) => l.code === 'rounding')?.amountMinor).toBe(50);
  });
  test.each([['21:59', false], ['22:00', true], ['05:59', true], ['06:00', false]])(
    'boundary %s → night %s', (time, night) => {
      const r = total({ pickup: { date: '2026-10-10', time } });
      expect(r.lines.some((l) => l.code === 'night')).toBe(night);
    },
  );
  test('nonexistent local time on the spring DST change is invalid (P06 boundary)', () => {
    const r = total({ pickup: { date: '2027-03-28', time: '02:30' } }); // 02:00–03:00 does not exist in Zurich
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('nonexistent_local_time');
  });
  test('ambiguous local time on the autumn DST change is priced as the first occurrence and recorded', () => {
    const r = total({ pickup: { date: '2026-10-25', time: '02:30' } }); // 02:00–03:00 happens twice in Zurich
    expect(r.status).toBe('estimate');
    expect(r.totalMinor).toBe(25300);
    expect(r.assumptions).toContain('ambiguous_local_time_first');
  });
  test('night uses the pickup wall clock, independent of the process time zone', () => {
    const r = total({ pickup: { date: '2026-12-10', time: '22:00' } });
    expect(r.lines.some((l) => l.code === 'night')).toBe(true);
  });
});

describe('formatting', () => {
  test.each([[22000, 'CHF 220'], [28750, 'CHF 287.50'], [0, 'CHF 0'], [-30, 'CHF -0.30'], [-50, 'CHF -0.50'], [-100, 'CHF -1'], [5, 'CHF 0.05']])(
    'formatChf(%i) = %s', (minor, txt) => { expect(formatChf(minor)).toBe(txt); },
  );
});

describe('Classe S (P04)', () => {
  test('S = sedan fare + 10%: 220 → 242', () => {
    const r = total({ category: 'sedan_s' });
    expect(r.totalMinor).toBe(24200);
  });
  test('S at night: night computed on the S base, then rounded: 242 × 1.15 = 278.30 → 278', () => {
    const r = total({ category: 'sedan_s', pickup: { date: '2026-10-10', time: '22:30' } });
    expect(r.totalMinor).toBe(27800);
    expect(r.lines.find((l) => l.code === 'rounding')?.amountMinor).toBe(-30);
    expect(r.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(27800);
  });
});

describe('capacity (P12–P15)', () => {
  test('5 passengers in a sedan is invalid with a capacity reason', () => {
    const r = total({ passengers: 5 });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('capacity_passengers');
  });
  test('9 passengers in a van is invalid', () => {
    expect(total({ passengers: 9, category: 'van' }).status).toBe('invalid');
  });
  test.each([0, -1, 1.5, NaN, Infinity])('passenger count %s is invalid', (n) => {
    expect(total({ passengers: n as number }).status).toBe('invalid');
  });
  test('special luggage (skis, wheelchair, pets) goes to review', () => {
    const r = total({ specialLuggage: true });
    expect(r.status).toBe('request_only');
    expect(r.reasons).toContain('special_luggage_review');
  });
  test('ordinary luggage count is carried, not priced', () => {
    const r = total({ luggage: 3 });
    expect(r.status).toBe('estimate');
    expect(r.totalMinor).toBe(22000);
  });
  test('child seat request goes to review, no total', () => {
    const r = total({ childSeats: 1 });
    expect(r.status).toBe('request_only');
    expect(r.reasons).toContain('child_seat_review');
  });
});

describe('distance pricing (P22)', () => {
  test('60 km at 2.75 = 165', () => {
    const r = total({ from: 'custom', to: 'malpensa', distanceKm: 60 });
    expect(r.status).toBe('estimate');
    expect(r.totalMinor).toBe(16500);
    expect(r.lines[0].code).toBe('distance_fare');
  });
  test('5 km is lifted to the 80 minimum', () => {
    const r = total({ from: 'custom', to: 'custom', distanceKm: 5 });
    expect(r.totalMinor).toBe(8000);
    expect(r.lines.some((l) => l.code === 'minimum_fare')).toBe(true);
  });
  test('fixed route wins over a supplied distance', () => {
    expect(total({ distanceKm: 300 }).totalMinor).toBe(22000);
  });
  test('van on distance uses the same per-km rate', () => {
    expect(total({ from: 'custom', to: 'custom', distanceKm: 100, category: 'van' }).totalMinor).toBe(27500);
  });
  test('Classe S on distance adds 10%', () => {
    expect(total({ from: 'custom', to: 'custom', distanceKm: 100, category: 'sedan_s' }).totalMinor).toBe(30300); // 302.50 → 303
  });
  test('night on distance: 100 km → 275 × 1.15 = 316.25 → 316', () => {
    expect(total({ from: 'custom', to: 'custom', distanceKm: 100, pickup: { date: '2026-10-10', time: '01:00' } }).totalMinor).toBe(31600);
  });
  test('29.273 km × 2.75 = 80.50075 rounds half-up to 81, never truncated by early rounding', () => {
    const r = total({ from: 'custom', to: 'custom', distanceKm: 29.273 });
    expect(r.totalMinor).toBe(8100);
    expect(r.lines.find((l) => l.code === 'distance_fare')?.amountMinor).toBe(8050);
    expect(r.lines.find((l) => l.code === 'rounding')?.amountMinor).toBe(50);
    expect(r.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(8100);
  });
  test('custom endpoints without distance are request-only', () => {
    expect(total({ from: 'custom', to: 'custom' }).status).toBe('request_only');
  });
  test('non-positive or absurd distance is invalid', () => {
    expect(total({ from: 'custom', to: 'custom', distanceKm: 0 }).status).toBe('invalid');
    expect(total({ from: 'custom', to: 'custom', distanceKm: 5000 }).status).toBe('invalid');
  });
});

describe('waiting (P12)', () => {
  test('30 extra minutes at 65/h pro-rata = 32.50, rounded into whole francs', () => {
    const r = total({ extraWaitingMinutes: 30 });
    expect(r.lines.find((l) => l.code === 'waiting')?.amountMinor).toBe(3250);
    expect(r.totalMinor).toBe(25300); // 220 + 32.50 = 252.50 → 253
  });
  test('waiting is not part of the night base', () => {
    const r = total({ extraWaitingMinutes: 60, pickup: { date: '2026-10-10', time: '22:00' } });
    expect(r.totalMinor).toBe(22000 + 3300 + 6500);
  });
});

describe('return legs (P18)', () => {
  test('daytime outbound + night return are priced independently and summed', () => {
    const r = total({ returnLeg: { date: '2026-10-12', time: '23:00' } });
    expect(r.status).toBe('estimate');
    expect(r.legs).toHaveLength(2);
    expect(r.legs[0].totalMinor).toBe(22000);
    expect(r.legs[1].totalMinor).toBe(25300);
    expect(r.totalMinor).toBe(47300);
  });
  test('return leg beyond the booking horizon is invalid', () => {
    const r = estimate(base({ returnLeg: { date: '2030-10-10', time: '10:00' } }), T, { now: '2026-10-01T08:00:00Z' });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('beyond_booking_horizon');
  });
  test('return leg after tariff expiry yields no estimate', () => {
    const r = estimate(base({ returnLeg: { date: '2026-11-01', time: '10:00' } }), { ...T, effectiveTo: '2026-10-31' });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_not_effective');
  });
  test('return leg is priced in the reverse direction: no reverse rule means request-only', () => {
    const asym = { ...T, routes: T.routes.map((r: any) => ({ ...r, reverseSame: false })) };
    const r = estimate(base({ returnLeg: { date: '2026-10-11', time: '10:00' } }), asym);
    expect(r.status).toBe('request_only');
  });
  test('return leg at a nonexistent local time is invalid', () => {
    const r = total({ returnLeg: { date: '2027-03-28', time: '02:30' } });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('nonexistent_local_time');
  });
  test('return before outbound is invalid', () => {
    expect(total({ returnLeg: { date: '2026-10-09', time: '10:00' } }).status).toBe('invalid');
  });
});

describe('validation and tariff lifecycle', () => {
  test('missing pickup date is invalid', () => {
    expect(total({ pickup: { date: '', time: '10:00' } }).status).toBe('invalid');
  });
  test('journey before tariff effective date yields no estimate', () => {
    const r = total({ pickup: { date: '2026-09-01', time: '10:00' } });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_not_effective');
  });
  test('a tariff with only a schema version is rejected without throwing', () => {
    const r = estimate(base({}), { schemaVersion: 1 });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_invalid');
  });
  test('a route missing its base fare is rejected, never NaN', () => {
    const broken = { ...T, routes: T.routes.map((r: any) => ({ ...r, sedanMinor: undefined })) };
    const r = estimate(base({}), broken);
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_invalid');
  });
  test('unsupported schema version is rejected', () => {
    const r = estimate(base({}), { ...T, schemaVersion: 99 });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_schema');
  });
  test('short notice (< 12 h) goes to review', () => {
    const r = estimate(base({ pickup: { date: '2026-10-10', time: '10:00' } }), T, { now: '2026-10-10T03:00:00Z' }); // 05:00 in Zurich
    expect(r.status).toBe('request_only');
    expect(r.reasons).toContain('short_notice');
  });
  test('pickup in the past is invalid', () => {
    const r = estimate(base({}), T, { now: '2026-10-11T08:00:00Z' });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('pickup_in_past');
  });
  test('hourly hire or stops go to review', () => {
    expect(total({ stops: 1 }).status).toBe('request_only');
  });
});

describe('re-audit: tariff validation depth (R2)', () => {
  test('a null place entry is rejected, not thrown', () => {
    const r = estimate(base({}), { ...T, places: { ...T.places, malpensa: null } });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_invalid');
  });
  test('an unknown time zone is rejected, not thrown', () => {
    const r = estimate(base({}), { ...T, timeZone: 'not/a-zone' });
    expect(r.status).toBe('invalid');
    expect(r.reasons).toContain('tariff_invalid');
  });
  test('a negative night percentage is rejected', () => {
    expect(estimate(base({}), { ...T, night: { ...T.night, bp: -1500 } }).reasons).toContain('tariff_invalid');
  });
  test('an out-of-range night clock is rejected', () => {
    expect(estimate(base({}), { ...T, night: { ...T.night, startInclusive: '25:00' } }).reasons).toContain('tariff_invalid');
  });
  test('a category multiplier below 100% or zero seats is rejected', () => {
    expect(estimate(base({}), { ...T, categories: { ...T.categories, sedan: { ...T.categories.sedan, multiplierBp: 9000 } } }).reasons).toContain('tariff_invalid');
    expect(estimate(base({}), { ...T, categories: { ...T.categories, sedan: { ...T.categories.sedan, seats: 0 } } }).reasons).toContain('tariff_invalid');
  });
  test('effectiveTo before effectiveFrom or an invalid calendar date is rejected', () => {
    expect(estimate(base({}), { ...T, effectiveTo: '2026-01-01' }).reasons).toContain('tariff_invalid');
    expect(estimate(base({}), { ...T, effectiveFrom: '2026-02-30' }).reasons).toContain('tariff_invalid');
  });
  test('non-finite or absurd money values are rejected', () => {
    expect(estimate(base({}), { ...T, distance: { ...T.distance, perKmMinor: 1e15 } }).reasons).toContain('tariff_invalid');
    expect(estimate(base({}), { ...T, waiting: { ...T.waiting, includedMinutes: -5 } }).reasons).toContain('tariff_invalid');
  });
});

describe('re-audit: distance-based return legs (R3)', () => {
  test('a distance-priced return without its own distance is request-only, never inherited', () => {
    const r = total({ from: 'custom', to: 'custom', distanceKm: 60, returnLeg: { date: '2026-10-12', time: '10:00' } });
    expect(r.status).toBe('request_only');
    expect(r.reasons).toContain('return_distance_missing');
  });
  test('a distance-priced return with its own distance is priced on that distance', () => {
    const r = total({ from: 'custom', to: 'custom', distanceKm: 60, returnLeg: { date: '2026-10-12', time: '10:00', distanceKm: 40 } });
    expect(r.status).toBe('estimate');
    expect(r.legs[1].totalMinor).toBe(11000);
  });
  test('a fixed-route return still needs no distance', () => {
    expect(total({ returnLeg: { date: '2026-10-12', time: '10:00' } }).status).toBe('estimate');
  });
});

describe('re-audit: ambiguous local time is explicit per leg (R1)', () => {
  test('legs expose the resolved UTC offset and whether the time was ambiguous', () => {
    const r = total({ pickup: { date: '2026-10-25', time: '02:30' } });
    expect(r.legs[0].utcOffsetMinutes).toBe(120);
    expect(r.legs[0].ambiguous).toBe(true);
    const n = total({});
    expect(n.legs[0].utcOffsetMinutes).toBe(120);
    expect(n.legs[0].ambiguous).toBe(false);
  });
});
