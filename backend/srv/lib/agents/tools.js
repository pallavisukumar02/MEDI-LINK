'use strict';
/*
 * The narrow, read-only tools agents may call. Each is scoped to the signed-in user's own hospital (ctx.hospitalId)
 * and returns counts, batches and hospital names only: never a patient reference.
 * The tools reuse the same code the screens use (cover board, near-expiry list, the 8 hard rules), so an agent
 * can never see or claim more than the pharmacist could see on the screen.
 */
const coverdb = require('../coverdb');
const { daysBetween, addDays, toDay } = require('../cover');

const MAX_DAYS = 90;
const clampDays = (v, d) => Math.max(1, Math.min(MAX_DAYS, Math.round(Number(v) || d)));
const drugLabel = d => `${d.genericName} ${String(d.strength).split('/')[0]}`;
const shortName = n => String(n || '').split(',')[0];

/** Medicines in the master that match a name (and strength, when given). */
async function findDrugs(text) {
  const q = String(text || '').toLowerCase();
  const drugs = Object.values(await coverdb.drugsById());
  const hits = drugs.filter(d => q.includes(d.genericName.toLowerCase()) || d.genericName.toLowerCase().includes(q.trim()) && q.trim().length >= 4);
  const num = q.match(/(\d+(?:\.\d+)?)\s*(mg|g|ml)\b/);
  const exact = num ? hits.filter(d => String(d.strength).toLowerCase().replace(/\s/g, '').startsWith(num[1] + num[2])) : [];
  return exact.length ? exact : hits;
}

