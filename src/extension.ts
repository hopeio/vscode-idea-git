import * as vscode from 'vscode';
import { GitService, GitRepo } from './gitService';
import { StatusBarManager } from './statusBar';
import { LogViewProvider } from './logViewProvider';
import { GitDiffContentProvider } from './diffProvider';
import * as path from 'path';

export async function activate(context: vscode.ExtensionContext) {
  const gitService = new GitService();
  const statusBar = new StatusBarManager(gitService);
  const logProvider = new LogViewProvider(context.extensionUri, gitService);
  const cfg = vscode.workspace.getConfiguration('ideaGit');
  const autoFetchEnabled = cfg.get<boolean>('autoFetch', true);
  const autoFetchIntervalSec = Math.max(60, cfg.get<number>('autoFetchIntervalSeconds', 300));
  let fetchTimer: NodeJS.Timeout | undefined;
  let isFetching = false;
  const LAST_REPO_KEY = 'ideaGit.lastSelectedRepoPath';

  const selectRepo = (repo: { rootPath: string } & { name: string }) => {
    statusBar.setRepo(repo);
    logProvider.setRepo(repo);
    context.workspaceState.update(LAST_REPO_KEY, repo.rootPath);
  };

  const pickInitialRepo = (repos: { name: string; rootPath: string }[]) => {
    const saved = context.workspaceState.get<string>(LAST_REPO_KEY);
    return (saved && repos.find(r => r.rootPath === saved)) || repos[0];
  };

  /** 命令面板操作的目标仓库：Git Log 当前选中项，否则第一个已发现仓库。 */
  const pickRepoForCommands = (): GitRepo | undefined => logProvider.getCurrentRepo() ?? gitService.getRepos()[0];

  context.subscriptions.push(
    { dispose: () => gitService.dispose() },
    vscode.workspace.registerTextDocumentContentProvider('idea-git-diff', new GitDiffContentProvider(gitService)),
    vscode.window.registerWebviewViewProvider(LogViewProvider.viewType, logProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    statusBar,
    vscode.commands.registerCommand('ideaGit.showGitCommandLog', () => gitService.showGitCommandLog())
  );

  async function init() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const repos = await gitService.discoverRepos(folders);
    if (repos.length > 0) {
      selectRepo(pickInitialRepo(repos));
      await statusBar.refresh();
    }
  }

  async function fetchAllRepos(): Promise<boolean> {
    if (isFetching) { return false; }
    const repos = gitService.getRepos();
    if (repos.length === 0) { return false; }
    isFetching = true;
    try {
      await Promise.all(repos.map(r => gitService.fetchAll(r.rootPath).catch(() => undefined)));
      return true;
    } finally {
      isFetching = false;
    }
  }

  async function doAutoFetch() {
    if (!autoFetchEnabled) { return; }
    if (await fetchAllRepos()) {
      await statusBar.refresh();
      logProvider.refresh();
    }
  }

  const toGitPath = (p: string) => p.split(path.sep).join('/');
  const getRepoForFile = async (filePath: string) => {
    let repos = gitService.getRepos();
    if (!repos.length) {
      const folders = vscode.workspace.workspaceFolders;
      if (folders) { repos = await gitService.discoverRepos(folders); }
    }
    return repos
      .filter(r => filePath === r.rootPath || filePath.startsWith(r.rootPath + path.sep))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ideaGit.switchBranch', () => statusBar.switchBranch()),
    vscode.commands.registerCommand('ideaGit.createBranch', async () => {
      const repo = pickRepoForCommands();
      if (!repo) { vscode.window.showWarningMessage('当前工作区未发现 Git 仓库'); return; }
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
      const repo = pickRepoForCommands();
      if (!repo) { vscode.window.showWarningMessage('当前工作区未发现 Git 仓库'); return; }
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
      const repo = pickRepoForCommands();
      if (!repo) { vscode.window.showWarningMessage('当前工作区未发现 Git 仓库'); return; }
      const branches = await gitService.getBranches(repo.rootPath);
      const items = branches.filter(b => !b.current && !b.remote).map(b => b.name);
      const pick = await vscode.window.showQuickPick(items, { placeHolder: '选择要删除的分支' });
      if (!pick) { return; }
      try {
        try {
          await gitService.deleteBranch(repo.rootPath, pick, false);
          vscode.window.showInformationMessage(`已删除分支: ${pick}`);
        } catch (e: any) {
          const text = `${(e as { stderr?: unknown })?.stderr ?? ''}\n${e?.message ?? ''}`;
          if (/not fully merged/i.test(text)) {
            const force = await vscode.window.showWarningMessage(
              `分支 "${pick}" 未完全合并到 HEAD，删除会丢失其独有提交。是否强制删除？`,
              { modal: true, detail: '相当于 git branch -D（不可撤销，请先确认 reflog 仍可找回）。' },
              '强制删除'
            );
            if (force !== '强制删除') { return; }
            await gitService.deleteBranch(repo.rootPath, pick, true);
            vscode.window.showWarningMessage(`已强制删除分支: ${pick}`);
          } else { throw e; }
        }
        await statusBar.refresh();
        logProvider.refresh();
      } catch (e: any) { vscode.window.showErrorMessage(`删除分支失败: ${e.message}`); }
    }),
    vscode.commands.registerCommand('ideaGit.openLog', () => {
      vscode.commands.executeCommand('ideaGit.logView.focus');
    }),
    vscode.commands.registerCommand('ideaGit.refresh', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'IDEA Git: Fetching...' },
        async () => {
          await fetchAllRepos();
          await rescanRepos();
        }
      );
      await statusBar.refresh();
      logProvider.refresh();
    }),
    vscode.commands.registerCommand('ideaGit.selectRepo', async () => {
      const repos = gitService.getRepos();
      if (repos.length <= 1) { return; }
      const pick = await vscode.window.showQuickPick(
        repos.map(r => ({ label: r.name, description: r.rootPath, repo: r })),
        { placeHolder: '选择仓库' }
      );
      if (!pick) { return; }
      selectRepo(pick.repo);
      await statusBar.refresh();
      logProvider.refresh();
    }),
    vscode.commands.registerCommand('ideaGit.fileHistory', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') { return; }
      const repo = await getRepoForFile(target.fsPath);
      if (!repo) {
        vscode.window.showWarningMessage('当前文件不在已识别的 Git 仓库内');
        return;
      }
      const relPath = toGitPath(path.relative(repo.rootPath, target.fsPath));
      await logProvider.openFileHistoryTabWithNativeDiff(repo.rootPath, relPath);
    }),
    vscode.commands.registerCommand('ideaGit.repoChanged', (repo) => {
      statusBar.setRepo(repo);
      if (repo?.rootPath) { context.workspaceState.update(LAST_REPO_KEY, repo.rootPath); }
      statusBar.refresh();
    }),
    vscode.commands.registerCommand('ideaGit.manageExcludedRepos', () => manageExcludedRepos(gitService))
  );

  async function rescanRepos() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const repos = await gitService.discoverRepos(folders);
    if (repos.length > 0) {
      const current = logProvider.getCurrentRepo();
      const stillExists = current && repos.find(r => r.rootPath === current.rootPath);
      if (!stillExists) {
        selectRepo(pickInitialRepo(repos));
      }
      await statusBar.refresh();
      logProvider.refresh();
    }
  }

  const headWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  headWatcher.onDidChange(() => { statusBar.refresh(); logProvider.refresh(); });
  context.subscriptions.push(headWatcher);

  let indexBannerTimer: ReturnType<typeof setTimeout> | undefined;
  const indexWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
  indexWatcher.onDidChange(() => {
    if (indexBannerTimer) { clearTimeout(indexBannerTimer); }
    indexBannerTimer = setTimeout(() => { void logProvider.refreshOpBanner(); }, 250);
  });
  context.subscriptions.push(indexWatcher);

  const gitDirWatcher = vscode.workspace.createFileSystemWatcher('**/.git', false, true, true);
  gitDirWatcher.onDidCreate(() => { rescanRepos(); });
  context.subscriptions.push(gitDirWatcher);

  const refsWatcher = vscode.workspace.createFileSystemWatcher('**/.git/refs/**');
  refsWatcher.onDidChange(() => { statusBar.refresh(); logProvider.refresh(); });
  refsWatcher.onDidCreate(() => { statusBar.refresh(); logProvider.refresh(); });
  refsWatcher.onDidDelete(() => { statusBar.refresh(); logProvider.refresh(); });
  context.subscriptions.push(refsWatcher);

  setupBuiltinGitWatcher(context, statusBar, logProvider).catch(() => { /* ignore */ });

  vscode.workspace.onDidChangeWorkspaceFolders(() => { rescanRepos(); }, null, context.subscriptions);

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('ideaGit.excludeRepos')) { rescanRepos(); }
  }, null, context.subscriptions);

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

