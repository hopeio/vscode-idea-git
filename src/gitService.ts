import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

export interface GitRepo {
  name: string;
  rootPath: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitCommit {
  hash: string;
  abbrevHash: string;
  author: string;
  email: string;
  date: string;
  timestamp: number;
  message: string;
  parents: string[];
  refs: string[];
}

export interface GitFileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export class GitService {
  private repos: GitRepo[] = [];

  async discoverRepos(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<GitRepo[]> {
    this.repos = [];
    const seen = new Set<string>();
    for (const folder of workspaceFolders) {
      await this.findGitRoots(folder.uri.fsPath, 0, seen);
    }
    return this.repos;
  }

  private async findGitRoots(dir: string, depth: number, seen: Set<string>): Promise<void> {
    if (depth > 3 || seen.has(dir)) { return; }
    seen.add(dir);
    const gitDir = path.join(dir, '.git');
    try {
      const stat = await fs.promises.stat(gitDir);
      if (stat.isDirectory() || stat.isFile()) {
        this.repos.push({ name: path.basename(dir), rootPath: dir });
        await this.discoverSubmodules(dir, seen);
        return;
      }
    } catch { /* not a git root */ }
    if (depth >= 3) { return; }
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          await this.findGitRoots(path.join(dir, e.name), depth + 1, seen);
        }
      }
    } catch { /* ignore permission errors */ }
  }

  private async discoverSubmodules(repoDir: string, seen: Set<string>): Promise<void> {
    try {
      const out = await this.git(repoDir, ['submodule', 'foreach', '--quiet', '--recursive', 'echo $sm_path']);
      for (const line of out.trim().split('\n')) {
        if (!line) { continue; }
        const subPath = path.resolve(repoDir, line.trim());
        if (seen.has(subPath)) { continue; }
        seen.add(subPath);
        try {
          await fs.promises.stat(path.join(subPath, '.git'));
          this.repos.push({ name: path.basename(subPath) + ' [submodule]', rootPath: subPath });
        } catch { /* submodule not initialized */ }
      }
    } catch { /* no submodules or git error */ }
  }

  private async git(repoPath: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  }

  async getBranches(repoPath: string): Promise<GitBranch[]> {
    const branches: GitBranch[] = [];
    const parse = (out: string, remote: boolean) => {
      for (const raw of out.split('\n')) {
        if (!raw) { continue; }
        const parts = raw.split('\t');
        if (parts.length < 5) { continue; }
        const current = parts[0].trim() === '*';
        const name = parts[1].trim();
        const tracking = parts[2].trim() || undefined;
        const track = parts[3].trim();
        const fullRef = parts[4].trim();
        if (!name || name === 'HEAD' || name.endsWith('/HEAD') || (remote && !name.includes('/'))) { continue; }
        const ahead = this.parseTrackCount(track, 'ahead');
        const behind = this.parseTrackCount(track, 'behind');
        branches.push({ name, current, remote: !!remote || fullRef.startsWith('refs/remotes/'), tracking, ahead, behind });
      }
    };
    try {
      const localOut = await this.git(
        repoPath,
        ['for-each-ref', 'refs/heads', '--format=%(if)%(HEAD)%(then)*%(else) %(end)\t%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(refname)']
      );
      parse(localOut, false);
    } catch { /* ignore */ }
    try {
      const remoteOut = await this.git(
        repoPath,
        ['for-each-ref', 'refs/remotes', '--format= \t%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(refname)']
      );
      parse(remoteOut, true);
    } catch { /* ignore */ }
    return branches;
  }

  private parseTrackCount(track: string, dir: 'ahead' | 'behind'): number {
    if (!track) { return 0; }
    const m = track.match(new RegExp(dir + ' (\\d+)'));
    return m ? parseInt(m[1], 10) : 0;
  }

  async getTags(repoPath: string): Promise<string[]> {
    try {
      const out = await this.git(repoPath, ['tag', '--sort=-creatordate']);
      return out.trim().split('\n').filter(Boolean);
    } catch { return []; }
  }

  async getUserEmail(repoPath: string): Promise<string> {
    try { return (await this.git(repoPath, ['config', 'user.email'])).trim(); } catch { return ''; }
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    try {
      const out = await this.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = out.trim();
      if (branch === 'HEAD') {
        const hash = (await this.git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
        return `(detached ${hash})`;
      }
      return branch;
    } catch { return '(unknown)'; }
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    if (branch.startsWith('origin/')) {
      const localName = branch.replace(/^origin\//, '');
      try {
        await this.git(repoPath, ['rev-parse', '--verify', localName]);
        await this.git(repoPath, ['checkout', localName]);
      } catch {
        await this.git(repoPath, ['checkout', '-b', localName, '--track', branch]);
      }
    } else {
      await this.git(repoPath, ['checkout', branch]);
    }
  }

  async createBranch(repoPath: string, name: string, startPoint?: string): Promise<void> {
    const args = ['checkout', '-b', name];
    if (startPoint) { args.push(startPoint); }
    await this.git(repoPath, args);
  }

  async renameBranch(repoPath: string, oldName: string, newName: string): Promise<void> {
    await this.git(repoPath, ['branch', '-m', oldName, newName]);
  }

  async deleteBranch(repoPath: string, name: string, force: boolean = false): Promise<void> {
    await this.git(repoPath, ['branch', force ? '-D' : '-d', name]);
  }

  async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    const out = await this.git(repoPath, ['status', '--porcelain']);
    return out.trim().length > 0;
  }

  async stash(repoPath: string, message?: string): Promise<string | undefined> {
    const args = ['stash', 'push', '-u'];
    if (message) { args.push('-m', message); }
    await this.git(repoPath, args);
    try { return (await this.git(repoPath, ['stash', 'list', '-n', '1', '--format=%gd'])).trim() || undefined; }
    catch { return undefined; }
  }

  async stashPop(repoPath: string): Promise<{ ok: boolean; conflictFiles: string[] }> {
    try {
      await this.git(repoPath, ['stash', 'pop']);
      return { ok: true, conflictFiles: [] };
    } catch {
      const conflictFiles = await this.getConflictFiles(repoPath);
      return { ok: false, conflictFiles };
    }
  }

  async smartCheckout(repoPath: string, branch: string): Promise<{ shelved: boolean; stashRef?: string }> {
    const dirty = await this.hasUncommittedChanges(repoPath);
    if (!dirty) {
      await this.checkout(repoPath, branch);
      return { shelved: false, stashRef: undefined };
    }
    try {
      await this.checkout(repoPath, branch);
      return { shelved: false, stashRef: undefined };
    } catch {
      const current = await this.getCurrentBranch(repoPath);
      const answer = await vscode.window.showWarningMessage(
        `直接切换失败（存在冲突文件）。需要先暂存（Shelve）当前改动再切换到 "${branch}" 吗？`,
        { modal: true }, 'Shelve & 切换', '取消'
      );
      if (!answer || answer === '取消') { throw new Error('用户取消操作'); }
      const stashRef = await this.stash(repoPath, `smart-checkout: ${current} -> ${branch}`);
      await this.checkout(repoPath, branch);
      return { shelved: true, stashRef };
    }
  }

  async unshelve(repoPath: string): Promise<{ ok: boolean; conflictFiles: string[] }> {
    return this.stashPop(repoPath);
  }

  async getLog(repoPath: string, opts: { maxCount?: number; skip?: number; branch?: string; author?: string; after?: string; before?: string; path?: string } = {}): Promise<GitCommit[]> {
    const SEP = '\x1e';
    const REC = '\x1f';
    const format = ['%H', '%h', '%an', '%ae', '%aI', '%at', '%s', '%P', '%D'].join(SEP);
    const args = ['log', `--format=${format}`, '--decorate=short'];
    args.push(`--max-count=${opts.maxCount || 500}`);
    if (opts.skip && opts.skip > 0) { args.push(`--skip=${opts.skip}`); }
    if (opts.branch) { args.push(opts.branch); }
    if (opts.author) { args.push(`--author=${opts.author}`); }
    if (opts.after) { args.push(`--after=${opts.after}`); }
    if (opts.before) { args.push(`--before=${opts.before}`); }
    if (!opts.branch) { args.push('--all'); }
    if (opts.path) { args.push('--', opts.path); }
    let out: string;
    try { out = await this.git(repoPath, args); } catch { return []; }
    const commits: GitCommit[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line) { continue; }
      const parts = line.split(SEP);
      if (parts.length < 9) { continue; }
      const refs = parts[8] ? parts[8].split(',').map(r => r.trim()).filter(Boolean) : [];
      commits.push({
        hash: parts[0], abbrevHash: parts[1], author: parts[2], email: parts[3],
        date: parts[4], timestamp: parseInt(parts[5], 10), message: parts[6],
        parents: parts[7] ? parts[7].split(' ').filter(Boolean) : [], refs
      });
    }
    return commits;
  }

  async getCommitFiles(repoPath: string, hash: string): Promise<GitFileChange[]> {
    try {
      const parents = await this.getCommitParents(repoPath, hash);
      if (parents.length > 1) {
        return this.parseDiffOutput(await this.git(repoPath, ['diff-tree', '-r', '--no-commit-id', '--name-status', '-M', parents[0], hash]));
      }
      return this.parseDiffOutput(await this.git(repoPath, ['diff-tree', '--no-commit-id', '-r', '--name-status', '-M', hash]));
    } catch {
      return [];
    }
  }

  async getMergeFileGroups(repoPath: string, hash: string): Promise<{ combined: GitFileChange[]; parentDiffs: { parentHash: string; abbrev: string; message: string; files: GitFileChange[] }[] } | null> {
    try {
      const parents = await this.getCommitParents(repoPath, hash);
      if (parents.length < 2) { return null; }
      let combined: GitFileChange[] = [];
      try {
        const combinedOut = await this.git(repoPath, ['diff-tree', '--cc', '--no-commit-id', '-r', '--name-only', hash]);
        for (const p of combinedOut.trim().split('\n').filter(Boolean)) { combined.push({ status: 'M', path: p }); }
      } catch { /* ignore */ }
      const parentDiffs: { parentHash: string; abbrev: string; message: string; files: GitFileChange[] }[] = [];
      for (const ph of parents) {
        try {
          const msg = (await this.git(repoPath, ['log', '-1', '--format=%s', ph])).trim();
          const files = this.parseDiffOutput(await this.git(repoPath, ['diff-tree', '-r', '--no-commit-id', '--name-status', '-M', ph, hash]));
          parentDiffs.push({ parentHash: ph, abbrev: ph.slice(0, 7), message: msg, files });
        } catch { parentDiffs.push({ parentHash: ph, abbrev: ph.slice(0, 7), message: '(error)', files: [] }); }
      }
      return { combined, parentDiffs };
    } catch {
      return null;
    }
  }

  private parseDiffOutput(out: string): GitFileChange[] {
    const files: GitFileChange[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line) { continue; }
      const m = line.match(/^([AMDRC]\d*)\t(.+?)(?:\t(.+))?$/);
      if (m) { files.push({ status: m[1][0], path: m[3] || m[2], oldPath: m[3] ? m[2] : undefined }); }
    }
    return files;
  }

  private async getCommitParents(repoPath: string, hash: string): Promise<string[]> {
    const out = await this.git(repoPath, ['rev-parse', `${hash}^@`]);
    return out.trim().split('\n').filter(Boolean);
  }

  async cherryPick(repoPath: string, hash: string): Promise<void> {
    await this.git(repoPath, ['cherry-pick', hash]);
  }

  async revertCommit(repoPath: string, hash: string): Promise<void> {
    await this.git(repoPath, ['revert', hash, '--no-edit']);
  }

  async showFileDiff(repoPath: string, hash: string, filePath: string): Promise<void> {
    const parents = await this.getCommitParents(repoPath, hash);
    const parentHash = parents.length > 0 ? parents[0] : `${hash}~1`;
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${parentHash}`);
    const rightUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${hash}`);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${hash.slice(0, 7)})`);
  }

  async getFileContent(repoPath: string, hash: string, filePath: string): Promise<string> {
    try {
      return await this.git(repoPath, ['show', `${hash}:${filePath}`]);
    } catch {
      return '';
    }
  }

  async getCommitDetail(repoPath: string, hash: string): Promise<any> {
    const SEP = '\x1e';
    const info = (await this.git(repoPath, ['log', '-1', `--format=%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%D${SEP}%B`, hash]));
    const idx = info.indexOf(SEP);
    const parts = info.split(SEP);
    const fullHash = parts[0], author = parts[1], email = parts[2], date = parts[3], refsStr = parts[4];
    const message = parts.slice(5).join(SEP).trim();
    const refs = refsStr ? refsStr.split(',').map((r: string) => r.trim()).filter(Boolean) : [];
    const parentHashes = await this.getCommitParents(repoPath, hash);
    const parents: { hash: string; abbrev: string; message: string }[] = [];
    for (const ph of parentHashes) {
      try { const msg = (await this.git(repoPath, ['log', '-1', '--format=%s', ph])).trim(); parents.push({ hash: ph, abbrev: ph.slice(0, 7), message: msg }); } catch { parents.push({ hash: ph, abbrev: ph.slice(0, 7), message: '' }); }
    }
    let branches: string[] = [];
    try { const out = await this.git(repoPath, ['branch', '-a', '--contains', hash, '--format=%(refname:short)']); branches = out.trim().split('\n').filter(Boolean); } catch { /* ignore */ }
    return { message, fullHash, author, email, date, refs, parents, branches };
  }

  async editCommitMessage(repoPath: string, hash: string, newMessage: string): Promise<void> {
    const head = (await this.git(repoPath, ['rev-parse', 'HEAD'])).trim();
    if (head === hash) {
      await this.git(repoPath, ['commit', '--amend', '-m', newMessage]);
    } else {
      const env = { ...process.env, GIT_SEQUENCE_EDITOR: `sed -i '' 's/^pick/reword/' ` };
      const terminal = vscode.window.createTerminal({ name: 'Git Edit Message', cwd: repoPath, env: { EDITOR: `bash -c 'echo "${newMessage.replace(/'/g, "'\\''")}" > "$1"' --` } });
      terminal.sendText(`GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick /reword /1'" git rebase -i ${hash}~1`);
      terminal.show();
    }
  }

  async mergeBranch(repoPath: string, branch: string): Promise<void> {
    await this.git(repoPath, ['merge', branch]);
  }

  async rebaseBranch(repoPath: string, onto: string): Promise<void> {
    await this.git(repoPath, ['rebase', onto]);
  }

  async pullBranch(repoPath: string): Promise<void> {
    await this.git(repoPath, ['pull']);
  }

  async smartUpdateBranch(repoPath: string, branch: string): Promise<{ updated: boolean; shelved: boolean; branch: string; stashRef?: string; unshelveConflicts: string[] }> {
    let target = branch;
    if (target.startsWith('origin/')) { target = target.slice('origin/'.length); }
    const before = (await this.git(repoPath, ['rev-parse', target])).trim();
    const current = await this.getCurrentBranch(repoPath);
    let shelved = false;
    let stashRef: string | undefined;
    if (current !== target) {
      const switched = await this.smartCheckout(repoPath, target);
      shelved = switched.shelved;
      stashRef = switched.stashRef;
    }
    try {
      await this.pullBranch(repoPath);
    } catch {
      if (!shelved) {
        const switched = await this.smartCheckout(repoPath, target);
        shelved = switched.shelved;
        stashRef = switched.stashRef;
        await this.pullBranch(repoPath);
      } else {
        throw new Error('Pull 失败，请先处理本地冲突后重试');
      }
    }
    let unshelveConflicts: string[] = [];
    if (shelved) {
      const un = await this.unshelve(repoPath);
      if (!un.ok) { unshelveConflicts = un.conflictFiles; }
    }
    const after = (await this.git(repoPath, ['rev-parse', target])).trim();
    return { updated: before !== after, shelved, branch: target, stashRef, unshelveConflicts };
  }

  async getConflictFiles(repoPath: string): Promise<string[]> {
    try {
      const out = await this.git(repoPath, ['diff', '--name-only', '--diff-filter=U']);
      return out.trim().split('\n').filter(Boolean);
    } catch { return []; }
  }

  async openConflictFiles(repoPath: string, files: string[]): Promise<void> {
    const targets = files.slice(0, 20);
    for (const file of targets) {
      const uri = vscode.Uri.file(path.join(repoPath, file));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  }

  async fetchAll(repoPath: string): Promise<void> {
    await this.git(repoPath, ['fetch', '--all', '--prune']);
  }

  async pushBranch(repoPath: string, branch: string, setUpstream: boolean = false): Promise<void> {
    const args = ['push'];
    if (setUpstream) { args.push('-u', 'origin', branch); }
    else { args.push('origin', branch); }
    await this.git(repoPath, args);
  }

  private async getTrackingBranch(repoPath: string, branch: string): Promise<string | undefined> {
    try {
      const out = await this.git(repoPath, ['for-each-ref', `refs/heads/${branch}`, '--format=%(upstream:short)']);
      const tracking = out.trim();
      return tracking || undefined;
    } catch { return undefined; }
  }

  private isPushRejectedForBehind(err: any): boolean {
    const msg = String(err?.stderr || err?.message || '');
    return msg.includes('non-fast-forward') || msg.includes('[rejected]') || msg.includes('fetch first');
  }

  async smartPushBranch(repoPath: string, branch: string, setUpstream: boolean = false): Promise<{ rebased: boolean }> {
    try {
      await this.pushBranch(repoPath, branch, setUpstream);
      return { rebased: false };
    } catch (e) {
      if (!this.isPushRejectedForBehind(e)) { throw e; }
    }
    await this.fetchAll(repoPath);
    const tracking = await this.getTrackingBranch(repoPath, branch);
    if (!tracking) {
      await this.pushBranch(repoPath, branch, setUpstream);
      return { rebased: false };
    }
    const cur = await this.getCurrentBranch(repoPath);
    const switched = cur !== branch ? await this.smartCheckout(repoPath, branch) : { shelved: false, stashRef: undefined };
    await this.rebaseBranch(repoPath, tracking);
    await this.pushBranch(repoPath, branch, setUpstream);
    if (switched.shelved) {
      try { await this.unshelve(repoPath); } catch { /* ignore */ }
    }
    return { rebased: true };
  }

  async pullFromTracking(repoPath: string, tracking: string, useRebase: boolean): Promise<void> {
    const parts = tracking.split('/');
    if (parts.length < 2) { throw new Error(`非法 tracking 分支: ${tracking}`); }
    const remote = parts[0];
    const remoteBranch = parts.slice(1).join('/');
    const args = ['pull', useRebase ? '--rebase' : '--no-rebase', remote, remoteBranch];
    await this.git(repoPath, args);
  }

  async compareBranches(repoPath: string, from: string, to: string): Promise<string> {
    return await this.git(repoPath, ['diff', '--stat', from, to]);
  }

  async compareBranchFiles(repoPath: string, from: string, to: string): Promise<GitFileChange[]> {
    return this.parseDiffOutput(await this.git(repoPath, ['diff', '--name-status', '-M', from, to]));
  }

  async showBranchFileDiff(repoPath: string, from: string, to: string, filePath: string): Promise<void> {
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${from}`);
    const rightUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${to}`);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${from.slice(0, 7)}..${to.slice(0, 7)})`);
  }

  async diffWithWorkTreeFiles(repoPath: string, ref: string): Promise<GitFileChange[]> {
    return this.parseDiffOutput(await this.git(repoPath, ['diff', '--name-status', '-M', ref]));
  }

  async showWorkTreeFileDiff(repoPath: string, ref: string, filePath: string): Promise<void> {
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${ref}`);
    const rightUri = vscode.Uri.file(path.join(repoPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${ref.slice(0, 7)} vs Working Tree)`);
  }

  async resetTo(repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard' | 'keep'): Promise<void> {
    await this.git(repoPath, ['reset', `--${mode}`, hash]);
  }

  async squashCommits(repoPath: string, fromHash: string, toHash: string, message: string): Promise<void> {
    await this.git(repoPath, ['reset', '--soft', fromHash]);
    await this.git(repoPath, ['commit', '-m', message]);
  }

  async createPatch(repoPath: string, hash: string, outputPath: string): Promise<void> {
    const patch = await this.git(repoPath, ['format-patch', '-1', hash, '--stdout']);
    await fs.promises.writeFile(outputPath, patch);
  }

  async checkoutRevision(repoPath: string, hash: string): Promise<void> {
    await this.git(repoPath, ['checkout', hash]);
  }

  async createTag(repoPath: string, name: string, hash: string, message?: string): Promise<void> {
    if (message) { await this.git(repoPath, ['tag', '-a', name, hash, '-m', message]); }
    else { await this.git(repoPath, ['tag', name, hash]); }
  }

  async dropCommit(repoPath: string, hash: string): Promise<void> {
    const terminal = vscode.window.createTerminal({ name: 'Git Drop Commit', cwd: repoPath });
    terminal.sendText(`GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick ${hash.slice(0, 7)}/drop ${hash.slice(0, 7)}/'" git rebase -i ${hash}~1`);
    terminal.show();
  }

  async pushUpTo(repoPath: string, hash: string, branch: string): Promise<void> {
    await this.git(repoPath, ['push', 'origin', `${hash}:refs/heads/${branch}`]);
  }

  async getRemoteUrl(repoPath: string): Promise<string> {
    try { return (await this.git(repoPath, ['remote', 'get-url', 'origin'])).trim(); } catch { return ''; }
  }

  getRepos(): GitRepo[] { return this.repos; }
}