const TOOLS = {
  cover_outlook: {
    description: 'Critical medicines that will run short (booked doses not covered by usable stock) within the next N days, worst first.',
    args: { days: 'number (1-90, default 14)' },
    async run({ days }, ctx) {
      const n = clampDays(days, 14);
      const window = n <= 7 ? 7 : n <= 14 ? 14 : 21; // the cover engine works on 7/14/21-day windows
      const until = addDays(coverdb.today(), n);
      const board = await coverdb.board(ctx.hospitalId, window);
      const rows = board.filter(r => r.status === 'RED' && r.firstAffectedDate && toDay(r.firstAffectedDate) <= until);
      return {
        days: n, windowUsed: window,
        short: rows.map(r => ({ drugId: r.drugId, drug: drugLabel(r), shortBy: r.shortfall, booked: r.booked, usableStock: r.usableStock, firstShortOn: toDay(r.firstAffectedDate), patientsAffected: r.patientsAffected })),
        belowSafetyMargin: board.filter(r => r.status === 'GREEN' && r.belowMargin).map(r => ({ drugId: r.drugId, drug: drugLabel(r), usableStock: r.usableStock, booked: r.booked })),
      };
    },
  },

  expiring_lots: {
    description: 'Usable batches in our stock that expire within the next N days, soonest first, with how many we could offer as surplus.',
    args: { days: 'number (1-90, default 30)' },
    async run({ days }, ctx) {
      const n = clampDays(days, 30);
      const lots = await coverdb.nearExpiry(ctx.hospitalId, n);
      return { days: n, lots: lots.map(l => ({ drug: drugLabel(l), brand: l.brandName, batchNo: l.batchNo, quantity: Number(l.quantity), expiryDate: l.expiryDate, daysToExpiry: l.daysToExpiry, canOfferAsSurplus: Number(l.surplus) || 0 })) };
    },
  },

  find_lenders: {
    description: 'Nearby hospitals that could lend a medicine right now. Runs the same 8 safety rules as a real request (surplus, trust flags, seal, expiry, storage, licences, same medicine, route).',
    args: { drug: 'medicine name, e.g. "carboplatin 450"', maxKm: 'number (default 15)', qty: 'number (optional)' },
    async run({ drug, maxKm, qty }, ctx) {
      const drugs = await findDrugs(drug);
      if (!drugs.length) return { error: `No medicine called "${drug}" in the master list` };
      const km = Number(maxKm) > 0 ? Number(maxKm) : 15;
      const { evaluate } = require('../matching');
      const neededBy = addDays(coverdb.today(), 7);
      const out = [];
      let excluded = 0;
      for (const d of drugs.slice(0, 3)) {
        const ev = await evaluate({ drug_ID: d.ID, hospital_ID: ctx.hospitalId, qty: Number(qty) || 1, neededBy, allowBrandSwitch: true });
        excluded += ev.exclusions.length;
        const byHospital = {};
        for (const c of ev.candidates) {
          const h = byHospital[c.hospitalId] ||= { hospital: shortName(c.hospitalName), drug: drugLabel(d), distanceKm: Math.round(Number(c.distanceKm) * 10) / 10, etaMin: c.etaMin, canLend: 0, batches: [] };
          h.canLend += c.maxQty; h.batches.push(c.batchNo);
        }
        for (const [hid, h] of Object.entries(byHospital)) {
          h.canLend = Math.min(h.canLend, Math.max(0, Number(ev.hospitalCaps[hid] ?? h.canLend)));
          if (h.distanceKm <= km && h.canLend > 0) out.push(h);
        }
      }
      out.sort((a, b) => a.distanceKm - b.distanceKm);
      return { drug: drugs.map(drugLabel).join(' / '), maxKm: km, lenders: out, lotsRuledOutBySafetyRules: excluded };
    },
  },

  stock_of: {
    description: 'Our own usable stock of a medicine, per batch.',
    args: { drug: 'medicine name' },
    async run({ drug }, ctx) {
      const drugs = await findDrugs(drug);
      if (!drugs.length) return { error: `No medicine called "${drug}" in the master list` };
      const lots = await SELECT.from('medilink.Lots').where({ hospital_ID: ctx.hospitalId, drug_ID: { in: drugs.map(d => d.ID) }, quantity: { '>': 0 } });
      const today = coverdb.today();
      return {
        drug: drugs.map(drugLabel).join(' / '),
        totalUsable: lots.filter(l => !l.quarantined && toDay(l.expiryDate) > today).reduce((s, l) => s + Number(l.quantity), 0),
        batches: lots.map(l => ({ drug: drugLabel(drugs.find(d => d.ID === l.drug_ID)), batchNo: l.batchNo, brand: l.brandName, quantity: Number(l.quantity), expiryDate: toDay(l.expiryDate), daysToExpiry: daysBetween(today, l.expiryDate), quarantined: !!l.quarantined })),
      };
    },
  },

  open_deliveries: {
    description: 'Deliveries to or from our hospital that are not finished yet: status, arrival time, temperature problems, closed roads.',
    args: {},
    async run(_args, ctx) {
      const ts = (await SELECT.from('medilink.Transfers').where({ status: { in: ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT'] } }))
        .filter(t => t.supplier_ID === ctx.hospitalId || t.receiver_ID === ctx.hospitalId);
      const drugs = await coverdb.drugsById();
      const names = Object.fromEntries((await SELECT.from('medilink.Hospitals').columns('ID', 'name')).map(h => [h.ID, shortName(h.name)]));
      return {
        deliveries: ts.map(t => ({ drug: drugLabel(drugs[t.drug_ID]), qty: t.qty, direction: t.receiver_ID === ctx.hospitalId ? 'incoming' : 'outgoing', other: names[t.receiver_ID === ctx.hospitalId ? t.supplier_ID : t.receiver_ID], status: String(t.status).toLowerCase().replace(/_/g, ' '), eta: t.eta || null, temperatureProblem: !!t.excursion, roadClosed: !!t.routeClosed })),
      };
    },
  },
};

/** Pick a subset of tools by name (each agent gets only what it needs). */
const pick = (...names) => Object.fromEntries(names.map(n => [n, TOOLS[n]]));

module.exports = { TOOLS, pick, findDrugs, drugLabel, shortName, clampDays, MAX_DAYS };
