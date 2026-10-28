/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const extension = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(extension, 'dist/editor-test');
const workspace = path.join(output, 'workspace');
const resultFile = path.join(output, 'result.json');
const require = createRequire(path.join(extension, 'src/errs/package.json'));
await mkdir(workspace, { recursive: true });
await rm(resultFile, { force: true });
await writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, target: 'es2022', module: 'nodenext', checkJs: false }, errorOptions: { noUnhandledRootErrors: true, noImplicitReturns: true } }));
await writeFile(path.join(workspace, 'contracts.ts'), "export function wrong(): Returns<number, RangeError> { throw new TypeError('x'); }\nexport function missing() { throw new Error('x'); }\nexport function pure() { return 123; }\n");
await writeFile(path.join(workspace, 'returns-fixes.ts'), await readFile(path.join(extension, 'src/errs/tests/returns-fixes.ts.txt'), 'utf8'));
await writeFile(path.join(workspace, 'returns-fixes-js.js'), await readFile(path.join(extension, 'src/errs/tests/returns-fixes.js.txt'), 'utf8'));
await writeFile(path.join(workspace, 'fix-errors.ts'), "export class ExportedError extends Error { readonly exported = true; }\nexport function makeError() { return new ExportedError('failure'); }\n");
await writeFile(path.join(workspace, 'index.ts'), "import { failure } from './dependency.js';\nimport { CustomError } from './custom error (types).js';\nexport function wrapper() { failure(); }\nexport function combined(error: CustomError | Error) { throw error; }\nwrapper();\n");
await writeFile(path.join(workspace, 'custom error (types).ts'), "const emoji = '😀'; export class CustomError extends Error { constructor(message: string) { super(message); } }\n");
await writeFile(path.join(workspace, 'dependency.js'), "export function failure() { throw new TypeError('original'); }\n");
await writeFile(path.join(workspace, 'promise-dependency.js'), "import { failure } from './dependency.js';\nexport async function rejection() { failure(); return 123; }\n");
await writeFile(path.join(workspace, 'promises.ts'), "import { rejection } from './promise-dependency.js';\nrejection().then(() => {}).catch(error => { error.message; });\nrejection().catch(error => { console.error(error); });\n");
await writeFile(path.join(workspace, 'catches.ts'), "import { failure } from './dependency.js';\ntry { failure(); } catch (error) { error.message; }\ndeclare const flag: boolean;\ntry { if (flag) throw 'text'; throw 123; } catch (value) { if (typeof value === 'string') { value; } else { value; } }\n");
await require('esbuild').build({
	entryPoints: [path.join(extension, 'src/errs/tests/editor.ts')],
	outfile: path.join(output, 'test.cjs'),
	bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
});
const result = spawnSync(process.env.VSCODE_EXECUTABLE || 'code', [
	'--new-window', '--wait', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
	`--user-data-dir=${path.join(output, 'user-data')}`,
	`--extensions-dir=${path.join(output, 'extensions')}`,
	`--extensionDevelopmentPath=${path.join(extension, 'dist/development')}`,
	`--extensionTestsPath=${path.join(output, 'test.cjs')}`,
	...process.argv.slice(2), workspace,
], { stdio: 'inherit', timeout: 120_000, env: { ...process.env, ERRORSCRIPT_TEST_RESULT: resultFile } });
if (result.error) { throw result.error; }
// The code launcher can exit successfully even when the extension test host reports an assertion failure.
const testResult = JSON.parse(await readFile(resultFile, 'utf8'));
if (!testResult.passed) { throw new Error(testResult.error); }
process.exitCode = result.status ?? 1;
console.log('ErrorScript editor integration passed');
