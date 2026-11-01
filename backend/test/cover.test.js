const { computeCover, maxGivable, addDays } = require('../srv/lib/cover');
const { build } = require('../../seed/generate');

const T = '2026-11-01';
const lot = (ID, quantity, expDays, extra = {}) => ({ ID, quantity, expiryDate: addDays(T, expDays), sealed: true, quarantined: false, ...extra });
const bk = (ID, day, units, intent = 'CURATIVE', patientRef = ID) => ({ ID, scheduledDate: addDays(T, day), doseUnits: units, intent, patientRef });

describe('scheduled-demand cover', () => {
  test('fully covered drug is GREEN with surplus = stock - demand - margin', () => {
    const c = computeCover({ lots: [lot('a', 30, 100)], bookings: [bk('1', 1, 5), bk('2', 3, 5)], today: T, windowDays: 14, safetyMarginPct: 20 });
    expect(c).toMatchObject({ booked: 10, covered: 10, shortfall: 0, margin: 2, surplus: 18, status: 'GREEN', coverPct: 100 });
  });

  test('stock expiring before a dose date cannot cover it', () => {
    const c = computeCover({ lots: [lot('a', 10, 3)], bookings: [bk('1', 1, 4), bk('2', 5, 4)], today: T });
    expect(c.covered).toBe(4);
    expect(c.shortfall).toBe(4);
    expect(c.affected.map(a => a.bookingId)).toEqual(['2']);
    expect(c.firstAffectedDate).toBe(addDays(T, 5));
  });

  test('expiry on the dose date itself does not count (strictly after)', () => {
    const c = computeCover({ lots: [lot('a', 5, 2)], bookings: [bk('1', 2, 1)], today: T });
    expect(c.shortfall).toBe(1);
  });

  test('unsealed, quarantined, flagged and expired lots are excluded', () => {
    const lots = [lot('u', 5, 50, { sealed: false }), lot('q', 5, 50, { quarantined: true }), lot('f', 5, 50), lot('x', 5, -1)];
    const c = computeCover({ lots, bookings: [bk('1', 1, 2)], today: T, isFlagged: l => l.ID === 'f' });
    expect(c.usableStock).toBe(0);
    expect(c.status).toBe('RED');
  });

  test('earliest-expiry-first allocation maximises covered doses', () => {
    // naive "longest expiry first" would waste the short lot
    const c = computeCover({ lots: [lot('long', 2, 100), lot('short', 2, 2)], bookings: [bk('1', 0, 2), bk('2', 5, 2)], today: T });
    expect(c.shortfall).toBe(0);
  });

  test('window toggles 7/14/21 days', () => {
    const bookings = [bk('1', 2, 1), bk('2', 10, 1), bk('3', 20, 1), bk('4', 21, 1)];
    const f = w => computeCover({ lots: [], bookings, today: T, windowDays: w }).booked;
    expect([f(7), f(14), f(21)]).toEqual([1, 2, 3]);
  });

  test('covered but below safety margin is GREEN with belowMargin and no surplus', () => {
    const c = computeCover({ lots: [lot('a', 10, 100)], bookings: [bk('1', 1, 10)], today: T, safetyMarginPct: 20 });
    expect(c.status).toBe('GREEN');
    expect(c.belowMargin).toBe(true);
    expect(c.surplus).toBe(0);
  });

  test('patients affected counts distinct patient refs', () => {
    const c = computeCover({ lots: [], bookings: [bk('1', 1, 1, 'CURATIVE', 'p1'), bk('2', 2, 1, 'CURATIVE', 'p1'), bk('3', 3, 1, 'PALLIATIVE', 'p2')], today: T });
    expect(c.patientsAffected).toBe(2);
    expect(c.affected.filter(a => a.curative)).toHaveLength(2);
  });
});

describe('maxGivable (rule 1 per lot)', () => {
  test('keeps own bookings covered and margin intact', () => {
    const lots = [lot('near', 12, 45), lot('far', 20, 300)];
    const bookings = [bk('1', 2, 2), bk('2', 5, 2), bk('3', 7, 2), bk('4', 10, 2), bk('5', 12, 2)];
    // stock 32, demand 10, margin 2 -> surplus 20
    expect(maxGivable({ lots, bookings, today: T, lotId: 'near' })).toBe(12);
    expect(maxGivable({ lots, bookings, today: T, lotId: 'far' })).toBe(20);
    expect(maxGivable({ lots, bookings, today: T, lotId: 'far', alreadyRemoved: { near: 12 } })).toBe(8);
  });
  test('returns 0 when the hospital has no genuine surplus', () => {
    expect(maxGivable({ lots: [lot('a', 10, 100)], bookings: [bk('1', 1, 10)], today: T, lotId: 'a' })).toBe(0);
  });
});

describe('seed data reproduces the PRD demo numbers', () => {
  test('H1 carboplatin: 16 of 40 booked doses short, 9 patients affected first', () => {
    const data = build(new Date(T + 'T00:00:00Z'));
    const c = computeCover({
      lots: data.lots.H1.filter(l => l.drug_ID === 'D-CARB450'),
      bookings: data.bookings.H1.filter(b => b.drug_ID === 'D-CARB450').map(b => ({ ...b, ID: b.srcId, patientRef: b.mrn })),
      today: T, windowDays: 14,
    });
    expect(c.booked).toBe(40);
    expect(c.shortfall).toBe(16);
    expect(c.patientsAffected).toBe(9);
    expect(c.status).toBe('RED');
  });
});
