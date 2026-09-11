// Extracted from the Veloce Transfers site @ 6b8bf12 (private). Tariff figures are illustrative.
/**
 * VeloceTransfers pricing engine — pure, deterministic, integer arithmetic.
 *
 * Amounts are minor units (rappen); internal leg arithmetic runs in milli-rappen
 * so that km × rate is exact until the single approved rounding step per leg.
 * Percentages are basis points. The engine never touches the network or the
 * DOM; the clock comes in through `opts.now` (an ISO instant) and the tariff
 * object from `src/tariffs.json` is the single source of truth.
 *
 * Evaluation order: tariff validation → input validation → per-leg lifecycle
 * (effective window, DST, notice, horizon) → review triggers → per-leg:
 * fixed directed route | distance formula → category multiplier → night on
 * base → waiting (first leg) → rounding once.
 */
import { localToInstant } from './time.ts';

export type PlaceId = string;
export type CategoryId = 'sedan' | 'sedan_s' | 'van' | string;

export interface LocalDateTime {
  /** ISO date, YYYY-MM-DD, pickup-local. */
  date: string;
  /** HH:MM, 24 h, pickup-local wall clock. */
  time: string;
  /** Road distance of this leg (km) when it has no fixed fare. A return leg never inherits the outbound distance. */
  distanceKm?: number;
}

export interface EstimateInput {
  from: PlaceId | 'custom';
  to: PlaceId | 'custom';
  category: CategoryId;
  passengers: number;
  pickup: LocalDateTime;
  /** Road distance of the customer's outbound leg, km, for journeys with no fixed fare. */
  distanceKm?: number;
  /** Return leg: priced in the reverse direction (to → from) with its own pickup. */
  returnLeg?: LocalDateTime;
  /** Minutes of waiting beyond the included allowance (operator-entered). */
  extraWaitingMinutes?: number;
  /** Ordinary luggage pieces: carried to the operator, not priced (no approved capacity rule). */
  luggage?: number;
  /** Skis, oversize bags, wheelchair, pets: needs operator review. */
  specialLuggage?: boolean;
  childSeats?: number;
  stops?: number;
  hourlyHire?: boolean;
}

export interface EstimateOptions {
  /** ISO instant (e.g. "2026-10-10T08:00:00Z") for notice/horizon checks; omit to skip them. */
  now?: string;
}

export type LineCode = 'route_fare' | 'distance_fare' | 'minimum_fare' | 'category' | 'night' | 'waiting' | 'rounding';

export interface Line {
  code: LineCode;
  /** Minor units, rounded to the rappen for display; the rounding line makes lines sum to the leg total. */
  amountMinor: number;
  qty?: number;
}

export interface Leg {
  from: string;
  to: string;
  pickup: LocalDateTime;
  /** Resolved UTC offset of the pickup instant in the tariff zone (minutes east). */
  utcOffsetMinutes: number;
  /** True when the wall time occurs twice (autumn change) and the first occurrence was taken. */
  ambiguous: boolean;
  lines: Line[];
  totalMinor: number;
  night: boolean;
}

export type Status = 'estimate' | 'request_only' | 'invalid';

export interface EstimateResult {
  status: Status;
  currency: string;
  tariffVersion: string;
  legs: Leg[];
  /** Lines of the first leg (convenience for single-leg display). */
  lines: Line[];
  totalMinor: number | null;
  reasons: string[];
  /** Non-blocking notes about how an input was interpreted. */
  assumptions: string[];
}

interface Category { seats: number; fareBasis: 'sedan' | 'van'; multiplierBp: number; label?: string }
interface Route { from: string; to: string; sedanMinor: number; vanMinor: number; reverseSame: boolean }
interface Tariff {
  schemaVersion: number;
  tariffVersion: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  currency: string;
  timeZone: string;
  categories: Record<string, Category>;
  places: Record<string, { kind: string; fixedFareOrigin?: boolean; requestOnly?: boolean }>;
  routes: Route[];
  night: { bp: number; startInclusive: string; endExclusive: string; appliesTo: 'base' };
  distance: { enabled: boolean; perKmMinor: number; minimumMinor: number };
  waiting: { includedMinutes: number; perHourMinor: number; proRata: 'minute' };
  rounding: { incrementMinor: number; mode: 'half_up'; stage: 'per_leg' };
  notice: { minimumHours: number; maximumDays: number };
}

