#!/usr/bin/env node
'use strict';
// npm run test:standalone: the whole backend Jest suite again, under the standalone profile (see helpers/env.js).
const { spawnSync } = require('child_process');
const jest = require.resolve('jest/bin/jest');
const r = spawnSync(process.execPath, [jest, '--runInBand', ...process.argv.slice(2)], { cwd: __dirname + '/..', stdio: 'inherit', env: { ...process.env, MEDILINK_TEST_PROFILE: 'standalone' } });
process.exit(r.status ?? 1);
