'use strict';
/*
 * The 8 hard rules (PRD section 9, FR-16). Pure functions: every input is passed in, nothing is
 * read from the database here, so each rule is unit-testable. Each failure is a machine-readable
 * { rule, code, detail } object; a lot is eligible only if the list is empty.
 */
const { toDay, addDays } = require('./cover');

const RULES = {
  1: 'GENUINE_SURPLUS', 2: 'TRUST_CHECK', 3: 'SEALED', 4: 'EXPIRY', 5: 'STORAGE', 6: 'LICENSED', 7: 'SAME_MEDICINE', 8: 'ROUTE',
};
const CODES = {
  NO_GENUINE_SURPLUS: 1,
  FLAGGED_BATCH: 2, FLAGGED_MANUFACTURER: 2,
  NOT_SEALED: 3,
  EXPIRES_TOO_SOON: 4,
  STORAGE_MISMATCH: 5, NO_COLD_CHAIN_PARTNER: 5,
  SUPPLIER_LICENCE_INVALID: 6, RECEIVER_LICENCE_INVALID: 6, NO_LICENSED_PARTNER: 6,
  DIFFERENT_MEDICINE: 7, BRAND_SWITCH_NOT_ALLOWED: 7,
  ROUTE_CLOSED: 8, ETA_AFTER_NEEDED_BY: 8,
};
const fail = (code, detail) => ({ rule: CODES[code], ruleName: RULES[CODES[code]], code, detail });
const norm = s => String(s ?? '').toLowerCase().replace(/\(synthetic\)/g, '').replace(/[^a-z0-9]/g, '');

/** Return the first active flag that matches the lot, or null. */
function matchFlag(lot, lotDrug, flags) {
  for (const f of flags) {
    if (f.active === false) continue;
    const drugOk = f.drug_ID ? f.drug_ID === lot.drug_ID
      : (f.genericName ? norm(f.genericName) === norm(lotDrug?.genericName) : true);
    if (!drugOk) continue;
    const mfrOk = !f.manufacturer || norm(f.manufacturer) === norm(lot.manufacturer);
    if (f.batchNo) {
      if (norm(f.batchNo) === norm(lot.batchNo) && mfrOk) return { flag: f, code: 'FLAGGED_BATCH' };
    } else if (f.manufacturer && mfrOk) {
      return { flag: f, code: 'FLAGGED_MANUFACTURER' };
    }
  }
  return null;
}

const licenceValid = (validTill, onDate) => !!validTill && toDay(validTill) >= toDay(onDate);

function partnerCanCarry(p, storageClass) {
  if (p.active === false) return false;
  const classes = String(p.storageClasses || '').split(',').map(s => s.trim().toUpperCase());
  if (!classes.includes(storageClass)) return false;
  if (storageClass !== 'AMBIENT' && !p.coldChainCertified) return false;
  return true;
}

// ---------- individual rules ----------
const rule1 = ({ maxGivable, surplusApplicable = true }) =>
  surplusApplicable && !(maxGivable > 0) ? [fail('NO_GENUINE_SURPLUS', `Supplier would fall below its own booked demand + safety margin (givable ${maxGivable || 0})`)] : [];

function rule2({ lot, lotDrug, flags }) {
  const m = matchFlag(lot, lotDrug, flags || []);
  return m ? [fail(m.code, `${m.flag.reason} flag on ${m.flag.batchNo ? 'batch ' + lot.batchNo : 'manufacturer ' + lot.manufacturer} (${m.flag.source || 'flag table'})`)] : [];
}

const rule3 = ({ lot }) => (lot.sealed ? [] : [fail('NOT_SEALED', `Lot ${lot.batchNo} is opened/unsealed`)]);

function rule4({ lot, request, expiryBufferDays }) {
  const minExpiry = addDays(request.neededBy, expiryBufferDays);
  return toDay(lot.expiryDate) > minExpiry ? [] : [fail('EXPIRES_TOO_SOON', `Expires ${toDay(lot.expiryDate)}; must be after ${minExpiry} (needed-by + ${expiryBufferDays} days)`)];
}