const SUPPORTED_SCHEMA = 1;
const MAX_DISTANCE_KM = 1500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_MONEY_MINOR = 100_000_000; // CHF 1,000,000 — anything larger is a data error
const has = (o: unknown, k: string) => typeof o === 'object' && o !== null && Object.prototype.hasOwnProperty.call(o, k);
const money = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_MONEY_MINOR;
const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, mo, d] = v.split('-').map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
};
const validClock = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v) && Number(v.slice(0, 2)) < 24 && Number(v.slice(3)) < 60;
const validZone = (z: unknown): z is string => {
  if (typeof z !== 'string' || !z) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
};

/** Runtime validation of the tariff shape. Returns a list of problems; empty means usable. */
export function validateTariff(t: unknown): string[] {
  const p: string[] = [];
  if (!isRecord(t)) return ['not_an_object'];
  if (t.schemaVersion !== SUPPORTED_SCHEMA) return ['schema'];
  if (typeof t.tariffVersion !== 'string' || !t.tariffVersion) p.push('tariffVersion');
  if (!validDate(t.effectiveFrom)) p.push('effectiveFrom');
  if (t.effectiveTo !== null && !validDate(t.effectiveTo)) p.push('effectiveTo');
  if (validDate(t.effectiveFrom) && validDate(t.effectiveTo) && t.effectiveTo < t.effectiveFrom) p.push('effectiveWindow');
  if (typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency)) p.push('currency');
  if (!validZone(t.timeZone)) p.push('timeZone');
  if (!isRecord(t.categories) || Object.keys(t.categories).length === 0) p.push('categories');
  else for (const [k, c] of Object.entries(t.categories)) {
    if (!isRecord(c) || !intIn(c.seats, 1, 64) || (c.fareBasis !== 'sedan' && c.fareBasis !== 'van') || !intIn(c.multiplierBp, 10000, 100000)) p.push(`categories.${k}`);
  }
  if (!isRecord(t.places) || Object.keys(t.places).length === 0) p.push('places');
  else for (const [k, pl] of Object.entries(t.places)) {
    if (!isRecord(pl) || typeof pl.label !== 'string' || typeof pl.kind !== 'string' || (pl.requestOnly !== undefined && typeof pl.requestOnly !== 'boolean')) p.push(`places.${k}`);
  }
  if (!Array.isArray(t.routes)) p.push('routes');
  else t.routes.forEach((r, i) => {
    if (!isRecord(r) || typeof r.from !== 'string' || typeof r.to !== 'string' || !money(r.sedanMinor) || !money(r.vanMinor) || typeof r.reverseSame !== 'boolean') p.push(`routes[${i}]`);
    else if (isRecord(t.places) && (!has(t.places, r.from) || !has(t.places, r.to))) p.push(`routes[${i}].place`);
  });
  const n = t.night;
  if (!isRecord(n) || !intIn(n.bp, 0, 10000) || !validClock(n.startInclusive) || !validClock(n.endExclusive) || n.appliesTo !== 'base') p.push('night');
  const d = t.distance;
  if (!isRecord(d) || typeof d.enabled !== 'boolean' || !money(d.perKmMinor) || !money(d.minimumMinor)) p.push('distance');
  const w = t.waiting;
  if (!isRecord(w) || !intIn(w.includedMinutes, 0, 1440) || !money(w.perHourMinor) || w.proRata !== 'minute') p.push('waiting');
  const r = t.rounding;
  if (!isRecord(r) || !intIn(r.incrementMinor, 1, 10000) || r.mode !== 'half_up' || r.stage !== 'per_leg') p.push('rounding');
  const no = t.notice;
  if (!isRecord(no) || typeof no.minimumHours !== 'number' || !(no.minimumHours >= 0 && no.minimumHours <= 720) || !intIn(no.maximumDays, 1, 3650)) p.push('notice');
  return p;
}

