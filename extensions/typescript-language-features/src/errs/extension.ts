/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ErrorScript's isolated entry point. The packaged manifest selects this module rather than the upstream tsserver client.
import * as vscode from 'vscode';
import * as path from 'node:path';
import { access } from 'node:fs/promises';
import { DocumentDiagnosticRequest, LanguageClient, TransportKind } from 'vscode-languageclient/node.js';

const languageIds = ['errorscript', 'errorscriptreact', 'errorscriptjavascript', 'errorscriptjavascriptreact'];
const ordinaryLanguages = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
let client: LanguageClient | undefined;

/** Start the native compiler's language service, which supplies both TS information and error-effect hovers. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('ErrorScript');
	context.subscriptions.push(output);
	const configuredPath = vscode.workspace.getConfiguration('errorscript').get<string>('server.path', '');
	const command = configuredPath || context.asAbsolutePath(path.join('server', process.platform === 'win32' ? 'tsrs.exe' : 'tsrs'));
	try {
		await access(command);
	} catch {
		void vscode.window.showErrorMessage(vscode.l10n.t('ErrorScript compiler not found at {0}. Build the extension or configure errorscript.server.path.', command));
		return;
	}
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}');
	context.subscriptions.push(watcher);
	const languageClient = new LanguageClient('errorscript', 'ErrorScript', {
		command,
		args: ['--errorscript', '--lsp', '-stdio'],
		transport: TransportKind.stdio,
		options: { env: { ...process.env, TSRS_LIB_PATH: context.asAbsolutePath(path.join('server', 'libs')) } },
	}, {
		documentSelector: languageIds.map(language => ({ scheme: 'file', language })),
		outputChannel: output,
		synchronize: { fileEvents: watcher },
		middleware: {
			handleDiagnostics: (uri, diagnostics, next) => {
				const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
				next(uri, document && languageIds.includes(document.languageId) ? diagnostics : []);
			},
		},
	});
	client = languageClient;
	context.subscriptions.push(languageClient);
	await languageClient.start();
	// Ordinary dependencies are outside the provider selector, so their manual synchronization must also
	// invalidate pulled diagnostics for ErrorScript documents (the client only does this for selected files).
	const refreshDependencyDiagnostics = (): void => {
		const feature = languageClient.getFeature(DocumentDiagnosticRequest.method);
		const providers = new Set(vscode.workspace.textDocuments.map(document => feature?.getProvider(document)).filter(provider => provider !== undefined));
		for (const provider of providers) {
			provider.onDidChangeDiagnosticsEmitter.fire();
		}
	};
	// Keep unsaved ordinary TS/JS dependencies in the SAME native project snapshot, while their editor providers
	// remain owned by VS Code's TypeScript extension. Switching language modes closes then reopens the document.
	const openDependency = async (document: vscode.TextDocument): Promise<void> => {
		if (document.uri.scheme === 'file' && ordinaryLanguages.has(document.languageId)) {
			await languageClient.sendNotification('textDocument/didOpen', {
				textDocument: { uri: document.uri.toString(), languageId: document.languageId, version: document.version, text: document.getText() },
			});
			refreshDependencyDiagnostics();
		}
	};
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => void openDependency(document)));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async event => {
		if (event.document.uri.scheme === 'file' && ordinaryLanguages.has(event.document.languageId)) {
			await languageClient.sendNotification('textDocument/didChange', {
				textDocument: { uri: event.document.uri.toString(), version: event.document.version },
				contentChanges: [{ text: event.document.getText() }],
			});
			refreshDependencyDiagnostics();
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(async document => {
		if (document.uri.scheme === 'file' && ordinaryLanguages.has(document.languageId)) {
			await languageClient.sendNotification('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
			refreshDependencyDiagnostics();
		}
	}));
	for (const document of vscode.workspace.textDocuments) {
		await openDependency(document);
	}
	context.subscriptions.push(vscode.commands.registerCommand('errorscript.restartServer', async () => {
		await languageClient.restart();
		for (const document of vscode.workspace.textDocuments) {
			await openDependency(document);
		}
	}));
}

/** Await shutdown so development hosts and installed extensions do not leave a compiler process behind. */
export async function deactivate(): Promise<void> {
	await client?.stop();
	client = undefined;
}
