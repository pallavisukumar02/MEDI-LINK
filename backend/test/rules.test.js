const R = require('../srv/lib/rules');
const T = '2026-11-01';
const carb = { ID: 'D-CARB450', genericName: 'Carboplatin', strength: '450 mg/45 mL', dosageForm: 'Injection', storageClass: 'AMBIENT' };
const tras = { ID: 'D-TRAS440', genericName: 'Trastuzumab', strength: '440 mg', dosageForm: 'Powder for injection', storageClass: 'COLD' };
const P1 = { ID: 'P1', active: true, coldChainCertified: true, storageClasses: 'AMBIENT,COLD' };
const P2 = { ID: 'P2', active: true, coldChainCertified: false, storageClasses: 'AMBIENT' };
const lic = { validTill: '2028-01-01', licenceNo: 'X' };

function ctx(over = {}) {
  return {
    request: { qty: 16, neededBy: '2026-11-10', allowBrandSwitch: false, preferredBrand: 'Carbokem' },
    requestDrug: carb, lotDrug: carb,
    lot: { ID: 'L1', drug_ID: 'D-CARB450', brandName: 'Carbokem', manufacturer: 'Sunrise Oncology Ltd', batchNo: 'B1', quantity: 20, expiryDate: '2027-01-01', storageClass: 'AMBIENT', sealed: true },
    maxGivable: 12, flags: [], partners: [P1, P2], partnerLicences: { P1: lic, P2: lic },
    supplierLicence: lic, receiverLicence: lic, transferDate: T, expiryBufferDays: 7,
    route: { open: true, etaMin: 30 }, now: new Date(T + 'T08:00:00Z'),
    ...over,
  };
}
const codes = c => R.evaluateLot(c).exclusions.map(e => e.code);

test('a clean lot is eligible with maxQty = givable quantity', () => {
  expect(R.evaluateLot(ctx())).toEqual({ eligible: true, maxQty: 12, exclusions: [] });
});

test('rule 1 genuine surplus', () => {
  expect(codes(ctx({ maxGivable: 0 }))).toEqual(['NO_GENUINE_SURPLUS']);
  expect(R.rule1({ maxGivable: 0, surplusApplicable: false })).toEqual([]);
});

test('rule 2 trust check: batch flag and manufacturer-wide flag', () => {
  const batchFlag = { batchNo: 'b1', manufacturer: 'Sunrise Oncology Ltd (synthetic)', drug_ID: 'D-CARB450', reason: 'SPURIOUS', active: true };
  expect(codes(ctx({ flags: [batchFlag] }))).toEqual(['FLAGGED_BATCH']);
  expect(codes(ctx({ flags: [{ manufacturer: 'Sunrise Oncology Ltd', reason: 'RECALL', active: true }] }))).toEqual(['FLAGGED_MANUFACTURER']);
  expect(codes(ctx({ flags: [{ ...batchFlag, active: false }] }))).toEqual([]);
  expect(codes(ctx({ flags: [{ ...batchFlag, batchNo: 'OTHER' }] }))).toEqual([]);
  expect(codes(ctx({ flags: [{ batchNo: 'B1', genericName: 'Cisplatin', reason: 'NSQ', active: true }] }))).toEqual([]);
});

test('rule 3 sealed and unopened', () => {
  const c = ctx(); c.lot.sealed = false;
  expect(codes(c)).toEqual(['NOT_SEALED']);
});

test('rule 4 expiry after needed-by + buffer', () => {
  const c = ctx(); c.lot.expiryDate = '2026-11-17'; // needed-by 10th + 7 = 17th -> not strictly after
  expect(codes(c)).toEqual(['EXPIRES_TOO_SOON']);
  c.lot.expiryDate = '2026-11-18';
  expect(codes(c)).toEqual([]);
});

test('rule 5 storage class and cold-chain partner', () => {
  const c = ctx(); c.lot.storageClass = 'COLD';
  expect(codes(c)).toEqual(['STORAGE_MISMATCH']);
  const cold = ctx({ requestDrug: tras, lotDrug: tras, partners: [P2], partnerLicences: { P2: lic }, request: { neededBy: '2026-11-10', allowBrandSwitch: true } });
  cold.lot = { ...cold.lot, drug_ID: 'D-TRAS440', storageClass: 'COLD' };
  expect(codes(cold)).toEqual(['NO_COLD_CHAIN_PARTNER', 'NO_LICENSED_PARTNER']);
});

test('rule 6 licensed supplier, receiver and partner', () => {
  expect(codes(ctx({ supplierLicence: { validTill: '2026-10-31' } }))).toEqual(['SUPPLIER_LICENCE_INVALID']);
  expect(codes(ctx({ receiverLicence: null }))).toEqual(['RECEIVER_LICENCE_INVALID']);
  expect(codes(ctx({ partnerLicences: { P1: { validTill: '2026-01-01' }, P2: { validTill: '2026-01-01' } } }))).toEqual(['NO_LICENSED_PARTNER']);
  expect(codes(ctx({ supplierLicence: { validTill: T } }))).toEqual([]); // valid through the transfer date
});

test('rule 7 same medicine and brand switch', () => {
  expect(codes(ctx({ lotDrug: { ...carb, strength: '150 mg/15 mL' } }))).toEqual(['DIFFERENT_MEDICINE']);
  const c = ctx(); c.lot.brandName = 'Platinex';
  expect(codes(c)).toEqual(['BRAND_SWITCH_NOT_ALLOWED']);
  c.request.allowBrandSwitch = true;
  expect(codes(c)).toEqual([]);
});

test('rule 8 road open and on time', () => {
  expect(codes(ctx({ route: { open: false, note: 'Flooded underpass' } }))).toEqual(['ROUTE_CLOSED']);
  expect(codes(ctx({ route: { open: true, etaMin: 60 * 24 * 30 } }))).toEqual(['ETA_AFTER_NEEDED_BY']);
});

test('every exclusion carries rule number, name, code and detail', () => {
  const c = ctx({ maxGivable: 0, route: { open: false } }); c.lot.sealed = false;
  for (const e of R.evaluateLot(c).exclusions) {
    expect(e).toEqual(expect.objectContaining({ rule: expect.any(Number), ruleName: expect.any(String), code: expect.any(String), detail: expect.any(String) }));
  }
});
