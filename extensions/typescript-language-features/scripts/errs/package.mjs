/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const extension = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url))], { stdio: 'inherit' });
if (result.status !== 0) { process.exit(result.status || 1); }
const require = createRequire(path.join(extension, 'src/errs/package.json'));
const { createVSIX } = require('@vscode/vsce');
const platform = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[process.platform];
if (!platform) { throw new Error(`Unsupported VSIX platform: ${process.platform}`); }
await createVSIX({
	cwd: path.join(extension, 'dist/production'),
	packagePath: path.join(extension, 'dist', `errorscript-${platform}-${process.arch}.vsix`),
	target: `${platform}-${process.arch}`,
	dependencies: false,
	allowMissingRepository: true,
});
