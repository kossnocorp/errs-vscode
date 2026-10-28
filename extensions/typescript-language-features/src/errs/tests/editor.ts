/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';

/** Exercise the installed contribution points, native client, and unsaved dependency synchronization together. */
export async function run(): Promise<void> {
	try {
		await runTests();
		await writeFile(process.env.ERRORSCRIPT_TEST_RESULT!, JSON.stringify({ passed: true }));
	} catch (error) {
		await writeFile(process.env.ERRORSCRIPT_TEST_RESULT!, JSON.stringify({ passed: false, error: String(error) }));
		throw error;
	}
}

async function runTests(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders![0].uri;
	let document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'index.ts'));
	document = await vscode.languages.setTextDocumentLanguage(document, 'errorscript');
	await vscode.window.showTextDocument(document);
	await vscode.extensions.getExtension('nocorp.errorscript')!.activate();
	let position = document.positionAt(document.getText().lastIndexOf('wrapper'));
	const hoverText = async (): Promise<string> => {
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
		return (hovers || []).flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
	};
	const expectHover = async (expected: string): Promise<string> => {
		let text = '';
		for (let attempt = 0; attempt < 100; attempt++) {
			text = await hoverText();
			if (text.includes(expected)) { return text; }
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.fail(`Expected ${expected} in hover, got: ${text}`);
	};
	const expectRootErrors = async (count: number, type?: string): Promise<void> => {
		let errors: vscode.Diagnostic[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			errors = vscode.languages.getDiagnostics(document.uri).filter(error => error.code === 98001);
			if (errors.length === count && (!type || errors.every(error => error.message.includes(type)))) { return; }
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.fail(`Expected ${count} root errors (${type}), got: ${JSON.stringify(errors)}`);
	};
	await expectHover('throws: [`TypeError`](<file://');
	await expectRootErrors(1, 'TypeError');
	position = document.positionAt(document.getText().indexOf('combined'));
	const linkedHover = await expectHover('throws: [`CustomError`](<file://');
	const links = [...linkedHover.matchAll(/\[`(?<name>CustomError|Error)`\]\(<(?<uri>[^>]+)>\)/g)];
	assert.equal(links.length, 2, linkedHover);
	for (const link of links) {
		const { name, uri } = link.groups!;
		const target = vscode.Uri.parse(uri);
		assert.equal(target.scheme, 'file');
		if (name === 'Error') {
			assert.match(target.path, /\/server\/libs\/lib\..*\.d\.ts$/);
		} else {
			assert.equal(target.path, vscode.Uri.joinPath(folder, 'custom error (types).ts').path);
		}
		await vscode.commands.executeCommand('vscode.open', target);
		const editor = vscode.window.activeTextEditor!;
		const start = editor.selection.start;
		assert.equal(editor.document.uri.path, target.path);
		assert.equal(editor.document.getText(new vscode.Range(start, start.translate(0, name.length))), name);
	}
	// Ordinary Go to Definition also resolves Error to openable packaged declarations.
	const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
		'vscode.executeDefinitionProvider', document.uri, document.positionAt(document.getText().indexOf('| Error') + 2)
	);
	assert.ok(definitions?.length);
	for (const definition of definitions) {
		const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
		assert.match(uri.path, /\/server\/libs\/lib\..*\.d\.ts$/);
		assert.ok((await vscode.workspace.openTextDocument(uri)).getText().includes('interface Error'));
	}
	await vscode.window.showTextDocument(document);
	position = document.positionAt(document.getText().lastIndexOf('wrapper'));
	const dependency = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'dependency.js'));
	const edit = new vscode.WorkspaceEdit();
	edit.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)), "export function failure() { throw new RangeError('unsaved'); }");
	await vscode.workspace.applyEdit(edit);
	assert.equal(dependency.isDirty, true);
	await expectHover('throws: [`RangeError`](<file://');
	await expectRootErrors(1, 'RangeError');
	const pureEdit = new vscode.WorkspaceEdit();
	pureEdit.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)), 'export function failure() { return 123; }');
	await vscode.workspace.applyEdit(pureEdit);
	await expectHover('throws: `never`');
	await expectRootErrors(0);
	const restoreEdit = new vscode.WorkspaceEdit();
	restoreEdit.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)), "export function failure() { throw new RangeError('unsaved'); }");
	await vscode.workspace.applyEdit(restoreEdit);
	await expectHover('throws: [`RangeError`](<file://');
	await expectRootErrors(1, 'RangeError');
	await vscode.commands.executeCommand('errorscript.restartServer');
	await expectHover('throws: [`RangeError`](<file://');
	document = await vscode.languages.setTextDocumentLanguage(document, 'typescript');
	assert.equal((await hoverText()).includes('ErrorScript'), false);
	document = await vscode.languages.setTextDocumentLanguage(document, 'errorscript');
	await expectHover('throws: [`RangeError`](<file://');
	const contracts = await vscode.languages.setTextDocumentLanguage(
		await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'contracts.ts')), 'errorscript'
	);
	await vscode.window.showTextDocument(contracts);
	const expectContracts = async (expected: number[]): Promise<void> => {
		let codes: number[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			codes = vscode.languages.getDiagnostics(contracts.uri).map(error => Number(error.code)).sort();
			if (JSON.stringify(codes) === JSON.stringify(expected)) { return; }
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.deepEqual(codes, expected, JSON.stringify(vscode.languages.getDiagnostics(contracts.uri)));
	};
	await expectContracts([98002, 98003]);
	const returnsDefinitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
		'vscode.executeDefinitionProvider', contracts.uri, contracts.positionAt(contracts.getText().indexOf('Returns'))
	);
	assert.ok(returnsDefinitions?.length);
	for (const definition of returnsDefinitions) {
		const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
		assert.match(uri.path, /\/server\/libs\/lib\.es5\.d\.ts$/);
	}
	const contractEdit = new vscode.WorkspaceEdit();
	contractEdit.replace(contracts.uri, new vscode.Range(contracts.positionAt(0), contracts.positionAt(contracts.getText().length)),
		"export function correct(): Returns<number, TypeError> { throw new TypeError('x'); }\nexport function explicit(): Returns<never, Error> { throw new Error('x'); }\nexport function pure() { return 123; }\n");
	await vscode.workspace.applyEdit(contractEdit);
	await expectContracts([]);
	document = await vscode.languages.setTextDocumentLanguage(
		await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'catches.ts')), 'errorscript'
	);
	await vscode.window.showTextDocument(document);
	position = document.positionAt(document.getText().indexOf('error.message'));
	await expectHover('error: RangeError');
	const expectCatchDiagnostics = async (expected: number[]): Promise<void> => {
		let codes: number[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			codes = vscode.languages.getDiagnostics(document.uri).map(error => Number(error.code)).sort();
			if (JSON.stringify(codes) === JSON.stringify(expected)) { return; }
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.deepEqual(codes, expected, `${document.uri}: ${JSON.stringify(vscode.languages.getDiagnostics(document.uri))}\n${document.getText()}`);
	};
	await expectCatchDiagnostics([]);
	position = document.positionAt(document.getText().indexOf('{ value;') + 2);
	await expectHover('value: "text"');
	position = document.positionAt(document.getText().lastIndexOf('{ value;') + 2);
	await expectHover('value: 123');
	const catchEdit = new vscode.WorkspaceEdit();
	catchEdit.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)),
		'export function failure() { throw 123; }');
	await vscode.workspace.applyEdit(catchEdit);
	position = document.positionAt(document.getText().indexOf('error.message'));
	await expectHover('error: 123');
	await expectCatchDiagnostics([2339]);
	const catchRestore = new vscode.WorkspaceEdit();
	catchRestore.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)),
		"export function failure() { throw new RangeError('unsaved'); }");
	await vscode.workspace.applyEdit(catchRestore);
	await expectHover('error: RangeError');
	await expectCatchDiagnostics([]);
	document = await vscode.languages.setTextDocumentLanguage(
		await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'promises.ts')), 'errorscript'
	);
	await vscode.window.showTextDocument(document);
	position = document.positionAt(document.getText().indexOf('error.message'));
	await expectHover('error: RangeError');
	await expectCatchDiagnostics([98001]);
	const rootError = vscode.languages.getDiagnostics(document.uri).find(error => error.code === 98001)!;
	assert.match(rootError.message, /unknown/);
	assert.match(document.getText(rootError.range), /rejection\(\)\.catch/);
	const promiseEdit = new vscode.WorkspaceEdit();
	promiseEdit.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)),
		'export function failure() { throw 123; }');
	await vscode.workspace.applyEdit(promiseEdit);
	await expectHover('error: 123');
	await expectCatchDiagnostics([2339, 98001]);
	for (const [file, language, count] of [
		['returns-fixes.ts', 'errorscript', 12],
		['returns-fixes-js.js', 'errorscriptjavascript', 3],
	] as const) {
		document = await vscode.languages.setTextDocumentLanguage(
			await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, file)), language
		);
		await vscode.window.showTextDocument(document);
		for (let remaining = count; remaining > 0; remaining--) {
			await expectCatchDiagnostics(Array.from({ length: remaining }, () => 98003));
			const diagnostic = vscode.languages.getDiagnostics(document.uri).find(error => error.code === 98003)!;
			assert.ok(!diagnostic.message.includes('Returns<Value, Error>'), diagnostic.message);
			const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
				'vscode.executeCodeActionProvider', document.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value
			);
			const action = actions?.find(action => action.title.startsWith('Add return type Returns<'));
			assert.ok(action?.edit, `Missing Returns quick fix for ${file}: ${diagnostic.message}`);
			assert.ok(diagnostic.message.includes(action.title.slice('Add return type '.length)), action.title);
			await vscode.workspace.applyEdit(action.edit);
		}
		await expectCatchDiagnostics([]);
		if (file.endsWith('.ts')) {
			assert.match(document.getText(), /Returns<"string", CustomError>/);
			assert.match(document.getText(), /\(value\): Returns<number, Error> =>/);
			assert.match(document.getText(), /Returns<Promise<number>, Error>/);
			assert.match(document.getText(), /import\("\.\/fix-errors\.js"\)\.ExportedError/);
		} else {
			assert.match(document.getText(), /@returns \{Returns<number, Error>\} Keep this return description/);
			assert.match(document.getText(), /Keep this documentation/);
		}
	}
	console.log('ErrorScript editor integration passed');
}
