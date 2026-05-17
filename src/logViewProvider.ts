import * as vscode from 'vscode';
import { GitService, GitRepo, GitCommit, GitBranch, GitFileChange, GitLogAuthor } from './gitService';
import * as path from 'path';

export class LogViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ideaGit.logView';
  private static readonly INITIAL_PAGE_SIZE = 80;
  private static readonly PAGE_SIZE = 200;
  private static readonly FILE_HISTORY_PAGE_SIZE = 50;
  /** Webview filter pill + git log; sync embedded script FILTER_AUTHOR_ME */
  private static readonly filterAuthorMe = '__ideaGit_me__';
  private view?: vscode.WebviewView;
  private currentRepo?: GitRepo;
  private currentLogFilters: { branch?: string; author?: string; after?: string; before?: string; path?: string } = {};
  private defaultBranchFilterAppliedRepo?: string;
  /** 上次 refresh 观察到的当前分支，用于"filter 跟随 HEAD"判定 */
  private lastObservedBranch?: string;

  /** 与 loadLog 竞态：refresh 后丢弃过期的 loadLog 响应，避免旧 logData 覆盖新 tags/commits。 */
  private logStaleSeq = 0;

  constructor(private extensionUri: vscode.Uri, private gitService: GitService) {}

  private async buildGetLogOpts(repo: string, filters: { branch?: string; author?: string; after?: string; before?: string; path?: string }, skip: number, maxCount: number) {
    const opts: {
      maxCount: number; skip: number; branch?: string; author?: string; authorPatterns?: string[]; after?: string; before?: string; path?: string;
    } = { maxCount, skip, branch: filters.branch, after: filters.after, before: filters.before, path: filters.path };
    if (filters.author === LogViewProvider.filterAuthorMe) {
      const patterns = await this.gitService.getMeAuthorPatterns(repo);
      if (!patterns.length) return { opts, emptyMe: true as const };
      opts.authorPatterns = patterns;
      return { opts, emptyMe: false as const };
    }
    if (filters.author) opts.author = filters.author;
    return { opts, emptyMe: false as const };
  }

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
        const seqAtStart = this.logStaleSeq;
        const filters = msg.filters || {};
        this.currentLogFilters = filters;
        const skip = Number(msg.skip || 0);
        const defaultCount = skip > 0 ? LogViewProvider.PAGE_SIZE : LogViewProvider.INITIAL_PAGE_SIZE;
        const maxCount = Number(msg.maxCount || defaultCount);
        const { opts, emptyMe } = await this.buildGetLogOpts(repo, filters, skip, maxCount);
        const [commits, branches, currentBranch, tags, authors] = await Promise.all([
          emptyMe ? Promise.resolve([]) : this.gitService.getLog(repo, opts),
          this.gitService.getBranches(repo),
          this.gitService.getCurrentBranch(repo),
          this.gitService.getTags(repo),
          msg.append ? Promise.resolve([] as GitLogAuthor[]) : this.gitService.getLogAuthors(repo),
        ]);
        const inProgress = await this.detectInProgress(repo);
        if (seqAtStart !== this.logStaleSeq) { return; }
        this.postMessage({
          type: 'logData',
          commits,
          branches,
          currentBranch,
          tags,
          authors,
          append: !!msg.append,
          hasMore: commits.length >= maxCount,
          reqId: msg.reqId,
          inProgress,
        });
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
      case 'showDiffNewTab':
        await this.gitService.showFileDiffInNewTab(repo, msg.hash, msg.filePath);
        break;
      case 'compareFileWithLocal':
        await this.gitService.compareCommitFileWithLocal(repo, msg.hash, msg.filePath);
        break;
      case 'compareBeforeWithLocal':
        await this.gitService.compareBeforeFileWithLocal(repo, msg.hash, msg.filePath);
        break;
      case 'openRepositoryVersion':
        await this.gitService.openRepositoryVersion(repo, msg.hash, msg.filePath);
        break;
      case 'revertFileToHead':
        await this.gitService.restoreFileFromHead(repo, msg.filePath);
        vscode.window.showInformationMessage(`已恢复文件: ${msg.filePath}`);
        await this.refresh();
        break;
      case 'checkoutFileFromRevision':
        await this.gitService.checkoutFileFromRevision(repo, msg.hash, msg.filePath);
        vscode.window.showInformationMessage(`已从 ${msg.hash.slice(0, 7)} 获取文件: ${msg.filePath}`);
        await this.refresh();
        break;
      case 'createFilePatch': {
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${path.basename(msg.filePath)}.${msg.hash.slice(0, 7)}.patch`), filters: { 'Patch': ['patch'] } });
        if (!uri) { break; }
        await this.gitService.createFilePatch(repo, msg.hash, msg.filePath, uri.fsPath);
        vscode.window.showInformationMessage(`Patch saved to ${uri.fsPath}`);
        break;
      }
      case 'fileHistory': {
        let upto = typeof msg.uptoHash === 'string' ? msg.uptoHash : '';
        let focus: string | undefined = typeof msg.focusHash === 'string' ? msg.focusHash : undefined;
        if (typeof msg.hash === 'string' && msg.hash && !upto && typeof msg.focusHash !== 'string') {
          upto = msg.hash;
          focus = msg.hash;
        }
        await this.openFileHistoryTabWithNativeDiff(repo, msg.filePath, upto, focus);
        break;
      }
      case 'unsupportedFileAction':
        vscode.window.showInformationMessage('该操作在当前版本按“文件级”暂不支持“选中部分变更”');
        break;
      case 'checkoutBranch': {
        try {
          const result = await this.gitService.smartCheckout(repo, msg.branch);
          const cur = await this.gitService.getCurrentBranch(repo);
          if (result.forced) {
            vscode.window.showWarningMessage(`已强制切换到分支: ${cur}（原工作区改动已丢弃）`);
          } else {
            await this.tryAutoUnshelve(repo, result, `已切换到分支: ${cur}`);
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
          this.lastObservedBranch = undefined;
          vscode.commands.executeCommand('ideaGit.repoChanged', target);
          await this.refresh();
        }
        break;
      }
      case 'refreshRepos': {
        await vscode.commands.executeCommand('ideaGit.refresh');
        break;
      }
      case 'manageExcludedRepos': {
        await vscode.commands.executeCommand('ideaGit.manageExcludedRepos');
        break;
      }
      case 'opOpenScm': {
        await this.focusSourceControlForConflicts();
        break;
      }
      case 'opAcceptOurs':
      case 'opAcceptTheirs': {
        const side = msg.type === 'opAcceptOurs' ? 'ours' : 'theirs';
        try {
          const n = await this.gitService.acceptConflictSide(repo, side);
          if (n > 0) {
            vscode.window.showInformationMessage(`已接受 ${side} 并标记解决 ${n} 个冲突路径`);
          } else {
            vscode.window.showInformationMessage('当前无未合并冲突');
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`接受 ${side} 失败: ${e?.message || e}`);
        }
        await this.refresh();
        break;
      }
      case 'opRebaseContinue':
      case 'opRebaseSkip':
      case 'opRebaseAbort':
      case 'opMergeContinue':
      case 'opMergeAbort': {
        try {
          if (msg.type === 'opRebaseContinue') { await this.gitService.rebaseContinue(repo); }
          else if (msg.type === 'opRebaseSkip') { await this.gitService.rebaseSkip(repo); }
          else if (msg.type === 'opRebaseAbort') { await this.gitService.rebaseAbort(repo); }
          else if (msg.type === 'opMergeContinue') { await this.gitService.mergeContinue(repo); }
          else if (msg.type === 'opMergeAbort') { await this.gitService.mergeAbort(repo); }
          const stillRebase = await this.gitService.isRebasing(repo);
          const stillMerge = await this.gitService.isMerging(repo);
          if (!stillRebase && !stillMerge) {
            vscode.window.showInformationMessage(
              msg.type.endsWith('Abort') ? '已 Abort' : '操作已完成'
            );
          }
        } catch (e: any) {
          const detail = `${e?.stderr ?? ''}\n${e?.message ?? e}`.trim() || String(e);
          vscode.window.showWarningMessage(`${msg.type}: ${detail}`);
        }
        await this.refresh();
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
        const ontoRef = await this.gitService.getHeadAsRefForGit(repo);
        const curDisplay = await this.gitService.getCurrentBranch(repo);
        const result = await this.gitService.smartCheckout(repo, msg.branch);
        try {
          const successMsg = `已 Checkout ${msg.branch} 并 Rebase onto ${ontoRef}（原在 ${curDisplay}）`;
          const rebaseRes = await this.gitService.rebaseBranch(repo, ontoRef);
          if (result.shelved) { await this.tryAutoUnshelve(repo, result, successMsg); }
          else { await this.finishWithAutoStash(repo, rebaseRes, successMsg); }
        } catch (e: any) { await this.handleRebaseConflict(repo, e); }
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
        const curDisplay = await this.gitService.getCurrentBranch(repo);
        const onBranch = await this.gitService.getSymbolicBranchShortName(repo);
        if (!onBranch) {
          const go = await vscode.window.showWarningMessage(
            '当前为 detached HEAD：rebase 只会改写 HEAD 指向，完成后仍不在任何命名分支上（这是 Git 正常行为）。请先 checkout 到本地分支再 rebase，或确认仍要继续。',
            '仍要继续', '取消'
          );
          if (go !== '仍要继续') { await this.refresh(); break; }
        }
        try {
          const rebaseRes = await this.gitService.rebaseBranch(repo, msg.branch);
          await this.finishWithAutoStash(repo, rebaseRes, `已 Rebase ${curDisplay} onto ${msg.branch}`);
        } catch (e: any) {
          await this.handleRebaseConflict(repo, e);
        }
        await this.refresh();
        break;
      }
      case 'mergeInto': {
        const cur = await this.gitService.getCurrentBranch(repo);
        try {
          await this.gitService.mergeBranch(repo, msg.branch);
          vscode.window.showInformationMessage(`已 Merge ${msg.branch} into ${cur}`);
        } catch (e: any) {
          await this.handleMergeConflict(repo, e);
        }
        await this.refresh();
        break;
      }
      case 'mergeCurrentInto': {
        const mergeFromRef = await this.gitService.getHeadAsRefForGit(repo);
        const curDisplay = await this.gitService.getCurrentBranch(repo);
        let switched: { shelved: boolean; forced: boolean; stashRef?: string };
        try {
          switched = await this.gitService.smartCheckout(repo, msg.branch);
        } catch (e: any) {
          if (e?.message?.includes('用户取消')) { break; }
          vscode.window.showErrorMessage(`切换分支失败: ${e?.message || e}`);
          break;
        }
        const successMsg = `已 Merge ${mergeFromRef}（原 ${curDisplay}）into ${msg.branch}`;
        try {
          await this.gitService.mergeBranch(repo, mergeFromRef);
          if (switched.shelved) { await this.tryAutoUnshelve(repo, switched, successMsg); }
          else { vscode.window.showInformationMessage(successMsg); }
        } catch (e: any) {
          await this.handleMergeConflict(repo, e);
        }
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
              `恢复本地未提交改动时冲突${res.stashRef ? `（${res.stashRef}）` : ''}，共 ${res.unshelveConflicts.length} 个路径（含子模块目录时多为指针与上游不一致，非「你改过该文件正文」）。`,
              '打开冲突文件'
            );
            if (open === '打开冲突文件') { await this.gitService.openConflictFiles(repo, res.unshelveConflicts); }
          }
          await this.refresh();
        } catch (e: any) {
          if (await this.gitService.isRebasing(repo)) { await this.handleRebaseConflict(repo, e); await this.refresh(); }
          else { vscode.window.showErrorMessage(`Pull 失败: ${e.message}`); }
        }
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
            try {
              await ensureTarget();
              const rebaseRes = await this.gitService.rebaseBranch(repo, tracking);
              await this.finishWithAutoStash(repo, rebaseRes, `已 Rebase '${targetBranch}' onto '${tracking}'`);
            } catch (e: any) { await this.handleRebaseConflict(repo, e); }
            break;
          case 'merge':
            try {
              await ensureTarget();
              await this.gitService.mergeBranch(repo, tracking);
            } catch (e: any) { await this.handleMergeConflict(repo, e); }
            break;
          case 'pullRebase':
            await ensureTarget();
            await this.notifyPullResult(repo, await this.gitService.pullFromTracking(repo, tracking, true));
            break;
          case 'pullMerge':
            await ensureTarget();
            await this.notifyPullResult(repo, await this.gitService.pullFromTracking(repo, tracking, false));
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
            try {
              await ensureTarget();
              const rebaseRes = await this.gitService.rebaseBranch(repo, tracking);
              await this.finishWithAutoStash(repo, rebaseRes, `已 Rebase '${targetBranch}' onto '${tracking}'`);
            } catch (e: any) { await this.handleRebaseConflict(repo, e); }
            break;
          case 'merge':
            try {
              await ensureTarget();
              await this.gitService.mergeBranch(repo, tracking);
            } catch (e: any) { await this.handleMergeConflict(repo, e); }
            break;
          case 'pullRebase':
            await ensureTarget();
            await this.notifyPullResult(repo, await this.gitService.pullFromTracking(repo, tracking, true));
            break;
          case 'pullMerge':
            await ensureTarget();
            await this.notifyPullResult(repo, await this.gitService.pullFromTracking(repo, tracking, false));
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
        try {
          await this.gitService.deleteBranch(repo, msg.branch, !!msg.force);
          vscode.window.showInformationMessage(`已删除 ${msg.branch}${msg.force ? '（强制）' : ''}`);
        } catch (e: any) {
          const text = `${(e as { stderr?: unknown })?.stderr ?? ''}\n${e?.message ?? ''}`;
          if (!msg.force && /not fully merged/i.test(text)) {
            const pick = await vscode.window.showWarningMessage(
              `分支 "${msg.branch}" 未完全合并到 HEAD，删除会丢失其独有提交。是否强制删除？`,
              { modal: true, detail: '相当于 git branch -D（不可撤销，请先确认 reflog 仍可找回）。' },
              '强制删除'
            );
            if (pick === '强制删除') {
              await this.gitService.deleteBranch(repo, msg.branch, true);
              vscode.window.showWarningMessage(`已强制删除 ${msg.branch}`);
            }
          } else {
            vscode.window.showErrorMessage(`删除分支失败: ${e.message}`);
          }
        }
        await this.refresh();
        break;
      }
      case 'deleteTag': {
        const taggedHash = await this.gitService.resolveTagCommit(repo, msg.tag);
        try {
          await this.gitService.deleteTag(repo, msg.tag);
        } catch (e: any) {
          vscode.window.showErrorMessage(`删除 Tag 失败: ${e.message}`);
          break;
        }
        vscode.window.showInformationMessage(`已删除本地 Tag: ${msg.tag}`);
        void this.refresh();
        if (taggedHash) { void this.refreshCommitDetail(repo, taggedHash); }
        void vscode.window.showWarningMessage(
          `是否同时删除远端 Tag "${msg.tag}"？`, '删除远端', '保留远端'
        ).then(async pick => {
          if (pick !== '删除远端') { return; }
          try {
            await this.gitService.deleteRemoteTag(repo, msg.tag);
            vscode.window.showInformationMessage(`已删除远端 Tag: ${msg.tag}`);
          } catch (e: any) {
            vscode.window.showErrorMessage(`删除远端 Tag 失败: ${e.message}`);
          }
        });
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
          const files = await this.gitService.diffWithWorkTreeFiles(repo, msg.hash);
          this.postMessage({
            type: 'compareFiles',
            from: msg.hash,
            to: 'Working Tree',
            fromLabel: msg.hash.slice(0, 9),
            toLabel: 'Working Tree',
            files,
            diffMode: 'worktree',
          });
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
        const input = await vscode.window.showInputBox({
          prompt: `在 ${msg.hash.slice(0, 7)} 创建 Tag（可用 "name | message" 创建 annotated tag）`,
          placeHolder: 'v1.0.0',
          validateInput: v => (v && v.trim() ? null : '请输入 tag 名'),
        });
        if (!input) { break; }
        const sepIdx = input.indexOf('|');
        const name = (sepIdx >= 0 ? input.slice(0, sepIdx) : input).trim();
        const tagMsg = sepIdx >= 0 ? input.slice(sepIdx + 1).trim() : '';
        if (!name) { break; }
        try {
          await this.gitService.createTag(repo, name, msg.hash, tagMsg || undefined);
        } catch (e: any) {
          vscode.window.showErrorMessage(`创建 Tag 失败: ${e?.message || e}`);
          break;
        }
        vscode.window.showInformationMessage(`已创建 Tag: ${name}${tagMsg ? '（annotated）' : ''}`);
        void this.refresh();
        void this.refreshCommitDetail(repo, msg.hash);
        break;
      }
      case 'mergeIntoPrevious': {
        try {
          await this.gitService.fixupCommitIntoParent(repo, msg.hash);
          vscode.window.showInformationMessage(`Fixup into previous completed (${msg.hash.slice(0, 7)}; commit message discarded).`);
          void this.refresh();
        } catch (e: unknown) {
          const t = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Fixup into previous failed: ${t}`);
        }
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

  private static fileHistoryRowLite(c: GitCommit): { hash: string; abbrevHash: string; author: string; date: string; message: string } {
    return { hash: c.hash, abbrevHash: c.abbrevHash, author: c.author, date: c.date, message: c.message };
  }

  /** 首屏 + 为定位 focusHash 必要时预取多页；nextRawSkip 为 git log --skip 游标 */
  private async loadFileHistoryInitialRows(repo: string, filePath: string, uptoHash: string, focusHash: string | undefined): Promise<{
    rows: ReturnType<typeof LogViewProvider.fileHistoryRowLite>[]; nextRawSkip: number; hasMore: boolean;
  }> {
    const PAGE = LogViewProvider.FILE_HISTORY_PAGE_SIZE;
    const dedupe = (arr: GitCommit[]) => {
      const s = new Set<string>();
      return arr.filter((c) => (s.has(c.hash) ? false : (s.add(c.hash), true)));
    };
    let nextRawSkip = 0;
    let merged: GitCommit[] = [];
    let hasMore = true;
    const pull = async () => {
      const p = await this.gitService.getFileHistoryPage(repo, filePath, uptoHash, nextRawSkip, PAGE);
      nextRawSkip = p.nextRawSkip;
      hasMore = p.hasMore;
      merged = dedupe([...merged, ...p.commits]);
    };
    await pull();
    if (focusHash && !merged.some((c) => c.hash === focusHash) && hasMore) {
      for (let i = 0; i < 4 && hasMore && !merged.some((c) => c.hash === focusHash); i++) {
        await pull();
      }
    }
    return { rows: merged.map(LogViewProvider.fileHistoryRowLite), nextRawSkip, hasMore };
  }

  async openFileHistoryTabWithNativeDiff(repo: string, filePath: string, uptoHash: string = '', focusHash?: string) {
    const init = await this.loadFileHistoryInitialRows(repo, filePath, uptoHash, focusHash);
    if (!init.rows.length) {
      vscode.window.showInformationMessage('该文件暂无提交历史');
      return;
    }
    const initialHash = (focusHash && init.rows.some((r) => r.hash === focusHash)) ? focusHash : init.rows[0].hash;
    const panel = vscode.window.createWebviewPanel(
      'ideaGit.fileHistory.nativeDiff',
      `File History: ${path.basename(filePath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    let nextRawSkip = init.nextRawSkip;
    let hasMore = init.hasMore;
    let loadMoreInFlight = false;
    const items = JSON.stringify(init.rows);
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:12px}
      .wrap{display:flex;height:100vh;min-height:0}
      .leftCol{width:320px;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;min-height:0;min-width:0}
      #left{flex:1;overflow:auto;min-height:0}
      #histFoot{flex-shrink:0;padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);border-top:1px solid var(--vscode-panel-border)}
      .right{flex:1;overflow:auto;padding:0;min-width:0}
      .item{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}
      .item:hover{background:var(--vscode-list-hoverBackground)}.item.sel{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
      .m1{display:flex;align-items:center;gap:8px}
      .m1t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
      .native{opacity:.75;cursor:pointer;user-select:none}
      .native:hover{opacity:1}
      .m2{color:var(--vscode-descriptionForeground);margin-top:2px}
      .ph{position:sticky;top:0;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);padding:6px 10px;display:flex;gap:8px;align-items:center}
      .hint{margin-left:auto;color:var(--vscode-descriptionForeground);font-size:11px}
      .b{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px}.b.add{background:#2ea04333;color:#3fb950}.b.del{background:#f8514933;color:#ff7b72}
      #patch{padding:8px 10px;font-family:var(--vscode-editor-font-family,monospace);line-height:1.45;white-space:pre;overflow:auto}
      .l{display:block}.l.h{color:#6ea8fe}.l.a{color:#3fb950;background:#2ea0431f}.l.d{color:#ff7b72;background:#f851491f}.l.m{color:#d2a8ff}
      .l.c{color:#8b949e}.ctx{display:block;color:#79c0ff;cursor:pointer;background:#1f6feb22;padding:1px 6px;margin:1px 0;border-radius:4px}
      .ctx:hover{background:#1f6feb44}
    </style></head><body><div class="wrap"><div class="leftCol"><div id="left"></div><div id="histFoot"></div></div><div class="right"><div class="ph"><span class="b add" id="addCnt">+0</span><span class="b del" id="delCnt">-0</span><span class="hint">点击左侧小图标打开原生 Diff</span></div><div id="patch"></div></div></div>
      <script>
        const vscode=acquireVsCodeApi();let commits=${items};let hasMore=${JSON.stringify(init.hasMore)};let loadingMore=false;let currentSel=${JSON.stringify(initialHash)};
        const left=document.getElementById('left');const histFoot=document.getElementById('histFoot');
        function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
        function rowHtml(c){return '<div class="item'+(c.hash===currentSel?' sel':'')+'" data-h="'+c.hash+'"><div class="m1"><span class="m1t">'+esc(c.message||'')+'</span><span class="native" data-nh="'+c.hash+'" title="打开 VS Code 原生 Diff">⧉</span></div><div class="m2">'+esc(c.abbrevHash)+'  '+esc(c.author||'')+'  '+esc((c.date||'').replace('T',' ').slice(0,16))+'</div></div>';}
        function setSel(h){currentSel=h;left.querySelectorAll('.item').forEach(el=>el.classList.toggle('sel',el.getAttribute('data-h')===h));}
        function updateFoot(){if(!histFoot)return;histFoot.textContent=hasMore?'向下滚动加载更多':'已全部加载';}
        function scrollSel(){requestAnimationFrame(()=>{const el=left.querySelector('.item.sel');if(el)el.scrollIntoView({block:'nearest'});});}
        function bindScroll(){left.onscroll=()=>{if(!hasMore||loadingMore)return;if(left.scrollTop+left.clientHeight>=left.scrollHeight-100){loadingMore=true;if(histFoot)histFoot.textContent='加载中…';vscode.postMessage({type:'fileHistoryLoadMore'});}};}
        left.addEventListener('click',(e)=>{const nat=e.target.closest('.native');const item=e.target.closest('.item');if(nat){e.stopPropagation();vscode.postMessage({type:'openHistoryCommitNativeDiff',hash:nat.getAttribute('data-nh')});return;}if(item){const h=item.getAttribute('data-h');setSel(h);vscode.postMessage({type:'selectHistoryCommitPatch',hash:h});}});
        const ctxOpen=new Set();
        function renderPatch(p){const lines=(p||'').split('\\n');let add=0,del=0,html='';let i=0,b=0;
          while(i<lines.length){const ln=lines[i];
            if(ln.startsWith(' ')){let j=i;while(j<lines.length&&lines[j].startsWith(' '))j++;const block=lines.slice(i,j);
              const headKeep=2,tailKeep=2,minFold=7;
              const folded=block.length>=minFold&&!ctxOpen.has(b);
              if(folded){
                for(const l of block.slice(0,headKeep)){html+='<span class="l c">'+esc(l)+'</span>';}
                html+='<span class="ctx" data-b="'+b+'">↕ Show '+(block.length-headKeep-tailKeep)+' more context lines</span>';
                for(const l of block.slice(-tailKeep)){html+='<span class="l c">'+esc(l)+'</span>';}
              }else{
                for(const l of block){html+='<span class="l c">'+esc(l)+'</span>';}
              }
              b++;i=j;continue;
            }
            let cls='';if(ln.startsWith('+++')||ln.startsWith('---')){cls='h';}
            else if(ln.startsWith('@@')){cls='m';}else if(ln.startsWith('+')){cls='a';add++;}else if(ln.startsWith('-')){cls='d';del++;}
            html+='<span class="l '+cls+'">'+esc(ln)+'</span>';i++;
          }
          const pEl=document.getElementById('patch');pEl.innerHTML=html;document.getElementById('addCnt').textContent='+'+add;document.getElementById('delCnt').textContent='-'+del;
          pEl.querySelectorAll('.ctx').forEach(el=>{el.onclick=()=>{ctxOpen.add(Number(el.dataset.b));renderPatch(p);};});
        }
        left.innerHTML=commits.map(rowHtml).join('');
        renderPatch('');
        function tryAutoLoadMore(){if(!hasMore||loadingMore)return;if(left.scrollHeight<=left.clientHeight+8){loadingMore=true;if(histFoot)histFoot.textContent='加载中…';vscode.postMessage({type:'fileHistoryLoadMore'});}}
        bindScroll();updateFoot();scrollSel();requestAnimationFrame(()=>requestAnimationFrame(tryAutoLoadMore));
        window.addEventListener('message',e=>{const m=e.data;if(m.type==='historyCommitsAppend'){const seen=new Set(commits.map(x=>x.hash));for(const c of(m.commits||[])){if(seen.has(c.hash))continue;seen.add(c.hash);commits.push(c);left.insertAdjacentHTML('beforeend',rowHtml(c));}hasMore=!!m.hasMore;loadingMore=false;updateFoot();tryAutoLoadMore();return;}if(m.type==='historyPatch'){renderPatch(m.patch||'');setSel(m.hash||currentSel);scrollSel();}});
      </script></body></html>`;
    void this.gitService.getFilePatchAtCommit(repo, initialHash, filePath).then((patch) => {
      panel.webview.postMessage({ type: 'historyPatch', hash: initialHash, patch });
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'fileHistoryLoadMore') {
        if (loadMoreInFlight || !hasMore) { return; }
        loadMoreInFlight = true;
        try {
          const page = await this.gitService.getFileHistoryPage(repo, filePath, uptoHash, nextRawSkip, LogViewProvider.FILE_HISTORY_PAGE_SIZE);
          nextRawSkip = page.nextRawSkip;
          hasMore = page.hasMore;
          panel.webview.postMessage({ type: 'historyCommitsAppend', commits: page.commits.map(LogViewProvider.fileHistoryRowLite), hasMore });
        } catch {
          panel.webview.postMessage({ type: 'historyCommitsAppend', commits: [], hasMore: false });
        } finally {
          loadMoreInFlight = false;
        }
        return;
      }
      if (msg.type === 'openHistoryCommitNativeDiff') {
        if (!msg.hash) { return; }
        await this.gitService.showFileDiffInNewTab(repo, msg.hash, filePath);
        return;
      }
      if (msg.type !== 'selectHistoryCommitPatch' || !msg.hash) { return; }
      const patch = await this.gitService.getFilePatchAtCommit(repo, msg.hash, filePath);
      panel.webview.postMessage({ type: 'historyPatch', hash: msg.hash, patch });
    });
  }

  private async openFileHistoryPanel(repo: string, filePath: string, uptoHash: string) {
    const page = await this.gitService.getFileHistoryPage(repo, filePath, uptoHash, 0, 200);
    const commits = page.commits;
    const panel = vscode.window.createWebviewPanel(
      'ideaGit.fileHistory',
      `History Up to Here: ${path.basename(filePath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const firstHash = commits.length ? commits[0].hash : '';
    const firstPatch = firstHash ? await this.gitService.getFilePatchAtCommit(repo, firstHash, filePath) : '';
    const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const initialCommits = JSON.stringify(commits.map(c => ({
      hash: c.hash, abbrevHash: c.abbrevHash, author: c.author, date: c.date, message: c.message
    })));
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:12px}
      .wrap{display:flex;height:100vh}.left{width:280px;border-right:1px solid var(--vscode-panel-border);overflow:auto}
      .right{flex:1;overflow:auto;padding:0}.item{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}
      .item:hover{background:var(--vscode-list-hoverBackground)}.item.sel{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
      .m1{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.m2{color:var(--vscode-descriptionForeground);margin-top:2px}
      .ph{position:sticky;top:0;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);padding:6px 10px;display:flex;gap:8px;align-items:center}
      .b{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px}.b.add{background:#2ea04333;color:#3fb950}.b.del{background:#f8514933;color:#ff7b72}
      #patch{padding:8px 10px;font-family:var(--vscode-editor-font-family,monospace);line-height:1.45;white-space:pre;overflow:auto}
      .l{display:block}.l.h{color:#6ea8fe}.l.a{color:#3fb950;background:#2ea0431f}.l.d{color:#ff7b72;background:#f851491f}.l.m{color:#d2a8ff}
      .l.c{color:#8b949e}.ctx{display:block;color:#79c0ff;cursor:pointer;background:#1f6feb22;padding:1px 6px;margin:1px 0;border-radius:4px}
      .ctx:hover{background:#1f6feb44}
    </style></head><body><div class="wrap"><div class="left" id="left"></div><div class="right"><div class="ph"><span class="b add" id="addCnt">+0</span><span class="b del" id="delCnt">-0</span></div><div id="patch"></div></div></div>
      <script>
      const vscode=acquireVsCodeApi(); const commits=${initialCommits}; const left=document.getElementById('left');
      const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      function render(sel){left.innerHTML=commits.map(c=>'<div class="item'+(c.hash===sel?' sel':'')+'" data-h="'+c.hash+'"><div class="m1">'+(c.message||'')+'</div><div class="m2">'+c.abbrevHash+'  '+c.author+'  '+(c.date||'').replace('T',' ').slice(0,16)+'</div></div>').join('');
        left.querySelectorAll('.item').forEach(el=>el.onclick=()=>vscode.postMessage({type:'selectHistoryCommit',hash:el.dataset.h,selected:sel}));}
      const ctxOpen=new Set();
      function renderPatch(p){const lines=(p||'').split('\\n');let add=0,del=0,html='';let i=0,b=0;
        while(i<lines.length){const ln=lines[i];
          if(ln.startsWith(' ')){let j=i;while(j<lines.length&&lines[j].startsWith(' '))j++;const block=lines.slice(i,j);
            const headKeep=2,tailKeep=2,minFold=7;
            const folded=block.length>=minFold&&!ctxOpen.has(b);
            if(folded){
              for(const l of block.slice(0,headKeep)){html+='<span class="l c">'+esc(l)+'</span>';}
              html+='<span class="ctx" data-b="'+b+'">↕ Show '+(block.length-headKeep-tailKeep)+' more context lines</span>';
              for(const l of block.slice(-tailKeep)){html+='<span class="l c">'+esc(l)+'</span>';}
            }else{
              for(const l of block){html+='<span class="l c">'+esc(l)+'</span>';}
            }
            b++;i=j;continue;
          }
          let cls='';if(ln.startsWith('+++')||ln.startsWith('---')){cls='h';}
          else if(ln.startsWith('@@')){cls='m';}else if(ln.startsWith('+')){cls='a';add++;}else if(ln.startsWith('-')){cls='d';del++;}
          html+='<span class="l '+cls+'">'+esc(ln)+'</span>';i++;
        }
        const pEl=document.getElementById('patch');pEl.innerHTML=html;document.getElementById('addCnt').textContent='+'+add;document.getElementById('delCnt').textContent='-'+del;
        pEl.querySelectorAll('.ctx').forEach(el=>{el.onclick=()=>{ctxOpen.add(Number(el.dataset.b));renderPatch(p);};});
      }
      render('${firstHash}');renderPatch(${JSON.stringify(firstPatch)});
      window.addEventListener('message',e=>{const m=e.data; if(m.type==='historyPatch'){renderPatch(m.patch||''); render(m.hash||'');}});
      </script></body></html>`;
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type !== 'selectHistoryCommit' || !msg.hash) { return; }
      const patch = await this.gitService.getFilePatchAtCommit(repo, msg.hash, filePath);
      panel.webview.postMessage({ type: 'historyPatch', hash: msg.hash, patch });
    });
  }

  /** 切到 VS Code 内置源代码管理（Git）视图，在 Merge Changes 等区域解决冲突。 */
  private async focusSourceControlForConflicts(): Promise<void> {
    try { await vscode.commands.executeCommand('workbench.view.scm'); } catch { /* ignore */ }
  }

  /** 操作结束后展示提示；若曾 autostash，说明是否已自动 Unshelve 及冲突。 */
  private async finishWithAutoStash(
    repo: string, res: { shelved: boolean; stashRef?: string; unshelveConflicts: string[] }, successMsg: string
  ): Promise<void> {
    if (res.unshelveConflicts.length > 0) {
      const stashHint = res.stashRef ? `（已保留 ${res.stashRef}，可手动 git stash pop）` : '';
      const open = await vscode.window.showWarningMessage(
        `${successMsg}；恢复本地未提交改动时冲突 ${res.unshelveConflicts.length} 个路径${stashHint}。`,
        '打开冲突文件'
      );
      if (open === '打开冲突文件') { await this.gitService.openConflictFiles(repo, res.unshelveConflicts); }
    } else if (res.shelved) {
      vscode.window.showInformationMessage(`${successMsg}；已自动恢复 Shelve 的改动${res.stashRef ? `（${res.stashRef}）` : ''}`);
    } else {
      vscode.window.showInformationMessage(successMsg);
    }
  }

  /** pullFromTracking 结束后展示通用提示，含 unshelve 冲突提醒。 */
  private async notifyPullResult(repo: string, res: { shelved: boolean; stashRef?: string; unshelveConflicts: string[] }): Promise<void> {
    await this.finishWithAutoStash(repo, res, 'Pull 已完成');
  }

  /** 切分支后若产生 Shelve（stash），自动尝试 Unshelve；冲突时引导到源代码管理。 */
  private async tryAutoUnshelve(repo: string, switched: { shelved: boolean; stashRef?: string }, successMsg: string): Promise<void> {
    if (!switched.shelved) { vscode.window.showInformationMessage(successMsg); return; }
    const un = await this.gitService.unshelve(repo);
    if (un.ok) {
      vscode.window.showInformationMessage(`${successMsg}；已自动恢复 Shelve 的改动${switched.stashRef ? `（${switched.stashRef}）` : ''}`);
      return;
    }
    const stashHint = switched.stashRef ? `（已保留 ${switched.stashRef}，可手动 git stash pop）` : '';
    const open = await vscode.window.showWarningMessage(
      `${successMsg}；自动 Unshelve 出现冲突 ${un.conflictFiles.length} 个文件${stashHint}。`,
      '打开源代码管理'
    );
    if (open === '打开源代码管理') { await this.focusSourceControlForConflicts(); }
  }

  /**
   * Rebase 冲突循环引导：切到 Git 面板解决冲突 → Continue/Skip/Abort → 若仍冲突再循环。
   * 子模块场景额外提供 "Fetch Submodules"，避免 `Could not read <oid>` 类问题。
   */
  private async handleRebaseConflict(repo: string, error: any): Promise<void> {
    if (!(await this.gitService.isRebasing(repo))) {
      vscode.window.showErrorMessage(`Rebase 失败: ${error?.message || error}`);
      return;
    }
    const hasSubmodules = await this.gitService.hasSubmodules(repo);
    const initialErr = `${(error as { stderr?: unknown })?.stderr ?? ''}\n${error?.message ?? ''}`;
    const submoduleHint = /Recursive merging with submodules|each conflicted submodule|submoduleMergeConflict|Could not read [0-9a-f]{40}/i.test(initialErr);
    let firstRound = true;
    let lastAutoContinueFailed = false;
    while (await this.gitService.isRebasing(repo)) {
      const conflicts = await this.gitService.getConflictFiles(repo);
      if (conflicts.length === 0 && !lastAutoContinueFailed) {
        try { await this.gitService.rebaseContinue(repo); continue; }
        catch (e: any) {
          lastAutoContinueFailed = true;
          vscode.window.showWarningMessage(`自动 Continue 失败: ${e?.message || e}`);
          continue;
        }
      }
      if (conflicts.length) { await this.focusSourceControlForConflicts(); }
      const submoduleTip = (firstRound && submoduleHint)
        ? '检测到子模块冲突：通常是父仓库提交里更新了子模块指针，需先到对应子模块仓库手动合并/更新到目标 commit，再回父仓库 git add 该子模块，最后 Continue。'
        : '';
      const tip = (conflicts.length
        ? `Rebase 冲突: ${conflicts.length} 个文件待解决，已在源代码管理中打开。`
        : 'Rebase 中: 自动 Continue 未通过，请手动选择操作。')
        + (submoduleTip ? `\n${submoduleTip}` : '');
      firstRound = false;
      const buttons: string[] = ['Continue', 'Skip', 'Abort'];
      if (hasSubmodules) { buttons.push('Fetch Submodules'); }
      const action = await vscode.window.showWarningMessage(tip, ...buttons);
      if (!action) { return; }
      try {
        if (action === 'Continue') { await this.gitService.rebaseContinue(repo); lastAutoContinueFailed = false; }
        else if (action === 'Skip') { await this.gitService.rebaseSkip(repo); lastAutoContinueFailed = false; }
        else if (action === 'Fetch Submodules') {
          await this.gitService.submoduleSyncAndFetch(repo);
          vscode.window.showInformationMessage('已同步并初始化子模块对象。可重试 Continue。');
          lastAutoContinueFailed = false;
        }
        else { await this.gitService.rebaseAbort(repo); vscode.window.showInformationMessage('已 Abort Rebase'); return; }
      } catch (e: any) {
        vscode.window.showWarningMessage(`${action} 后仍有冲突: ${e?.message || e}`);
      }
    }
    vscode.window.showInformationMessage('Rebase 已完成');
  }

  private async handleMergeConflict(repo: string, error: any): Promise<void> {
    if (!(await this.gitService.isMerging(repo))) {
      if (await this.gitService.isRebasing(repo)) {
        vscode.window.showErrorMessage(
          `Merge 未完成: ${error?.message || error}。当前仓库仍在 Rebase 中，请先在日志顶栏完成或 Abort Rebase，再执行 Merge。`
        );
      } else {
        vscode.window.showErrorMessage(`Merge 失败: ${error?.message || error}`);
      }
      return;
    }
    let lastAutoCommitFailed = false;
    while (await this.gitService.isMerging(repo)) {
      const conflicts = await this.gitService.getConflictFiles(repo);
      if (conflicts.length === 0 && !lastAutoCommitFailed) {
        try { await this.gitService.mergeContinue(repo); continue; }
        catch (e: any) {
          lastAutoCommitFailed = true;
          vscode.window.showWarningMessage(`自动 Commit 失败: ${e?.message || e}`);
          continue;
        }
      }
      if (conflicts.length) { await this.focusSourceControlForConflicts(); }
      const tip = conflicts.length
        ? `Merge 冲突: ${conflicts.length} 个文件待解决，已在源代码管理中打开。处理完后选择操作。`
        : `Merge 中: 自动 Commit 未通过，请手动选择操作。`;
      const action = await vscode.window.showWarningMessage(tip, 'Commit', 'Abort');
      if (!action) { return; }
      try {
        if (action === 'Commit') { await this.gitService.mergeContinue(repo); lastAutoCommitFailed = false; }
        else { await this.gitService.mergeAbort(repo); vscode.window.showInformationMessage('已 Abort Merge'); return; }
      } catch (e: any) {
        vscode.window.showWarningMessage(`${action} 后仍有冲突: ${e?.message || e}`);
      }
    }
    vscode.window.showInformationMessage('Merge 已完成');
  }

  async refresh() {
    if (!this.view || !this.currentRepo) { return; }
    this.logStaleSeq++;
    const mySeq = this.logStaleSeq;
    try {
      const repo = this.currentRepo.rootPath;
      const [branches, currentBranch, tags, authors] = await Promise.all([
        this.gitService.getBranches(repo), this.gitService.getCurrentBranch(repo), this.gitService.getTags(repo),
        this.gitService.getLogAuthors(repo),
      ]);
      this.maybeFollowHead(repo, currentBranch);
      const { opts, emptyMe } = await this.buildGetLogOpts(repo, this.currentLogFilters, 0, LogViewProvider.INITIAL_PAGE_SIZE);
      const commits = emptyMe ? [] : await this.gitService.getLog(repo, opts);
      const repos = await this.buildReposWithUpdateFlags();
      const inProgress = await this.detectInProgress(repo);
      if (mySeq !== this.logStaleSeq) { return; }
      this.postMessage({ type: 'logData', commits, branches, currentBranch, tags, authors, repos, currentRepoPath: repo, activeFilters: this.currentLogFilters, inProgress, append: false, hasMore: commits.length >= LogViewProvider.INITIAL_PAGE_SIZE });
    } catch (e: any) { vscode.window.showErrorMessage(`刷新失败: ${e.message}`); }
  }

  /** 改变某 commit 的 refs/标签后，重新拉取 changed 面板的 detail/files 并发送到 webview。 */
  private async refreshCommitDetail(repo: string, hash: string): Promise<void> {
    if (!hash) { return; }
    const oid = await this.gitService.resolveCommitOid(repo, hash);
    try {
      const [files, detail, mergeGroups] = await Promise.all([
        this.gitService.getCommitFiles(repo, oid),
        this.gitService.getCommitDetail(repo, oid),
        this.gitService.getMergeFileGroups(repo, oid),
      ]);
      this.postMessage({ type: 'commitFiles', hash: oid, files, detail, mergeGroups });
    } catch (e: any) {
      vscode.window.showErrorMessage(`同步提交详情失败: ${e?.message || e}`);
    }
  }

  private async buildReposWithUpdateFlags(): Promise<Array<GitRepo & { hasRemoteUpdates: boolean }>> {
    const repos = this.gitService.getRepos();
    const flags = await Promise.all(repos.map(r => this.gitService.repoHasRemoteUpdates(r.rootPath).catch(() => false)));
    return repos.map((r, i) => ({ ...r, hasRemoteUpdates: flags[i] }));
  }

  /** 检测 rebase / merge 进行中，以及「仅工作区未合并」（如 rebase 已完成但 autostash 恢复失败），供顶部横幅展示。 */
  private async detectInProgress(repo: string): Promise<{
    rebase: boolean; merge: boolean; conflicts: number; conflictOnly: boolean; repoName: string;
    head: string; onto: string; ontoName: string; otherRef: string; done: number; total: number;
  }> {
    const repoName = this.currentRepo?.name || '';
    const [rebase, merge] = await Promise.all([
      this.gitService.isRebasing(repo).catch(() => false),
      this.gitService.isMerging(repo).catch(() => false),
    ]);
    let conflicts = 0;
    try { conflicts = (await this.gitService.getConflictFiles(repo)).length; } catch { /* ignore */ }
    const conflictOnly = conflicts > 0 && !rebase && !merge;
    const base = { rebase, merge, conflicts, conflictOnly, repoName, head: '', onto: '', ontoName: '', otherRef: '', done: 0, total: 0 };
    if (rebase || merge) {
      try {
        const info = await this.gitService.getOperationInfo(repo);
        base.head = info.head; base.onto = info.onto; base.ontoName = info.ontoName;
        base.otherRef = info.otherRef; base.done = info.done; base.total = info.total;
      } catch { /* ignore */ }
    } else if (conflictOnly) {
      try { base.head = await this.gitService.getCurrentBranch(repo); } catch { /* ignore */ }
    }
    return base;
  }

  /**
   * filter.branch 默认跟随当前 HEAD：
   * - 首次进入仓库或没有任何 filter 时，把 branch filter 设为当前分支
   * - 用户没主动改过 branch filter（filter.branch === 上次观察到的分支）时，
   *   外部切分支自动同步到新分支；用户主动选了别的分支则保留其选择
   */
  private maybeFollowHead(repo: string, currentBranch: string): void {
    const detached = !currentBranch || currentBranch.startsWith('(');
    const noFilters = !this.currentLogFilters.branch && !this.currentLogFilters.author && !this.currentLogFilters.after && !this.currentLogFilters.before && !this.currentLogFilters.path;
    if (noFilters && this.defaultBranchFilterAppliedRepo !== repo && !detached) {
      this.currentLogFilters = { branch: currentBranch };
      this.defaultBranchFilterAppliedRepo = repo;
    } else if (
      !detached &&
      this.lastObservedBranch && this.lastObservedBranch !== currentBranch &&
      this.currentLogFilters.branch === this.lastObservedBranch
    ) {
      this.currentLogFilters = { ...this.currentLogFilters, branch: currentBranch };
    }
    this.lastObservedBranch = currentBranch;
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
.tb-search input{background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);padding:3px 6px;border-radius:3px;font-size:12px;width:90px}
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
.repo-select{position:relative;flex-shrink:0;margin-right:6px}
.repo-select-btn{display:inline-flex;align-items:center;gap:4px;cursor:pointer;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.repo-select-btn::after{content:'\\25BE';opacity:.65;font-size:10px;flex-shrink:0}
.repo-select-btn.has-updates{border-color:#f0883e;color:#f0883e;box-shadow:0 0 0 1px #f0883e60 inset}
.repo-select-dd{left:auto;right:auto;width:max-content;min-width:0;max-width:min(360px,60vw);max-height:240px;z-index:300}
.repo-select-dd .tb-dd-item.sel{background:var(--active);color:var(--active-fg)}
.repo-select-dd .tb-dd-item.has-updates{color:#f0883e}
.repo-update-badge{display:none;align-items:center;justify-content:center;gap:2px;min-width:20px;min-height:20px;padding:2px 7px;margin-right:4px;border-radius:10px;background:#f0883e;color:#1f1f1f;font-size:11px;font-weight:700;cursor:pointer;user-select:none;line-height:1;flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums}
.repo-update-badge.show{display:inline-flex}
.repo-update-badge:hover{filter:brightness(1.1)}
.tb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;margin-right:4px;background:transparent;color:var(--fg);border:1px solid transparent;border-radius:3px;font-size:14px;line-height:1;cursor:pointer;flex-shrink:0;opacity:.75}
.tb-icon-btn:hover{background:var(--hover);border-color:var(--input-border);opacity:1}
.date-picker{position:fixed;display:flex;flex-direction:column;background:var(--vscode-menu-background,#252526);border:1px solid var(--border);border-radius:4px;padding:8px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);font-size:12px;min-width:260px}
.dp-head{display:flex;align-items:center;width:100%;margin-bottom:6px;gap:4px}
.dp-head-side{display:flex;gap:2px;flex:0 0 72px;align-items:center}
.dp-head-side.left{justify-content:flex-start}
.dp-head-side.right{justify-content:flex-end}
.dp-title{flex:1;min-width:0;text-align:center;font-weight:600;font-variant-numeric:tabular-nums}
.dp-nav{background:transparent;border:1px solid transparent;color:var(--fg);border-radius:3px;cursor:pointer;padding:2px 6px;line-height:1;font-size:13px}
.dp-nav:hover{background:var(--hover);border-color:var(--input-border)}
.dp-grid{display:grid;grid-template-columns:repeat(7,30px);gap:2px}
.dp-cell{height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:3px;user-select:none}
.dp-cell.head{color:var(--desc);cursor:default;font-weight:600;font-size:11px}
.dp-cell.dim{opacity:.35}
.dp-cell:hover:not(.head){background:var(--hover)}
.dp-cell.today{outline:1px dashed var(--vscode-focusBorder,#007fd4);outline-offset:-2px}
.dp-cell.range{background:var(--vscode-list-inactiveSelectionBackground,#3a3d41)}
.dp-cell.endpoint{background:var(--active);color:var(--active-fg)}
.dp-hint{margin-top:6px;color:var(--desc);font-size:11px}
.main{display:flex;flex:1;overflow:hidden}
.branch-panel{width:200px;min-width:140px;border-right:1px solid var(--border);flex-shrink:0;height:100%;overflow-y:auto;overflow-x:hidden;position:relative}
.bp-pinned{position:sticky;top:0;z-index:5;background:var(--bg);box-shadow:0 1px 4px rgba(0,0,0,.3)}
.bp-toolbar{display:flex;align-items:center;padding:4px 6px;gap:3px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.toggle-btn{background:none;border:1px solid var(--input-border);color:var(--fg);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:11px;line-height:16px;white-space:nowrap}
.toggle-btn.active{background:var(--badge);color:var(--badge-fg);border-color:var(--badge)}
.bp-content{}
.bp-head{background:var(--bg);border-bottom:1px solid var(--border)}
.bp-head .branch-item{padding:5px 10px;font-weight:600}
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
.ftype{width:18px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;opacity:.92}
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
.hidden{display:none}
.resize-handle{width:4px;cursor:col-resize;flex-shrink:0}
.resize-handle:hover{background:var(--vscode-focusBorder,#007fd4)}
.op-banner{display:none;align-items:center;gap:8px;padding:4px 10px;background:var(--vscode-inputValidation-warningBackground,#5a4500);color:var(--vscode-inputValidation-warningForeground,#fff);border-bottom:1px solid var(--vscode-inputValidation-warningBorder,#b89500);font-size:12px}
.op-banner.show{display:flex}
.op-banner.merge{background:var(--vscode-inputValidation-infoBackground,#063b49);border-bottom-color:var(--vscode-inputValidation-infoBorder,#007acc)}
.op-banner .op-label{font-weight:600}
.op-banner .op-meta{opacity:.95}
.op-banner .op-meta b{font-weight:600}
.op-banner .op-sep{opacity:.5;margin:0 2px}
.op-banner .op-conflicts{color:var(--vscode-errorForeground,#f48771);font-weight:600}
.op-banner .op-btns{margin-left:auto;display:flex;gap:6px}
.op-banner button{padding:2px 8px;font-size:12px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);border-radius:3px}
.op-banner button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.op-banner button.danger{background:var(--vscode-errorForeground,#a1260d);color:#fff;border-color:transparent}
.op-banner button.danger:hover{filter:brightness(1.1)}
</style></head>
<body>
<div class="root">
  <div class="op-banner" id="opBanner"></div>
  <div class="toolbar" id="toolbar">
    <div class="repo-select" id="repoSelectWrap" style="display:none">
      <button type="button" class="tb-select repo-select-btn" id="repoSelectBtn" title="选择仓库"></button>
    </div>
    <span id="repoUpdateBadge" class="repo-update-badge" title="点击执行 Refresh（fetch + 刷新）"></span>
    <button class="tb-icon-btn" id="repoExcludeBtn" title="管理排除的仓库">&#x2699;</button>
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
    <div class="dp-head">
      <div class="dp-head-side left">
        <button class="dp-nav" id="dpPrevY" title="上一年">&#171;</button>
        <button class="dp-nav" id="dpPrev" title="上个月">&#8249;</button>
      </div>
      <span class="dp-title" id="dpTitle"></span>
      <div class="dp-head-side right">
        <button class="dp-nav" id="dpNext" title="下个月">&#8250;</button>
        <button class="dp-nav" id="dpNextY" title="下一年">&#187;</button>
      </div>
    </div>
    <div class="dp-grid" id="dpGrid"></div>
    <div class="dp-hint">先点起始日期，再点截止日期；范围内自动高亮。</div>
  </div>
  <div class="main">
    <div class="branch-panel" id="branchPanel">
      <div class="bp-pinned">
        <div class="bp-toolbar">
          <button class="toggle-btn active" id="bpTree" title="Tree view">Tree</button>
          <button class="toggle-btn" id="bpFlat" title="Flat view">Flat</button>
          <button class="toggle-btn" id="bpCollapse" title="Collapse all">Fold</button>
          <button class="toggle-btn" id="bpJumpHead" title="Jump to HEAD">Head</button>
        </div>
        <div class="bp-head" id="bpHead"></div>
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
        <span id="fpTitle">Changed</span>
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
<div class="tb-dd repo-select-dd" id="repoSelectDD"></div>
<script>
const vscode=acquireVsCodeApi();
const FILTER_AUTHOR_ME='${LogViewProvider.filterAuthorMe}';
let allCommits=[],allBranches=[],allTags=[],currentBranch='';
let selectedHashes=new Set(),lastClickedIdx=-1;
let branchViewMode='tree', filesViewMode='tree';
let currentFilesHash=null, currentFiles=[], currentDetail=null, currentMergeGroups=null;
const branchTreeOpen=new Set();
let branchClickTimer=null;
let lastBranchSig='';
function branchPanelSig(){
  const bs=(allBranches||[]).map(b=>b.name+'#'+(b.remote?'r':'l')+'#'+(b.tracking||'')+'#'+(b.behind||0)+'/'+(b.ahead||0)).join('|');
  return currentBranch+'\\u0001'+bs+'\\u0001'+(allTags||[]).join('|');
}
const LOG_INITIAL_PAGE_SIZE=80;
const LOG_PAGE_SIZE=200;
let logHasMore=true,logLoadingMore=false,currentLoadFilters={};
let lastIssuedLogReqId=0;
const authorLastAt=new Map();
function syncAuthors(list){
  if(!Array.isArray(list)||!list.length)return;
  authorLastAt.clear();
  for(const a of list){
    if(!a||!a.name)continue;
    authorLastAt.set(a.name,Number(a.lastAt)||0);
  }
}
function rememberAuthor(name,ts){
  if(!name)return;
  const t=Number(ts)||0;
  const cur=authorLastAt.get(name);
  if(cur==null||t>cur)authorLastAt.set(name,t);
}
function authorsByRecent(){
  return [...authorLastAt.keys()].sort((a,b)=>{
    const da=authorLastAt.get(a)||0,db=authorLastAt.get(b)||0;
    return db-da||(a+'').localeCompare(b+'');
  });
}
const $=id=>document.getElementById(id);

window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type==='logData'){
    if(m.reqId!=null&&m.reqId<lastIssuedLogReqId)return;
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
      for(const c of incoming)rememberAuthor(c.author,c.timestamp);
    }else{
      allCommits=incoming;
      syncAuthors(m.authors);
      if(!authorLastAt.size)for(const c of incoming)rememberAuthor(c.author,c.timestamp);
    }
    if(m.append){
      const seen=new Set(allCommits.map(c=>c.hash));
      for(const c of incoming){if(!seen.has(c.hash))allCommits.push(c);}
    }
    allBranches=Array.isArray(m.branches)?m.branches:allBranches;allTags=Array.isArray(m.tags)?m.tags:allTags;currentBranch=m.currentBranch||currentBranch;
    logHasMore=typeof m.hasMore==='boolean'?m.hasMore:(incoming.length>=LOG_PAGE_SIZE);
    logLoadingMore=false;
    if(m.repos)renderRepoSelect(m.repos,m.currentRepoPath);
    if('inProgress' in m){renderOpBanner(m.inProgress||null);}
    const _sig=branchPanelSig();
    if(_sig!==lastBranchSig){lastBranchSig=_sig;renderBranches();}
    renderBranchFilter();renderAuthorList();renderFilterBar();renderLog(allCommits);
    if(filters.branch)highlightBranch(filters.branch);
  }else if(m.type==='commitFiles'){
    currentFilesHash=m.hash;currentFiles=m.files||[];currentDetail=m.detail||null;currentMergeGroups=m.mergeGroups||null;
    if(m.hash&&selectedHashes.size===1){selectedHashes.clear();selectedHashes.add(m.hash);renderLog(allCommits);}
    renderFiles(currentFiles,m.hash);
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
function closeRepoSelectDropdown(){
  const dd=$('repoSelectDD');
  if(dd)dd.classList.remove('show');
}
function toggleRepoSelectDropdown(){
  const btn=$('repoSelectBtn'),dd=$('repoSelectDD');
  if(!btn||!dd)return;
  if(dd.classList.contains('show')){closeRepoSelectDropdown();return;}
  const r=btn.getBoundingClientRect();
  dd.style.position='fixed';
  dd.style.left=r.left+'px';
  dd.style.top=(r.bottom+2)+'px';
  dd.style.right='auto';
  dd.style.width='max-content';
  dd.style.minWidth=r.width+'px';
  dd.style.maxWidth='min(360px,60vw)';
  dd.classList.add('show');
}
function renderRepoSelect(repos,cur){
  const wrap=$('repoSelectWrap');
  const btn=$('repoSelectBtn');
  const dd=$('repoSelectDD');
  const badge=$('repoUpdateBadge');
  const updatedRepos=(repos||[]).filter(r=>r&&r.hasRemoteUpdates);
  const curHasUpdates=!!updatedRepos.find(r=>r.rootPath===cur);
  const otherUpdated=updatedRepos.filter(r=>r.rootPath!==cur);
  if(badge){
    if(curHasUpdates||otherUpdated.length){
      badge.classList.add('show');
      const lines=[];
      if(curHasUpdates)lines.push('当前仓库远端有未拉取的更新');
      if(otherUpdated.length)lines.push('以下仓库远端有更新：\\n  '+otherUpdated.map(r=>r.name).join('\\n  '));
      badge.title=lines.join('\\n')+'\\n\\n点击执行 Refresh（fetch + 刷新）';
      badge.textContent=String(updatedRepos.length);
    }else{
      badge.classList.remove('show');
    }
  }
  if(!wrap||!btn||!dd)return;
  if(repos&&repos.length<=1){wrap.style.display='none';dd.classList.remove('show');return;}
  wrap.style.display='';
  const current=(repos||[]).find(r=>r.rootPath===cur)||repos[0];
  btn.textContent=(current&&current.hasRemoteUpdates?'* ':'')+(current&&current.name||'');
  btn.classList.toggle('has-updates',curHasUpdates);
  btn.title=updatedRepos.length?'有仓库远端有未拉取的更新':(current&&current.rootPath||'选择仓库');
  dd.innerHTML=repos.map(r=>{
    const mark=r.hasRemoteUpdates?'* ':'';
    const cls='tb-dd-item'+(r.rootPath===cur?' sel':'')+(r.hasRemoteUpdates?' has-updates':'');
    return '<div class="'+cls+'" data-path="'+esc(r.rootPath)+'" title="'+esc(r.rootPath)+(r.hasRemoteUpdates?' （远端有更新）':'')+'">'+mark+eh(r.name)+'</div>';
  }).join('');
  dd.querySelectorAll('.tb-dd-item').forEach(el=>{el.onmousedown=ev=>{ev.preventDefault();pickRepo(el.dataset.path);};});
}
function pickRepo(repoPath){
  if(!repoPath)return;
  closeRepoSelectDropdown();
  filters.branch='';filters.author='';filters.after='';filters.before='';filters.path='';
  $('branchInput').value='';$('searchInput').value='';$('pathInput').value='';
  filterBranchPanel('');renderFilterBar();
  authorLastAt.clear();
  vscode.postMessage({type:'switchRepo',repoPath});
}
const repoBtn=$('repoSelectBtn');
if(repoBtn){repoBtn.onmousedown=ev=>{ev.preventDefault();ev.stopPropagation();toggleRepoSelectDropdown();};}
$('repoUpdateBadge').onclick=()=>{vscode.postMessage({type:'refreshRepos'});};
$('repoExcludeBtn').onclick=()=>{vscode.postMessage({type:'manageExcludedRepos'});};
function renderOpBanner(ip){
  const el=$('opBanner');if(!el)return;
  if(!ip){el.className='op-banner';el.innerHTML='';return;}
  const isMerge=!!ip.merge,isRebase=!!ip.rebase;
  const co=!!ip.conflictOnly||(ip.conflicts>0&&!isRebase&&!isMerge);
  if(!isRebase&&!isMerge&&!co){el.className='op-banner';el.innerHTML='';return;}
  if(co&&!isRebase&&!isMerge){
    el.className='op-banner show';
    const p=['<span class="op-label">工作区存在未合并冲突</span>'];
    if(ip.repoName)p.push('<span class="op-meta">仓库: <b>'+eh(ip.repoName)+'</b></span>');
    if(ip.head)p.push('<span class="op-meta">分支: <b>'+eh(ip.head)+'</b></span>');
    if(ip.conflicts>0)p.push('<span class="op-conflicts">'+ip.conflicts+' 个路径</span>');
    p.push('<span class="op-meta" style="opacity:.9">（无 Rebase/Merge 进行中时，多为恢复本地改动导致，请到源代码管理解决）</span>');
    let coBtns='<button data-op="opOpenScm">源代码管理</button>';
    if(ip.conflicts>0){coBtns='<button data-op="opAcceptOurs">Ours</button><button data-op="opAcceptTheirs">Theirs</button>'+coBtns;}
    p.push('<div class="op-btns">'+coBtns+'</div>');
    el.innerHTML=p.join('<span class="op-sep">·</span>');
    el.querySelectorAll('button[data-op]').forEach(b=>{b.onclick=()=>vscode.postMessage({type:b.getAttribute('data-op')});});
    return;
  }
  el.className='op-banner show'+(isMerge&&!isRebase?' merge':'');
  const parts=[];
  parts.push('<span class="op-label">'+(isRebase?'Rebase':'Merge')+' in progress</span>');
  if(ip.repoName)parts.push('<span class="op-meta">仓库: <b>'+eh(ip.repoName)+'</b></span>');
  if(isRebase){
    if(ip.head)parts.push('<span class="op-meta">分支: <b>'+eh(ip.head)+'</b></span>');
    const onto=ip.ontoName||ip.onto;
    if(onto)parts.push('<span class="op-meta">onto: <b>'+eh(onto)+'</b></span>');
    if(ip.total>0)parts.push('<span class="op-meta">进度: '+ip.done+'/'+ip.total+'</span>');
  }else{
    if(ip.head)parts.push('<span class="op-meta">当前: <b>'+eh(ip.head)+'</b></span>');
    if(ip.otherRef)parts.push('<span class="op-meta">合入: <b>'+eh(ip.otherRef)+'</b></span>');
  }
  parts.push(ip.conflicts>0
    ?'<span class="op-conflicts">'+ip.conflicts+' 个冲突待解决</span>'
    :'<span style="opacity:.85">无未解决冲突</span>');
  let btns=isRebase
    ?'<button data-op="opRebaseContinue">Continue</button><button data-op="opRebaseSkip">Skip</button><button class="danger" data-op="opRebaseAbort">Abort</button>'
    :'<button data-op="opMergeContinue">Commit</button><button class="danger" data-op="opMergeAbort">Abort</button>';
  if(ip.conflicts>0){btns='<button data-op="opAcceptOurs">Ours</button><button data-op="opAcceptTheirs">Theirs</button>'+btns;}
  el.innerHTML=parts.join('<span class="op-sep">·</span>')+'<div class="op-btns">'+btns+'</div>';
  el.querySelectorAll('button[data-op]').forEach(b=>{
    b.onclick=()=>{const op=b.getAttribute('data-op');if(op)vscode.postMessage({type:op});};
  });
}

/* ===== Branch Panel ===== */
$('bpTree').onclick=()=>{branchViewMode='tree';$('bpTree').classList.add('active');$('bpFlat').classList.remove('active');renderBranches();};
$('bpFlat').onclick=()=>{branchViewMode='flat';$('bpFlat').classList.add('active');$('bpTree').classList.remove('active');renderBranches();};
$('bpCollapse').onclick=()=>{branchTreeOpen.clear();if(branchViewMode==='tree')renderBranches();};

function scrollPanelTop(){
  const reset=()=>{['branchPanel','bpContent','logScroll'].forEach(id=>{const el=$(id);if(el){el.scrollTop=0;el.scrollLeft=0;}});};
  reset();
  requestAnimationFrame(()=>{reset();requestAnimationFrame(reset);});
  setTimeout(reset,80);
  setTimeout(reset,300);
}

$('bpJumpHead').onclick=()=>{
  if(!currentBranch)return;
  filters.branch=currentBranch;
  applyF();
  highlightBranch(currentBranch);
  scrollPanelTop();
};

function renderBranches(){
  const p=$('bpContent'),lo=allBranches.filter(b=>!b.remote),rm=allBranches.filter(b=>b.remote);
  const remotes=new Set();
  for(const b of rm){const i=b.name.indexOf('/');if(i>0)remotes.add(b.name.slice(0,i));}
  const singleRemote=remotes.size<=1;
  const rmDisplay=rm.map(b=>{
    const idx=b.name.indexOf('/');
    if(singleRemote&&idx>0&&idx<b.name.length-1)return {...b,displayName:b.name.slice(idx+1)};
    return {...b,displayName:b.name};
  });
  let h='';
  ensureCurrentBranchPathExpanded(lo,rmDisplay);
  const headEl=$('bpHead');
  if(headEl){
    headEl.innerHTML=currentBranch?('<div class="branch-item cur" data-branch="'+esc(currentBranch)+'" title="点击：回到顶部并切到 HEAD 分支">\\u2605 HEAD ('+eh(currentBranch)+')</div>'):'';
    headEl.querySelectorAll('.branch-item').forEach(el=>{bindBI(el);el.addEventListener('click',scrollPanelTop);});
  }
  h+=secHd('Local');
  h+='<div class="sec-body">';
  if(branchViewMode==='tree')h+=buildBTree(lo);
  else for(const b of lo)h+=bLeaf(b,20);
  h+='</div>';
  h+=secHd('Remote');
  h+='<div class="sec-body">';
  if(branchViewMode==='tree')h+=buildBTree(rmDisplay);
  else for(const b of rmDisplay)h+=bLeaf(b,20);
  h+='</div>';
  h+=secHd('Tags');
  h+='<div class="sec-body">';
  if(allTags.length){
    if(branchViewMode==='tree'){
      const tagBranches=allTags.map(t=>({name:t,remote:false,current:false}));
      h+=buildBTree(tagBranches,true);
    }else{
      for(const t of allTags)h+='<div class="branch-item tag-item" data-branch="'+esc(t)+'" data-istag="1" style="padding-left:20px"><span class="bi">\\u{1F3F7}</span>'+eh(t)+'</div>';
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
      const k=el.dataset.k;
      if(k){if(v)branchTreeOpen.add(k);else branchTreeOpen.delete(k);}
    };
  });
  p.querySelectorAll('.branch-item').forEach(el=>{bindBI(el);});
}

function ensureCurrentBranchPathExpanded(localBranches,remoteBranches){
  const all=localBranches.concat(remoteBranches);
  const cur=all.find(b=>b.name===currentBranch);
  if(!cur)return;
  const disp=(cur.displayName||cur.name||'');
  const pts=disp.split('/').filter(Boolean);
  if(pts.length<=1)return;
  let path='';
  for(let i=0;i<pts.length-1;i++){
    path=path?path+'/'+pts[i]:pts[i];
    branchTreeOpen.add(path);
  }
}

function secHd(t){return '<div class="sec-hd"><span class="arr">\\u25BC</span>'+eh(t)+'</div>';}

function buildBTree(branches,isTag){
  const tree={};
  for(const b of branches){
    const display=(b.displayName||b.name);
    const pts=display.split('/');let nd=tree;
    for(let i=0;i<pts.length-1;i++){const k='d_'+pts[i];if(!nd[k])nd[k]={};nd=nd[k];}
    nd['L_'+b.name]=isTag?{...b,isTag:true}:b;
  }
  return rBNode(tree,0,'');
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

function rBNode(nd,dep,parentPath){
  let h='';const indent=10+dep*16;const dirs=[],leaves=[];
  for(const k of Object.keys(nd)){if(k.startsWith('L_'))leaves.push(nd[k]);else if(k.startsWith('d_'))dirs.push({key:k.slice(2),node:nd[k]});}
  dirs.sort((a,b)=>a.key.localeCompare(b.key));
  for(const d of dirs){
    const c=compactDirChain(d.key,d.node);
    const compact=c.name.includes('/');
    const key=parentPath?parentPath+'/'+c.name:c.name;
    const open=branchTreeOpen.has(key);
    h+='<div class="tdir'+(compact?' compact':'')+'" data-k="'+esc(key)+'" style="padding-left:'+indent+'px"><span class="arr">'+(open?'\\u25BC':'\\u25B6')+'</span><span class="dir-ico">'+(open?'\\u{1F4C2}':'\\u{1F4C1}')+'</span><span class="path">'+eh(c.name)+'</span>'+(compact?'<span class="dir-hint">compact</span>':'')+'</div>';
    h+='<div class="tdir-ch"'+(open?'':' style="display:none"')+'>';h+=rBNode(c.node,dep+1,key);h+='</div>';
  }
  for(const b of leaves)h+=bLeaf(b,indent+16);
  return h;
}

function bLeaf(b,indent){
  const c=b.name===currentBranch?' cur':'';
  const ico=b.isTag?'\\u{1F3F7}':(b.name===currentBranch?'\\u2B50':(b.remote?'\\u{1F310}':'\\u{1F33F}'));
  const display=(b.displayName||b.name);
  const lbl=branchViewMode==='tree'?display.split('/').pop():display;
  let sync='';
  if(!b.remote&&!b.isTag){
    if((b.behind||0)>0)sync+='<span title="Need pull">\\u2193 '+b.behind+'</span>';
    if((b.ahead||0)>0)sync+='<span title="Need push">\\u2191 '+b.ahead+'</span>';
  }
  const tagAttr=b.isTag?' data-istag="1"':'';
  const cls=b.isTag?' tag-item':'';
  return '<div class="branch-item'+c+cls+'" data-branch="'+esc(b.name)+'"'+(b.tracking?' data-tracking="'+esc(b.tracking)+'"':'')+tagAttr+' style="padding-left:'+indent+'px"><span class="bi">'+ico+'</span><span class="blabel">'+eh(lbl)+'</span>'+(sync?'<span class="bsync">'+sync+'</span>':'')+'</div>';
}

function bindBI(el){
  el.onclick=(e)=>{
    if(e.detail>=2)return;
    if(branchClickTimer){clearTimeout(branchClickTimer);branchClickTimer=null;}
    const br=el.dataset.branch;
    branchClickTimer=setTimeout(()=>{branchClickTimer=null;filters.branch=br;applyF();highlightBranch(br);},280);
  };
  el.ondblclick=(ev)=>{
    if(branchClickTimer){clearTimeout(branchClickTimer);branchClickTimer=null;}
    ev.preventDefault();ev.stopPropagation();
    const br=el.dataset.branch;
    if(el.dataset.istag==='1'){filters.branch=br;applyF();highlightBranch(br);return;}
    const tracking=el.dataset.tracking;
    let target=tracking;
    if(!target){
      const suffix='/'+br;
      const candidates=allBranches.filter(b=>b.remote&&b.name.endsWith(suffix));
      if(candidates.length===1)target=candidates[0].name;
      else{
        const origin=candidates.find(b=>b.name==='origin'+suffix);
        if(origin)target=origin.name;
      }
    }
    if(!target)target=br;
    filters.branch=target;applyF();highlightBranch(target);
  };
  el.oncontextmenu=ev=>{
    ev.preventDefault();ev.stopPropagation();
    const br=el.dataset.branch, isCur=el.classList.contains('cur');
    if(el.dataset.istag==='1'){
      showCtx(ev.clientX,ev.clientY,[
        {icon:'\\u21AA',label:'Checkout',action:()=>vscode.postMessage({type:'checkoutBranch',branch:br})},
        {sep:1},
        {icon:'\\u{1F5D1}',label:'Delete Tag',action:()=>vscode.postMessage({type:'deleteTag',tag:br})}
      ]);
      return;
    }
    const tracking=el.dataset.tracking;
    const items=[];
    items.push({icon:'\\u21AA',label:'Checkout',action:()=>vscode.postMessage({type:'checkoutBranch',branch:br})});
    items.push({icon:'\\u{1F4CB}',label:'Copy Branch Name',action:()=>{navigator.clipboard.writeText(br);}});
    items.push({icon:'\\u2B07',label:'Update',action:()=>vscode.postMessage({type:'pullBranch',branch:br})});
    items.push({icon:'\\u{1F680}',label:'Push...',action:()=>vscode.postMessage({type:'pushBranch',branch:br,setUpstream:true})});
    items.push({icon:'\\u{1F33F}',label:'New Branch from \\''+br+'\\'...',action:()=>vscode.postMessage({type:'newBranchFrom',branch:br})});
    items.push({sep:1});
    if(!isCur){
      items.push({icon:'\\u{1F501}',label:'Rebase \\''+currentBranch+'\\' onto \\''+br+'\\'',action:()=>vscode.postMessage({type:'rebaseOnto',branch:br})});
      items.push({icon:'\\u{1F500}',label:'Merge \\''+br+'\\' into \\''+currentBranch+'\\'',action:()=>vscode.postMessage({type:'mergeInto',branch:br})});
      items.push({icon:'\\u{1F500}',label:'Merge \\''+currentBranch+'\\' into \\''+br+'\\'',action:()=>vscode.postMessage({type:'mergeCurrentInto',branch:br})});
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
    {icon:'\\u{1F527}',label:'Fixup into previous',action:()=>vscode.postMessage({type:'mergeIntoPrevious',hash})},
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

function mergeGroupsFileCount(mg){
  if(!mg)return 0;
  let n=(mg.combined&&mg.combined.length)||0;
  if(mg.parentDiffs){for(const pd of mg.parentDiffs)n+=(pd.files&&pd.files.length)||0;}
  return n;
}
function renderFiles(files,hash){
  const l=$('filesList'),det=$('commitDetail');
  const mg=currentMergeGroups;
  const flatLen=files&&files.length?files.length:0;
  const mgCount=mergeGroupsFileCount(mg);
  const total=flatLen||mgCount;
  $('fpTitle').textContent=total?'Changed ('+total+')':'Changed';
  if(!flatLen&&!mgCount){
    l.innerHTML='<div style="padding:10px;color:var(--desc)">No changed files</div>';
    if(currentDetail){det.classList.remove('hidden');$('fpResize').classList.remove('hidden');}
    else{det.classList.add('hidden');$('fpResize').classList.add('hidden');}
    return;
  }
  const useMergeLayout=!!(mg&&((mg.combined&&mg.combined.length)||(!flatLen&&mg.parentDiffs&&mg.parentDiffs.some(pd=>pd.files&&pd.files.length))));
  let h='';
  if(useMergeLayout){
    if(mg.combined&&mg.combined.length>0){
      h+='<div class="fp-group"><span>\\u25BC Merge result</span><span class="cnt">'+mg.combined.length+' files</span></div>';
      h+='<div class="fp-group-ch">';
      h+=(filesViewMode==='tree'?buildFTree(mg.combined,hash):buildFFlat(mg.combined,hash));
      h+='</div>';
    }
    if(mg.parentDiffs){
      for(const pd of mg.parentDiffs){
        if(!pd.files||!pd.files.length)continue;
        const only=mgCount===pd.files.length&&!mg.combined?.length;
        h+='<div class="fp-group"><span>'+(only?'\\u25BC':'\\u25B6')+' Changes to '+eh(pd.abbrev)+' '+eh(pd.message.slice(0,50))+'</span><span class="cnt">'+pd.files.length+' files</span></div>';
        h+='<div class="fp-group-ch" style="display:'+(only?'':'none')+'">';
        h+=(filesViewMode==='tree'?buildFTree(pd.files,hash,pd.parentHash):buildFFlat(pd.files,hash,pd.parentHash));
        h+='</div>';
      }
    }
  }else if(flatLen){
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
      if(detailAuthorCommitterDiff(currentDetail)){
        dh+='<div style="color:var(--desc);font-size:11px;margin-bottom:4px;opacity:.92">committed by '+eh(currentDetail.committer)+' &lt;'+eh(currentDetail.committerEmail)+'&gt; on '+fD(currentDetail.committerDate)+'</div>';
      }
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

function fileItemAttrs(f,hash,fromHash){
  const base='data-path="'+esc(f.path)+'" data-hash="'+hash+'"';
  return fromHash?base+' data-from="'+esc(fromHash)+'" data-to="'+esc(hash)+'"':base;
}
function buildFFlat(files,hash,fromHash){
  let h='';for(const f of files)h+='<div class="file-item" '+fileItemAttrs(f,hash,fromHash)+'>'+fileChangeIcons(f)+'<span title="'+esc(f.path)+'">'+eh(f.path)+'</span></div>';
  return h;
}
function buildFTree(files,hash,fromHash){
  const tree={};
  for(const f of files){const pts=f.path.split('/');let nd=tree;for(let i=0;i<pts.length-1;i++){const k='d_'+pts[i];if(!nd[k])nd[k]={};nd=nd[k];}nd['f_'+f.path]=f;}
  return rFNode(tree,hash,0,fromHash);
}
function rFNode(nd,hash,dep,fromHash){
  let h='';const indent=6+dep*16;const dirs=[],leaves=[];
  for(const k of Object.keys(nd)){if(k.startsWith('f_'))leaves.push(nd[k]);else if(k.startsWith('d_'))dirs.push({key:k.slice(2),node:nd[k]});}
  dirs.sort((a,b)=>a.key.localeCompare(b.key));
  for(const d of dirs){
    const c=compactDirChain(d.key,d.node);
    h+='<div class="fdir'+(c.name.includes('/')?' compact':'')+'" style="padding-left:'+indent+'px"><span class="arr">\\u25BC</span><span class="dir-ico">\\u{1F4C2}</span><span class="path">'+eh(c.name)+'</span></div>';
    h+='<div class="fdir-ch">';h+=rFNode(c.node,hash,dep+1,fromHash);h+='</div>';
  }
  for(const f of leaves){const nm=f.path.split('/').pop();
    h+='<div class="file-item" '+fileItemAttrs(f,hash,fromHash)+' style="padding-left:'+(indent+16)+'px">'+fileChangeIcons(f)+'<span title="'+esc(f.path)+'">'+eh(nm)+'</span></div>';}
  return h;
}
function bindFI(c){c.querySelectorAll('.file-item').forEach(el=>{el.onclick=()=>{
  if(el.dataset.mode==='worktree'){vscode.postMessage({type:'showWorkTreeDiff',ref:el.dataset.from,filePath:el.dataset.path});}
  else if(el.dataset.from){vscode.postMessage({type:'showBranchDiff',from:el.dataset.from,to:el.dataset.to,filePath:el.dataset.path});}
  else{vscode.postMessage({type:'showDiff',hash:el.dataset.hash,filePath:el.dataset.path});}
};el.oncontextmenu=e=>fileCtx(e,el);});}

function fileCtx(e,el){
  e.preventDefault();e.stopPropagation();
  const fp=el.dataset.path,h=el.dataset.hash;
  if(!fp||!h){return;}
  showCtx(e.clientX,e.clientY,[
    {icon:'\\u21A9',label:'Revert Selected Changes',action:()=>vscode.postMessage({type:'revertFileToHead',filePath:fp})},
    {icon:'\\u{1F352}',label:'Cherry-Pick Selected Changes',action:()=>vscode.postMessage({type:'checkoutFileFromRevision',hash:h,filePath:fp})},
    {icon:'\\u{1F553}',label:'Show History',action:()=>vscode.postMessage({type:'fileHistory',filePath:fp,focusHash:h})}
  ]);
}

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
    h+='<div class="file-item" data-path="'+esc(f.path)+'" data-from="'+esc(from)+'" data-to="'+esc(to)+'"'+(mode?' data-mode="'+mode+'"':'')+' style="padding-left:'+(indent+16)+'px">'+fileChangeIcons(f)+'<span title="'+esc(f.path)+'">'+eh(nm)+'</span></div>';}
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
function datePickerOpen(){const dp=$('datePicker');return dp&&dp.style.display==='flex';}
/** 捕获阶段 mousedown：在 click 冒泡被拦截前也能收起日期面板 / 右键菜单 */
function onGlobalPointerDown(ev){
  const dp=$('datePicker'),cm=$('ctxMenu'),sub=$('ctxSubMenu'),repoBtn=$('repoSelectBtn'),repoDD=$('repoSelectDD'),t=ev.target;
  if(datePickerOpen()&&(t===dp||dp.contains(t)))return;
  if(repoBtn&&(t===repoBtn||repoBtn.contains(t)))return;
  if(repoDD&&(t===repoDD||repoDD.contains(t)))return;
  if(cm===t||cm.contains(t)||sub===t||sub.contains(t))return;
  hideMenus();
  closeRepoSelectDropdown();
}
window.addEventListener('mousedown',onGlobalPointerDown,true);
window.addEventListener('blur',()=>{hideMenus();});
document.addEventListener('scroll',ev=>{
  if(ev.target===$('ctxMenu')||$('ctxMenu').contains(ev.target))return;
  if(ev.target===$('ctxSubMenu')||$('ctxSubMenu').contains(ev.target))return;
  if(ev.target===$('datePicker')||$('datePicker').contains(ev.target))return;
  hideMenus();
  closeRepoSelectDropdown();
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
  const rid=++lastIssuedLogReqId;
  vscode.postMessage({type:'loadLog',filters:f,skip:0,maxCount:LOG_INITIAL_PAGE_SIZE,append:false,reqId:rid});
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
  const uLabel=filters.author?(filters.author===FILTER_AUTHOR_ME?'User: Me':'User: '+eh(filters.author)):'User';
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
    const authors=authorsByRecent();
    const items=[{label:'Me',action:()=>{filters.author=FILTER_AUTHOR_ME;applyF();lastPillAct='';}},{sep:1},...authors.map(a=>({label:a,action:()=>{filters.author=a;applyF();lastPillAct='';}}))];
    setTimeout(()=>showCtx(rect.left,rect.bottom+2,items),0);
  }else if(act==='date'){
    dp.style.display='flex';
    dp.style.left=rect.left+'px';dp.style.top=(rect.bottom+2)+'px';
    dpOpenAt();
  }
}

$('pillReset').onclick=()=>resetAllFilters();
let dpViewYM={y:0,m:0};
const dpSel={from:'',to:''};
function dpYMD(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function dpParse(s){const [y,m,d]=(s||'').split('-').map(Number);return (y&&m&&d)?new Date(y,m-1,d):null;}
function dpOpenAt(){
  dpSel.from=filters.after||'';dpSel.to=filters.before||'';
  const seed=dpParse(dpSel.from)||dpParse(dpSel.to)||new Date();
  dpViewYM={y:seed.getFullYear(),m:seed.getMonth()};
  dpRender();
}
function dpAddMonths(delta){
  let y=dpViewYM.y,m=dpViewYM.m+delta;
  while(m<0){m+=12;y--;}
  while(m>11){m-=12;y++;}
  dpViewYM={y,m};
}
function dpRender(){
  const today=dpYMD(new Date());
  $('dpTitle').textContent=dpViewYM.y+'\u5e74'+String(dpViewYM.m+1).padStart(2,'0')+'\u6708';
  const first=new Date(dpViewYM.y,dpViewYM.m,1);
  const startDow=first.getDay();
  const totalDays=new Date(dpViewYM.y,dpViewYM.m+1,0).getDate();
  const cells=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(h=>'<div class="dp-cell head">'+h+'</div>');
  const prevTotal=new Date(dpViewYM.y,dpViewYM.m,0).getDate();
  for(let i=0;i<startDow;i++){
    const date=new Date(dpViewYM.y,dpViewYM.m-1,prevTotal-startDow+1+i);
    cells.push(dpMakeCell(date,true,today));
  }
  for(let d=1;d<=totalDays;d++){
    cells.push(dpMakeCell(new Date(dpViewYM.y,dpViewYM.m,d),false,today));
  }
  const rest=42-(startDow+totalDays);
  for(let i=1;i<=rest;i++){
    cells.push(dpMakeCell(new Date(dpViewYM.y,dpViewYM.m+1,i),true,today));
  }
  const grid=$('dpGrid');grid.innerHTML=cells.join('');
  grid.querySelectorAll('.dp-cell[data-ymd]').forEach(el=>{el.onclick=ev=>{ev.stopPropagation();dpPick(el.getAttribute('data-ymd'));};});
}
function dpMakeCell(date,dim,today){
  const ymd=dpYMD(date);
  let cls='dp-cell'+(dim?' dim':'');
  if(dpSel.from&&dpSel.to&&ymd>dpSel.from&&ymd<dpSel.to)cls+=' range';
  if(ymd===dpSel.from||ymd===dpSel.to)cls+=' endpoint';
  if(ymd===today)cls+=' today';
  return '<div class="'+cls+'" data-ymd="'+ymd+'">'+date.getDate()+'</div>';
}
function dpPick(ymd){
  if(!dpSel.from||(dpSel.from&&dpSel.to)){
    dpSel.from=ymd;dpSel.to='';
  }else if(ymd<dpSel.from){
    dpSel.to=dpSel.from;dpSel.from=ymd;
  }else{
    dpSel.to=ymd;
  }
  filters.after=dpSel.from;filters.before=dpSel.to;
  dpRender();
  if(dpSel.from&&dpSel.to){applyF();hideMenus();}
}
$('dpPrevY').onclick=ev=>{ev.stopPropagation();dpAddMonths(-12);dpRender();};
$('dpPrev').onclick=ev=>{ev.stopPropagation();dpAddMonths(-1);dpRender();};
$('dpNext').onclick=ev=>{ev.stopPropagation();dpAddMonths(1);dpRender();};
$('dpNextY').onclick=ev=>{ev.stopPropagation();dpAddMonths(12);dpRender();};
(function(){const dp=$('datePicker');dp.addEventListener('mousedown',ev=>ev.stopPropagation());dp.addEventListener('click',ev=>ev.stopPropagation());})();

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
  const p=$('bpContent'),hp=$('bpHead');
  const setBg=(el,m)=>{el.style.background=m?'var(--active)':'';};
  if(!name){
    if(hp)hp.querySelectorAll('.branch-item').forEach(el=>setBg(el,false));
    p.querySelectorAll('.branch-item').forEach(el=>setBg(el,false));
    return;
  }
  if(branchViewMode==='tree')ensureBranchPathExpanded(name);
  let found=null,foundInHead=false;
  if(hp)hp.querySelectorAll('.branch-item').forEach(el=>{const m=el.dataset.branch===name;setBg(el,m);if(m&&!found){found=el;foundInHead=true;}});
  p.querySelectorAll('.branch-item').forEach(el=>{const m=el.dataset.branch===name;setBg(el,m);if(m&&!found)found=el;});
  if(!found||foundInHead)return;
  for(let cur=found.parentElement;cur&&cur!==p;cur=cur.parentElement){
    if((cur.classList.contains('tdir-ch')||cur.classList.contains('sec-body'))&&cur.style.display==='none'){
      cur.style.display='';
      const hd=cur.previousElementSibling;
      if(hd){const arr=hd.querySelector('.arr');if(arr)arr.textContent='\\u25BC';const ico=hd.querySelector('.dir-ico');if(ico)ico.textContent='\\u{1F4C2}';}
    }
    if(cur.style&&cur.style.display==='none')cur.style.display='';
  }
  found.scrollIntoView({block:'nearest'});
}

function ensureBranchPathExpanded(name){
  const isTag=allTags.includes(name);
  const isRemote=!isTag&&allBranches.some(b=>b.remote&&b.name===name);
  const prefix=isTag?'tag':(isRemote?'remote':'local');
  const disp=isRemote?(typeof remoteTreeDisplayPath==='function'?remoteTreeDisplayPath(name):name):name;
  const pts=disp.split('/').filter(Boolean);
  if(pts.length<=1)return;
  let path=prefix,added=false;
  for(let i=0;i<pts.length-1;i++){path=path+'/'+pts[i];if(!branchTreeOpen.has(path)){branchTreeOpen.add(path);added=true;}}
  if(added)renderBranches();
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
  const rid=++lastIssuedLogReqId;
  vscode.postMessage({type:'loadLog',filters:currentLoadFilters,skip:allCommits.length,maxCount:LOG_PAGE_SIZE,append:true,reqId:rid});
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
function detailAuthorCommitterDiff(d){
  if(!d)return false;
  const norm=s=>(s||'').trim().toLowerCase();
  return norm(d.author)!==norm(d.committer)||norm(d.email)!==norm(d.committerEmail);
}
function fileChangeIcons(f){return '<span class="fst">'+fileStatusIcon(f.status)+'</span><span class="ftype">'+fileTypeIcon(f.path)+'</span>';}
function fileTypeIcon(path){
  const base=((path||'').split('/').pop()||'').toLowerCase();
  if(base==='dockerfile'||base.endsWith('.dockerfile'))return '\\u{1F433}';
  if(base==='makefile'||base==='cmakelists.txt'||base==='cmakelists.txt.in')return '\\u{1F527}';
  if(base==='package.json'||base==='package-lock.json'||base==='pnpm-lock.yaml'||base==='yarn.lock')return '\\u{1F4E6}';
  if(base==='go.mod'||base==='go.sum'||base==='go.work')return '\\u{1F439}';
  const dot=base.lastIndexOf('.');
  const ext=dot>=0?base.slice(dot+1):'';
  const m={
    go:'\\u{1F439}',ts:'\\u{1F4D8}',tsx:'\\u269B\\uFE0F',mts:'\\u{1F4D8}',cts:'\\u{1F4D8}',
    js:'\\u{1F4DC}',jsx:'\\u269B\\uFE0F',mjs:'\\u{1F4DC}',cjs:'\\u{1F4DC}',vue:'\\u{1F49A}',svelte:'\\u{1F536}',
    py:'\\u{1F40D}',pyw:'\\u{1F40D}',java:'\\u2615',kt:'\\u{1F538}',kts:'\\u{1F538}',
    rs:'\\u{1F980}',rb:'\\u{1F48E}',php:'\\u{1F418}',swift:'\\u{1F426}',cs:'\\u{1F537}',
    cpp:'\\u2699\\uFE0F',cc:'\\u2699\\uFE0F',cxx:'\\u2699\\uFE0F',hpp:'\\u2699\\uFE0F',hh:'\\u2699\\uFE0F',c:'\\u2699\\uFE0F',h:'\\u2699\\uFE0F',
    css:'\\u{1F3A8}',scss:'\\u{1F3A8}',sass:'\\u{1F3A8}',less:'\\u{1F3A8}',
    html:'\\u{1F310}',htm:'\\u{1F310}',
    md:'\\u{1F4DD}',mdx:'\\u{1F4DD}',
    json:'\\u{1F4CB}',jsonc:'\\u{1F4CB}',
    yaml:'\\u2699\\uFE0F',yml:'\\u2699\\uFE0F',toml:'\\u2699\\uFE0F',
    xml:'\\u{1F4F0}',plist:'\\u{1F4F0}',
    sql:'\\u{1F5C4}\\uFE0F',
    sh:'\\u{1F4BB}',bash:'\\u{1F4BB}',zsh:'\\u{1F4BB}',fish:'\\u{1F4BB}',ps1:'\\u{1F4BB}',
    png:'\\u{1F5BC}\\uFE0F',jpg:'\\u{1F5BC}\\uFE0F',jpeg:'\\u{1F5BC}\\uFE0F',gif:'\\u{1F5BC}\\uFE0F',webp:'\\u{1F5BC}\\uFE0F',svg:'\\u{1F5BC}\\uFE0F',ico:'\\u{1F5BC}\\uFE0F',
    wasm:'\\u{1F680}',lock:'\\u{1F512}',
    gradle:'\\u2615',properties:'\\u2699\\uFE0F',env:'\\u{1F510}',
    woff:'\\u{1F524}',woff2:'\\u{1F524}',ttf:'\\u{1F524}',eot:'\\u{1F524}',
    pdf:'\\u{1F4C4}',zip:'\\u{1F4E6}',gz:'\\u{1F4E6}',tar:'\\u{1F4E6}',
  };
  if(ext&&m[ext])return m[ext];
  if(base.endsWith('.d.ts'))return '\\u{1F4D8}';
  return '\\u{1F4C4}';
}
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