function rule5({ lot, requestDrug, partners }) {
  const out = [];
  if (lot.storageClass !== requestDrug.storageClass) out.push(fail('STORAGE_MISMATCH', `Lot stored as ${lot.storageClass}; ${requestDrug.genericName} requires ${requestDrug.storageClass}`));
  if (requestDrug.storageClass !== 'AMBIENT' && !(partners || []).some(p => partnerCanCarry(p, requestDrug.storageClass)))
    out.push(fail('NO_COLD_CHAIN_PARTNER', `No delivery partner certified for ${requestDrug.storageClass}`));
  return out;
}

function rule6({ supplierLicence, receiverLicence, partners, partnerLicences, requestDrug, transferDate }) {
  const out = [];
  if (!licenceValid(supplierLicence?.validTill, transferDate)) out.push(fail('SUPPLIER_LICENCE_INVALID', `Supplier licence ${supplierLicence?.licenceNo || '(none)'} not valid on ${toDay(transferDate)} (valid till ${supplierLicence?.validTill || 'n/a'})`));
  if (!licenceValid(receiverLicence?.validTill, transferDate)) out.push(fail('RECEIVER_LICENCE_INVALID', `Receiver licence ${receiverLicence?.licenceNo || '(none)'} not valid on ${toDay(transferDate)}`));
  const ok = (partners || []).some(p => partnerCanCarry(p, requestDrug.storageClass) && licenceValid(partnerLicences?.[p.ID]?.validTill, transferDate));
  if (!ok) out.push(fail('NO_LICENSED_PARTNER', `No licensed delivery partner available for ${requestDrug.storageClass} on ${toDay(transferDate)}`));
  return out;
}

function rule7({ lotDrug, requestDrug, lot, request }) {
  const same = lotDrug && norm(lotDrug.genericName) === norm(requestDrug.genericName) && norm(lotDrug.strength) === norm(requestDrug.strength) && norm(lotDrug.dosageForm) === norm(requestDrug.dosageForm);
  if (!same) return [fail('DIFFERENT_MEDICINE', `${lotDrug?.genericName} ${lotDrug?.strength} ${lotDrug?.dosageForm} is not ${requestDrug.genericName} ${requestDrug.strength} ${requestDrug.dosageForm}`)];
  if (!request.allowBrandSwitch && request.preferredBrand && norm(lot.brandName) !== norm(request.preferredBrand))
    return [fail('BRAND_SWITCH_NOT_ALLOWED', `Brand ${lot.brandName} differs from ${request.preferredBrand} and the request does not allow another brand`)];
  return [];
}

function rule8({ route, request, now = new Date() }) {
  if (!route || route.open === false) return [fail('ROUTE_CLOSED', route?.note || 'Route closed')];
  const arrival = new Date(new Date(now).getTime() + Number(route.etaMin) * 60000);
  const deadline = new Date(toDay(request.neededBy) + 'T23:59:59Z');
  return arrival <= deadline ? [] : [fail('ETA_AFTER_NEEDED_BY', `ETA ${arrival.toISOString()} is after needed-by ${toDay(request.neededBy)}`)];
}

/** Evaluate all 8 rules for one candidate lot. */
function evaluateLot(ctx) {
  const exclusions = [
    ...rule1(ctx), ...rule2(ctx), ...rule3(ctx), ...rule4(ctx),
    ...rule5(ctx), ...rule6(ctx), ...rule7(ctx), ...rule8(ctx),
  ];
  return { eligible: exclusions.length === 0, maxQty: exclusions.length ? 0 : Number(ctx.maxGivable || 0), exclusions };
}

module.exports = { evaluateLot, matchFlag, partnerCanCarry, licenceValid, rule1, rule2, rule3, rule4, rule5, rule6, rule7, rule8, RULES, CODES };