function fail(t: Partial<Tariff> | undefined, status: Status, reasons: string[], assumptions: string[] = []): EstimateResult {
  return {
    status,
    currency: typeof t?.currency === 'string' ? t.currency : 'CHF',
    tariffVersion: typeof t?.tariffVersion === 'string' ? t.tariffVersion : '',
    legs: [], lines: [], totalMinor: null, reasons, assumptions,
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function validDateTime(dt: LocalDateTime | undefined): dt is LocalDateTime {
  if (!dt || typeof dt.date !== 'string' || typeof dt.time !== 'string' || !DATE_RE.test(dt.date) || !TIME_RE.test(dt.time)) return false;
  const [y, mo, d] = dt.date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return false;
  const [h, m] = dt.time.split(':').map(Number);
  return h >= 0 && h < 24 && m >= 0 && m < 60;
}

function isNight(t: Tariff, time: string): boolean {
  const m = minutesOf(time);
  const start = minutesOf(t.night.startInclusive);
  const end = minutesOf(t.night.endExclusive);
  return start > end ? m >= start || m < end : m >= start && m < end;
}

function roundHalfUp(amount: number, increment: number): number {
  return Math.round(amount / increment) * increment;
}

function findRoute(t: Tariff, from: string, to: string): Route | undefined {
  for (const r of t.routes) {
    if (r.from === from && r.to === to) return r;
    if (r.reverseSame && r.from === to && r.to === from) return r;
  }
  return undefined;
}

/** Validate one leg's pickup against the tariff window, DST, notice and horizon. Pushes reasons; returns the instant. */
interface LegTime { epochMs: number; utcOffsetMinutes: number; ambiguous: boolean }
function checkLeg(t: Tariff, pickup: LocalDateTime, nowMs: number | undefined, reasons: string[], assumptions: string[]): LegTime {
  if (pickup.date < t.effectiveFrom || (t.effectiveTo && pickup.date > t.effectiveTo)) reasons.push('tariff_not_effective');
  const res = localToInstant(pickup.date, pickup.time, t.timeZone);
  if (res.kind === 'nonexistent') reasons.push('nonexistent_local_time');
  if (res.kind === 'ambiguous') assumptions.push('ambiguous_local_time_first');
  if (nowMs !== undefined) {
    const diffMin = (res.epochMs - nowMs) / 60000;
    if (diffMin < 0) reasons.push('pickup_in_past');
    else if (diffMin > t.notice.maximumDays * 1440) reasons.push('beyond_booking_horizon');
  }
  const [y, mo, d] = pickup.date.split('-').map(Number);
  const [h, mi] = pickup.time.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  return { epochMs: res.epochMs, utcOffsetMinutes: Math.round((naive - res.epochMs) / 60000), ambiguous: res.kind === 'ambiguous' };
}

/** Price one directed leg. Returns milli-rappen totals; `undefined` means no fare rule. */
function priceLeg(t: Tariff, cat: Category, from: string, to: string, distanceKm: number | undefined, pickup: LocalDateTime, time: LegTime): Leg | 'no_fare_rule' | 'distance_missing' {
  const K = 1000; // milli-rappen
  const parts: Array<{ code: LineCode; milli: number; qty?: number }> = [];
  let base: number;

  const route = from !== 'custom' && to !== 'custom' ? findRoute(t, from, to) : undefined;
  if (route) {
    base = (cat.fareBasis === 'van' ? route.vanMinor : route.sedanMinor) * K;
    parts.push({ code: 'route_fare', milli: base });
  } else if (t.distance.enabled && typeof distanceKm === 'number') {
    const metres = Math.round(distanceKm * 1000);
    base = metres * t.distance.perKmMinor; // exact: metres × rappen/km = milli-rappen
    parts.push({ code: 'distance_fare', milli: base, qty: distanceKm });
    const min = t.distance.minimumMinor * K;
    if (base < min) {
      parts.push({ code: 'minimum_fare', milli: min - base });
      base = min;
    }
  } else if (t.distance.enabled && distanceKm === undefined) {
    return 'distance_missing';
  } else {
    return 'no_fare_rule';
  }

  if (cat.multiplierBp !== 10000) {
    const extra = (base * (cat.multiplierBp - 10000)) / 10000;
    parts.push({ code: 'category', milli: extra });
    base += extra;
  }
  const night = isNight(t, pickup.time);
  let total = base;
  if (night) {
    const n = (base * t.night.bp) / 10000;
    parts.push({ code: 'night', milli: n });
    total += n;
  }
  const lines: Line[] = parts.map((p) => ({ code: p.code, amountMinor: Math.round(p.milli / K), ...(p.qty !== undefined ? { qty: p.qty } : {}) }));
  return { from, to, pickup, utcOffsetMinutes: time.utcOffsetMinutes, ambiguous: time.ambiguous, lines, totalMinor: total / K, night }; // totalMinor still fractional here
}

export function estimate(input: EstimateInput, tariffData: unknown, opts: EstimateOptions = {}): EstimateResult {
  const problems = validateTariff(tariffData);
  if (problems.length) {
    const t = isRecord(tariffData) ? (tariffData as Partial<Tariff>) : undefined;
    return fail(t, 'invalid', [problems[0] === 'schema' ? 'tariff_schema' : 'tariff_invalid']);
  }
  const t = tariffData as Tariff;
  const reasons: string[] = [];
  const assumptions: string[] = [];

  // 1. Input validation
  if (!validDateTime(input.pickup)) reasons.push('pickup_datetime');
  if (input.returnLeg !== undefined && !validDateTime(input.returnLeg)) reasons.push('return_datetime');
  const pax = input.passengers;
  if (!Number.isInteger(pax) || pax < 1) reasons.push('passengers');
  const cat = has(t.categories, input.category) ? t.categories[input.category] : undefined;
  if (!cat) reasons.push('unknown_category');
  for (const p of [input.from, input.to]) if (p !== 'custom' && !has(t.places, p)) reasons.push('unknown_place');
  if (input.from === input.to && input.from !== 'custom') reasons.push('same_place');
  for (const km of [input.distanceKm, input.returnLeg?.distanceKm]) {
    if (km !== undefined && (!Number.isFinite(km) || km <= 0 || km > MAX_DISTANCE_KM)) reasons.push('distance');
  }
  if (input.extraWaitingMinutes !== undefined && (!Number.isFinite(input.extraWaitingMinutes) || input.extraWaitingMinutes < 0)) reasons.push('waiting');
  if (input.luggage !== undefined && (!Number.isInteger(input.luggage) || input.luggage < 0)) reasons.push('luggage');
  if (reasons.length) return fail(t, 'invalid', reasons);

  // 2. Lifecycle per leg
  let nowMs: number | undefined;
  if (opts.now) {
    nowMs = Date.parse(opts.now);
    if (!Number.isFinite(nowMs)) return fail(t, 'invalid', ['now']);
  }
  const outT = checkLeg(t, input.pickup, nowMs, reasons, assumptions);
  let retT: LegTime | undefined;
  if (input.returnLeg) {
    retT = checkLeg(t, input.returnLeg, nowMs, reasons, assumptions);
    if (retT.epochMs <= outT.epochMs) reasons.push('return_before_outbound');
  }
  const outMs = outT.epochMs;
  if (cat && pax > cat.seats) reasons.push('capacity_passengers');
  if (reasons.length) return fail(t, 'invalid', reasons, assumptions);

  // 3. Review triggers
  if (nowMs !== undefined && (outMs - nowMs) / 60000 < t.notice.minimumHours * 60) reasons.push('short_notice');
  if (input.from !== 'custom' && t.places[input.from].requestOnly) reasons.push('request_only_origin');
  if (input.to !== 'custom' && t.places[input.to].requestOnly) reasons.push('request_only_destination');
  if ((input.childSeats ?? 0) > 0) reasons.push('child_seat_review');
  if (input.specialLuggage) reasons.push('special_luggage_review');
  if ((input.stops ?? 0) > 0) reasons.push('stops_review');
  if (input.hourlyHire) reasons.push('hourly_hire_review');
  if (reasons.length) return fail(t, 'request_only', reasons, assumptions);

  // 4. Price legs: outbound as given, return in the reverse direction
  // A return leg never inherits the outbound distance: roads and directions differ (PLAN §10).
  const specs: Array<[string, string, number | undefined, LocalDateTime, LegTime]> = [[input.from, input.to, input.distanceKm, input.pickup, outT]];
  if (input.returnLeg) specs.push([input.to, input.from, input.returnLeg.distanceKm, input.returnLeg, retT!]);
  const legs: Leg[] = [];
  for (let i = 0; i < specs.length; i++) {
    const [from, to, km, pickup, time] = specs[i];
    const leg = priceLeg(t, cat!, from, to, km, pickup, time);
    if (leg === 'no_fare_rule') return fail(t, 'request_only', ['no_fare_rule'], assumptions);
    if (leg === 'distance_missing') return fail(t, 'request_only', [i === 0 ? 'no_fare_rule' : 'return_distance_missing'], assumptions);
    if (i === 0 && (input.extraWaitingMinutes ?? 0) > 0) {
      const w = (input.extraWaitingMinutes! * t.waiting.perHourMinor) / 60;
      leg.lines.push({ code: 'waiting', amountMinor: Math.round(w), qty: input.extraWaitingMinutes });
      leg.totalMinor += w;
    }
    const rounded = roundHalfUp(leg.totalMinor, t.rounding.incrementMinor);
    const shown = leg.lines.reduce((s, l) => s + l.amountMinor, 0);
    if (rounded !== shown) leg.lines.push({ code: 'rounding', amountMinor: rounded - shown });
    leg.totalMinor = rounded;
    legs.push(leg);
  }

  return {
    status: 'estimate',
    currency: t.currency,
    tariffVersion: t.tariffVersion,
    legs,
    lines: legs[0].lines,
    totalMinor: legs.reduce((s, l) => s + l.totalMinor, 0),
    reasons: [],
    assumptions,
  };
}

/** Format minor units as "CHF 253", "CHF 287.50" or "CHF -0.30". */
export function formatChf(minor: number, currency = 'CHF'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return cents === 0 ? `${currency} ${sign}${whole}` : `${currency} ${sign}${whole}.${String(cents).padStart(2, '0')}`;
}
