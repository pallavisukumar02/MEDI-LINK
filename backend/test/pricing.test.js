'use strict';
/*
 * Price vs distance (docs/PRICING.md): supplier price tiers, near-expiry discount, cap at the landed cost, courier
 * quote by storage class and distance, the best-trade-off line, the /me/journeys/:id/prices endpoint, the live
 * "prices" push, and loans valued at the supplier's price. Price is shown; it never changes the 8 rules or the ranking.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const pricing = require('../srv/lib/pricing');
const ingestH1 = require('./helpers/h1');

const as = user => ({ auth: { username: user, password: 'demo' } });
const act = (user, id, body) => T.axios.post(`/me/actions/${id}`, body, as(user));
const prices = (user, id) => T.axios.get(`/me/journeys/${id}/prices`, as(user));

describe('pricing rules', () => {
  const drug = { unitCost: 1850 };
  test('tier x landed cost, near-expiry discount, batch override, never above the landed cost', () => {
    expect(pricing.unitPrice({ drug, hospital: { pricingMultiplier: 0.9 } })).toBe(1665);
    expect(pricing.unitPrice({ drug, hospital: { pricingMultiplier: 1 }, nearExpiry: true })).toBe(1665);
    expect(pricing.unitPrice({ drug, hospital: { pricingMultiplier: 0.9 }, nearExpiry: true })).toBe(1498.5);
    expect(pricing.unitPrice({ drug, hospital: { pricingMultiplier: 1.4 } })).toBe(1850); // a tier above cost is capped
    expect(pricing.unitPrice({ drug, lot: { unitPrice: 2400 }, hospital: {} })).toBe(1850); // so is a batch price
    expect(pricing.unitPrice({ drug, lot: { unitPrice: 1500 }, hospital: { pricingMultiplier: 0.9 } })).toBe(1500);
    expect(pricing.unitPrice({ drug, hospital: { pricingMultiplier: null } })).toBe(1850);
  });

  test('courier quote by storage class and distance', () => {
    expect(pricing.deliveryCost('AMBIENT', 10)).toBe(270);
    expect(pricing.deliveryCost('COLD', 10)).toBe(570);
    expect(pricing.deliveryCost('FROZEN', 0)).toBe(500);
    expect(pricing.deliveryCost('UNKNOWN', 5)).toBe(210); // falls back to ambient
  });

  test('best trade-off line keeps only points nobody beats on both distance and price', () => {
    const pts = [{ id: 'a', distanceKm: 3, costPerUnit: 2100 }, { id: 'b', distanceKm: 4, costPerUnit: 1850 }, { id: 'c', distanceKm: 10, costPerUnit: 1620 }, { id: 'd', distanceKm: 9, costPerUnit: 1900 }];
    expect(pricing.paretoFrontier(pts).map(p => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('price vs distance for an open request', () => {
  let requestId;
  beforeAll(async () => {
    await ingestH1();
    const card = (await T.axios.get('/me/home', as('asha'))).data.tasks.find(t => t.kind === 'send_request' && t.primaryAction.body.drugId === 'D-CARB450');
    const sent = await act('asha', 'send-request', { ...card.primaryAction.body, allowBrandSwitch: false });
    requestId = sent.data.journey.id;
  });

  test('one point per safe lender: price at its tier, courier quote, total, price per vial, tags', async () => {
    const r = await prices('asha', requestId);
    expect(r.status).toBe(200);
    const d = r.data;
    expect(d).toMatchObject({ qty: 16, landedCost: 1850, currency: 'INR', synthetic: true, drug: { name: 'Carboplatin 450 mg', storageClass: 'AMBIENT' }, delivery: { base: 150, perKm: 12 } });
    expect(d.points.map(p => p.hospitalName)).toEqual(['Banashankari Care Hospital', 'Sanjeevani Hospital']); // nearest first
    expect(JSON.stringify(d.points)).not.toMatch(/Lakeside|Hebbal/); // flagged batch / expired licence never shown
    const [b, s] = d.points;
    // Banashankari (tier 1.00): 12 near-expiry vials at 10% off + 4 at cost
    expect(b).toMatchObject({ qty: 16, unitPrice: 1711.25, medicineCost: 27380, nearExpiry: true, fullyCovers: true, tags: ['Nearest'], planRank: 1, action: { id: 'choose-suppliers', body: { requestId, hospitals: 'H5' } } });
    expect(b.deliveryCost).toBe(150 + Math.round(12 * b.distanceKm));
    expect(b.costPerUnit).toBeCloseTo((b.medicineCost + b.deliveryCost) / 16, 2);
    // Sanjeevani (tier 0.90): farther, cheaper per vial
    expect(s).toMatchObject({ unitPrice: 1665, tags: ['Lowest price'], nearExpiry: false });
    expect(s.distanceKm).toBeGreaterThan(b.distanceKm);
    expect(s.costPerUnit).toBeLessThan(b.costPerUnit);
    expect(d.paretoFrontier).toEqual(['H5', 'H2']);
    expect(d.points.every(p => p.unitPrice <= d.landedCost)).toBe(true);
    expect(d.ruledOut).toBeGreaterThan(0);
  });

  test('price never changes the ranking: the nearest safe plan stays first', async () => {
    const plan1 = await cds.tx(() => SELECT.one.from('medilink.Plans').where({ request_ID: requestId, rank: 1 }));
    expect(JSON.parse(plan1.legs)[0].hospitalId).toBe('H5');
  });

  test('only the requesting hospital (and admin) can see its prices', async () => {
    expect((await prices('ravi', requestId)).data.code).toBe('REQUEST_NOT_FOUND');
    expect((await prices('admin', requestId)).status).toBe(200);
    expect((await prices('admin', requestId)).data.points.every(p => p.action === null)).toBe(true); // admins look, pharmacists choose
  });

  test('re-ranking pushes a live "prices" event to the requesting hospital', async () => {
    const seen = [];
    const ws = require('../srv/lib/ws');
    const l = (event, data) => { if (event === 'prices') seen.push(data); };
    ws.listeners.add(l);
    try { await cds.tx(() => require('../srv/lib/matching').rankRequest(requestId, { resync: false, actor: 'test' })); } finally { ws.listeners.delete(l); }
    expect(seen).toEqual([{ requestId, hospitalId: 'H1' }]);
  });

  test('the AI plan check quotes the cost and the cheaper backup', async () => {
    const r = await act('asha', 'review-plans', { requestId });
    expect(r.data.result.explanation).toMatch(/about ₹[\d,]+ with delivery \(₹[\d,]+ a vial\)/);
    expect(r.data.result.plans.find(p => p.rank === 1).cost).toMatchObject({ medicine: 27380 });
  });
});
