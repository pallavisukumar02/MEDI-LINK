#!/usr/bin/env node
'use strict';
/*
 * MediLink synthetic seed generator.
 *
 * ALL DATA PRODUCED HERE IS SYNTHETIC. Hospital names are fictional; coordinates are real
 * Bengaluru localities (OpenStreetMap); stock, batches, brands, manufacturers, patients and
 * licences are invented. Drug master entries follow the National List of Essential Medicines
 * (NLEM 2022, section 8 anticancer medicines); unit costs are illustrative.
 *
 * Dates are generated relative to an anchor date (default: today, UTC) so the demo always
 * shows "the next 14 days". Re-run with `npm run seed` (root) whenever the date changes;
 * backend/srv/server.js and mock-medisoft re-run it automatically in development when stale.
 *
 * Writes:
 *   backend/db/data/medilink-*.csv           CAP seed (H2..H5 already connected; H1 onboards live)
 *   mock-medisoft/data/seed.json             MediSoft HIS tenants H1 and H5 (raw MRNs stay inside MediSoft)
 *   connector/seed/init.sql                  Hospital C (H3) pharmacy demo DB (PostgreSQL dialect; npm run connector:seed builds a SQLite copy)
 *   seed/sap-sandbox-fixture.json            Offline fallback for the SAP sandbox puller (H2)
 *   seed/sheets/hebbal_stock_sheet.csv       Sheet-upload sample (H4) with messy column names
 *   seed/trust/cdsco_alert_sample.txt        CDSCO-style alert text for the LLM trust feed
 *   seed/.anchor                             anchor date of the last run
 *
 * Scale test: `npm run seed -- --hospitals 50` adds 45 more synthetic hospitals (H6..H50) to the CAP CSVs for
 * the PRD section 12 performance targets. Run plain `npm run seed` to go back to the 5-hospital demo set
 * (the demo and its tests expect exactly that).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = {
  cap: path.join(ROOT, 'backend', 'db', 'data'),
  medisoft: path.join(ROOT, 'mock-medisoft', 'data'),
  connector: path.join(ROOT, 'connector', 'seed'),
  seed: __dirname,
};
const SEED_REF_SALT = 'synthetic-seed-salt'; // only for refs pre-hashed into CAP CSVs

// ---------- helpers ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hashRef = (salt, mrn) => sha256(`${salt}:${mrn}`);

function anchorDate(env = process.env) {
  if (env.SEED_ANCHOR_DATE) return new Date(env.SEED_ANCHOR_DATE + 'T00:00:00Z');
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function csv(rows, cols) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[;,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return cols.join(';') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(';')).join('\n') + '\n';
}

// ---------- master data ----------
const DRUGS = [
  { ID: 'D-CARB450', genericName: 'Carboplatin', strength: '450 mg/45 mL', dosageForm: 'Injection', storageClass: 'AMBIENT', unitCost: 1850 },
  { ID: 'D-CARB150', genericName: 'Carboplatin', strength: '150 mg/15 mL', dosageForm: 'Injection', storageClass: 'AMBIENT', unitCost: 720 },
  { ID: 'D-CISP50', genericName: 'Cisplatin', strength: '50 mg/50 mL', dosageForm: 'Injection', storageClass: 'AMBIENT', unitCost: 420 },
  { ID: 'D-OXAL100', genericName: 'Oxaliplatin', strength: '100 mg', dosageForm: 'Powder for injection', storageClass: 'AMBIENT', unitCost: 2300 },
  { ID: 'D-PACL260', genericName: 'Paclitaxel', strength: '260 mg/43.4 mL', dosageForm: 'Injection', storageClass: 'AMBIENT', unitCost: 2900 },
  { ID: 'D-DOXO50', genericName: 'Doxorubicin', strength: '50 mg/25 mL', dosageForm: 'Injection', storageClass: 'COLD', unitCost: 650 },
  { ID: 'D-CYCL500', genericName: 'Cyclophosphamide', strength: '500 mg', dosageForm: 'Powder for injection', storageClass: 'AMBIENT', unitCost: 180 },
  { ID: 'D-5FU500', genericName: 'Fluorouracil', strength: '500 mg/10 mL', dosageForm: 'Injection', storageClass: 'AMBIENT', unitCost: 60 },
  { ID: 'D-GEMC1G', genericName: 'Gemcitabine', strength: '1 g', dosageForm: 'Powder for injection', storageClass: 'AMBIENT', unitCost: 1400 },
  { ID: 'D-TRAS440', genericName: 'Trastuzumab', strength: '440 mg', dosageForm: 'Powder for injection', storageClass: 'COLD', unitCost: 28000 },
  { ID: 'D-BORT2', genericName: 'Bortezomib', strength: '2 mg', dosageForm: 'Powder for injection', storageClass: 'AMBIENT', unitCost: 3500 },
  { ID: 'D-RITU500', genericName: 'Rituximab', strength: '500 mg/50 mL', dosageForm: 'Injection', storageClass: 'COLD', unitCost: 26000 },
].map(d => ({ ...d, criticalFlag: true, nlemSection: 'NLEM 2022 s.8' }));
const drugById = Object.fromEntries(DRUGS.map(d => [d.ID, d]));

const BRANDS = { // fictional brands / manufacturers
  'D-CARB450': [['Carbokem', 'Sunrise Oncology Ltd (synthetic)'], ['Platinex', 'Medora Labs (synthetic)']],
  'D-CARB150': [['Carbokem', 'Sunrise Oncology Ltd (synthetic)']],
  'D-CISP50': [['Cisplanova', 'Medora Labs (synthetic)']],
  'D-OXAL100': [['Oxaliva', 'Deccan Biogenerics (synthetic)']],
  'D-PACL260': [['Paxitara', 'Sunrise Oncology Ltd (synthetic)']],
  'D-DOXO50': [['Doxorin', 'Kaveri Pharma (synthetic)']],
  'D-CYCL500': [['Cyclomed', 'Kaveri Pharma (synthetic)']],
  'D-5FU500': [['Fluracil', 'Deccan Biogenerics (synthetic)']],
  'D-GEMC1G': [['Gemzora', 'Medora Labs (synthetic)']],
  'D-TRAS440': [['Herzuma-S', 'Nandi Biologics (synthetic)']],
  'D-BORT2': [['Bortenix', 'Deccan Biogenerics (synthetic)']],
  'D-RITU500': [['Rituvia', 'Nandi Biologics (synthetic)']],
};

function build(anchor, now = new Date()) {
  const rnd = mulberry32(20261101);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const day = n => iso(addDays(anchor, n));
  const nowIso = now.toISOString();

  const HOSPITALS = [
    { ID: 'H1', licenceNo: 'KA-BLR-20B-1001', name: 'City Cancer Hospital, Jayanagar', address: '9th Block, Jayanagar, Bengaluru 560069', lat: 12.929900, long: 77.582600, licenceValidTill: '2028-03-31', software: 'MEDISOFT', connected: false, adminEmail: 'admin.h1@example.org' },
    { ID: 'H2', licenceNo: 'KA-BLR-20B-1002', name: 'Sanjeevani Hospital, Whitefield', address: 'ITPL Main Road, Whitefield, Bengaluru 560066', lat: 12.969800, long: 77.750000, licenceValidTill: '2027-12-31', software: 'SAP_SANDBOX', connected: true, adminEmail: 'admin.h2@example.org' },
    { ID: 'H3', licenceNo: 'KA-BLR-20B-1003', name: 'Lakeside Oncology Centre, Koramangala', address: '5th Block, Koramangala, Bengaluru 560095', lat: 12.935200, long: 77.624500, licenceValidTill: '2028-06-30', software: 'CONNECTOR', connected: true, adminEmail: 'admin.h3@example.org' },
    { ID: 'H4', licenceNo: 'KA-BLR-20B-1004', name: 'Hebbal Community Hospital, Hebbal', address: 'Bellary Road, Hebbal, Bengaluru 560024', lat: 13.035800, long: 77.597000, licenceValidTill: day(-62), software: 'SHEET', connected: true, adminEmail: 'admin.h4@example.org' },
    { ID: 'H5', licenceNo: 'KA-BLR-20B-1005', name: 'Banashankari Care Hospital, Banashankari', address: '2nd Stage, Banashankari, Bengaluru 560070', lat: 12.925500, long: 77.546800, licenceValidTill: '2027-09-30', software: 'MEDISOFT', connected: true, adminEmail: 'admin.h5@example.org' },
  ].map(h => ({ ...h, safetyMarginPct: 20, coverWindowDays: 14, feedStale: false, synthetic: true, lastSyncedAt: h.connected ? nowIso : null }));

  const LICENCES = [
    ...HOSPITALS.map(h => ({ ID: 'LIC-' + h.ID, partyId: h.ID, partyType: 'HOSPITAL', licenceNo: h.licenceNo, licenceType: 'Form 20B/21B drug licence (synthetic)', validTill: h.licenceValidTill })),
    { ID: 'LIC-P1', partyId: 'P1', partyType: 'PARTNER', licenceNo: 'KA-BLR-CC-2001', licenceType: 'Wholesale + cold-chain carrier (synthetic)', validTill: '2027-12-31' },
    { ID: 'LIC-P2', partyId: 'P2', partyType: 'PARTNER', licenceNo: 'KA-BLR-CC-2002', licenceType: 'Wholesale carrier (synthetic)', validTill: '2027-06-30' },
    { ID: 'LIC-P3', partyId: 'P3', partyType: 'PARTNER', licenceNo: 'KA-BLR-CC-2003', licenceType: 'Wholesale + cold-chain carrier (synthetic)', validTill: day(-20) },
  ];
  const PARTNERS = [
    { ID: 'P1', name: 'CoolRoute Logistics (synthetic)', licenceNo: 'KA-BLR-CC-2001', coldChainCertified: true, storageClasses: 'AMBIENT,COLD', active: true, lat: 12.9716, long: 77.5946 },
    { ID: 'P2', name: 'QuickMeds Couriers (synthetic)', licenceNo: 'KA-BLR-CC-2002', coldChainCertified: false, storageClasses: 'AMBIENT', active: true, lat: 12.9580, long: 77.6400 },
    { ID: 'P3', name: 'FrostLine Express (synthetic, licence expired)', licenceNo: 'KA-BLR-CC-2003', coldChainCertified: true, storageClasses: 'AMBIENT,COLD,FROZEN', active: true, lat: 13.0100, long: 77.5500 },
  ];

  // ---- lots & bookings per hospital ----
  const lots = { H1: [], H2: [], H3: [], H4: [], H5: [] };
  const bookings = { H1: [], H2: [], H3: [], H4: [], H5: [] }; // with raw mrn; hashed per destination
  const lot = (h, id, drug, bi, batchNo, quantity, expDays, extra = {}) => {
    const [brandName, manufacturer] = BRANDS[drug][bi];
    lots[h].push({ ID: id, hospital_ID: h, drug_ID: drug, brandName, manufacturer, batchNo, quantity, expiryDate: day(expDays), storageClass: drugById[drug].storageClass, sealed: true, quarantined: false, ...extra });
  };
  const mrnCounter = { H1: 100200, H2: 300400, H3: 500600, H4: 700800, H5: 900100 };
  const prefix = { H1: 'CCH', H2: 'SJV', H3: 'LOC', H4: 'HCH', H5: 'BCH' };
  const intents = ['CURATIVE', 'CURATIVE', 'ADJUVANT', 'NEOADJUVANT', 'PALLIATIVE'];
  const book = (h, drug, dayN, units, intent) => {
    const n = bookings[h].length + 1;
    bookings[h].push({ srcId: `${prefix[h]}-APT-${String(n).padStart(4, '0')}`, mrn: `${prefix[h]}-MRN-${mrnCounter[h]++}`, drug_ID: drug, doseUnits: units, scheduledDate: day(dayN), intent: intent || intents[ri(0, intents.length - 1)] });
  };

  // H1 carboplatin 450: 40 doses booked in 14 days; 24 coverable; 16 short across 9 patients.
  lot('H1', 'H1-CARB-A', 'D-CARB450', 0, 'SOL24C112', 20, 200);
  lot('H1', 'H1-CARB-B', 'D-CARB450', 0, 'SOL24A031', 6, 4);           // expires before later doses
  lot('H1', 'H1-CARB-C', 'D-CARB450', 0, 'SOL24C113', 1, 150, { sealed: false }); // opened vial
  [0, 1, 2, 3].forEach(d => book('H1', 'D-CARB450', d, 1));
  [4, 4, 5, 5, 6, 6, 7, 7, 8, 8].forEach(d => book('H1', 'D-CARB450', d, 2));
  [[9, 2, 'CURATIVE'], [9, 2, 'PALLIATIVE'], [10, 2, 'CURATIVE'], [10, 2, 'ADJUVANT'], [11, 2, 'CURATIVE'],
   [11, 2, 'PALLIATIVE'], [12, 2, 'CURATIVE'], [12, 1, 'NEOADJUVANT'], [13, 1, 'CURATIVE']]
    .forEach(([d, u, i]) => book('H1', 'D-CARB450', d, u, i));

  // H5 donor: near-expiry surplus (same brand as H1)
  lot('H5', 'H5-CARB-A', 'D-CARB450', 0, 'SOL24B077', 12, 45);         // near expiry (< 60 days)
  lot('H5', 'H5-CARB-B', 'D-CARB450', 0, 'SOL25A015', 20, 320);
  lot('H5', 'H5-CARB-C', 'D-CARB450', 0, 'SOL25A019', 5, 300, { storageClass: 'COLD' }); // storage mis-recorded -> rule 5
  [2, 5, 7, 10, 12].forEach(d => book('H5', 'D-CARB450', d, 2));

  // H2 SAP hospital: several rule failures plus one clean same-brand lot
  lot('H2', 'H2-CARB-A', 'D-CARB450', 0, 'SOL24D201', 30, 260);
  lot('H2', 'H2-CARB-B', 'D-CARB450', 1, 'MDL24K450', 15, 210);        // other brand -> rule 7 unless switch allowed
  lot('H2', 'H2-CARB-C', 'D-CARB450', 0, 'SOL24A090', 8, 10);          // expires too soon -> rule 4
  lot('H2', 'H2-CARB-D', 'D-CARB450', 0, 'SOL24C300', 4, 220, { sealed: false }); // opened -> rule 3
  lot('H2', 'H2-C150-A', 'D-CARB150', 0, 'SOL24E015', 40, 240);        // different strength -> rule 7
  [1, 3, 6, 8, 11, 13].forEach(d => book('H2', 'D-CARB450', d, 2));
  lot('H2', 'H2-TRAS-A', 'D-TRAS440', 0, 'NB24T044', 6, 280);          // after 2 vials already shipped to H3

  // H3 connector hospital: flagged lot + no genuine surplus
  lot('H3', 'H3-CARB-A', 'D-CARB450', 1, 'ZX24K07', 25, 180, { brandName: 'Oncocarb', manufacturer: 'Zenvix Pharma (synthetic)' }); // flagged
  lot('H3', 'H3-CARB-B', 'D-CARB450', 0, 'SOL24C150', 14, 190);
  [0, 2, 4, 6, 9, 11, 13].forEach(d => book('H3', 'D-CARB450', d, 2));
  [1, 3, 5].forEach(d => book('H3', 'D-TRAS440', d, 1, 'CURATIVE'));
  lot('H3', 'H3-TRAS-A', 'D-TRAS440', 0, 'NB24T031', 1, 200);

  // H4 sheet hospital, expired licence
  lot('H4', 'H4-CARB-A', 'D-CARB450', 0, 'SOL24B310', 30, 240);
  [3, 8, 12].forEach(d => book('H4', 'D-CARB450', d, 2));

  // Background stock for other drugs: covered (green) everywhere, cisplatin below margin at H1
  const others = ['D-CISP50', 'D-OXAL100', 'D-PACL260', 'D-DOXO50', 'D-CYCL500', 'D-5FU500', 'D-GEMC1G', 'D-BORT2', 'D-RITU500'];
  for (const h of Object.keys(lots)) {
    for (const drug of others) {
      if (rnd() < 0.25 && drug !== 'D-CISP50') continue;
      let demand = 0;
      for (let d = 0; d < 14; d++) if (rnd() < 0.3) { const u = ri(1, 2); demand += u; book(h, drug, d, u); }
      const factor = (h === 'H1' && drug === 'D-CISP50') ? 1.05 : 1.5 + rnd();
      let stock = Math.max(4, Math.ceil(demand * factor));
      if (h === 'H1' && drug === 'D-CISP50') stock = Math.max(1, demand); // covered but below safety margin
      const nLots = stock > 12 ? 2 : 1;
      for (let i = 0; i < nLots; i++) {
        const q = i === nLots - 1 ? stock - Math.floor(stock / nLots) * (nLots - 1) : Math.floor(stock / nLots);
        lot(h, `${h}-${drug.slice(2)}-${i + 1}`, drug, 0, `${drug.slice(2, 6)}${ri(10, 99)}${String.fromCharCode(65 + ri(0, 11))}${ri(100, 999)}`, q, ri(90, 400));
      }
    }
  }

  // ---- CAP CSV rows ----
  const capLots = [];
  const capBookings = [];
  for (const h of ['H2', 'H3', 'H4', 'H5']) {
    const src = { H2: 'SAP_SANDBOX', H3: 'CONNECTOR', H4: 'SHEET', H5: 'MEDISOFT' }[h];
    lots[h].forEach(l => capLots.push({ ...l, source: src, lastSynced: nowIso }));
    bookings[h].forEach(b => capBookings.push({ ID: `${h}:${b.srcId}`, hospital_ID: h, patientRef: hashRef(SEED_REF_SALT, b.mrn), drug_ID: b.drug_ID, doseUnits: b.doseUnits, scheduledDate: b.scheduledDate, intent: b.intent, source: src }));
  }

  const FLAGS = [
    { ID: 'f0000000-0000-4000-8000-000000000001', batchNo: 'ZX24K07', manufacturer: 'Zenvix Pharma (synthetic)', drug_ID: 'D-CARB450', genericName: 'Carboplatin', reason: 'SPURIOUS', source: 'Hand-made recall for demo (synthetic, modelled on CDSCO spurious-drug alerts)', date: day(-12), active: true, synthetic: true },
    { ID: 'f0000000-0000-4000-8000-000000000002', batchNo: 'GZ23M118', manufacturer: 'Medora Labs (synthetic)', drug_ID: 'D-GEMC1G', genericName: 'Gemcitabine', reason: 'NSQ', source: 'Synthetic NSQ entry in CDSCO monthly alert format', date: day(-30), active: true, synthetic: true },
  ];

  // ---- seeded in-transit cold-chain shipment H2 -> H3 (for the excursion demo) ----
  const T1 = 'a0000000-0000-4000-8000-000000000001';
  const R1 = 'b0000000-0000-4000-8000-000000000001';
  const pickedUp = new Date(now.getTime() - 5 * 60000).toISOString();
  const REQUESTS = [{ ID: R1, hospital_ID: 'H3', drug_ID: 'D-TRAS440', qty: 2, neededBy: day(3), allowBrandSwitch: false, preferredBrand: 'Herzuma-S', note: 'Seeded shipment for tracking demo (synthetic)', status: 'IN_PROGRESS' }];
  const TRANSFERS = [{ ID: T1, request_ID: R1, supplier_ID: 'H2', receiver_ID: 'H3', drug_ID: 'D-TRAS440', qty: 2, status: 'IN_TRANSIT', planRank: 1, partner_ID: 'P1', distanceKm: 16.4, etaMin: 75, eta: new Date(now.getTime() + 70 * 60000).toISOString(), repaymentMode: 'IN_KIND', requiresSecondSignoff: true, riskReasons: 'COLD_CHAIN', sealId: 'SEAL-5521', loggerId: 'LOG-7781', pickedUpAt: pickedUp, routeClosed: false, excursion: false, quarantineSuggested: false }];
  const TRANSFER_LOTS = [{ ID: 'c0000000-0000-4000-8000-000000000001', transfer_ID: T1, lot_ID: 'H2-TRAS-A', batchNo: 'NB24T044', qty: 2 }];
  const APPROVALS = [
    { ID: 'd0000000-0000-4000-8000-000000000001', transfer_ID: T1, level: 1, approver: 'meera.h2@example.org', decision: 'APPROVE', decidedAt: pickedUp },
    { ID: 'd0000000-0000-4000-8000-000000000002', transfer_ID: T1, level: 2, approver: 'kiran.h2@example.org', decision: 'APPROVE', decidedAt: pickedUp },
  ];
  const LEDGER = [{ ID: 'e0000000-0000-4000-8000-000000000001', lender_ID: 'H2', borrower_ID: 'H3', drug_ID: 'D-TRAS440', qty: 2, landedCost: 56000, repaymentMode: 'IN_KIND', status: 'OPEN', transfer_ID: T1 }];

  // Audit history for the seeded shipment, hash-chained with the same code the service uses
  const { nextEntry } = require(path.join(ROOT, 'backend', 'srv', 'lib', 'audit-chain.js'));
  const AUDIT = [];
  const seedEvents = [
    ['seed', 'SEED_LOADED', { note: 'Synthetic demo dataset loaded', anchor: iso(anchor) }],
    ['ravi.h2@example.org', 'SUPPLIER_ACCEPTED', { transfer: T1, qty: 2, repaymentMode: 'IN_KIND' }],
    ['meera.h2@example.org', 'APPROVED', { transfer: T1, level: 1 }],
    ['kiran.h2@example.org', 'APPROVED', { transfer: T1, level: 2 }],
    ['partner.p1@example.org', 'PICKUP', { transfer: T1, batchNo: 'NB24T044', sealId: 'SEAL-5521', loggerId: 'LOG-7781' }],
  ];
  let last = null;
  for (const [actor, action, payload] of seedEvents) { last = nextEntry(last, actor, action, payload, new Date(pickedUp)); AUDIT.push(last); }

  const MATERIALS = capLots.filter(l => l.hospital_ID === 'H2').map(l => ({ material: 'MLK-' + l.ID, drug_ID: l.drug_ID, hospital_ID: 'H2', brandName: l.brandName, manufacturer: l.manufacturer }));

  return { HOSPITALS, DRUGS, LICENCES, PARTNERS, lots, bookings, capLots, capBookings, FLAGS, REQUESTS, TRANSFERS, TRANSFER_LOTS, APPROVALS, LEDGER, AUDIT, MATERIALS, anchor: iso(anchor), day };
}

// Real Bengaluru localities (OpenStreetMap); the hospitals placed there are fictional.
const LOCALITIES = [
  ['Malleshwaram', 13.0035, 77.5710], ['Indiranagar', 12.9784, 77.6408], ['Rajajinagar', 12.9910, 77.5550], ['Yelahanka', 13.1007, 77.5963],
  ['Electronic City', 12.8452, 77.6602], ['HSR Layout', 12.9116, 77.6474], ['BTM Layout', 12.9166, 77.6101], ['Marathahalli', 12.9569, 77.7011],
  ['JP Nagar', 12.9063, 77.5857], ['Basavanagudi', 12.9406, 77.5738], ['RT Nagar', 13.0213, 77.5946], ['Bellandur', 12.9304, 77.6784],
  ['Vijayanagar', 12.9719, 77.5370], ['Sadashivanagar', 13.0068, 77.5813], ['KR Puram', 13.0076, 77.6950], ['Banaswadi', 13.0104, 77.6481],
  ['Kengeri', 12.9139, 77.4854], ['Yeshwanthpur', 13.0285, 77.5409], ['Domlur', 12.9610, 77.6387], ['Shivajinagar', 12.9857, 77.6057],
  ['Frazer Town', 12.9967, 77.6143], ['Bommanahalli', 12.9010, 77.6230], ['Hennur', 13.0358, 77.6431], ['Peenya', 13.0285, 77.5197], ['Ulsoor', 12.9817, 77.6194],
];

/**
 * Extra synthetic hospitals H6..H<total> for scale tests: connected, licensed, random stock and bookings for every drug.
 * Returns CAP rows; the 5 demo hospitals are untouched.
 */