/**
 * 通过 QuickPick 让用户从当前工作区可发现的所有仓库里选出要排除的，
 * 结果写入 `ideaGit.excludeRepos`（workspace 级），保存使用 rootPath，避免重名歧义。
 */
async function manageExcludedRepos(gitService: GitService): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { vscode.window.showInformationMessage('没有打开的工作区'); return; }
  const allRepos = await gitService.scanAllReposIgnoringExclude(folders);
  if (!allRepos.length) { vscode.window.showInformationMessage('未发现任何 Git 仓库'); return; }
  const cfg = vscode.workspace.getConfiguration('ideaGit');
  const current = new Set(cfg.get<string[]>('excludeRepos') || []);
  const items: (vscode.QuickPickItem & { rootPath: string })[] = allRepos.map(r => ({
    label: r.name,
    description: r.rootPath,
    picked: current.has(r.rootPath) || current.has(r.name),
    rootPath: r.rootPath,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: '勾选要排除的仓库（按 Enter 保存）',
    matchOnDescription: true,
  });
  if (!picked) { return; }
  const newList = picked.map(i => i.rootPath);
  await cfg.update('excludeRepos', newList, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`已更新排除仓库列表（${newList.length} 项）`);
}

/**
 * 借助 VS Code 内置 `vscode.git` 扩展感知 HEAD/分支变化，比 file system watcher
 * 可靠（默认 watcherExclude 会忽略 .git 目录下的多数文件）。
 */
