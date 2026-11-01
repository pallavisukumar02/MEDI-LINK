#!/usr/bin/env node
'use strict';
/*
 * npm start  ->  production: the CAP server only, with NODE_ENV=production (works the same in PowerShell and bash).
 * Needs backend/.env (or host variables) with strong AUTH_JWT_SECRET and TOKEN_ENCRYPTION_KEY, and a database from
 * npm run db:init. Production never creates secrets or demo users by itself. Run the matcher and MediSoft separately.
 */
const { spawn } = require('child_process');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..', 'backend');
const cap = spawn(process.execPath, [path.join(BACKEND, 'node_modules', '@sap', 'cds', 'bin', 'serve.js')], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => cap.kill(s));
cap.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