function scale(anchor, total = 50, now = new Date()) {
  const rnd = mulberry32(5050);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const day = n => iso(addDays(anchor, n));
  const out = { HOSPITALS: [], LICENCES: [], capLots: [], capBookings: [] };
  for (let i = 6; i <= total; i++) {
    const id = 'H' + i;
    const [loc, lat, long] = LOCALITIES[(i - 6) % LOCALITIES.length];
    const jitter = () => Math.round((rnd() - 0.5) * 0.008 * 1e6) / 1e6;
    const licenceNo = `KA-BLR-20B-${1000 + i}`;
    out.HOSPITALS.push({ ID: id, licenceNo, name: `Synthetic Hospital ${i}, ${loc}`, address: `${loc}, Bengaluru (synthetic)`, lat: Math.round((lat + jitter()) * 1e6) / 1e6, long: Math.round((long + jitter()) * 1e6) / 1e6,
      licenceValidTill: '2028-03-31', software: 'SHEET', safetyMarginPct: 20, coverWindowDays: 14, connected: true, lastSyncedAt: now.toISOString(), feedStale: false, adminEmail: `admin.h${i}@example.org`, synthetic: true });
    out.LICENCES.push({ ID: 'LIC-' + id, partyId: id, partyType: 'HOSPITAL', licenceNo, licenceType: 'Form 20B/21B drug licence (synthetic)', validTill: '2028-03-31' });
    for (const d of DRUGS) {
      if (rnd() < 0.3) continue;
      const [brandName, manufacturer] = BRANDS[d.ID][0];
      const nLots = ri(1, 2);
      for (let k = 1; k <= nLots; k++) {
        out.capLots.push({ ID: `${id}-${d.ID.slice(2)}-${k}`, hospital_ID: id, drug_ID: d.ID, brandName, manufacturer, batchNo: `${d.ID.slice(2, 6)}S${i}${k}${ri(100, 999)}`,
          quantity: ri(5, 40), expiryDate: day(ri(60, 400)), storageClass: d.storageClass, sealed: rnd() > 0.05, quarantined: false, source: 'SHEET', lastSynced: now.toISOString() });
      }
      for (let n = 0, nb = ri(0, 6); n < nb; n++) {
        const appt = `SYN${i}-APT-${d.ID.slice(2)}-${n + 1}`;
        out.capBookings.push({ ID: `${id}:${appt}`, hospital_ID: id, patientRef: hashRef(SEED_REF_SALT, `SYN${i}-MRN-${d.ID}-${n}`), drug_ID: d.ID, doseUnits: ri(1, 2), scheduledDate: day(ri(0, 13)), intent: ['CURATIVE', 'ADJUVANT', 'PALLIATIVE'][ri(0, 2)], source: 'SHEET' });
      }
    }
  }
  return out;
}

