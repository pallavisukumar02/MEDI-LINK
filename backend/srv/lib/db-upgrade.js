'use strict';
/*
 * A database file made by an older checkout (npm run dev keeps backend/db/medilink.sqlite between runs) lacks what
 * newer code added. At start-up, add only what is missing; every existing table, row and column stays as it is:
 *   tables   AgentRuns, AgentProposals (agentic AI)
 *   columns  Hospitals.pricingMultiplier, Lots.unitPrice (price vs distance); synthetic hospitals get their seed price tier
 */
const cds = require('@sap/cds');
const path = require('path');
const LOG = cds.log('medilink');
const TABLES = ['medilink_AgentRuns', 'medilink_AgentProposals'];
const COLUMNS = [['medilink_Hospitals', 'pricingMultiplier', 'DECIMAL(4, 2) DEFAULT 1.00'], ['medilink_Lots', 'unitPrice', 'DECIMAL(10, 2)']];

let ddl;
async function ddlFor(table) {
  ddl ||= cds.compile.to.sql(await cds.load(path.join(__dirname, '..', '..', 'db', 'schema.cds')), { dialect: 'sqlite' });
  return ddl.find(s => new RegExp(`^CREATE TABLE ${table}\\s*\\(`).test(s));
}

async function upgrade(db) {
  const added = [];
  for (const t of TABLES) {
    try { await db.run(`SELECT 1 FROM ${t} LIMIT 1`); } catch { const stmt = await ddlFor(t); if (stmt) { await db.run(stmt); added.push(t); } }
  }
  for (const [t, col, type] of COLUMNS) {
    try { await db.run(`SELECT ${col} FROM ${t} LIMIT 1`); } catch {
      await db.run(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`);
      added.push(`${t}.${col}`);
      if (col === 'pricingMultiplier') {
        let tiers = {}; try { tiers = require('../../../seed/generate').PRICING || {}; } catch { /* seed not shipped */ }
        for (const [id, m] of Object.entries(tiers)) await db.run(`UPDATE medilink_Hospitals SET pricingMultiplier = ? WHERE ID = ? AND synthetic = 1`, [m, id]);
      }
    }
  }
  if (added.length) LOG.info(`database upgraded (data kept): added ${added.join(', ')}`);
  return added;
}

module.exports = { upgrade, ensureTables: upgrade };
