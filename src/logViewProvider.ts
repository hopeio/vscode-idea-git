import * as vscode from 'vscode';
import { GitService, GitRepo, GitCommit, GitBranch, GitFileChange } from './gitService';

export class LogViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ideaGit.logView';
  private static readonly INITIAL_PAGE_SIZE = 80;
  private static readonly PAGE_SIZE = 200;
  private view?: vscode.WebviewView;
  private currentRepo?: GitRepo;
  private currentLogFilters: { branch?: string; author?: string; after?: string; before?: string; path?: string } = {};
  private defaultBranchFilterAppliedRepo?: string;

  constructor(private extensionUri: vscode.Uri, private gitService: GitService) {}

  setRepo(repo: GitRepo) { this.currentRepo = repo; }
  getCurrentRepo(): GitRepo | undefined { return this.currentRepo; }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try { await this.handleMessage(msg); } catch (e: any) {
        vscode.window.showErrorMessage(e.message);
      }
    });
    this.refresh();
  }

  private async handleMessage(msg: any) {
    if (!this.currentRepo) { return; }
    const repo = this.currentRepo.rootPath;
    switch (msg.type) {
      case 'ready': await this.refresh(); break;
      case 'loadLog': {
        const filters = msg.filters || {};
        this.currentLogFilters = filters;
        const skip = Number(msg.skip || 0);
        const defaultCount = skip > 0 ? LogViewProvider.PAGE_SIZE : LogViewProvider.INITIAL_PAGE_SIZE;
        const maxCount = Number(msg.maxCount || defaultCount);
        const commits = await this.gitService.getLog(repo, { ...filters, skip, maxCount });
        const branches = await this.gitService.getBranches(repo);
        const currentBranch = await this.gitService.getCurrentBranch(repo);
        const tags = await this.gitService.getTags(repo);
        this.postMessage({ type: 'logData', commits, branches, currentBranch, tags, append: !!msg.append, hasMore: commits.length >= maxCount });
        break;
      }
      case 'selectCommit': {
        const files = await this.gitService.getCommitFiles(repo, msg.hash);
        const detail = await this.gitService.getCommitDetail(repo, msg.hash);
        const mergeGroups = await this.gitService.getMergeFileGroups(repo, msg.hash);
        this.postMessage({ type: 'commitFiles', hash: msg.hash, files, detail, mergeGroups });
        break;
      }
      case 'cherryPick':
        await this.gitService.cherryPick(repo, msg.hash);
        vscode.window.showInformationMessage(`Cherry-pick ${msg.hash.slice(0, 7)} 成功`);
        await this.refresh();
        break;
      case 'revert':
        await this.gitService.revertCommit(repo, msg.hash);
        vscode.window.showInformationMessage(`Revert ${msg.hash.slice(0, 7)} 成功`);
        await this.refresh();
        break;
      case 'interactiveRebase': {
        const terminal = vscode.window.createTerminal({ name: 'Git Interactive Rebase', cwd: repo });
        terminal.sendText(`git rebase -i ${msg.hash}~1`);
        terminal.show();
        break;
      }
      case 'showDiff':
        await this.gitService.showFileDiff(repo, msg.hash, msg.filePath);
        break;
      case 'checkoutBranch': {
        try {
          const result = await this.gitService.smartCheckout(repo, msg.branch);
          const cur = await this.gitService.getCurrentBranch(repo);
          if (result.shelved) {
            const restore = await vscode.window.showInformationMessage(
              `已 Shelve 改动并切换到 ${cur}${result.stashRef ? `（${result.stashRef}）` : ''}。是否恢复之前的改动？`,
              '恢复 (Unshelve)', '稍后手动恢复'
            );
            if (restore === '恢复 (Unshelve)') {
              const un = await this.gitService.unshelve(repo);
              if (un.ok) {
                vscode.window.showInformationMessage('改动已恢复');
              } else {
                const open = await vscode.window.showWarningMessage(
                  `Unshelve 出现冲突${result.stashRef ? `（${result.stashRef}）` : ''}，共 ${un.conflictFiles.length} 个文件。`,
                  '打开冲突文件'
                );
                if (open === '打开冲突文件') { await this.gitService.openConflictFiles(repo, un.conflictFiles); }
              }
            }
          } else {
            vscode.window.showInformationMessage(`已切换到分支: ${cur}`);
          }
          this.postMessage({ type: 'branchSwitched', branch: cur });
        } catch (e: any) {
          if (!e.message?.includes('用户取消')) { vscode.window.showErrorMessage(`切换分支失败: ${e.message}`); }
        }
        await this.refresh();
        break;
      }
      case 'switchRepo': {
        const repos = this.gitService.getRepos();
        const target = repos.find(r => r.rootPath === msg.repoPath);
        if (target) {
          this.currentRepo = target;
          this.currentLogFilters = {};
          this.defaultBranchFilterAppliedRepo = undefined;
          vscode.commands.executeCommand('ideaGit.repoChanged', target);
          await this.refresh();
        }
        break;
      }
      case 'newBranchFrom': {
        const name = await vscode.window.showInputBox({ prompt: `从 "${msg.branch}" 新建分支`, placeHolder: 'feature/new-branch' });
        if (!name) { break; }
        await this.gitService.createBranch(repo, name, msg.branch);
        vscode.window.showInformationMessage(`已从 ${msg.branch} 创建并切换到 ${name}`);
        await this.refresh();
        break;
      }
      case 'checkoutAndRebase': {
        const cur = await this.gitService.getCurrentBranch(repo);
        const result = await this.gitService.smartCheckout(repo, msg.branch);
        if (result.shelved) { await vscode.window.showInformationMessage('已 Shelve 改动'); }
        await this.gitService.rebaseBranch(repo, cur);
        vscode.window.showInformationMessage(`已 Checkout ${msg.branch} 并 Rebase onto ${cur}`);
        await this.refresh();
        break;
      }
      case 'compareBranch': {
        try {
          const cur = await this.gitService.getCurrentBranch(repo);
          const files = await this.gitService.compareBranchFiles(repo, msg.branch, cur);
          this.postMessage({ type: 'compareFiles', from: msg.branch, to: cur, files });
        } catch (e: any) { vscode.window.showErrorMessage(`Compare 失败: ${e.message}`); }
        break;
      }
      case 'showBranchDiff':
        await this.gitService.showBranchFileDiff(repo, msg.from, msg.to, msg.filePath);
        break;
      case 'diffWithWorkingTree': {
        try {
          const files = await this.gitService.diffWithWorkTreeFiles(repo, msg.branch);
          this.postMessage({ type: 'compareFiles', from: msg.branch, to: 'Working Tree', fromLabel: msg.branch, toLabel: 'Working Tree', files, diffMode: 'worktree' });
        } catch (e: any) { vscode.window.showErrorMessage(`Diff 失败: ${e.message}`); }
        break;
      }
      case 'showWorkTreeDiff':
        await this.gitService.showWorkTreeFileDiff(repo, msg.ref, msg.filePath);
        break;
      case 'rebaseOnto': {
        const cur = await this.gitService.getCurrentBranch(repo);
        const confirm = await vscode.window.showWarningMessage(`Rebase "${cur}" onto "${msg.branch}"？`, { modal: true }, '确定');
        if (confirm !== '确定') { break; }
        await this.gitService.rebaseBranch(repo, msg.branch);
        vscode.window.showInformationMessage(`已 Rebase ${cur} onto ${msg.branch}`);
        await this.refresh();
        break;
      }
      case 'mergeInto': {
        const cur = await this.gitService.getCurrentBranch(repo);
        const confirm = await vscode.window.showWarningMessage(`Merge "${msg.branch}" into "${cur}"？`, { modal: true }, '确定');
        if (confirm !== '确定') { break; }
        await this.gitService.mergeBranch(repo, msg.branch);
        vscode.window.showInformationMessage(`已 Merge ${msg.branch} into ${cur}`);
        await this.refresh();
        break;
      }
      case 'pullBranch': {
        try {
          const res = await this.gitService.smartUpdateBranch(repo, msg.branch);
          if (res.updated) {
            vscode.window.showInformationMessage(`已更新分支 ${res.branch}${res.shelved ? '（含 Shelve/Unshelve）' : ''}`);
          } else {
            vscode.window.showInformationMessage(`分支 ${res.branch} 已是最新`);
          }
          if (res.unshelveConflicts.length > 0) {
            const open = await vscode.window.showWarningMessage(
              `自动 Unshelve 冲突${res.stashRef ? `（${res.stashRef}）` : ''}，共 ${res.unshelveConflicts.length} 个文件。`,
              '打开冲突文件'
            );
            if (open === '打开冲突文件') { await this.gitService.openConflictFiles(repo, res.unshelveConflicts); }
          }
          await this.refresh();
        } catch (e: any) { vscode.window.showErrorMessage(`Pull 失败: ${e.message}`); }
        break;
      }
      case 'trackedBranchAction': {
        const targetBranch = msg.branch;
        const tracking = msg.tracking;
        if (!targetBranch || !tracking || !msg.action) { break; }
        const ensureTarget = async () => {
          const cur = await this.gitService.getCurrentBranch(repo);
          if (cur !== targetBranch) { await this.gitService.smartCheckout(repo, targetBranch); }
        };
        switch (msg.action) {
          case 'checkout':
            await this.gitService.smartCheckout(repo, tracking);
            break;
          case 'newBranch': {
            const name = await vscode.window.showInputBox({ prompt: `从 "${tracking}" 新建分支`, placeHolder: 'feature/new-branch' });
            if (!name) { break; }
            await this.gitService.createBranch(repo, name, tracking);
            break;
          }
          case 'compare': {
            const files = await this.gitService.compareBranchFiles(repo, tracking, targetBranch);
            this.postMessage({ type: 'compareFiles', from: tracking, to: targetBranch, fromLabel: tracking, toLabel: targetBranch, files });
            break;
          }
          case 'worktree': {
            const files = await this.gitService.diffWithWorkTreeFiles(repo, tracking);
            this.postMessage({ type: 'compareFiles', from: tracking, to: 'Working Tree', fromLabel: tracking, toLabel: 'Working Tree', files, diffMode: 'worktree' });
            break;
          }
          case 'rebase':
            await ensureTarget();
            await this.gitService.rebaseBranch(repo, tracking);
            break;
          case 'merge':
            await ensureTarget();
            await this.gitService.mergeBranch(repo, tracking);
            break;
          case 'pullRebase':
            await ensureTarget();
            await this.gitService.pullFromTracking(repo, tracking, true);
            break;
          case 'pullMerge':
            await ensureTarget();
            await this.gitService.pullFromTracking(repo, tracking, false);
            break;
        }
        await this.refresh();
        break;
      }
      case 'trackedBranchMenu': {
        if (!msg.tracking || !msg.branch) { break; }
        const targetBranch = msg.branch;
        const tracking = msg.tracking;
        const pick = await vscode.window.showQuickPick(
          [
            { label: `Checkout '${tracking}'`, value: 'checkout' },
            { label: `New Branch from '${tracking}'...`, value: 'newBranch' },
            { label: `Compare with '${tracking}'`, value: 'compare' },
            { label: 'Show Diff with Working Tree', value: 'worktree' },
            { label: `Rebase '${targetBranch}' onto '${tracking}'`, value: 'rebase' },
            { label: `Merge '${tracking}' into '${targetBranch}'`, value: 'merge' },
            { label: `Pull into '${targetBranch}' Using Rebase`, value: 'pullRebase' },
            { label: `Pull into '${targetBranch}' Using Merge`, value: 'pullMerge' }
          ],
          { placeHolder: `Tracked Branch '${tracking}'` }
        );
        if (!pick) { break; }
        const ensureTarget = async () => {
          const cur = await this.gitService.getCurrentBranch(repo);
          if (cur !== targetBranch) { await this.gitService.smartCheckout(repo, targetBranch); }
        };
        switch (pick.value) {
          case 'checkout':
            await this.gitService.smartCheckout(repo, tracking);
            break;
          case 'newBranch': {
            const name = await vscode.window.showInputBox({ prompt: `从 "${tracking}" 新建分支`, placeHolder: 'feature/new-branch' });
            if (!name) { break; }
            await this.gitService.createBranch(repo, name, tracking);
            break;
          }
          case 'compare': {
            const files = await this.gitService.compareBranchFiles(repo, tracking, targetBranch);
            this.postMessage({ type: 'compareFiles', from: tracking, to: targetBranch, fromLabel: tracking, toLabel: targetBranch, files });
            break;
          }
          case 'worktree': {
            const files = await this.gitService.diffWithWorkTreeFiles(repo, tracking);
            this.postMessage({ type: 'compareFiles', from: tracking, to: 'Working Tree', fromLabel: tracking, toLabel: 'Working Tree', files, diffMode: 'worktree' });
            break;
          }
          case 'rebase':
            await ensureTarget();
            await this.gitService.rebaseBranch(repo, tracking);
            break;
          case 'merge':
            await ensureTarget();
            await this.gitService.mergeBranch(repo, tracking);
            break;
          case 'pullRebase':
            await ensureTarget();
            await this.gitService.pullFromTracking(repo, tracking, true);
            break;
          case 'pullMerge':
            await ensureTarget();
            await this.gitService.pullFromTracking(repo, tracking, false);
            break;
        }
        await this.refresh();
        break;
      }
      case 'pushBranch': {
        try {
          const res = await this.gitService.smartPushBranch(repo, msg.branch, msg.setUpstream);
          vscode.window.showInformationMessage(`已 Push ${msg.branch}${res.rebased ? '（已自动 Rebase）' : ''}`);
          await this.refresh();
        } catch (e: any) { vscode.window.showErrorMessage(`Push 失败: ${e.message}`); }
        break;
      }
      case 'renameBranch': {
        const newName = await vscode.window.showInputBox({ prompt: `重命名 "${msg.branch}" 为`, value: msg.branch });
        if (!newName || newName === msg.branch) { break; }
        await this.gitService.renameBranch(repo, msg.branch, newName);
        vscode.window.showInformationMessage(`已重命名为 ${newName}`);
        await this.refresh();
        break;
      }
      case 'deleteBranch': {
        await this.gitService.deleteBranch(repo, msg.branch, !!msg.force);
        vscode.window.showInformationMessage(`已删除 ${msg.branch}${msg.force ? '（强制）' : ''}`);
        await this.refresh();
        break;
      }
      case 'createPatch': {
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${msg.hash.slice(0, 7)}.patch`), filters: { 'Patch': ['patch'] } });
        if (!uri) { break; }
        await this.gitService.createPatch(repo, msg.hash, uri.fsPath);
        vscode.window.showInformationMessage(`Patch saved to ${uri.fsPath}`);
        break;
      }
      case 'checkoutRevision':
        await this.gitService.checkoutRevision(repo, msg.hash);
        vscode.window.showInformationMessage(`Checked out ${msg.hash.slice(0, 7)} (detached HEAD)`);
        await this.refresh();
        break;
      case 'compareWithLocal': {
        try {
          const cur = await this.gitService.getCurrentBranch(repo);
          const files = await this.gitService.compareBranchFiles(repo, msg.hash, 'HEAD');
          this.postMessage({ type: 'compareFiles', from: msg.hash, to: 'HEAD', fromLabel: msg.hash.slice(0, 9), toLabel: 'HEAD (' + cur + ')', files });
        } catch (e: any) { vscode.window.showErrorMessage(`Compare 失败: ${e.message}`); }
        break;
      }
      case 'newBranchFromCommit': {
        const name = await vscode.window.showInputBox({ prompt: `从 ${msg.hash.slice(0, 7)} 创建新分支`, placeHolder: 'feature/new-branch' });
        if (!name) { break; }
        await this.gitService.createBranch(repo, name, msg.hash);
        vscode.window.showInformationMessage(`已从 ${msg.hash.slice(0, 7)} 创建分支 ${name}`);
        await this.refresh();
        break;
      }
      case 'newTag': {
        const name = await vscode.window.showInputBox({ prompt: `在 ${msg.hash.slice(0, 7)} 创建 Tag`, placeHolder: 'v1.0.0' });
        if (!name) { break; }
        const tagMsg = await vscode.window.showInputBox({ prompt: 'Tag 信息（留空为 lightweight tag）', placeHolder: '' });
        await this.gitService.createTag(repo, name, msg.hash, tagMsg || undefined);
        vscode.window.showInformationMessage(`已创建 Tag: ${name}`);
        await this.refresh();
        break;
      }
      case 'fixup': {
        const terminal = vscode.window.createTerminal({ name: 'Git Fixup', cwd: repo });
        terminal.sendText(`if git rev-parse --verify ${msg.hash}~2 >/dev/null 2>&1; then GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick ${msg.hash} /fixup ${msg.hash} /'" git rebase -i ${msg.hash}~2; else GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick ${msg.hash} /fixup ${msg.hash} /'" git rebase -i --root; fi`);
        terminal.show();
        break;
      }
      case 'squashInto': {
        const terminal = vscode.window.createTerminal({ name: 'Git Squash Into', cwd: repo });
        terminal.sendText(`if git rev-parse --verify ${msg.hash}~2 >/dev/null 2>&1; then GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick ${msg.hash} /squash ${msg.hash} /'" git rebase -i ${msg.hash}~2; else GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick ${msg.hash} /squash ${msg.hash} /'" git rebase -i --root; fi`);
        terminal.show();
        break;
      }
      case 'dropCommit': {
        const c = await vscode.window.showWarningMessage(`确定 Drop commit ${msg.hash.slice(0, 7)}？此操作不可逆！`, { modal: true }, '确定');
        if (c !== '确定') { break; }
        await this.gitService.dropCommit(repo, msg.hash);
        break;
      }
      case 'pushUpTo': {
        const cur = await this.gitService.getCurrentBranch(repo);
        const c = await vscode.window.showWarningMessage(`Push all commits up to ${msg.hash.slice(0, 7)} on branch ${cur}?`, { modal: true }, '确定');
        if (c !== '确定') { break; }
        await this.gitService.pushUpTo(repo, msg.hash, cur);
        vscode.window.showInformationMessage(`Pushed up to ${msg.hash.slice(0, 7)}`);
        break;
      }
      case 'viewInBrowser': {
        const url = await this.gitService.getRemoteUrl(repo);
        if (!url) { vscode.window.showWarningMessage('No remote origin found'); break; }
        let webUrl = url.replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/');
        webUrl += `/commit/${msg.hash}`;
        vscode.env.openExternal(vscode.Uri.parse(webUrl));
        break;
      }
      case 'editMessage': {
        const newMsg = await vscode.window.showInputBox({ prompt: '修改 Commit 信息', value: msg.oldMessage });
        if (newMsg !== undefined && newMsg !== msg.oldMessage) {
          await this.gitService.editCommitMessage(repo, msg.hash, newMsg);
          vscode.window.showInformationMessage('Commit 信息已修改');
          await this.refresh();
        }
        break;
      }
      case 'resetTo': {
        const mode = await vscode.window.showQuickPick(
          [{ label: 'Soft', description: '文件不变，差异保留在暂存区', detail: 'soft' }, { label: 'Mixed', description: '文件不变，差异不暂存', detail: 'mixed' }, { label: 'Hard', description: '文件回退到目标提交，本地改动丢失', detail: 'hard' }, { label: 'Keep', description: '文件回退到目标提交，但保留本地改动', detail: 'keep' }],
          { placeHolder: `Reset HEAD 到 ${msg.hash.slice(0, 7)}，选择模式` }
        );
        if (!mode) { break; }
        if (mode.detail === 'hard') {
          const confirm = await vscode.window.showWarningMessage(`确定要 Hard Reset 到 ${msg.hash.slice(0, 7)}？所有改动将丢失！`, { modal: true }, '确定');
          if (confirm !== '确定') { break; }
        }
        await this.gitService.resetTo(repo, msg.hash, mode.detail as any);
        vscode.window.showInformationMessage(`已 ${mode.label} Reset 到 ${msg.hash.slice(0, 7)}`);
        await this.refresh();
        break;
      }
      case 'squash': {
        const newMsg = await vscode.window.showInputBox({ prompt: 'Squash 后的 Commit 信息', value: msg.message || '' });
        if (newMsg === undefined) { break; }
        const confirm = await vscode.window.showWarningMessage(`将 Squash ${msg.count} 个提交为一个？`, { modal: true }, '确定');
        if (confirm !== '确定') { break; }
        await this.gitService.squashCommits(repo, msg.oldestHash, msg.newestHash, newMsg);
        vscode.window.showInformationMessage(`已 Squash ${msg.count} 个提交`);
        await this.refresh();
        break;
      }
    }
  }

  postMessage(msg: any) { this.view?.webview.postMessage(msg); }

  async refresh() {
    if (!this.view || !this.currentRepo) { return; }
    try {
      const repo = this.currentRepo.rootPath;
      const [branches, currentBranch, tags] = await Promise.all([
        this.gitService.getBranches(repo), this.gitService.getCurrentBranch(repo), this.gitService.getTags(repo)
      ]);
      const noFilters = !this.currentLogFilters.branch && !this.currentLogFilters.author && !this.currentLogFilters.after && !this.currentLogFilters.before && !this.currentLogFilters.path;
      if (noFilters && this.defaultBranchFilterAppliedRepo !== repo && currentBranch && !currentBranch.startsWith('(')) {
        this.currentLogFilters = { branch: currentBranch };
        this.defaultBranchFilterAppliedRepo = repo;
      }
      const commits = await this.gitService.getLog(repo, { ...this.currentLogFilters, maxCount: LogViewProvider.INITIAL_PAGE_SIZE });
      const repos = this.gitService.getRepos();
      this.postMessage({ type: 'logData', commits, branches, currentBranch, tags, repos, currentRepoPath: repo, activeFilters: this.currentLogFilters, append: false, hasMore: commits.length >= LogViewProvider.INITIAL_PAGE_SIZE });
    } catch (e: any) { vscode.window.showErrorMessage(`刷新失败: ${e.message}`); }
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);--border:var(--vscode-panel-border,#333);--hover:var(--vscode-list-hoverBackground);--active:var(--vscode-list-activeSelectionBackground);--active-fg:var(--vscode-list-activeSelectionForeground);--input-bg:var(--vscode-input-background);--input-fg:var(--vscode-input-foreground);--input-border:var(--vscode-input-border,#444);--badge:var(--vscode-badge-background);--badge-fg:var(--vscode-badge-foreground);--desc:var(--vscode-descriptionForeground,#888)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--fg);background:var(--bg);overflow:hidden;height:100vh}
.root{display:flex;flex-direction:column;height:100vh}
.toolbar{display:flex;align-items:center;gap:8px;padding:4px 10px;border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto}
.tb-search{position:relative;flex-shrink:0}
.tb-search input{background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);padding:3px 6px;border-radius:3px;font-size:12px;width:120px}
.tb-search input:focus{border-color:var(--vscode-focusBorder,#007fd4)}
.tb-dd{position:absolute;top:100%;left:0;right:0;background:var(--vscode-menu-background,#252526);border:1px solid var(--border);border-radius:0 0 4px 4px;max-height:200px;overflow-y:auto;z-index:100;display:none}
.tb-dd.show{display:block}
.tb-dd-item{padding:4px 8px;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-dd-item:hover,.tb-dd-item.hl{background:var(--active);color:var(--active-fg)}
.pill{display:inline-flex;align-items:center;gap:4px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:12px;padding:3px 12px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.pill:hover{border-color:var(--vscode-focusBorder,#007fd4)}
.pill.on{background:var(--badge);color:var(--badge-fg);border-color:var(--badge)}
.pill .x{font-size:13px;margin-left:2px;opacity:.7;cursor:pointer}
.pill .x:hover{opacity:1}
.tb-sep{width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 2px}
.tb-select{background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);padding:2px 4px;border-radius:3px;font-size:11px;max-width:130px}
.date-picker{position:fixed;display:flex;align-items:center;gap:6px;background:var(--vscode-menu-background,#252526);border:1px solid var(--border);border-radius:4px;padding:8px 10px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.date-picker input{background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);padding:3px 6px;border-radius:3px;font-size:12px}
.date-picker button{background:var(--badge);color:var(--badge-fg);border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:12px}
.main{display:flex;flex:1;overflow:hidden}
.branch-panel{width:200px;min-width:140px;border-right:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column}
.bp-toolbar{display:flex;align-items:center;padding:4px 6px;gap:4px;border-bottom:1px solid var(--border);flex-shrink:0}
.toggle-btn{background:none;border:1px solid var(--input-border);color:var(--fg);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px;line-height:16px}
.toggle-btn.active{background:var(--badge);color:var(--badge-fg);border-color:var(--badge)}
.bp-content{flex:1;overflow-y:auto}
.sec-hd{padding:6px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--desc);cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px}
.sec-hd:hover{background:var(--hover)}
.sec-hd .arr{display:inline-block;width:10px;font-size:10px}
.branch-item{padding:3px 10px 3px 20px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;display:flex;align-items:center;gap:5px}
.branch-item:hover{background:var(--hover)}
.branch-item.cur{font-weight:600;color:#7ee787}
.branch-item .bi{width:12px;text-align:center;flex-shrink:0;font-size:11px}
.branch-item .blabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.branch-item .bsync{margin-left:auto;display:inline-flex;gap:4px;color:#6ea8fe;font-size:11px;flex-shrink:0}
.tdir{padding:3px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;color:var(--desc);user-select:none}
.tdir:hover{background:var(--hover)}
.tdir .arr{display:inline-block;width:10px;font-size:10px;color:#a0a0a0}
.tdir .dir-ico{display:inline-block;width:14px;text-align:center}
.tdir.compact{padding-top:2px;padding-bottom:2px;font-size:11px;opacity:.9}
.tdir .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dir-hint{font-size:10px;opacity:.55;margin-left:4px;letter-spacing:.2px}
.tdir-ch{}
.log-area{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.log-scroll{flex:1;overflow-y:auto;overflow-x:hidden}
.log-header{display:flex;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--desc);position:sticky;top:0;z-index:2;background:var(--bg)}
.log-header>div{padding:4px 8px}
.log-row{display:flex;align-items:center;cursor:pointer;border-bottom:1px solid var(--border);min-height:26px}
.log-row:hover{background:var(--hover)}
.log-row.selected{background:var(--active);color:var(--active-fg)}
.log-row.merge{opacity:.55}
.log-row.merge:hover{opacity:.75}
.log-row.merge.selected{opacity:1}
.col-graph{width:120px;flex-shrink:0;overflow:hidden}
.col-msg{flex:1;padding:2px 8px;white-space:nowrap;overflow:hidden;min-width:60px;display:flex;align-items:center;gap:4px}
.msg-text{overflow:hidden;text-overflow:ellipsis;flex-shrink:1;min-width:0}
.msg-refs{flex-shrink:0;max-width:50%;overflow:hidden;text-overflow:ellipsis;display:inline-flex;gap:2px}
.col-author{width:80px;flex-shrink:0;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.col-date{width:120px;flex-shrink:0;padding:2px 4px;white-space:nowrap;font-size:11px;color:var(--desc)}
.col-hash{width:70px;flex-shrink:0;padding:2px 4px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;color:var(--desc)}
.ref-tag{display:inline-block;padding:0 5px;margin:0 2px;border-radius:3px;font-size:10px;font-weight:600;line-height:18px}
.ref-branch{background:#2ea04380;color:#7ee787}.ref-remote{background:#1f6feb80;color:#79c0ff}
.ref-head{background:#f0883e80;color:#ffa657}.ref-tag-label{background:#8b949e40;color:#8b949e}
.multi-info{padding:4px 10px;font-size:11px;background:var(--badge);color:var(--badge-fg);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
.multi-info button{background:rgba(255,255,255,.15);color:inherit;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px}
.multi-info button:hover{background:rgba(255,255,255,.25)}
.files-panel{width:220px;min-width:140px;border-left:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column}
.fp-header{display:flex;align-items:center;justify-content:space-between;padding:4px 10px;font-weight:600;font-size:11px;border-bottom:1px solid var(--border);flex-shrink:0}
.fp-header .fp-btns{display:flex;gap:3px}
.fp-content{flex:1;overflow-y:auto}
.fp-resize{height:4px;cursor:row-resize;flex-shrink:0;border-top:1px solid var(--border)}
.fp-resize:hover{background:var(--vscode-focusBorder,#007fd4)}
.fp-detail{padding:8px 10px;font-size:12px;height:120px;overflow-y:auto;flex-shrink:0;white-space:pre-wrap;word-break:break-word;color:var(--fg);font-family:var(--vscode-editor-font-family,monospace);line-height:1.5;background:var(--vscode-editor-background)}
.fp-group{padding:4px 10px;font-size:11px;font-weight:600;color:var(--desc);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none}
.fp-group:hover{background:var(--hover)}
.fp-group .cnt{background:var(--badge);color:var(--badge-fg);padding:0 6px;border-radius:8px;font-size:10px}
.fp-group-ch{}
.file-item{padding:3px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-item:hover{background:var(--hover)}
.fst{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.fdir{padding:3px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px;color:var(--desc);user-select:none}
.fdir:hover{background:var(--hover)}
.fdir .arr{display:inline-block;width:10px;font-size:10px}
.fdir .dir-ico{display:inline-block;width:14px;text-align:center}
.fdir.compact{padding-top:2px;padding-bottom:2px;font-size:11px;opacity:.9}
.fdir .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fdir-ch{}
.ctx-menu{position:fixed;background:var(--vscode-menu-background,#252526);border:1px solid var(--border);border-radius:4px;padding:4px 0;z-index:9999;min-width:200px;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.ctx-menu-item{padding:5px 12px;cursor:pointer;font-size:12px;white-space:nowrap;display:flex;align-items:center;gap:8px}
.ctx-icon{width:16px;text-align:center;flex-shrink:0;font-size:14px;opacity:.8}
.ctx-menu-item:hover{background:var(--active);color:var(--active-fg)}
.ctx-sep{height:1px;background:var(--border);margin:4px 0}
.ctx-sub-arrow{margin-left:auto;opacity:.8}
.repo-select{margin-right:6px}
.hidden{display:none}
.resize-handle{width:4px;cursor:col-resize;flex-shrink:0}
.resize-handle:hover{background:var(--vscode-focusBorder,#007fd4)}
</style></head>
<body>
<div class="root">
  <div class="toolbar" id="toolbar">
    <select class="tb-select" id="repoSelect" title="选择仓库" style="display:none"></select>
    <div class="tb-search">
      <input id="branchInput" placeholder="Branch or tag" autocomplete="off">
      <div class="tb-dd" id="branchDD"></div>
    </div>
    <div class="tb-search">
      <input id="searchInput" placeholder="Text or hash" autocomplete="off">
    </div>
    <div class="tb-sep"></div>
    <div id="filterArea" style="display:flex;gap:8px;align-items:center"></div>
    <div class="tb-search">
      <input id="pathInput" placeholder="Paths" autocomplete="off" style="width:100px">
    </div>
    <div class="pill" id="pillReset" title="Reset all filters" style="display:none">Reset</div>
  </div>
  <div class="date-picker hidden" id="datePicker" style="display:none">
    <input type="date" id="dpFrom" title="From"><span style="color:var(--desc)">~</span><input type="date" id="dpTo" title="To">
    <button id="dpApply">OK</button>
  </div>
  <div class="main">
    <div class="branch-panel" id="branchPanel">
      <div class="bp-toolbar">
        <button class="toggle-btn active" id="bpTree" title="Tree view">Tree</button>
        <button class="toggle-btn" id="bpFlat" title="Flat view">Flat</button>
      </div>
      <div class="bp-content" id="bpContent"></div>
    </div>
    <div class="resize-handle" id="resizeLeft"></div>
    <div class="log-area">
      <div id="multiBar" class="multi-info hidden"></div>
      <div class="log-scroll" id="logScroll">
        <div class="log-header" id="logHeader">
          <div class="col-graph">Graph</div>
          <div class="col-msg">Commit</div>
          <div class="col-author">Author</div>
          <div class="col-date">Date</div>
          <div class="col-hash">Hash</div>
        </div>
        <div id="logBody"></div>
      </div>
    </div>
    <div class="resize-handle" id="resizeRight"></div>
    <div class="files-panel" id="filesPanel">
      <div class="fp-header">
        <span id="fpTitle">Changed Files</span>
        <div class="fp-btns">
          <button class="toggle-btn active" id="fpTree" title="Tree view">Tree</button>
          <button class="toggle-btn" id="fpFlat" title="Flat view">Flat</button>
        </div>
      </div>
      <div class="fp-content" id="filesList"></div>
      <div class="fp-resize" id="fpResize"></div>
      <div class="fp-detail hidden" id="commitDetail"></div>
    </div>
  </div>
</div>
<div class="ctx-menu hidden" id="ctxMenu"></div>
<div class="ctx-menu hidden" id="ctxSubMenu"></div>
<script>
const vscode=acquireVsCodeApi();
let allCommits=[],allBranches=[],allTags=[],currentBranch='';
let selectedHashes=new Set(),lastClickedIdx=-1;
let branchViewMode='tree', filesViewMode='tree';
let currentFilesHash=null, currentFiles=[], currentDetail=null, currentMergeGroups=null;
const LOG_INITIAL_PAGE_SIZE=80;
const LOG_PAGE_SIZE=200;
let logHasMore=true,logLoadingMore=false,currentLoadFilters={};
const $=id=>document.getElementById(id);

window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type==='logData'){
    if(m.activeFilters){
      filters.branch=m.activeFilters.branch||'';
      filters.author=m.activeFilters.author||'';
      filters.after=m.activeFilters.after||'';
      filters.before=m.activeFilters.before||'';
      filters.path=m.activeFilters.path||'';
      $('pathInput').value=filters.path||'';
    }
    const incoming=m.commits||[];
    if(m.append){
      const seen=new Set(allCommits.map(c=>c.hash));
      for(const c of incoming){if(!seen.has(c.hash))allCommits.push(c);}
    }else{
      allCommits=incoming;
    }
    allBranches=m.branches||allBranches;allTags=m.tags||allTags;currentBranch=m.currentBranch||currentBranch;
    logHasMore=typeof m.hasMore==='boolean'?m.hasMore:(incoming.length>=LOG_PAGE_SIZE);
    logLoadingMore=false;
    if(m.repos)renderRepoSelect(m.repos,m.currentRepoPath);
    renderBranches();renderBranchFilter();renderAuthorList();renderFilterBar();renderLog(allCommits);
  }else if(m.type==='commitFiles'){
    currentFilesHash=m.hash;currentFiles=m.files||[];currentDetail=m.detail||null;currentMergeGroups=m.mergeGroups||null;renderFiles(currentFiles,m.hash);
  }else if(m.type==='compareFiles'){
    renderCompareFiles(m.from,m.to,m.files||[],m.fromLabel||m.from,m.toLabel||m.to,m.diffMode||'');
  }else if(m.type==='branchSwitched'){
    if(m.branch&&typeof m.branch==='string'){
      filters.branch=m.branch;
      renderFilterBar();
      highlightBranch(m.branch);
      applyF();
    }
  }
});

/* ===== Repo ===== */
function renderRepoSelect(repos,cur){
  const s=$('repoSelect');
  if(repos.length<=1){s.style.display='none';return;}
  s.style.display='';s.innerHTML=repos.map(r=>'<option value="'+esc(r.rootPath)+'"'+(r.rootPath===cur?' selected':'')+'>'+eh(r.name)+'</option>').join('');
}
$('repoSelect').onchange=e=>{
  filters.branch='';filters.author='';filters.after='';filters.before='';filters.path='';
  $('branchInput').value='';$('searchInput').value='';$('pathInput').value='';
  filterBranchPanel('');renderFilterBar();
  vscode.postMessage({type:'switchRepo',repoPath:e.target.value});
};

/* ===== Branch Panel ===== */
$('bpTree').onclick=()=>{branchViewMode='tree';$('bpTree').classList.add('active');$('bpFlat').classList.remove('active');renderBranches();};
$('bpFlat').onclick=()=>{branchViewMode='flat';$('bpFlat').classList.add('active');$('bpTree').classList.remove('active');renderBranches();};

function renderBranches(){
  const p=$('bpContent'),lo=allBranches.filter(b=>!b.remote),rm=allBranches.filter(b=>b.remote);
  let h='';
  if(currentBranch){
    h+='<div class="branch-item cur" data-branch="'+esc(currentBranch)+'" style="padding:5px 10px;font-weight:600">\\u2605 HEAD ('+eh(currentBranch)+')</div>';
  }
  h+=secHd('Local');
  h+='<div class="sec-body">';
  if(branchViewMode==='tree')h+=buildBTree(lo);
  else for(const b of lo)h+=bLeaf(b,20);
  h+='</div>';
  h+=secHd('Remote');
  h+='<div class="sec-body">';
  if(branchViewMode==='tree')h+=buildBTree(rm);
  else for(const b of rm)h+=bLeaf(b,20);
  h+='</div>';
  h+=secHd('Tags');
  h+='<div class="sec-body">';
  if(allTags.length){
    if(branchViewMode==='tree'){
      const tagBranches=allTags.map(t=>({name:t,remote:false,current:false}));
      h+=buildBTree(tagBranches,true);
    }else{
      for(const t of allTags)h+='<div class="branch-item tag-item" data-branch="'+esc(t)+'" style="padding-left:20px"><span class="bi">\\u{1F3F7}</span>'+eh(t)+'</div>';
    }
  }else{
    h+='<div style="padding:4px 20px;color:var(--desc);font-size:11px">No tags</div>';
  }
  h+='</div>';
  p.innerHTML=h;
  p.querySelectorAll('.sec-hd').forEach(el=>{
    el.onclick=()=>{const s=el.nextElementSibling;if(!s)return;const v=s.style.display==='none';s.style.display=v?'':'none';el.querySelector('.arr').textContent=v?'\\u25BC':'\\u25B6';};
  });
  p.querySelectorAll('.tdir').forEach(el=>{
    el.onclick=()=>{
      const s=el.nextElementSibling;if(!s||!s.classList.contains('tdir-ch'))return;
      const v=s.style.display==='none';
      s.style.display=v?'':'none';
      el.querySelector('.arr').textContent=v?'\\u25BC':'\\u25B6';
      const ico=el.querySelector('.dir-ico');
      if(ico)ico.textContent=v?'\\u{1F4C2}':'\\u{1F4C1}';
    };
  });
  p.querySelectorAll('.branch-item').forEach(el=>{bindBI(el);});
}

function secHd(t){return '<div class="sec-hd"><span class="arr">\\u25BC</span>'+eh(t)+'</div>';}

function buildBTree(branches,isTag){
  const tree={};
  for(const b of branches){
    const pts=b.name.split('/');let nd=tree;
    for(let i=0;i<pts.length-1;i++){const k='d_'+pts[i];if(!nd[k])nd[k]={};nd=nd[k];}
    nd['L_'+b.name]=isTag?{...b,isTag:true}:b;
  }
  return rBNode(tree,0);
}

function compactDirChain(name,node){
  let merged=name,cur=node;
  while(cur){
    const ks=Object.keys(cur),dirs=ks.filter(k=>k.startsWith('d_')),leaves=ks.filter(k=>k.startsWith('L_')||k.startsWith('f_'));
    if(leaves.length||dirs.length!==1)break;
    const nk=dirs[0];
    merged+='/'+nk.slice(2);
    cur=cur[nk];
  }
  return {name:merged,node:cur};
}

function rBNode(nd,dep){
  let h='';const indent=10+dep*16;const dirs=[],leaves=[];
  for(const k of Object.keys(nd)){if(k.startsWith('L_'))leaves.push(nd[k]);else if(k.startsWith('d_'))dirs.push({key:k.slice(2),node:nd[k]});}
  dirs.sort((a,b)=>a.key.localeCompare(b.key));
  for(const d of dirs){
    const c=compactDirChain(d.key,d.node);
    const compact=c.name.includes('/');
    h+='<div class="tdir'+(compact?' compact':'')+'" style="padding-left:'+indent+'px"><span class="arr">\\u25BC</span><span class="dir-ico">\\u{1F4C2}</span><span class="path">'+eh(c.name)+'</span>'+(compact?'<span class="dir-hint">compact</span>':'')+'</div>';
    h+='<div class="tdir-ch">';h+=rBNode(c.node,dep+1);h+='</div>';
  }
  for(const b of leaves)h+=bLeaf(b,indent+16);
  return h;
}

function bLeaf(b,indent){
  const c=b.name===currentBranch?' cur':'';
  const ico=b.isTag?'\\u{1F3F7}':(b.name===currentBranch?'\\u2B50':(b.remote?'\\u{1F310}':'\\u{1F33F}'));
  const lbl=branchViewMode==='tree'?b.name.split('/').pop():b.name;
  let sync='';
  if(!b.remote){
    if((b.behind||0)>0)sync+='<span title="Need pull">\\u2199 '+b.behind+'</span>';
    if((b.ahead||0)>0)sync+='<span title="Need push">\\u2197 '+b.ahead+'</span>';
  }
  return '<div class="branch-item'+c+'" data-branch="'+esc(b.name)+'"'+(b.tracking?' data-tracking="'+esc(b.tracking)+'"':'')+' style="padding-left:'+indent+'px"><span class="bi">'+ico+'</span><span class="blabel">'+eh(lbl)+'</span>'+(sync?'<span class="bsync">'+sync+'</span>':'')+'</div>';
}

function bindBI(el){
  el.onclick=()=>{filters.branch=el.dataset.branch;applyF();highlightBranch(el.dataset.branch);};
  el.ondblclick=()=>{filters.branch=el.dataset.branch;applyF();highlightBranch(el.dataset.branch);};
  el.oncontextmenu=ev=>{
    ev.preventDefault();ev.stopPropagation();
    const br=el.dataset.branch, isCur=el.classList.contains('cur');
    const tracking=el.dataset.tracking;
    const items=[];
    items.push({icon:'\\u21AA',label:'Checkout',action:()=>vscode.postMessage({type:'checkoutBranch',branch:br})});
    items.push({icon:'\\u2B07',label:'Update',action:()=>vscode.postMessage({type:'pullBranch',branch:br})});
    items.push({icon:'\\u{1F680}',label:'Push...',action:()=>vscode.postMessage({type:'pushBranch',branch:br,setUpstream:true})});
    items.push({icon:'\\u{1F33F}',label:'New Branch from \\''+br+'\\'...',action:()=>vscode.postMessage({type:'newBranchFrom',branch:br})});
    items.push({sep:1});
    if(!isCur){
      items.push({icon:'\\u{1F501}',label:'Rebase \\''+currentBranch+'\\' onto \\''+br+'\\'',action:()=>vscode.postMessage({type:'rebaseOnto',branch:br})});
      items.push({icon:'\\u{1F500}',label:'Merge \\''+br+'\\' into \\''+currentBranch+'\\'',action:()=>vscode.postMessage({type:'mergeInto',branch:br})});
      items.push({sep:1});
    }
    if(!isCur){
      items.push({icon:'\\u{1F50D}',label:'Compare with \\''+currentBranch+'\\'',action:()=>vscode.postMessage({type:'compareBranch',branch:br})});
    }
    items.push({icon:'\\u{1F4C4}',label:'Show Diff with Working Tree',action:()=>vscode.postMessage({type:'diffWithWorkingTree',branch:br})});
    items.push({sep:1});
    if(tracking){
      items.push({icon:'\\u{1F517}',label:'Tracked Branch \\''+tracking+'\\'',children:[
        {icon:'\\u21AA',label:'Checkout',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'checkout'})},
        {icon:'\\u{1F33F}',label:'New Branch from \\''+tracking+'\\'...',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'newBranch'})},
        {sep:1},
        {icon:'\\u{1F501}',label:'Rebase \\''+br+'\\' onto \\''+tracking+'\\'',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'rebase'})},
        {icon:'\\u{1F500}',label:'Merge \\''+tracking+'\\' into \\''+br+'\\'',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'merge'})},
        {sep:1},
        {icon:'\\u{1F50D}',label:'Compare with \\''+tracking+'\\'',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'compare'})},
        {icon:'\\u{1F4C4}',label:'Show Diff with Working Tree',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'worktree'})},
        {icon:'\\u2B07',label:'Pull into \\''+br+'\\' Using Rebase',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'pullRebase'})},
        {icon:'\\u2B07',label:'Pull into \\''+br+'\\' Using Merge',action:()=>vscode.postMessage({type:'trackedBranchAction',branch:br,tracking,action:'pullMerge'})}
      ]});
    }
    items.push({sep:1});
    items.push({icon:'\\u270F',label:'Rename...',action:()=>vscode.postMessage({type:'renameBranch',branch:br})});
    if(!isCur){
      items.push({icon:'\\u{1F5D1}',label:'Delete',action:()=>vscode.postMessage({type:'deleteBranch',branch:br,force:false})});
    }
    showCtx(ev.clientX,ev.clientY,items);
  };
}

function renderBranchFilter(){}
function renderAuthorList(){}

/* ===== Graph ===== */
const CC=['#e06c75','#61afef','#98c379','#c678dd','#e5c07b','#56b6c2','#be5046','#d19a66'];
function buildGraph(cs){
  const ln=[],r=[];
  for(let i=0;i<cs.length;i++){
    const c=cs[i];let my=ln.indexOf(c.hash);
    if(my===-1){my=ln.indexOf(null);if(my===-1){my=ln.length;ln.push(c.hash);}else ln[my]=c.hash;}
    const nd={lane:my,color:CC[my%CC.length],cn:[],nL:ln.length};
    for(let l=0;l<ln.length;l++){if(ln[l]!==null&&ln[l]!==c.hash)nd.cn.push({f:l,t:l,c:CC[l%CC.length]});}
    ln[my]=null;
    for(let p=0;p<c.parents.length;p++){
      const ph=c.parents[p];let tl=ln.indexOf(ph);
      if(tl===-1){if(p===0){tl=my;ln[my]=ph;}else{tl=ln.indexOf(null);if(tl===-1){tl=ln.length;ln.push(ph);}else ln[tl]=ph;}}
      nd.cn.push({f:my,t:tl,c:CC[tl%CC.length]});
    }
    while(ln.length>0&&ln[ln.length-1]===null)ln.pop();
    nd.nL=Math.max(nd.nL,ln.length);r.push(nd);
  }return r;
}
function gSvg(g){
  if(!g)return '';const W=16,H=26,w=Math.max((g.nL+1)*W,60);
  let s='<svg width="'+w+'" height="'+H+'" viewBox="0 0 '+w+' '+H+'">';
  for(const cn of g.cn){const x1=cn.f*W+W/2,x2=cn.t*W+W/2;
    if(x1===x2)s+='<line x1="'+x1+'" y1="0" x2="'+x2+'" y2="'+H+'" stroke="'+cn.c+'" stroke-width="1.5"/>';
    else s+='<path d="M'+x1+' 0C'+x1+' '+(H/2)+' '+x2+' '+(H/2)+' '+x2+' '+H+'" stroke="'+cn.c+'" stroke-width="1.5" fill="none"/>';}
  s+='<circle cx="'+(g.lane*W+W/2)+'" cy="'+(H/2)+'" r="4" fill="'+g.color+'"/></svg>';return s;
}

/* ===== Log ===== */
let filteredCommits=[];
function renderLog(cs){
  const q=$('searchInput').value.toLowerCase();filteredCommits=cs;
  if(q)filteredCommits=filteredCommits.filter(c=>c.message.toLowerCase().includes(q)||c.hash.startsWith(q)||c.author.toLowerCase().includes(q));
  const gn=buildGraph(filteredCommits),sc=$('logBody');let h='';
  for(let i=0;i<filteredCommits.length;i++){
    const c=filteredCommits[i],sel=selectedHashes.has(c.hash)?' selected':'';
    const refs=c.refs.map(r=>{
      if(r.startsWith('HEAD'))return '<span class="ref-tag ref-head">'+eh(r)+'</span>';
      if(r.includes('origin/')||r.includes('remotes/'))return '<span class="ref-tag ref-remote">'+eh(r)+'</span>';
      if(r.startsWith('tag:'))return '<span class="ref-tag ref-tag-label">'+eh(r)+'</span>';
      return '<span class="ref-tag ref-branch">'+eh(r)+'</span>';}).join('');
    const isMerge=c.parents&&c.parents.length>1?' merge':'';
    const starred=isAuthorDifferentFromCommitter(c);
    h+='<div class="log-row'+sel+isMerge+'" data-hash="'+c.hash+'" data-idx="'+i+'" data-msg="'+esc(c.message)+'">'
      +'<div class="col-graph">'+gSvg(gn[i])+'</div><div class="col-msg"><span class="msg-text">'+eh(c.message)+'</span>'+(refs?'<span class="msg-refs" title="'+esc(c.refs.join('\\n'))+'">'+refs+'</span>':'')+'</div>'
      +'<div class="col-author">'+(starred?'<b>'+eh(c.author)+'*</b>':eh(c.author))+'</div><div class="col-date">'+fD(c.date)+'</div>'
      +'<div class="col-hash">'+c.abbrevHash+'</div></div>';
  }
  sc.innerHTML=h;
  sc.querySelectorAll('.log-row').forEach(row=>{row.onclick=e=>onRow(e,row);row.oncontextmenu=e=>ctxCommit(e,row);});
  applyColWidths();
  upMulti();
}
function onRow(e,row){
  const idx=+row.dataset.idx;
  if(e.shiftKey&&lastClickedIdx>=0){
    const lo=Math.min(lastClickedIdx,idx),hi=Math.max(lastClickedIdx,idx);selectedHashes.clear();
    for(let i=lo;i<=hi;i++)selectedHashes.add(filteredCommits[i].hash);
    $('logScroll').querySelectorAll('.log-row').forEach(r=>{r.classList.toggle('selected',selectedHashes.has(r.dataset.hash));});upMulti();
  }else{
    selectedHashes.clear();selectedHashes.add(row.dataset.hash);
    $('logScroll').querySelectorAll('.log-row.selected').forEach(r=>r.classList.remove('selected'));
    row.classList.add('selected');lastClickedIdx=idx;
    vscode.postMessage({type:'selectCommit',hash:row.dataset.hash});upMulti();
  }
}
function upMulti(){
  const bar=$('multiBar');
  if(selectedHashes.size<=1){bar.classList.add('hidden');return;}
  bar.classList.remove('hidden');
  bar.innerHTML='Selected <b>'+selectedHashes.size+'</b> commits <button id="btnSq">Squash</button>';
  $('btnSq').onclick=doSq;
}
function doSq(){
  if(selectedHashes.size<2)return;const idxs=[];
  for(let i=0;i<filteredCommits.length;i++){if(selectedHashes.has(filteredCommits[i].hash))idxs.push(i);}
  idxs.sort((a,b)=>a-b);
  const old=filteredCommits[idxs[idxs.length-1]],nw=filteredCommits[idxs[0]];
  vscode.postMessage({type:'squash',oldestHash:old.hash,newestHash:nw.hash,message:idxs.map(i=>filteredCommits[i].message).join('\\n'),count:selectedHashes.size});
}
function ctxCommit(e,row){
  e.preventDefault();if(!selectedHashes.has(row.dataset.hash))onRow(e,row);
  const hash=row.dataset.hash,msg=row.dataset.msg;
  const idx=+row.dataset.idx;
  if(selectedHashes.size>1){
    showCtx(e.clientX,e.clientY,[
      {icon:'\\u{1F4E6}',label:'Squash '+selectedHashes.size+' commits',action:doSq},{sep:1},
      {icon:'\\u2716',label:'Drop '+selectedHashes.size+' commits',action:()=>{for(const h of selectedHashes)vscode.postMessage({type:'dropCommit',hash:h});}},{sep:1},
      {icon:'\\u{1F4CB}',label:'Copy Commit Hashes',action:()=>{navigator.clipboard.writeText([...selectedHashes].join('\\n'));}}
    ]);return;
  }
  const parentHash=idx<filteredCommits.length-1?filteredCommits[idx+1].hash:null;
  const childHash=idx>0?filteredCommits[idx-1].hash:null;
  showCtx(e.clientX,e.clientY,[
    {icon:'\\u{1F4CB}',label:'Copy Revision Number',action:()=>{navigator.clipboard.writeText(hash);}},
    {icon:'\\u{1F352}',label:'Cherry-Pick',action:()=>vscode.postMessage({type:'cherryPick',hash})},
    {sep:1},
    {icon:'\\u{1F50D}',label:'Compare with Local',action:()=>vscode.postMessage({type:'compareWithLocal',hash})},
    {sep:1},
    {icon:'\\u21A9',label:'Reset Current Branch to Here...',action:()=>vscode.postMessage({type:'resetTo',hash})},
    {icon:'\\u238C',label:'Revert Commit',action:()=>vscode.postMessage({type:'revert',hash})},
    {sep:1},
    {icon:'\\u270F',label:'Edit Commit Message...',action:()=>vscode.postMessage({type:'editMessage',hash,oldMessage:msg})},
    {icon:'\\u{1F527}',label:'Fixup...',action:()=>vscode.postMessage({type:'fixup',hash})},
    {icon:'\\u{1F4E5}',label:'Squash Into...',action:()=>vscode.postMessage({type:'squashInto',hash})},
    {icon:'\\u2716',label:'Drop Commit',action:()=>vscode.postMessage({type:'dropCommit',hash})},
    {icon:'\\u{1F680}',label:'Push All up to Here...',action:()=>vscode.postMessage({type:'pushUpTo',hash})},
    {sep:1},
    {icon:'\\u{1F33F}',label:'New Branch...',action:()=>vscode.postMessage({type:'newBranchFromCommit',hash})},
    {icon:'\\u{1F3F7}',label:'New Tag...',action:()=>vscode.postMessage({type:'newTag',hash})},
    {sep:1},
    {icon:'\\u2190',label:'Go to Child Commit',action:()=>{if(childHash){const r=$('logScroll').querySelector('[data-hash="'+childHash+'"]');if(r){r.scrollIntoView({block:'center'});onRow({shiftKey:false},r);}}}},
    {icon:'\\u2192',label:'Go to Parent Commit',action:()=>{if(parentHash){const r=$('logScroll').querySelector('[data-hash="'+parentHash+'"]');if(r){r.scrollIntoView({block:'center'});onRow({shiftKey:false},r);}}}},
    {sep:1},
    {icon:'\\u{1F310}',label:'View in browser',action:()=>vscode.postMessage({type:'viewInBrowser',hash})}
  ]);
}

/* ===== Files Panel ===== */
$('fpTree').onclick=()=>{filesViewMode='tree';$('fpTree').classList.add('active');$('fpFlat').classList.remove('active');renderFiles(currentFiles,currentFilesHash);};
$('fpFlat').onclick=()=>{filesViewMode='flat';$('fpFlat').classList.add('active');$('fpTree').classList.remove('active');renderFiles(currentFiles,currentFilesHash);};

function renderFiles(files,hash){
  const l=$('filesList'),det=$('commitDetail');
  $('fpTitle').textContent=files&&files.length?'Changed Files ('+files.length+')':'Changed Files';
  if(!files||!files.length){l.innerHTML='<div style="padding:10px;color:var(--desc)">No changed files</div>';det.classList.add('hidden');$('fpResize').classList.add('hidden');return;}
  let h='';
  if(currentMergeGroups){
    const mg=currentMergeGroups;
    if(mg.combined&&mg.combined.length>0){
      h+='<div class="fp-group"><span>\\u25BC Merge result</span><span class="cnt">'+mg.combined.length+' files</span></div>';
      h+='<div class="fp-group-ch">';
      h+=(filesViewMode==='tree'?buildFTree(mg.combined,hash):buildFFlat(mg.combined,hash));
      h+='</div>';
    }
    if(mg.parentDiffs){
      for(const pd of mg.parentDiffs){
        h+='<div class="fp-group"><span>\\u25B6 Changes to '+eh(pd.abbrev)+' '+eh(pd.message.slice(0,50))+'</span><span class="cnt">'+pd.files.length+' files</span></div>';
        h+='<div class="fp-group-ch" style="display:none">';
        h+=(filesViewMode==='tree'?buildFTree(pd.files,hash):buildFFlat(pd.files,hash));
        h+='</div>';
      }
    }
  }else{
    h+=(filesViewMode==='tree'?buildFTree(files,hash):buildFFlat(files,hash));
  }
  l.innerHTML=h;
  l.querySelectorAll('.fp-group').forEach(el=>{
    el.onclick=()=>{const s=el.nextElementSibling;if(!s)return;const v=s.style.display==='none';s.style.display=v?'':'none';
      const txt=el.querySelector('span').textContent;
      el.querySelector('span').textContent=(v?'\\u25BC':'\\u25B6')+txt.slice(1);};
  });
  l.querySelectorAll('.fdir').forEach(el=>{
    el.onclick=()=>{
      const s=el.nextElementSibling;if(!s||!s.classList.contains('fdir-ch'))return;
      const v=s.style.display==='none';
      s.style.display=v?'':'none';
      el.querySelector('.arr').textContent=v?'\\u25BC':'\\u25B6';
      const ico=el.querySelector('.dir-ico');
      if(ico)ico.textContent=v?'\\u{1F4C2}':'\\u{1F4C1}';
    };
  });
  bindFI(l);
  if(currentDetail){
    det.classList.remove('hidden');$('fpResize').classList.remove('hidden');
    let dh='<div style="font-weight:600;margin-bottom:6px">'+eh(currentDetail.message)+'</div>';
    if(currentDetail.fullHash){
      dh+='<div style="color:var(--desc);font-size:11px;margin-bottom:4px">'+currentDetail.fullHash.slice(0,9)+' '+eh(currentDetail.author)+' &lt;'+eh(currentDetail.email)+'&gt; on '+fD(currentDetail.date)+'</div>';
    }
    if(currentDetail.refs&&currentDetail.refs.length){
      dh+='<div style="margin-bottom:4px">'+currentDetail.refs.map(r=>{
        if(r.includes('origin/')||r.includes('remotes/'))return '<span class="ref-tag ref-remote">'+eh(r)+'</span>';
        if(r.startsWith('tag:'))return '<span class="ref-tag ref-tag-label">'+eh(r)+'</span>';
        if(r.startsWith('HEAD'))return '<span class="ref-tag ref-head">'+eh(r)+'</span>';
        return '<span class="ref-tag ref-branch">'+eh(r)+'</span>';}).join(' ')+'</div>';
    }
    if(currentDetail.branches&&currentDetail.branches.length){
      const bl=currentDetail.branches,show=bl.slice(0,3).join(', ');
      dh+='<div style="color:var(--desc);font-size:11px">In '+bl.length+' branches: '+eh(show)+(bl.length>3?'... ':'')+'</div>';
    }
    det.innerHTML=dh;
  }else{det.classList.add('hidden');$('fpResize').classList.add('hidden');}
}

function buildFFlat(files,hash){
  let h='';for(const f of files)h+='<div class="file-item" data-path="'+esc(f.path)+'" data-hash="'+hash+'"><span class="fst">'+fileStatusIcon(f.status)+'</span><span title="'+esc(f.path)+'">'+eh(f.path)+'</span></div>';
  return h;
}
function buildFTree(files,hash){
  const tree={};
  for(const f of files){const pts=f.path.split('/');let nd=tree;for(let i=0;i<pts.length-1;i++){const k='d_'+pts[i];if(!nd[k])nd[k]={};nd=nd[k];}nd['f_'+f.path]=f;}
  return rFNode(tree,hash,0);
}
function rFNode(nd,hash,dep){
  let h='';const indent=6+dep*16;const dirs=[],leaves=[];
  for(const k of Object.keys(nd)){if(k.startsWith('f_'))leaves.push(nd[k]);else if(k.startsWith('d_'))dirs.push({key:k.slice(2),node:nd[k]});}
  dirs.sort((a,b)=>a.key.localeCompare(b.key));
  for(const d of dirs){
    const c=compactDirChain(d.key,d.node);
    h+='<div class="fdir'+(c.name.includes('/')?' compact':'')+'" style="padding-left:'+indent+'px"><span class="arr">\\u25BC</span><span class="dir-ico">\\u{1F4C2}</span><span class="path">'+eh(c.name)+'</span></div>';
    h+='<div class="fdir-ch">';h+=rFNode(c.node,hash,dep+1);h+='</div>';
  }
  for(const f of leaves){const nm=f.path.split('/').pop();
    h+='<div class="file-item" data-path="'+esc(f.path)+'" data-hash="'+hash+'" style="padding-left:'+(indent+16)+'px"><span class="fst">'+fileStatusIcon(f.status)+'</span><span title="'+esc(f.path)+'">'+eh(nm)+'</span></div>';}
  return h;
}
function bindFI(c){c.querySelectorAll('.file-item').forEach(el=>{el.onclick=()=>{
  if(el.dataset.mode==='worktree'){vscode.postMessage({type:'showWorkTreeDiff',ref:el.dataset.from,filePath:el.dataset.path});}
  else if(el.dataset.from){vscode.postMessage({type:'showBranchDiff',from:el.dataset.from,to:el.dataset.to,filePath:el.dataset.path});}
  else{vscode.postMessage({type:'showDiff',hash:el.dataset.hash,filePath:el.dataset.path});}
};});}

function renderCompareFiles(from,to,files,fromLabel,toLabel,diffMode){
  const l=$('filesList'),det=$('commitDetail');
  const fl=fromLabel||from,tl=toLabel||to;
  $('fpTitle').textContent='Changes: '+fl.split('/').pop()+'..'+tl.split('/').pop()+' ('+files.length+')';
  det.classList.remove('hidden');$('fpResize').classList.remove('hidden');
  det.innerHTML='<div style="font-weight:600;margin-bottom:4px">Changes Between '+eh(fl)+' and '+eh(tl)+'</div><div style="color:var(--desc);font-size:11px">'+files.length+' files changed</div>';
  if(!files.length){l.innerHTML='<div style="padding:10px;color:var(--desc)">No differences</div>';return;}
  const tree={};
  for(const f of files){const pts=f.path.split('/');let nd=tree;for(let i=0;i<pts.length-1;i++){const k='d_'+pts[i];if(!nd[k])nd[k]={};nd=nd[k];}nd['f_'+f.path]=f;}
  l.innerHTML=rCmpNode(tree,from,to,0,diffMode);
  l.querySelectorAll('.fdir').forEach(el=>{
    el.onclick=()=>{
      const s=el.nextElementSibling;if(!s||!s.classList.contains('fdir-ch'))return;
      const v=s.style.display==='none';
      s.style.display=v?'':'none';
      el.querySelector('.arr').textContent=v?'\\u25BC':'\\u25B6';
      const ico=el.querySelector('.dir-ico');
      if(ico)ico.textContent=v?'\\u{1F4C2}':'\\u{1F4C1}';
    };
  });
  bindFI(l);
}
function rCmpNode(nd,from,to,dep,mode){
  let h='';const indent=6+dep*16;const dirs=[],leaves=[];
  for(const k of Object.keys(nd)){if(k.startsWith('f_'))leaves.push(nd[k]);else if(k.startsWith('d_'))dirs.push({key:k.slice(2),node:nd[k]});}
  dirs.sort((a,b)=>a.key.localeCompare(b.key));
  for(const d of dirs){
    const c=compactDirChain(d.key,d.node);
    h+='<div class="fdir'+(c.name.includes('/')?' compact':'')+'" style="padding-left:'+indent+'px"><span class="arr">\\u25BC</span><span class="dir-ico">\\u{1F4C2}</span><span class="path">'+eh(c.name)+'</span></div>';
    h+='<div class="fdir-ch">';h+=rCmpNode(c.node,from,to,dep+1,mode);h+='</div>';
  }
  for(const f of leaves){const nm=f.path.split('/').pop();
    h+='<div class="file-item" data-path="'+esc(f.path)+'" data-from="'+esc(from)+'" data-to="'+esc(to)+'"'+(mode?' data-mode="'+mode+'"':'')+' style="padding-left:'+(indent+16)+'px"><span class="fst">'+fileStatusIcon(f.status)+'</span><span title="'+esc(f.path)+'">'+eh(nm)+'</span></div>';}
  return h;
}

/* ===== Context Menu ===== */
function showCtx(x,y,items){
  const m=$('ctxMenu'),sub=$('ctxSubMenu');let h='';
  sub.classList.add('hidden');
  for(let i=0;i<items.length;i++){
    if(items[i].sep){h+='<div class="ctx-sep"></div>';continue;}
    const ic=items[i].icon?'<span class="ctx-icon">'+items[i].icon+'</span>':'<span class="ctx-icon"></span>';
    const arr=items[i].children?'<span class="ctx-sub-arrow">\\u203A</span>':'';
    h+='<div class="ctx-menu-item" data-i="'+i+'">'+ic+eh(items[i].label)+arr+'</div>';
  }
  m.innerHTML=h;const bw=document.body.clientWidth,bh=document.body.clientHeight;
  const menuH=Math.min(items.length*28,bh*0.7);
  m.style.maxHeight=menuH+'px';m.style.overflowY=items.length*28>menuH?'auto':'';
  m.style.left=Math.min(x,bw-220)+'px';m.style.top=Math.max(0,Math.min(y,bh-menuH-4))+'px';
  m.classList.remove('hidden');
  m.querySelectorAll('.ctx-menu-item').forEach(el=>{
    const item=items[+el.dataset.i];
    const showSub=()=>{
      if(!item.children){sub.classList.add('hidden');return;}
      let sh='';
      for(let j=0;j<item.children.length;j++){
        const c=item.children[j];
        if(c.sep){sh+='<div class="ctx-sep"></div>';continue;}
        const ic=c.icon?'<span class="ctx-icon">'+c.icon+'</span>':'<span class="ctx-icon"></span>';
        sh+='<div class="ctx-menu-item" data-j="'+j+'">'+ic+eh(c.label)+'</div>';
      }
      sub.innerHTML=sh;
      const r=el.getBoundingClientRect();
      const subH=Math.min(item.children.length*28,bh*0.7);
      sub.style.maxHeight=subH+'px';sub.style.overflowY=item.children.length*28>subH?'auto':'';
      sub.style.left=Math.min(r.right+2,bw-260)+'px';
      sub.style.top=Math.max(0,Math.min(r.top,bh-subH-4))+'px';
      sub.classList.remove('hidden');
      sub.querySelectorAll('.ctx-menu-item').forEach(se=>{
        se.onclick=ev=>{
          ev.stopPropagation();
          const c=item.children[+se.dataset.j];
          c.action();
          m.classList.add('hidden');
          sub.classList.add('hidden');
        };
      });
    };
    el.onmouseenter=showSub;
    el.onclick=ev=>{
      ev.stopPropagation();
      if(item.children){showSub();return;}
      item.action();
      m.classList.add('hidden');
      sub.classList.add('hidden');
    };
  });
}
function hideMenus(){$('ctxMenu').classList.add('hidden');$('ctxSubMenu').classList.add('hidden');$('datePicker').style.display='none';lastPillAct='';}
document.onclick=hideMenus;
window.addEventListener('blur',hideMenus);
document.addEventListener('scroll',ev=>{
  if(ev.target===$('ctxMenu')||$('ctxMenu').contains(ev.target))return;
  if(ev.target===$('ctxSubMenu')||$('ctxSubMenu').contains(ev.target))return;
  if(ev.target===$('datePicker')||$('datePicker').contains(ev.target))return;
  hideMenus();
},true);

/* ===== Filter ===== */
const filters={branch:'',author:'',after:'',before:'',path:''};
function hasAnyFilter(){return filters.branch||filters.author||filters.after||filters.before||filters.path;}

function applyF(){
  const f={};
  if(filters.branch)f.branch=filters.branch;
  if(filters.author)f.author=filters.author;
  if(filters.after)f.after=filters.after;
  if(filters.before)f.before=filters.before;
  if(filters.path)f.path=filters.path;
  currentLoadFilters=f;
  logHasMore=true;
  logLoadingMore=true;
  vscode.postMessage({type:'loadLog',filters:f,skip:0,maxCount:LOG_INITIAL_PAGE_SIZE,append:false});
  renderFilterBar();
}

function resetAllFilters(){
  filters.branch='';filters.author='';filters.after='';filters.before='';filters.path='';
  $('branchInput').value='';$('searchInput').value='';$('pathInput').value='';
  filterBranchPanel('');
  applyF();
}

function renderFilterBar(){
  const area=$('filterArea');let h='';
  const active=hasAnyFilter();
  const bLabel=filters.branch?'Branch: '+eh(filters.branch):'Branch';
  const uLabel=filters.author?'User: '+eh(filters.author):'User';
  let dLabel='Date';
  if(filters.after||filters.before){dLabel='Date: ';if(filters.after)dLabel+=filters.after;dLabel+='~';if(filters.before)dLabel+=filters.before;}
  h+='<div class="pill'+(filters.branch?' on':'')+' btn" data-act="branch"><span>'+bLabel+'</span>'+(filters.branch?'<span class="x" data-k="branch">\\u00D7</span>':'')+'</div>';
  h+='<div class="pill'+(filters.author?' on':'')+' btn" data-act="user"><span>'+uLabel+'</span>'+(filters.author?'<span class="x" data-k="author">\\u00D7</span>':'')+'</div>';
  h+='<div class="pill'+((filters.after||filters.before)?' on':'')+' btn" data-act="date"><span>'+dLabel+'</span>'+((filters.after||filters.before)?'<span class="x" data-k="date">\\u00D7</span>':'')+'</div>';
  area.innerHTML=h;
  $('pillReset').style.display=active?'':'none';
  area.querySelectorAll('.x').forEach(el=>{el.onclick=ev=>{ev.stopPropagation();const k=el.dataset.k;if(k==='date'){filters.after='';filters.before='';}else filters[k]='';applyF();};});
  area.querySelectorAll('.btn').forEach(el=>{el.onclick=ev=>{ev.stopPropagation();onPillBtn(el.dataset.act,ev);};});
}

let lastPillAct='';
function onPillBtn(act,ev){
  const menu=$('ctxMenu'),dp=$('datePicker');
  if(act===lastPillAct&&(act==='date'?dp.style.display==='flex':!menu.classList.contains('hidden'))){
    menu.classList.add('hidden');dp.style.display='none';lastPillAct='';return;
  }
  menu.classList.add('hidden');dp.style.display='none';lastPillAct=act;
  const rect=ev.target.closest('.pill').getBoundingClientRect();
  if(act==='branch'){
    const items=allBranches.map(b=>({label:b.name,action:()=>{filters.branch=b.name;applyF();highlightBranch(b.name);lastPillAct='';}}));
    setTimeout(()=>showCtx(rect.left,rect.bottom+2,items),0);
  }else if(act==='user'){
    const seen=new Set();const authors=[];
    for(const c of allCommits){if(c.author&&!seen.has(c.author)){seen.add(c.author);authors.push(c.author);}}
    const items=authors.map(a=>({label:a,action:()=>{filters.author=a;applyF();lastPillAct='';}}));
    setTimeout(()=>showCtx(rect.left,rect.bottom+2,items),0);
  }else if(act==='date'){
    dp.style.display='flex';
    $('dpFrom').value=filters.after||'';$('dpTo').value=filters.before||'';
    dp.style.left=rect.left+'px';dp.style.top=(rect.bottom+2)+'px';
  }
}

$('pillReset').onclick=()=>resetAllFilters();
$('dpApply').onclick=()=>{filters.after=$('dpFrom').value;filters.before=$('dpTo').value;$('datePicker').style.display='none';applyF();};
document.addEventListener('click',ev=>{const dp=$('datePicker');if(dp.style.display==='flex'&&!dp.contains(ev.target))dp.style.display='none';});

let pathTimer=null;
$('pathInput').oninput=()=>{clearTimeout(pathTimer);pathTimer=setTimeout(()=>{filters.path=$('pathInput').value;applyF();},400);};
$('pathInput').onkeydown=ev=>{if(ev.key==='Escape'){$('pathInput').value='';filters.path='';applyF();}if(ev.key==='Enter'){filters.path=$('pathInput').value;applyF();}};

/* ===== Branch search -> filter left panel ===== */
const bInput=$('branchInput'),bDD=$('branchDD');
let branchDDIdx=-1;

bInput.oninput=()=>{
  const q=bInput.value.toLowerCase();
  filterBranchPanel(q);
  if(!q){bDD.classList.remove('show');return;}
  const matches=allBranches.filter(b=>b.name.toLowerCase().includes(q)).concat(allTags.filter(t=>t.toLowerCase().includes(q)).map(t=>({name:t}))).slice(0,15);
  if(!matches.length){bDD.classList.remove('show');return;}
  bDD.innerHTML=matches.map((b,i)=>'<div class="tb-dd-item'+(i===0?' hl':'')+'" data-b="'+esc(b.name)+'">'+eh(b.name)+'</div>').join('');
  branchDDIdx=0;bDD.classList.add('show');
  bDD.querySelectorAll('.tb-dd-item').forEach(el=>{el.onmousedown=ev=>{ev.preventDefault();pickBranch(el.dataset.b);};});
};
bInput.onkeydown=ev=>{
  const items=bDD.querySelectorAll('.tb-dd-item');
  if(ev.key==='ArrowDown'&&items.length){ev.preventDefault();branchDDIdx=Math.min(branchDDIdx+1,items.length-1);items.forEach((el,i)=>el.classList.toggle('hl',i===branchDDIdx));}
  else if(ev.key==='ArrowUp'&&items.length){ev.preventDefault();branchDDIdx=Math.max(branchDDIdx-1,0);items.forEach((el,i)=>el.classList.toggle('hl',i===branchDDIdx));}
  else if(ev.key==='Enter'){ev.preventDefault();const items2=bDD.querySelectorAll('.tb-dd-item');if(branchDDIdx>=0&&items2[branchDDIdx])pickBranch(items2[branchDDIdx].dataset.b);}
  else if(ev.key==='Escape'){bDD.classList.remove('show');bInput.value='';filterBranchPanel('');}
};
bInput.onblur=()=>{setTimeout(()=>{bDD.classList.remove('show');},150);};

function pickBranch(name){
  bInput.value='';bDD.classList.remove('show');filterBranchPanel('');
  filters.branch=name;applyF();highlightBranch(name);
}

function highlightBranch(name){
  $('bpContent').querySelectorAll('.branch-item').forEach(el=>{
    el.style.background=el.dataset.branch===name?'var(--active)':'';
    if(el.dataset.branch===name)el.scrollIntoView({block:'nearest'});
  });
}

function filterBranchPanel(q){
  const panel=$('bpContent');
  panel.querySelectorAll('.branch-item').forEach(el=>{
    if(!q){el.style.display='';return;}
    el.style.display=(el.dataset.branch||'').toLowerCase().includes(q)?'':'none';
  });
  panel.querySelectorAll('.tdir').forEach(el=>{
    if(!q){el.style.display='';const ch=el.nextElementSibling;if(ch)ch.style.display='';return;}
    const ch=el.nextElementSibling;if(!ch)return;
    const vis=ch.querySelectorAll('.branch-item').length-ch.querySelectorAll('.branch-item[style*="display:none"],.branch-item[style*="display: none"]').length;
    el.style.display=vis>0?'':'none';ch.style.display=vis>0?'':'none';
  });
}

/* ===== Text search ===== */
let searchTimer=null;
$('searchInput').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>renderLog(allCommits),200);};
$('logScroll').addEventListener('scroll',()=>{
  const sc=$('logScroll');
  if(logLoadingMore||!logHasMore)return;
  if(sc.scrollTop+sc.clientHeight<sc.scrollHeight-120)return;
  logLoadingMore=true;
  vscode.postMessage({type:'loadLog',filters:currentLoadFilters,skip:allCommits.length,maxCount:LOG_PAGE_SIZE,append:true});
});

/* ===== Resize ===== */
function setupR(hid,dir){$(hid).onmousedown=e=>{e.preventDefault();const pn=dir==='left'?$('branchPanel'):$('filesPanel'),sX=e.clientX,sW=pn.offsetWidth;
  const mv=ev=>{const d=dir==='left'?(ev.clientX-sX):(sX-ev.clientX);pn.style.width=Math.max(100,sW+d)+'px';};
  const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);saveState();};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);};}
setupR('resizeLeft','left');setupR('resizeRight','right');

/* ===== Column Resize ===== */
const savedState=vscode.getState()||{};
const colWidths=savedState.colWidths||{graph:120,author:80,date:120,hash:70};
const hdr=$('logHeader');
if(savedState.branchPanelW)$('branchPanel').style.width=savedState.branchPanelW+'px';
if(savedState.filesPanelW)$('filesPanel').style.width=savedState.filesPanelW+'px';
if(savedState.detailH)$('commitDetail').style.height=savedState.detailH+'px';

function saveState(){
  vscode.setState({colWidths,branchPanelW:$('branchPanel').offsetWidth,filesPanelW:$('filesPanel').offsetWidth,detailH:$('commitDetail').offsetHeight});
}
const colKeys=['graph','msg','author','date','hash'];

function applyColWidths(){
  document.querySelectorAll('.col-graph').forEach(el=>el.style.width=colWidths.graph+'px');
  document.querySelectorAll('.col-author').forEach(el=>el.style.width=colWidths.author+'px');
  document.querySelectorAll('.col-date').forEach(el=>el.style.width=colWidths.date+'px');
  document.querySelectorAll('.col-hash').forEach(el=>el.style.width=colWidths.hash+'px');
  saveState();
}

function getColEdges(){
  const sels=['.col-graph','.col-msg','.col-author','.col-date','.col-hash'];
  const hRect=hdr.getBoundingClientRect();
  return sels.map(s=>{const el=hdr.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return{left:r.left-hRect.left,right:r.right-hRect.left};});
}

function findEdge(x){
  const edges=getColEdges();
  const THRESH=5;
  for(let i=0;i<edges.length-1;i++){
    if(!edges[i])continue;
    const boundary=edges[i].right;
    if(Math.abs(x-boundary)<THRESH)return{idx:i,leftKey:colKeys[i],rightKey:colKeys[i+1]};
  }
  return null;
}

hdr.onmousemove=e=>{
  const hRect=hdr.getBoundingClientRect();
  const edge=findEdge(e.clientX-hRect.left);
  hdr.style.cursor=edge?'col-resize':'';
};
hdr.onmouseleave=()=>{hdr.style.cursor='';};

hdr.onmousedown=e=>{
  const hRect=hdr.getBoundingClientRect();
  const edge=findEdge(e.clientX-hRect.left);
  if(!edge)return;
  e.preventDefault();
  const sX=e.clientX;
  const lk=edge.leftKey,rk=edge.rightKey;
  const sL=colWidths[lk]||0,sR=colWidths[rk]||0;
  document.body.style.cursor='col-resize';document.body.style.userSelect='none';
  const mv=ev=>{
    const d=ev.clientX-sX;
    if(lk==='graph'){colWidths.graph=Math.max(40,sL+d);}
    else if(lk==='msg'){colWidths[rk]=Math.max(40,sR-d);}
    else{colWidths[rk]=Math.max(40,sR-d);}
    applyColWidths();
  };
  const up=()=>{document.body.style.cursor='';document.body.style.userSelect='';document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
};

/* ===== Detail Resize ===== */
$('fpResize').onmousedown=e=>{
  e.preventDefault();
  const det=$('commitDetail'),sY=e.clientY,sH=det.offsetHeight;
  document.body.style.cursor='row-resize';document.body.style.userSelect='none';
  const mv=ev=>{det.style.height=Math.max(40,sH-(ev.clientY-sY))+'px';};
  const up=()=>{document.body.style.cursor='';document.body.style.userSelect='';document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);saveState();};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
};

/* ===== Helpers ===== */
function eh(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';}
function esc(s){return s?s.replace(/"/g,'&quot;').replace(/'/g,'&#39;'):'';}
function fD(iso){try{const d=new Date(iso);return d.getFullYear()+'/'+(d.getMonth()+1).toString().padStart(2,'0')+'/'+d.getDate().toString().padStart(2,'0')+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');}catch(e){return iso;}}
function fileStatusIcon(st){if(st==='A')return '\\u{1F195}';if(st==='M')return '\\u270F\\uFE0F';if(st==='D')return '\\u{1F5D1}\\uFE0F';if(st==='R')return '\\u{1F501}';if(st==='C')return '\\u{1F4CB}';return '\\u{1F4C4}';}
function norm(s){return (s||'').trim().toLowerCase();}
function isAuthorDifferentFromCommitter(c){
  const an=norm(c.author),cn=norm(c.committer),ae=norm(c.email),ce=norm(c.committerEmail);
  return an!==cn||ae!==ce;
}

applyColWidths();
vscode.postMessage({type:'ready'});
</script>
</body></html>`;
  }
}