async function setupBuiltinGitWatcher(
  context: vscode.ExtensionContext,
  statusBar: StatusBarManager,
  logProvider: LogViewProvider,
): Promise<void> {
  const ext = vscode.extensions.getExtension<any>('vscode.git');
  if (!ext) { return; }
  if (!ext.isActive) {
    try { await ext.activate(); } catch { return; }
  }
  const api = ext.exports?.getAPI?.(1);
  if (!api) { return; }
  const seen = new WeakSet<object>();
  const lastHead = new Map<string, string>();
  const onRepoChange = (repo: any) => {
    const head = repo.state?.HEAD;
    const mergeN = repo.state?.mergeChanges?.length ?? 0;
    const rebase = repo.state?.rebasing ? 1 : 0;
    const sig = `${head?.name || ''}@${head?.commit || ''}|m${mergeN}|r${rebase}`;
    const key = repo.rootUri?.fsPath || '';
    if (lastHead.get(key) === sig) { return; }
    lastHead.set(key, sig);
    statusBar.refresh();
    if (mergeN > 0 || rebase) { void logProvider.refreshOpBanner(); }
    else { logProvider.refresh(); }
  };
  const subscribe = (repo: any) => {
    if (!repo || seen.has(repo)) { return; }
    seen.add(repo);
    onRepoChange(repo);
    const sub = repo.state?.onDidChange?.(() => onRepoChange(repo));
    if (sub) { context.subscriptions.push(sub); }
  };
  for (const r of api.repositories || []) { subscribe(r); }
  const opened = api.onDidOpenRepository?.((r: any) => subscribe(r));
  if (opened) { context.subscriptions.push(opened); }
}