function write(data, { quiet } = {}) {
  for (const d of Object.values(OUT)) fs.mkdirSync(d, { recursive: true });
  const w = (name, rows, cols) => fs.writeFileSync(path.join(OUT.cap, `medilink-${name}.csv`), csv(rows, cols));
  w('Hospitals', data.HOSPITALS, ['ID', 'licenceNo', 'name', 'address', 'lat', 'long', 'licenceValidTill', 'software', 'safetyMarginPct', 'coverWindowDays', 'connected', 'lastSyncedAt', 'feedStale', 'adminEmail', 'synthetic']);
  w('Drugs', data.DRUGS, ['ID', 'genericName', 'strength', 'dosageForm', 'criticalFlag', 'storageClass', 'nlemSection', 'unitCost']);
  w('Licences', data.LICENCES, ['ID', 'partyId', 'partyType', 'licenceNo', 'licenceType', 'validTill']);
  w('DeliveryPartners', data.PARTNERS, ['ID', 'name', 'licenceNo', 'coldChainCertified', 'storageClasses', 'active', 'lat', 'long']);
  w('Lots', data.capLots, ['ID', 'hospital_ID', 'drug_ID', 'brandName', 'manufacturer', 'batchNo', 'quantity', 'expiryDate', 'storageClass', 'sealed', 'quarantined', 'source', 'lastSynced']);
  w('Bookings', data.capBookings, ['ID', 'hospital_ID', 'patientRef', 'drug_ID', 'doseUnits', 'scheduledDate', 'intent', 'source']);
  w('Flags', data.FLAGS, ['ID', 'batchNo', 'manufacturer', 'drug_ID', 'genericName', 'reason', 'source', 'date', 'active', 'synthetic']);
  w('Requests', data.REQUESTS, ['ID', 'hospital_ID', 'drug_ID', 'qty', 'neededBy', 'allowBrandSwitch', 'preferredBrand', 'note', 'status']);
  w('Transfers', data.TRANSFERS, ['ID', 'request_ID', 'supplier_ID', 'receiver_ID', 'drug_ID', 'qty', 'status', 'planRank', 'partner_ID', 'distanceKm', 'etaMin', 'eta', 'repaymentMode', 'requiresSecondSignoff', 'riskReasons', 'sealId', 'loggerId', 'pickedUpAt', 'routeClosed', 'excursion', 'quarantineSuggested']);
  w('TransferLots', data.TRANSFER_LOTS, ['ID', 'transfer_ID', 'lot_ID', 'batchNo', 'qty']);
  w('Approvals', data.APPROVALS, ['ID', 'transfer_ID', 'level', 'approver', 'decision', 'decidedAt']);
  w('Ledger', data.LEDGER, ['ID', 'lender_ID', 'borrower_ID', 'drug_ID', 'qty', 'landedCost', 'repaymentMode', 'status', 'transfer_ID']);
  w('AuditLog', data.AUDIT, ['seq', 'actor', 'action', 'payload', 'loggedAt', 'hash', 'prevHash']);
  w('MaterialMappings', data.MATERIALS, ['material', 'drug_ID', 'hospital_ID', 'brandName', 'manufacturer']);

  // ---- mock MediSoft HIS (tenants H1, H5). Raw MRNs live only here, inside the "HIS". ----
  const tenant = (h, user) => ({
    hospitalId: h, licenceNo: data.HOSPITALS.find(x => x.ID === h).licenceNo, user,
    stock: data.lots[h].map(l => ({ itemCode: l.drug_ID, generic: drugById[l.drug_ID].genericName, strength: drugById[l.drug_ID].strength, form: drugById[l.drug_ID].dosageForm, brand: l.brandName, manufacturer: l.manufacturer, batch: l.batchNo, qty: l.quantity, expiry: l.expiryDate, storage: l.storageClass, sealed: l.sealed, lotRef: l.ID })),
    schedule: data.bookings[h].map(b => ({ appointmentId: b.srcId, mrn: b.mrn, itemCode: b.drug_ID, generic: drugById[b.drug_ID].genericName, strength: drugById[b.drug_ID].strength, form: drugById[b.drug_ID].dosageForm, units: b.doseUnits, date: b.scheduledDate, intent: b.intent })),
  });
  fs.writeFileSync(path.join(OUT.medisoft, 'seed.json'), JSON.stringify({
    _note: 'SYNTHETIC demo data for the mock MediSoft HIS. Not real patients or stock.',
    anchor: data.anchor,
    users: [
      { username: 'pharm.jayanagar', password: 'medisoft-demo', displayName: 'Asha (Pharmacist, City Cancer Hospital)', tenant: 'H1' },
      { username: 'pharm.banashankari', password: 'medisoft-demo', displayName: 'Ravi (Pharmacist, Banashankari Care)', tenant: 'H5' },
    ],
    tenants: { H1: tenant('H1'), H5: tenant('H5') },
  }, null, 2));

  // ---- connector PostgreSQL (H3) ----
  const q = s => s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
  const sql = [
    '-- SYNTHETIC "Hospital C" pharmacy database for the MediLink connector demo (Lakeside Oncology Centre, H3).',
    `-- Generated ${data.anchor}. Raw MRNs stay in this database; the connector hashes them before sending.`,
    'DROP VIEW IF EXISTS medilink_stock_v; DROP VIEW IF EXISTS medilink_schedule_v;',
    'DROP TABLE IF EXISTS pharmacy_inventory; DROP TABLE IF EXISTS chemo_schedule; DROP TABLE IF EXISTS item_master;',
    'CREATE TABLE item_master (item_code VARCHAR(20) PRIMARY KEY, generic VARCHAR(80), strength VARCHAR(40), form VARCHAR(40));',
    'CREATE TABLE pharmacy_inventory (inv_id SERIAL PRIMARY KEY, item_code VARCHAR(20) REFERENCES item_master, brand VARCHAR(80), mfr VARCHAR(120), batch VARCHAR(40), qty_on_hand INT, exp_date DATE, storage VARCHAR(10), seal_ok BOOLEAN, lot_ref VARCHAR(40));',
    'CREATE TABLE chemo_schedule (appt_id VARCHAR(30) PRIMARY KEY, mrn VARCHAR(30), patient_name VARCHAR(80), item_code VARCHAR(20) REFERENCES item_master, units INT, appt_date DATE, intent VARCHAR(12));',
    ...DRUGS.map(d => `INSERT INTO item_master VALUES (${q(d.ID)}, ${q(d.genericName)}, ${q(d.strength)}, ${q(d.dosageForm)});`),
    ...data.lots.H3.map(l => `INSERT INTO pharmacy_inventory (item_code, brand, mfr, batch, qty_on_hand, exp_date, storage, seal_ok, lot_ref) VALUES (${q(l.drug_ID)}, ${q(l.brandName)}, ${q(l.manufacturer)}, ${q(l.batchNo)}, ${l.quantity}, ${q(l.expiryDate)}, ${q(l.storageClass)}, ${l.sealed}, ${q(l.ID)});`),
    ...data.bookings.H3.map((b, i) => `INSERT INTO chemo_schedule VALUES (${q(b.srcId)}, ${q(b.mrn)}, ${q('Synthetic Patient ' + (i + 1))}, ${q(b.drug_ID)}, ${b.doseUnits}, ${q(b.scheduledDate)}, ${q(b.intent)});`),
    '-- The two read-only views the connector reads. patient_name is deliberately NOT exposed.',
    'CREATE VIEW medilink_stock_v AS SELECT i.lot_ref, m.generic, m.strength, m.form, i.brand, i.mfr, i.batch, i.qty_on_hand, i.exp_date, i.storage, i.seal_ok FROM pharmacy_inventory i JOIN item_master m ON m.item_code = i.item_code;',
    'CREATE VIEW medilink_schedule_v AS SELECT s.appt_id, s.mrn, m.generic, m.strength, m.form, s.units, s.appt_date, s.intent FROM chemo_schedule s JOIN item_master m ON m.item_code = s.item_code;',
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medilink_ro') THEN CREATE ROLE medilink_ro LOGIN PASSWORD 'medilink_ro'; END IF; END $$;",
    'GRANT SELECT ON medilink_stock_v, medilink_schedule_v TO medilink_ro;',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(OUT.connector, 'init.sql'), sql);

  // ---- SAP sandbox fixture (offline fallback for H2) ----
  const h2 = data.capLots.filter(l => l.hospital_ID === 'H2');
  fs.writeFileSync(path.join(OUT.seed, 'sap-sandbox-fixture.json'), JSON.stringify({
    _note: 'SYNTHETIC offline fixture shaped like API_MATERIAL_STOCK_SRV / api_batch responses. Used when SAP_API_HUB_KEY is empty or the sandbox is unreachable.',
    stock: { d: { results: h2.map(l => ({ Material: 'MLK-' + l.ID, Plant: '1010', StorageLocation: '101A', Batch: l.batchNo, InventoryStockType: l.sealed ? '01' : '02', MatlWrhsStkQtyInMatlBaseUnit: String(l.quantity), MaterialBaseUnit: 'VL' })) } },
    batch: { value: h2.map(l => ({ Material: 'MLK-' + l.ID, Batch: l.batchNo, ShelfLifeExpirationDate: l.expiryDate, Supplier: l.manufacturer })) },
  }, null, 2));

  // ---- sheet sample for H4 with messy headers ----
  fs.mkdirSync(path.join(OUT.seed, 'sheets'), { recursive: true });
  const sheet = ['Item Name,Strength,Form,Brand,Mfr,Batch No,Qty,ExpDt,Store,Sealed?',
    ...data.lots.H4.map(l => [drugById[l.drug_ID].genericName, drugById[l.drug_ID].strength, drugById[l.drug_ID].dosageForm, l.brandName, l.manufacturer, l.batchNo, l.quantity, l.expiryDate.split('-').reverse().join('/'), l.storageClass === 'COLD' ? 'Fridge' : 'Room', l.sealed ? 'Y' : 'N'].map(v => /,/.test(String(v)) ? `"${v}"` : v).join(','))];
  fs.writeFileSync(path.join(OUT.seed, 'sheets', 'hebbal_stock_sheet.csv'), sheet.join('\n') + '\n');

  // ---- CDSCO-style alert sample (text) ----
  fs.mkdirSync(path.join(OUT.seed, 'trust'), { recursive: true });
  fs.writeFileSync(path.join(OUT.seed, 'trust', 'cdsco_alert_sample.txt'), [
    'SYNTHETIC SAMPLE in the layout of a CDSCO monthly drug alert. Not a real alert.',
    'List of drugs declared Not of Standard Quality / Spurious / Adulterated / Misbranded',
    'S.No | Name of Drug | Batch No. | Mfg. Date | Exp. Date | Manufactured by | Reason',
    '1 | Carboplatin Injection 450 mg/45 mL | SOL24Z999 | 01/2024 | 12/2026 | Sunrise Oncology Ltd (synthetic) | Not of standard quality (assay)',
    '2 | Oxaliplatin for Injection 100 mg | OX23Q404 | 03/2023 | 02/2026 | Deccan Biogenerics (synthetic) | Spurious',
  ].join('\n') + '\n');

  fs.writeFileSync(path.join(OUT.seed, '.anchor'), data.anchor + '\n');
  if (!quiet) console.log(`[seed] synthetic seed written for anchor ${data.anchor}: ${data.capLots.length} CAP lots, ${data.capBookings.length} CAP bookings, MediSoft H1/H5, connector H3`);
}

function isStale(env = process.env) {
  try { return fs.readFileSync(path.join(OUT.seed, '.anchor'), 'utf8').trim() !== iso(anchorDate(env)); } catch { return true; }
}

function run(opts = {}) {
  const anchor = anchorDate(opts.env || process.env);
  const data = build(anchor, opts.now || new Date());
  if (opts.hospitals > 5) {
    const x = scale(anchor, opts.hospitals, opts.now || new Date());
    for (const k of Object.keys(x)) data[k] = [...data[k], ...x[k]];
  }
  write(data, opts);
  return data;
}

module.exports = { run, build, scale, isStale, hashRef, anchorDate, SEED_REF_SALT };
if (require.main === module) {
  const i = process.argv.indexOf('--hospitals');
  run({ hospitals: i > 0 ? Number(process.argv[i + 1]) : 5 });
}
