'use strict';
// SAP Business Accelerator Hub sandbox puller ("SAP hospital", H2). APIKey header; offline fixture fallback.
const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const http = require('./http');
const { ingestSnapshot } = require('./ingest');
const LOG = cds.log('sap');
// Repo layout (dev) or the copy the MTA build places next to the deployed srv (production)
const FIXTURE = [path.resolve(__dirname, '../../../seed/sap-sandbox-fixture.json'), path.resolve(__dirname, '../data/sap-sandbox-fixture.json')].find(f => fs.existsSync(f))
  || path.resolve(__dirname, '../../../seed/sap-sandbox-fixture.json');

async function fetchLive() {
  const h = { APIKey: config.sapHub.key, Accept: 'application/json' };
  const stock = await http.request(`${config.sapHub.base}${config.sapHub.stockPath}/A_MatlStkInAcctMod?$top=500&$format=json`, { headers: h, timeoutMs: 15000 });
  if (stock.status !== 200) throw new Error('stock API status ' + stock.status);
  let batch = { json: { value: [] } };
  try {
    batch = await http.request(`${config.sapHub.base}${config.sapHub.batchPath}/Batch?$top=500`, { headers: h, timeoutMs: 15000 });
    if (batch.status !== 200) throw new Error('batch API status ' + batch.status);
  } catch (e) { LOG.warn('SAP batch API unavailable, expiry from mapping fallback:', e.message); batch = { json: { value: [] } }; }
  return { stock: stock.json, batch: batch.json };
}

function mapToLots(raw, mappings, drugs) {
  const byMat = Object.fromEntries(mappings.map(m => [m.material, m]));
  const expiry = {};
  for (const b of raw.batch?.value || []) expiry[`${b.Material}|${b.Batch}`] = b.ShelfLifeExpirationDate;
  const rows = raw.stock?.d?.results || raw.stock?.value || [];
  const lots = {};
  let unmapped = 0;
  for (const r of rows) {
    const m = byMat[r.Material];
    if (!m || !r.Batch) { unmapped++; continue; }
    const key = `${r.Material}|${r.Batch}`;
    const exp = expiry[key];
    if (!exp) { unmapped++; continue; }
    const lot = lots[key] ||= { lotRef: String(r.Material).replace(/^MLK-/, ''), drugId: m.drug_ID, brandName: m.brandName, manufacturer: m.manufacturer, batchNo: r.Batch, quantity: 0, expiryDate: exp, storageClass: drugs[m.drug_ID]?.storageClass, sealed: true };
    lot.quantity += Number(r.MatlWrhsStkQtyInMatlBaseUnit || 0);
    if (r.InventoryStockType && r.InventoryStockType !== '01') lot.sealed = false; // not unrestricted-use stock => not released/sealed
  }
  return { lots: Object.values(lots), unmapped, rows: rows.length };
}

async function pull(hospitalId = 'H2') {
  const mappings = await SELECT.from('medilink.MaterialMappings').where({ hospital_ID: hospitalId });
  const drugs = Object.fromEntries((await SELECT.from('medilink.Drugs')).map(d => [d.ID, d]));
  let raw, mode = 'fixture', note;
  if (config.sapHub.key) {
    try { raw = await fetchLive(); mode = 'live'; } catch (e) { note = `Sandbox unreachable (${e.message}); used offline fixture`; LOG.warn(note); }
  } else note = 'SAP_API_HUB_KEY not set; used offline fixture';
  if (!raw) raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const { lots, unmapped, rows } = mapToLots(raw, mappings, drugs);
  if (mode === 'live' && lots.length === 0) {
    return { hospitalId, source: 'SAP_SANDBOX', lots: 0, bookings: 0, skipped: unmapped, mode, note: `Sandbox returned ${rows} stock rows but none map to MediLink drugs (add rows to MaterialMappings); existing stock kept` };
  }
  const r = await ingestSnapshot(hospitalId, 'SAP_SANDBOX', { lots }, { actor: 'system:sap-sandbox-sync' });
  return { ...r, skipped: r.skipped + unmapped, mode, note };
}

module.exports = { pull, mapToLots };
