import * as vscode from 'vscode';
import { GitService } from './gitService';
import { StatusBarManager } from './statusBar';
import { LogViewProvider } from './logViewProvider';
import { GitDiffContentProvider } from './diffProvider';

export async function activate(context: vscode.ExtensionContext) {
  const gitService = new GitService();
  const statusBar = new StatusBarManager(gitService);
  const logProvider = new LogViewProvider(context.extensionUri, gitService);
  const cfg = vscode.workspace.getConfiguration('ideaGit');
  const autoFetchEnabled = cfg.get<boolean>('autoFetch', true);
  const autoFetchIntervalSec = Math.max(60, cfg.get<number>('autoFetchIntervalSeconds', 300));
  let fetchTimer: NodeJS.Timeout | undefined;
  let isFetching = false;

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('idea-git-diff', new GitDiffContentProvider(gitService)),
    vscode.window.registerWebviewViewProvider(LogViewProvider.viewType, logProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    statusBar
  );

  async function init() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const repos = await gitService.discoverRepos(folders);
    if (repos.length > 0) {
      statusBar.setRepo(repos[0]);
      logProvider.setRepo(repos[0]);
      await statusBar.refresh();
    }
  }

  async function doAutoFetch() {
    if (!autoFetchEnabled || isFetching) { return; }
    const repos = gitService.getRepos();
    if (repos.length === 0) { return; }
    isFetching = true;
    try {
      await Promise.all(repos.map(r => gitService.fetchAll(r.rootPath).catch(() => undefined)));
      await statusBar.refresh();
      logProvider.refresh();
    } finally {
      isFetching = false;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('ideaGit.switchBranch', () => statusBar.switchBranch()),
    vscode.commands.registerCommand('ideaGit.createBranch', async () => {
      const repos = gitService.getRepos();
      if (repos.length === 0) { return; }
      const repo = repos[0];
      const name = await vscode.window.showInputBox({ prompt: '新分支名称', placeHolder: 'feature/my-branch' });
      if (!name) { return; }
      try {
        await gitService.createBranch(repo.rootPath, name);
        vscode.window.showInformationMessage(`已创建并切换到分支: ${name}`);
        await statusBar.refresh();
        logProvider.refresh();
      } catch (e: any) { vscode.window.showErrorMessage(`创建分支失败: ${e.message}`); }
    }),
    vscode.commands.registerCommand('ideaGit.renameBranch', async () => {
      const repos = gitService.getRepos();
      if (repos.length === 0) { return; }
      const repo = repos[0];
      const current = await gitService.getCurrentBranch(repo.rootPath);
      const newName = await vscode.window.showInputBox({ prompt: `重命名分支 "${current}" 为`, value: current });
      if (!newName || newName === current) { return; }
      try {
        await gitService.renameBranch(repo.rootPath, current, newName);
        vscode.window.showInformationMessage(`已将分支 "${current}" 重命名为 "${newName}"`);
        await statusBar.refresh();
        logProvider.refresh();
      } catch (e: any) { vscode.window.showErrorMessage(`重命名分支失败: ${e.message}`); }
    }),
    vscode.commands.registerCommand('ideaGit.deleteBranch', async () => {
      const repos = gitService.getRepos();
      if (repos.length === 0) { return; }
      const repo = repos[0];
      const branches = await gitService.getBranches(repo.rootPath);
      const items = branches.filter(b => !b.current && !b.remote).map(b => b.name);
      const pick = await vscode.window.showQuickPick(items, { placeHolder: '选择要删除的分支' });
      if (!pick) { return; }
      try {
        await gitService.deleteBranch(repo.rootPath, pick, false);
        vscode.window.showInformationMessage(`已删除分支: ${pick}`);
        await statusBar.refresh();
        logProvider.refresh();
      } catch (e: any) { vscode.window.showErrorMessage(`删除分支失败: ${e.message}`); }
    }),
    vscode.commands.registerCommand('ideaGit.openLog', () => {
      vscode.commands.executeCommand('ideaGit.logView.focus');
    }),
    vscode.commands.registerCommand('ideaGit.refresh', () => {
      logProvider.refresh();
      statusBar.refresh();
    }),
    vscode.commands.registerCommand('ideaGit.selectRepo', async () => {
      const repos = gitService.getRepos();
      if (repos.length <= 1) { return; }
      const pick = await vscode.window.showQuickPick(repos.map(r => ({ label: r.name, description: r.rootPath, repo: r })), { placeHolder: '选择仓库' });
      if (!pick) { return; }
      statusBar.setRepo(pick.repo);
      logProvider.setRepo(pick.repo);
      await statusBar.refresh();
      logProvider.refresh();
    }),
    vscode.commands.registerCommand('ideaGit.repoChanged', (repo) => {
      statusBar.setRepo(repo);
      statusBar.refresh();
    })
  );

  async function rescanRepos() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const repos = await gitService.discoverRepos(folders);
    if (repos.length > 0) {
      const current = logProvider.getCurrentRepo();
      const stillExists = current && repos.find(r => r.rootPath === current.rootPath);
      if (!stillExists) {
        statusBar.setRepo(repos[0]);
        logProvider.setRepo(repos[0]);
      }
      await statusBar.refresh();
      logProvider.refresh();
    }
  }

  const headWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  headWatcher.onDidChange(() => { statusBar.refresh(); logProvider.refresh(); });
  context.subscriptions.push(headWatcher);

  const gitDirWatcher = vscode.workspace.createFileSystemWatcher('**/.git', false, true, true);
  gitDirWatcher.onDidCreate(() => { rescanRepos(); });
  context.subscriptions.push(gitDirWatcher);

  const refsWatcher = vscode.workspace.createFileSystemWatcher('**/.git/refs/**');
  refsWatcher.onDidChange(() => { statusBar.refresh(); logProvider.refresh(); });
  refsWatcher.onDidCreate(() => { statusBar.refresh(); logProvider.refresh(); });
  refsWatcher.onDidDelete(() => { statusBar.refresh(); logProvider.refresh(); });
  context.subscriptions.push(refsWatcher);

  vscode.workspace.onDidChangeWorkspaceFolders(() => { rescanRepos(); }, null, context.subscriptions);

  if (autoFetchEnabled) {
    fetchTimer = setInterval(() => { doAutoFetch(); }, autoFetchIntervalSec * 1000);
    context.subscriptions.push(new vscode.Disposable(() => {
      if (fetchTimer) { clearInterval(fetchTimer); fetchTimer = undefined; }
    }));
    setTimeout(() => { doAutoFetch(); }, 3000);
  }

  await init();
}

export function deactivate() {}
