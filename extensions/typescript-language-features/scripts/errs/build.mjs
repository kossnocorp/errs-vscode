/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, mkdir, copyFile, chmod, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const extension = fileURLToPath(new URL('../../', import.meta.url));
const moduleDirectory = path.join(extension, 'src/errs');
const dev = process.argv.includes('--dev');
const output = path.join(extension, 'dist', dev ? 'development' : 'production');
const compiler = process.env.ERRS_REPO || path.resolve(extension, '../../../errs');

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { process.exit(result.status || 1); }
}

// A small standalone toolchain inside the isolated module works with the sparse VS Code checkout.
run('npm', ['ci', '--no-audit', '--no-fund'], moduleDirectory);
run('npm', ['run', 'check'], moduleDirectory);
run('cargo', ['build', '--profile', 'dev', '-p', 'tsrs_cli'], compiler);
const require = createRequire(path.join(moduleDirectory, 'package.json'));
const { build } = require('esbuild');
await mkdir(path.join(output, 'server'), { recursive: true });
await mkdir(path.join(output, 'syntaxes'), { recursive: true });
await build({
	entryPoints: [path.join(moduleDirectory, 'extension.ts')],
	outfile: path.join(output, 'extension.js'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	sourcemap: dev,
	minify: !dev,
});
const metadataResult = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: compiler, encoding: 'utf8' });
if (metadataResult.status !== 0) { throw new Error(metadataResult.stderr); }
const target = JSON.parse(metadataResult.stdout).target_directory;
const binaryName = process.platform === 'win32' ? 'tsrs.exe' : 'tsrs';
// Replace atomically so a running development host can keep using the previous executable on Unix.
const stagedBinary = path.join(output, 'server', `${binaryName}.${process.pid}.tmp`);
await copyFile(path.join(target, 'debug', binaryName), stagedBinary);
await chmod(stagedBinary, 0o755);
await rename(stagedBinary, path.join(output, 'server', binaryName));
// Match the compiler's embedded declarations, but expose real files for editor navigation.
const libraries = path.join(compiler, 'crates/tsrs_vfs/libs');
await mkdir(path.join(output, 'server/libs'), { recursive: true });
await Promise.all((await readdir(libraries)).filter(name => /^lib.*\.d\.ts$/.test(name)).map(name =>
	copyFile(path.join(libraries, name), path.join(output, 'server/libs', name))
));

const upstream = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
const contributes = JSON.parse(await readFile(path.join(moduleDirectory, 'contributes.json'), 'utf8'));
// Keep upstream's large manifest mergeable. The installable package contributes ONLY the isolated ErrorScript mode.
const manifest = {
	name: upstream.name,
	publisher: upstream.publisher,
	displayName: upstream.displayName,
	description: upstream.description,
	version: upstream.version,
	license: upstream.license,
	engines: { vscode: '^1.100.0' },
	categories: ['Programming Languages'],
	main: './extension.js',
	files: ['extension.js', ...(dev ? ['extension.js.map'] : []), 'language-configuration.json', 'error-options.schema.json', 'server/**', 'syntaxes/**', 'LICENSE.txt'],
	activationEvents: contributes.languages.map(language => `onLanguage:${language.id}`),
	capabilities: { untrustedWorkspaces: { supported: false }, virtualWorkspaces: false },
	contributes,
};
await writeFile(path.join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(path.join(moduleDirectory, 'error-options.schema.json'), path.join(output, 'error-options.schema.json'));
// Read the tracked upstream asset without expanding the sparse checkout.
const config = spawnSync('git', ['show', 'HEAD:extensions/typescript-basics/language-configuration.json'], { cwd: extension, encoding: 'utf8' });
if (config.status !== 0) { throw new Error(config.stderr); }
await writeFile(path.join(output, 'language-configuration.json'), config.stdout);
await copyFile(path.resolve(extension, '../../LICENSE.txt'), path.join(output, 'LICENSE.txt'));
const scopes = ['source.ts', 'source.tsx', 'source.js', 'source.js.jsx'];
for (const [index, language] of contributes.languages.entries()) {
	await writeFile(path.join(output, 'syntaxes', `${language.id}.json`), JSON.stringify({
		scopeName: `source.${language.id}`,
		patterns: [{ include: scopes[index] }],
	}));
}
console.log(`ErrorScript extension ready: ${output}`);
