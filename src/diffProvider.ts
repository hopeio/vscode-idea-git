import * as vscode from 'vscode';
import { GitService } from './gitService';

export class GitDiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private gitService: GitService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const repo = decodeURIComponent(params.get('repo') || '');
    const hash = params.get('hash') || '';
    const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    return this.gitService.getFileContent(repo, hash, filePath);
  }
}
