import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const execFileAsync = promisify(execFile);

export interface GitLogAuthor {
  name: string;
  lastAt: number;
}

export interface GitRepo {
  name: string;
  rootPath: string;
  /** 多根工作区中该仓库所属的 VS Code 工作区文件夹名（`.code-workspace` 里 `folders[].name`） */
  workspaceFolderName?: string;
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
  committer: string;
  committerEmail: string;
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

export class GitService implements vscode.Disposable {
  private repos: GitRepo[] = [];
  private gitCmdLog?: vscode.OutputChannel;

  dispose(): void {
    this.gitCmdLog?.dispose();
    this.gitCmdLog = undefined;
  }

  /** 打开「IDEA Git · Git 命令」输出面板（需已开启 ideaGit.logGitCommands 并至少执行过一次 git）。 */
  showGitCommandLog(): void {
    if (!this.gitCmdLog) {
      vscode.window.showInformationMessage('请先在设置中开启 ideaGit.logGitCommands，并执行一次 Git 操作后再试。');
      return;
    }
    this.gitCmdLog.show(true);
  }

  private maybeLogGitCommand(repoPath: string, args: string[]): void {
    try {
      if (!vscode.workspace.getConfiguration('ideaGit').get<boolean>('logGitCommands', false)) { return; }
      if (!this.gitCmdLog) { this.gitCmdLog = vscode.window.createOutputChannel('IDEA Git · Git 命令'); }
      const q = (s: string) => (/[^\w@%+=:,./-]/.test(s) ? JSON.stringify(s) : s);
      this.gitCmdLog.appendLine(`${repoPath}> git -c core.quotepath=false ${args.map(q).join(' ')}`);
    } catch { /* ignore */ }
  }

  async discoverRepos(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<GitRepo[]> {
    this.repos = [];
    const seen = new Set<string>();
    for (const folder of workspaceFolders) {
      await this.findGitRoots(folder.uri.fsPath, 0, seen, folder);
    }
    this.repos = this.applyExcludeFilter(this.repos);
    this.dedupeRepoDisplayNames(this.repos);
    return this.repos;
  }

  /** 仅扫描，不应用 excludeRepos 过滤，也不写入 this.repos。用于"管理排除项"命令。 */
  async scanAllReposIgnoringExclude(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<GitRepo[]> {
    const backup = this.repos;
    this.repos = [];
    const seen = new Set<string>();
    try {
      for (const folder of workspaceFolders) {
        await this.findGitRoots(folder.uri.fsPath, 0, seen, folder);
      }
      this.dedupeRepoDisplayNames(this.repos);
      return this.repos;
    } finally {
      this.repos = backup;
    }
  }

  /** 依据 `ideaGit.excludeRepos` 配置过滤掉用户不想识别的仓库。 */
  private applyExcludeFilter(repos: GitRepo[]): GitRepo[] {
    const patterns = (vscode.workspace.getConfiguration('ideaGit').get<string[]>('excludeRepos') || [])
      .map(s => (s || '').trim()).filter(Boolean);
    if (!patterns.length) { return repos; }
    return repos.filter(r => !patterns.some(p => this.matchExcludePattern(p, r)));
  }

  private matchExcludePattern(pat: string, repo: GitRepo): boolean {
    const fwd = repo.rootPath.split(path.sep).join('/');
    const hasSlash = pat.includes('/');
    const hasStar = pat.includes('*');
    if (!hasSlash && !hasStar) { return repo.name === pat; }
    if (!hasSlash && hasStar) {
      return this.globToRegex(pat, true).test(repo.name);
    }
    const re = this.globToRegex(pat, false);
    return re.test(fwd) || re.test(repo.name) || (!hasStar && fwd.includes(pat));
  }

  /** 把 glob 转 RegExp。anchor=true 时强制完整匹配，否则只要任意位置出现即可（用于路径子串）。 */
  private globToRegex(pat: string, anchor: boolean): RegExp {
    const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const body = esc.replace(/\*\*/g, '::DBLSTAR::').replace(/\*/g, '[^/]*').replace(/::DBLSTAR::/g, '.*');
    return new RegExp(anchor ? '^' + body + '$' : body);
  }

  /** 多根工作区下为同名展示名追加路径片段，避免下拉框无法区分。 */
  private dedupeRepoDisplayNames(repos: GitRepo[]): void {
    const groups = new Map<string, GitRepo[]>();
    for (const r of repos) {
      const g = groups.get(r.name) || [];
      g.push(r);
      groups.set(r.name, g);
    }
    for (const list of groups.values()) {
      if (list.length < 2) { continue; }
      for (const r of list) {
        const segs = r.rootPath.replace(/\\/g, '/').split('/').filter(Boolean);
        const hint = segs.slice(-2).join('/') || r.rootPath;
        r.name = `${r.name} — ${hint}`;
      }
    }
  }

  /** 展示名：仅仓库根目录名；子模块追加 [submodule]。重名由 dedupeRepoDisplayNames 用路径片段区分。 */
  private makeRepoLabel(_wsFolder: vscode.WorkspaceFolder, repoRoot: string, isSubmodule: boolean): string {
    const base = path.basename(repoRoot);
    return isSubmodule ? `${base}[submodule]` : base;
  }

  private async findGitRoots(dir: string, depth: number, seen: Set<string>, wsFolder: vscode.WorkspaceFolder): Promise<void> {
    if (depth > 3 || seen.has(dir)) { return; }
    seen.add(dir);
    const gitDir = path.join(dir, '.git');
    try {
      const stat = await fs.promises.stat(gitDir);
      if (stat.isDirectory() || stat.isFile()) {
        const name = this.makeRepoLabel(wsFolder, dir, false);
        this.repos.push({ name, rootPath: dir, workspaceFolderName: wsFolder.name });
        await this.discoverSubmodules(dir, seen, wsFolder);
        return;
      }
    } catch { /* not a git root */ }
    if (depth >= 3) { return; }
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          await this.findGitRoots(path.join(dir, e.name), depth + 1, seen, wsFolder);
        }
      }
    } catch { /* ignore permission errors */ }
  }

  private async discoverSubmodules(repoDir: string, seen: Set<string>, wsFolder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const out = await this.git(repoDir, ['submodule', 'foreach', '--quiet', '--recursive', 'echo $sm_path']);
      for (const line of out.trim().split('\n')) {
        if (!line) { continue; }
        const subPath = path.resolve(repoDir, line.trim());
        if (seen.has(subPath)) { continue; }
        seen.add(subPath);
        try {
          await fs.promises.stat(path.join(subPath, '.git'));
          const name = this.makeRepoLabel(wsFolder, subPath, true);
          this.repos.push({ name, rootPath: subPath, workspaceFolderName: wsFolder.name });
        } catch { /* submodule not initialized */ }
      }
    } catch { /* no submodules or git error */ }
  }

  private async git(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    this.maybeLogGitCommand(repoPath, args);
    const mergedEnv = env ? { ...process.env, ...env } : process.env;
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repoPath,
      maxBuffer: 50 * 1024 * 1024,
      env: mergedEnv,
    });
    return stdout;
  }

  private gitErrText(err: unknown): string {
    const o = err as { stderr?: unknown; message?: unknown };
    return `${o.stderr != null ? String(o.stderr) : ''}\n${o.message != null ? String(o.message) : ''}`;
  }

  /** pull --rebase 遇子模块非平凡合并时 Git 会失败；据此决定是否可安全 abort 后改 merge 拉取。 */
  private isSubmoduleRebasePullFailure(err: unknown): boolean {
    return /Recursive merging with submodules|each conflicted submodule|submoduleMergeConflict|manually handle the merging of each conflicted submodule/i.test(this.gitErrText(err));
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

  async getUserEmails(repoPath: string): Promise<string[]> {
    try {
      const out = await this.git(repoPath, ['config', '--get-all', 'user.email']);
      return out.trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }

  async getUserName(repoPath: string): Promise<string> {
    try { return (await this.git(repoPath, ['config', 'user.name'])).trim(); } catch { return ''; }
  }

  /** Patterns for `git log --author=<regex>` (OR when repeated). */
  async getMeAuthorPatterns(repoPath: string): Promise<string[]> {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const emails = await this.getUserEmails(repoPath);
    const name = (await this.getUserName(repoPath)).trim();
    const patterns: string[] = [];
    for (const e of emails) {
      const t = e.trim();
      if (t) patterns.push(esc(t));
    }
    if (name) patterns.push(esc(name));
    return patterns;
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

  /** 在命名分支上返回短分支名；detached 返回 null（勿把 getCurrentBranch 的 UI 串传给 git）。 */
  async getSymbolicBranchShortName(repoPath: string): Promise<string | null> {
    try {
      const out = (await this.git(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  /** merge/rebase 的「上一处 HEAD」：分支名或 detached 时的完整 OID。 */
  async getHeadAsRefForGit(repoPath: string): Promise<string> {
    const sym = await this.getSymbolicBranchShortName(repoPath);
    if (sym) { return sym; }
    return (await this.git(repoPath, ['rev-parse', 'HEAD'])).trim();
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

  /** 强制切换：丢弃工作区改动后 checkout（remote 分支自动建本地跟踪分支）。 */
  async forceCheckout(repoPath: string, branch: string): Promise<void> {
    if (branch.startsWith('origin/')) {
      const localName = branch.replace(/^origin\//, '');
      try {
        await this.git(repoPath, ['rev-parse', '--verify', localName]);
        await this.git(repoPath, ['checkout', '-f', localName]);
      } catch {
        await this.git(repoPath, ['checkout', '-f', '-B', localName, '--track', branch]);
      }
    } else {
      await this.git(repoPath, ['checkout', '-f', branch]);
    }
  }

  async smartCheckout(repoPath: string, branch: string): Promise<{ shelved: boolean; forced: boolean; stashRef?: string }> {
    const dirty = await this.hasUncommittedChanges(repoPath);
    if (!dirty) {
      await this.checkout(repoPath, branch);
      return { shelved: false, forced: false, stashRef: undefined };
    }
    try {
      await this.checkout(repoPath, branch);
      return { shelved: false, forced: false, stashRef: undefined };
    } catch {
      const current = await this.getCurrentBranch(repoPath);
      const answer = await vscode.window.showWarningMessage(
        `切换到 "${branch}" 失败：工作区有未提交改动且与目标分支冲突。`,
        { modal: true, detail: 'Shelve & 切换：暂存当前改动后切换\n强制切换：丢弃当前改动后切换（不可恢复）' },
        'Shelve & 切换', '强制切换'
      );
      if (!answer) { throw new Error('用户取消操作'); }
      if (answer === '强制切换') {
        await this.forceCheckout(repoPath, branch);
        return { shelved: false, forced: true, stashRef: undefined };
      }
      const stashRef = await this.stash(repoPath, `smart-checkout: ${current} -> ${branch}`);
      await this.checkout(repoPath, branch);
      return { shelved: true, forced: false, stashRef };
    }
  }

  async unshelve(repoPath: string): Promise<{ ok: boolean; conflictFiles: string[] }> {
    return this.stashPop(repoPath);
  }

  async getLogAuthors(repoPath: string): Promise<GitLogAuthor[]> {
    try {
      const out = await this.git(repoPath, ['log', '--all', '--format=%aN%x09%at']);
      const seen = new Map<string, number>();
      for (const line of out.trim().split('\n')) {
        if (!line) { continue; }
        const tab = line.lastIndexOf('\t');
        if (tab <= 0) { continue; }
        const name = line.slice(0, tab).trim();
        if (!name || seen.has(name)) { continue; }
        const ts = parseInt(line.slice(tab + 1), 10);
        seen.set(name, Number.isFinite(ts) ? ts : 0);
      }
      return [...seen.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, lastAt]) => ({ name, lastAt }));
    } catch { return []; }
  }

  private gitLogSinceArg(date: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} 00:00:00` : date;
  }

  private gitLogUntilArg(date: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} 23:59:59` : date;
  }

  async getLog(repoPath: string, opts: { maxCount?: number; skip?: number; branch?: string; author?: string; authorPatterns?: string[]; after?: string; before?: string; path?: string } = {}): Promise<GitCommit[]> {
    const SEP = '\x1e';
    const REC = '\x1f';
    const format = ['%H', '%h', '%an', '%aE', '%cn', '%cE', '%aI', '%at', '%s', '%P', '%D'].join(SEP);
    const args = ['log', `--format=${format}`, '--decorate=short'];
    args.push(`--max-count=${opts.maxCount || 500}`);
    if (opts.skip && opts.skip > 0) { args.push(`--skip=${opts.skip}`); }
    if (opts.branch) { args.push(opts.branch); }
    if (opts.authorPatterns?.length) {
      for (const p of opts.authorPatterns) { args.push(`--author=${p}`); }
    } else if (opts.author) { args.push(`--author=${opts.author}`); }
    if (opts.after) { args.push(`--since=${this.gitLogSinceArg(opts.after)}`); }
    if (opts.before) { args.push(`--until=${this.gitLogUntilArg(opts.before)}`); }
    if (!opts.branch) { args.push('--all'); }
    if (opts.path) { args.push('--', opts.path); }
    let out: string;
    try { out = await this.git(repoPath, args); } catch { return []; }
    const commits: GitCommit[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line) { continue; }
      const parts = line.split(SEP);
      if (parts.length < 11) { continue; }
      const refs = parts[10] ? parts[10].split(',').map(r => r.trim()).filter(Boolean) : [];
      commits.push({
        hash: parts[0], abbrevHash: parts[1], author: parts[2], email: parts[3], committer: parts[4], committerEmail: parts[5],
        date: parts[6], timestamp: parseInt(parts[7], 10), message: parts[8],
        parents: parts[9] ? parts[9].split(' ').filter(Boolean) : [], refs
      });
    }
    return commits;
  }

  async getCommitFiles(repoPath: string, hash: string): Promise<GitFileChange[]> {
    try {
      const parents = await this.getCommitParents(repoPath, hash);
      if (parents.length > 1) {
        const vsFirst = this.parseDiffOutput(
          await this.git(repoPath, ['diff-tree', '-r', '--no-commit-id', '--name-status', '-M', parents[0], hash])
        );
        if (vsFirst.length > 0) { return vsFirst; }
        // 合并结果与第一 parent 树相同（如 dev 已含改动再 merge origin/dev）时，相对第一 parent 为空，需汇总各 parent 差异
        const seen = new Set<string>();
        const union: GitFileChange[] = [];
        for (const ph of parents) {
          const part = this.parseDiffOutput(
            await this.git(repoPath, ['diff-tree', '-r', '--no-commit-id', '--name-status', '-M', ph, hash])
          );
          for (const f of part) {
            if (seen.has(f.path)) { continue; }
            seen.add(f.path);
            union.push(f);
          }
        }
        return union;
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

  /** 选 diff 左侧 parent：merge 与普通提交均用第一 parent。 */
  private async pickDiffParentForFile(repoPath: string, hash: string, filePath: string): Promise<string> {
    const parents = await this.getCommitParents(repoPath, hash);
    if (parents.length === 0) { return `${hash}~1`; }
    return parents[0];
  }

  async showFileDiff(repoPath: string, hash: string, filePath: string): Promise<void> {
    const parentHash = await this.pickDiffParentForFile(repoPath, hash, filePath);
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${parentHash}`);
    const rightUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${hash}`);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${parentHash.slice(0, 7)}..${hash.slice(0, 7)})`);
  }

  async showFileDiffInNewTab(repoPath: string, hash: string, filePath: string): Promise<void> {
    const parentHash = await this.pickDiffParentForFile(repoPath, hash, filePath);
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${parentHash}`);
    const rightUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${hash}`);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${parentHash.slice(0, 7)}..${hash.slice(0, 7)})`, { preview: false });
  }

  async compareCommitFileWithLocal(repoPath: string, hash: string, filePath: string): Promise<void> {
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${hash}`);
    const rightUri = vscode.Uri.file(path.join(repoPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${hash.slice(0, 7)} vs Local)`);
  }

  async compareBeforeFileWithLocal(repoPath: string, hash: string, filePath: string): Promise<void> {
    const before = await this.pickDiffParentForFile(repoPath, hash, filePath);
    const leftUri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${before}`);
    const rightUri = vscode.Uri.file(path.join(repoPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${before.slice(0, 7)} vs Local)`);
  }

  async openRepositoryVersion(repoPath: string, hash: string, filePath: string): Promise<void> {
    const uri = vscode.Uri.parse(`idea-git-diff:${filePath}?repo=${encodeURIComponent(repoPath)}&hash=${hash}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async restoreFileFromHead(repoPath: string, filePath: string): Promise<void> {
    await this.git(repoPath, ['restore', '--source=HEAD', '--', filePath]);
  }

  async checkoutFileFromRevision(repoPath: string, hash: string, filePath: string): Promise<void> {
    await this.git(repoPath, ['checkout', hash, '--', filePath]);
  }

  async createFilePatch(repoPath: string, hash: string, filePath: string, outputPath: string): Promise<void> {
    const before = await this.pickDiffParentForFile(repoPath, hash, filePath);
    const patch = await this.git(repoPath, ['diff', '--binary', before, hash, '--', filePath]);
    await fs.promises.writeFile(outputPath, patch);
  }

  async showFileHistory(repoPath: string, filePath: string): Promise<void> {
    const terminal = vscode.window.createTerminal({ name: 'Git File History', cwd: repoPath });
    terminal.sendText(`git log --follow -- "${filePath}"`);
    terminal.show();
  }

  private parseHistoryLogOutput(out: string, sep: string): GitCommit[] {
    const commits: GitCommit[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line) { continue; }
      const parts = line.split(sep);
      if (parts.length < 11) { continue; }
      const refs = parts[10] ? parts[10].split(',').map(r => r.trim()).filter(Boolean) : [];
      commits.push({
        hash: parts[0], abbrevHash: parts[1], author: parts[2], email: parts[3], committer: parts[4], committerEmail: parts[5],
        date: parts[6], timestamp: parseInt(parts[7], 10), message: parts[8],
        parents: parts[9] ? parts[9].split(' ').filter(Boolean) : [], refs
      });
    }
    return commits;
  }

  async getFileHistoryPage(repoPath: string, filePath: string, uptoHash: string, rawSkip: number, limit: number): Promise<{ commits: GitCommit[]; hasMore: boolean; nextRawSkip: number }> {
    const SEP = '\x1e';
    const format = ['%H', '%h', '%an', '%aE', '%cn', '%cE', '%aI', '%at', '%s', '%P', '%D'].join(SEP);
    const refArg = uptoHash || (await this.getCurrentBranch(repoPath)) || 'HEAD';
    const args = ['log', '--full-history', '--simplify-merges', '-M', `--format=${format}`, '--decorate=short', '-n', String(limit), '--skip', String(rawSkip), refArg, '--', filePath];
    let out = '';
    try { out = await this.git(repoPath, args); } catch { return { commits: [], hasMore: false, nextRawSkip: rawSkip }; }
    const commits = this.parseHistoryLogOutput(out, SEP);
    return { commits, hasMore: commits.length === limit, nextRawSkip: rawSkip + commits.length };
  }

  async getFilePatchAtCommit(repoPath: string, hash: string, filePath: string): Promise<string> {
    try {
      const parents = await this.getCommitParents(repoPath, hash);
      if (parents.length >= 2) {
        const parent = parents[0];
        const merged = await this.git(repoPath, ['diff', '--patch', '--stat', parent, hash, '--', filePath]);
        const header = await this.git(repoPath, ['show', '--no-patch', '--pretty=fuller', hash]);
        return merged.trim() ? `${header}\n\n# Diff to parent ${parent.slice(0, 7)}\n${merged}` : header;
      }
      return await this.git(repoPath, ['show', '--patch', '--stat', '--pretty=fuller', hash, '--', filePath]);
    } catch {
      return '';
    }
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
    const info = (await this.git(repoPath, ['log', '-1', `--format=%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%cn${SEP}%ce${SEP}%cI${SEP}%D${SEP}%B`, hash]));
    const parts = info.split(SEP);
    const fullHash = parts[0], author = parts[1], email = parts[2], date = parts[3];
    const committer = parts[4], committerEmail = parts[5], committerDate = parts[6], refsStr = parts[7];
    const message = parts.slice(8).join(SEP).trim();
    const refs = refsStr ? refsStr.split(',').map((r: string) => r.trim()).filter(Boolean) : [];
    const parentHashes = await this.getCommitParents(repoPath, hash);
    const parents: { hash: string; abbrev: string; message: string }[] = [];
    for (const ph of parentHashes) {
      try { const msg = (await this.git(repoPath, ['log', '-1', '--format=%s', ph])).trim(); parents.push({ hash: ph, abbrev: ph.slice(0, 7), message: msg }); } catch { parents.push({ hash: ph, abbrev: ph.slice(0, 7), message: '' }); }
    }
    let branches: string[] = [];
    try { const out = await this.git(repoPath, ['branch', '-a', '--contains', hash, '--format=%(refname:short)']); branches = out.trim().split('\n').filter(Boolean); } catch { /* ignore */ }
    return { message, fullHash, author, email, date, committer, committerEmail, committerDate, refs, parents, branches };
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

  /** 有未提交改动时使用 `rebase --autostash`，完成后自动恢复工作区（等同 Shelve → Rebase → Unshelve）。 */
  async rebaseBranch(repoPath: string, onto: string): Promise<{ shelved: boolean; unshelveConflicts: string[]; stashRef?: string }> {
    const dirty = await this.hasUncommittedChanges(repoPath);
    if (dirty) { await this.git(repoPath, ['rebase', '--autostash', onto]); }
    else { await this.git(repoPath, ['rebase', onto]); }
    const unshelveConflicts = await this.getConflictFiles(repoPath);
    let stashRef: string | undefined;
    if (dirty && unshelveConflicts.length > 0) {
      try { stashRef = (await this.git(repoPath, ['stash', 'list', '-n', '1', '--format=%gd'])).trim() || undefined; }
      catch { /* ignore */ }
    }
    return { shelved: dirty, unshelveConflicts, stashRef };
  }

  /** 解析仓库的真实 git dir，兼容 submodule 中 `.git` 是文件的情况 */
  private async resolveGitDir(repoPath: string): Promise<string | undefined> {
    try {
      const out = (await this.git(repoPath, ['rev-parse', '--git-dir'])).trim();
      return path.isAbsolute(out) ? out : path.join(repoPath, out);
    } catch { return undefined; }
  }

  private async pathExists(p: string): Promise<boolean> {
    try { await fs.promises.stat(p); return true; } catch { return false; }
  }

  /** 以 REBASE_HEAD / rebase-apply 为准，避免仅残留 rebase-merge 目录时误判为 Rebase 进行中。 */
  async isRebasing(repoPath: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '-q', 'REBASE_HEAD']);
      return true;
    } catch { /* not in rebase-merge style rebase */ }
    const dir = await this.resolveGitDir(repoPath);
    if (!dir) { return false; }
    return this.pathExists(path.join(dir, 'rebase-apply'));
  }

  async isMerging(repoPath: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '-q', 'MERGE_HEAD']);
      return true;
    } catch { return false; }
  }

  /**
   * 读取当前 rebase/merge 进度信息：原始分支、目标(onto)、对端引用，以及（如适用）已完成/总步数。
   * 失败时各字段为空字符串/0，调用方按需展示。
   */
  async getOperationInfo(repoPath: string): Promise<{ head: string; onto: string; ontoName: string; otherRef: string; done: number; total: number }> {
    const empty = { head: '', onto: '', ontoName: '', otherRef: '', done: 0, total: 0 };
    const dir = await this.resolveGitDir(repoPath);
    if (!dir) { return empty; }
    const readFile = async (rel: string) => {
      try { return (await fs.promises.readFile(path.join(dir, rel), 'utf8')).trim(); } catch { return ''; }
    };
    const stripRef = (s: string) => s.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
    const describe = async (ref: string) => {
      if (!ref) { return ''; }
      try { return (await this.git(repoPath, ['name-rev', '--name-only', '--no-undefined', ref])).trim(); }
      catch { return ref.slice(0, 12); }
    };
    if (await this.pathExists(path.join(dir, 'rebase-merge'))) {
      const head = stripRef(await readFile('rebase-merge/head-name'));
      const ontoHash = await readFile('rebase-merge/onto');
      const ontoName = await describe(ontoHash);
      const done = Number(await readFile('rebase-merge/msgnum')) || 0;
      const total = Number(await readFile('rebase-merge/end')) || 0;
      return { head, onto: ontoHash.slice(0, 7), ontoName, otherRef: '', done, total };
    }
    if (await this.pathExists(path.join(dir, 'rebase-apply'))) {
      const head = stripRef(await readFile('rebase-apply/head-name'));
      const ontoHash = await readFile('rebase-apply/onto');
      const ontoName = await describe(ontoHash);
      const done = Number(await readFile('rebase-apply/next')) || 0;
      const total = Number(await readFile('rebase-apply/last')) || 0;
      return { head, onto: ontoHash.slice(0, 7), ontoName, otherRef: '', done, total };
    }
    if (await this.pathExists(path.join(dir, 'MERGE_HEAD'))) {
      const mergeHead = await readFile('MERGE_HEAD');
      const other = mergeHead.split('\n').filter(Boolean)[0] || '';
      const otherRef = await describe(other);
      const head = await this.getCurrentBranch(repoPath).catch(() => '');
      return { head, onto: '', ontoName: '', otherRef: otherRef || other.slice(0, 7), done: 0, total: 0 };
    }
    return empty;
  }

  /** core.editor=true 让 git 在 commit message 阶段不阻塞编辑器 */
  async rebaseContinue(repoPath: string): Promise<void> {
    await this.git(repoPath, ['-c', 'core.editor=true', 'rebase', '--continue']);
  }

  async rebaseSkip(repoPath: string): Promise<void> {
    await this.git(repoPath, ['rebase', '--skip']);
  }

  async rebaseAbort(repoPath: string): Promise<void> {
    await this.git(repoPath, ['rebase', '--abort']);
  }

  async mergeContinue(repoPath: string): Promise<void> {
    await this.git(repoPath, ['-c', 'core.editor=true', 'commit', '--no-edit']);
  }

  async mergeAbort(repoPath: string): Promise<void> {
    await this.git(repoPath, ['merge', '--abort']);
  }

  /** 未合并路径（含 submodule gitlink），比 diff-filter=U 更完整。 */
  private async listUnmergedPaths(repoPath: string): Promise<string[]> {
    try {
      const out = await this.git(repoPath, ['ls-files', '-u']);
      const paths = new Set<string>();
      for (const line of out.trim().split('\n')) {
        if (!line) { continue; }
        const tab = line.lastIndexOf('\t');
        if (tab < 0) { continue; }
        paths.add(line.slice(tab + 1));
      }
      return [...paths];
    } catch { return []; }
  }

  /** 将全部未合并路径置为 --ours 或 --theirs（含 submodule gitlink），再 add。 */
  async acceptConflictSide(repoPath: string, side: 'ours' | 'theirs'): Promise<number> {
    const files = await this.listUnmergedPaths(repoPath);
    if (!files.length) { return 0; }
    for (const f of files) {
      await this.git(repoPath, ['checkout', `--${side}`, '--', f]);
      await this.git(repoPath, ['add', '--', f]);
    }
    return files.length;
  }

  /**
   * 为父仓里被改动的子模块拉取最新对象（解决 `Could not read <oid>` 类问题）。
   * 先 sync 配置 → init 缺失子模块 → 在每个子模块里 `git fetch --all`。
   */
  async submoduleSyncAndFetch(repoPath: string): Promise<void> {
    try { await this.git(repoPath, ['submodule', 'sync', '--recursive']); } catch { /* ignore */ }
    try { await this.git(repoPath, ['submodule', 'update', '--init', '--recursive']); } catch { /* ignore */ }
    try { await this.git(repoPath, ['submodule', 'foreach', '--recursive', 'git fetch --all --prune']); } catch { /* ignore */ }
  }

  async hasSubmodules(repoPath: string): Promise<boolean> {
    try {
      const out = (await this.git(repoPath, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])).trim();
      return !!out;
    } catch { return false; }
  }

  /**
   * fetch 远端分支后对 `remote/branch` 做 merge（不经过 `git pull`）。
   * rebase 路径请用 `rebaseOntoRemoteTracking`，以便在有本地改动时使用 `--autostash`。
   */
  private async fetchAndMergeRemoteBranch(repoPath: string, remote: string, remoteBranch: string): Promise<void> {
    await this.git(repoPath, ['fetch', remote, remoteBranch]);
    const onto = `${remote}/${remoteBranch}`;
    await this.git(repoPath, ['merge', '--no-edit', onto]);
  }

  /** fetch 后对 `remote/branch` 做 rebase；有本地改动时用 `--autostash`（避免手写 stash + pop 与子模块/未跟踪文件组合时误报冲突）。 */
  private async rebaseOntoRemoteTracking(repoPath: string, remote: string, remoteBranch: string, dirty: boolean): Promise<void> {
    await this.git(repoPath, ['fetch', remote, remoteBranch]);
    const onto = `${remote}/${remoteBranch}`;
    if (dirty) { await this.git(repoPath, ['rebase', '--autostash', onto]); }
    else { await this.git(repoPath, ['rebase', onto]); }
  }

  /**
   * Update：对上游 tracking fetch 后 rebase；有未提交改动时使用 `rebase --autostash`，不再 `stash push -u` + `stash pop`。
   * 返回的 `unshelveConflicts` 表示 rebase 完成后自动恢复工作区时仍存在的未合并路径（若为空则一切正常）。
   */
  async pullBranch(repoPath: string, localBranch: string): Promise<{ hadLocalChanges: boolean; unshelveConflicts: string[]; stashRef?: string }> {
    const tracking = await this.getTrackingBranch(repoPath, localBranch);
    if (!tracking) {
      throw new Error(`分支 "${localBranch}" 未设置上游跟踪分支，无法 Update。请先执行 git push -u 或配置 branch.${localBranch}.remote / merge。`);
    }
    const parts = tracking.split('/');
    if (parts.length < 2) { throw new Error(`非法 tracking 分支: ${tracking}`); }
    const remote = parts[0];
    const remoteBranch = parts.slice(1).join('/');
    const dirty = await this.hasUncommittedChanges(repoPath);
    await this.rebaseOntoRemoteTracking(repoPath, remote, remoteBranch, dirty);
    const unshelveConflicts = await this.getConflictFiles(repoPath);
    let stashRef: string | undefined;
    if (dirty && unshelveConflicts.length > 0) {
      try { stashRef = (await this.git(repoPath, ['stash', 'list', '-n', '1', '--format=%gd'])).trim() || undefined; }
      catch { /* ignore */ }
    }
    return { hadLocalChanges: dirty, unshelveConflicts, stashRef };
  }

  async smartUpdateBranch(repoPath: string, branch: string): Promise<{ updated: boolean; shelved: boolean; branch: string; stashRef?: string; unshelveConflicts: string[] }> {
    let target = branch;
    if (target.startsWith('origin/')) { target = target.slice('origin/'.length); }
    const before = await this.revParseMaybe(repoPath, target);
    const current = await this.getCurrentBranch(repoPath);
    if (current !== target) {
      if (branch.startsWith('origin/')) {
        const remoteBefore = await this.revParseMaybe(repoPath, branch);
        await this.fetchAll(repoPath);
        const remoteAfter = await this.revParseMaybe(repoPath, branch);
        return { updated: !!remoteBefore && !!remoteAfter && remoteBefore !== remoteAfter, shelved: false, branch: target, unshelveConflicts: [] };
      }
      await this.fetchAll(repoPath);
      const tracking = await this.getTrackingBranch(repoPath, target);
      if (!tracking) { return { updated: false, shelved: false, branch: target, unshelveConflicts: [] }; }
      const localHash = await this.revParseMaybe(repoPath, target);
      const remoteHash = await this.revParseMaybe(repoPath, tracking);
      if (!localHash || !remoteHash || localHash === remoteHash) {
        return { updated: false, shelved: false, branch: target, unshelveConflicts: [] };
      }
      const canFastForward = await this.isAncestor(repoPath, localHash, remoteHash);
      if (!canFastForward) {
        return { updated: false, shelved: false, branch: target, unshelveConflicts: [] };
      }
      await this.git(repoPath, ['branch', '-f', target, tracking]);
      return { updated: true, shelved: false, branch: target, unshelveConflicts: [] };
    }
    let pullRes: { hadLocalChanges: boolean; unshelveConflicts: string[]; stashRef?: string };
    try {
      pullRes = await this.pullBranch(repoPath, target);
    } catch (e) {
      // 已进入 rebase（含子模块/普通文件冲突）→ 交由上层的 handleRebaseConflict 引导处理
      throw e;
    }
    const after = await this.revParseMaybe(repoPath, target);
    return {
      updated: !!before && !!after && before !== after,
      shelved: pullRes.hadLocalChanges,
      branch: target,
      stashRef: pullRes.stashRef,
      unshelveConflicts: pullRes.unshelveConflicts,
    };
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

  private async revParseMaybe(repoPath: string, ref: string): Promise<string | undefined> {
    try { return (await this.git(repoPath, ['rev-parse', ref])).trim(); } catch { return undefined; }
  }

  private async isAncestor(repoPath: string, base: string, tip: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['merge-base', '--is-ancestor', base, tip]);
      return true;
    } catch { return false; }
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
    const switched = cur !== branch ? await this.smartCheckout(repoPath, branch) : { shelved: false, forced: false, stashRef: undefined };
    await this.rebaseBranch(repoPath, tracking);
    await this.pushBranch(repoPath, branch, setUpstream);
    if (switched.shelved) {
      try { await this.unshelve(repoPath); } catch { /* ignore */ }
    }
    return { rebased: true };
  }

  async pullFromTracking(repoPath: string, tracking: string, useRebase: boolean): Promise<{ shelved: boolean; stashRef?: string; unshelveConflicts: string[] }> {
    const parts = tracking.split('/');
    if (parts.length < 2) { throw new Error(`非法 tracking 分支: ${tracking}`); }
    const remote = parts[0];
    const remoteBranch = parts.slice(1).join('/');
    const dirty = await this.hasUncommittedChanges(repoPath);
    let shelved = false;
    let stashRef: string | undefined;
    let unshelveConflicts: string[] = [];
    if (useRebase) {
      await this.rebaseOntoRemoteTracking(repoPath, remote, remoteBranch, dirty);
      shelved = dirty;
      unshelveConflicts = await this.getConflictFiles(repoPath);
      if (dirty && unshelveConflicts.length > 0) {
        try { stashRef = (await this.git(repoPath, ['stash', 'list', '-n', '1', '--format=%gd'])).trim() || undefined; }
        catch { /* ignore */ }
      }
      return { shelved, stashRef, unshelveConflicts };
    }
    if (dirty) {
      stashRef = await this.stash(repoPath, `pull --no-rebase: ${tracking}`);
      shelved = !!stashRef || true;
    }
    await this.fetchAndMergeRemoteBranch(repoPath, remote, remoteBranch);
    if (shelved) {
      const un = await this.unshelve(repoPath);
      if (!un.ok) { unshelveConflicts = un.conflictFiles; }
    }
    return { shelved, stashRef, unshelveConflicts };
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

  /** 解析 tag 指向的 commit hash（annotated/lightweight 都支持） */
  async resolveTagCommit(repoPath: string, name: string): Promise<string> {
    try { return (await this.git(repoPath, ['rev-list', '-n', '1', `refs/tags/${name}`])).trim(); }
    catch { return ''; }
  }

  async deleteTag(repoPath: string, name: string): Promise<void> {
    await this.git(repoPath, ['tag', '-d', name]);
  }

  async deleteRemoteTag(repoPath: string, name: string, remote: string = 'origin'): Promise<void> {
    await this.git(repoPath, ['push', remote, '--delete', `refs/tags/${name}`]);
  }

  async resolveCommitOid(repoPath: string, ref: string): Promise<string> {
    try { return (await this.git(repoPath, ['rev-parse', ref])).trim(); }
    catch { return ref; }
  }

  /** 短 oid，与 interactive rebase todo 里列出的 commit 形式一致（受 core.abbrev 影响）。 */
  async revParseShort(repoPath: string, ref: string): Promise<string> {
    try { return (await this.git(repoPath, ['rev-parse', '--short', ref])).trim(); }
    catch { return ref.slice(0, 7); }
  }

  private shQuoteForSequenceEditor(s: string): string {
    if (process.platform === 'win32') {
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /**
   * 将指定提交在 interactive rebase 中从 pick 改为 fixup/squash（并入上一条），不经终端面板。
   * 序列编辑器脚本对 todo 中每行 pick 的 oid 做 rev-parse 再比对，兼容 todo 里任意缩写长度。
   */
  async interactiveRebasePickAs(repoPath: string, commitOid: string, verb: 'fixup' | 'squash'): Promise<void> {
    if (await this.isRebasing(repoPath)) {
      throw new Error('当前已有进行中的 rebase，请先完成或中止。');
    }
    const full = (await this.git(repoPath, ['rev-parse', '--verify', `${commitOid}^{commit}`])).trim();
    let rebaseArgs: string[];
    try {
      await this.git(repoPath, ['rev-parse', '--verify', `${full}~2`]);
      rebaseArgs = ['rebase', '-i', `${full}~2`];
    } catch {
      rebaseArgs = ['rebase', '-i', '--root'];
    }
    const scriptPath = path.join(os.tmpdir(), `idea-git-seq-${process.pid}-${Date.now()}.cjs`);
    const script = [
      '\'use strict\';',
      'const fs=require(\'fs\');',
      'const {execFileSync}=require(\'child_process\');',
      'const repo=process.env.IDEA_GIT_REPO;',
      'const target=process.env.IDEA_GIT_TARGET_OID;',
      'const verb=process.env.IDEA_GIT_SEQ_VERB||\'fixup\';',
      'const todoPath=process.argv[process.argv.length-1];',
      'function rev(r){try{return execFileSync(\'git\',[\'rev-parse\',\'--verify\',r+\'^{commit}\'],{cwd:repo,encoding:\'utf8\',stdio:[\'ignore\',\'pipe\',\'pipe\']}).trim();}catch(_){return \'\'}}',
      'const tgt=rev(target);',
      'if(!tgt){console.error(\'idea-git: invalid TARGET\');process.exit(1);}',
      'const raw=fs.readFileSync(todoPath,\'utf8\');',
      'const nl=raw.includes(String.fromCharCode(13,10))?String.fromCharCode(13,10):String.fromCharCode(10);',
      'const lines=raw.split(/\\r?\\n/);',
      'let changed=false;',
      'const out=lines.map(line=>{',
      'const m=line.match(/^pick\\s+(\\S+)(\\s.*)?$/i);',
      'if(!m)return line;',
      'if(rev(m[1])!==tgt)return line;',
      'changed=true;',
      'return verb+\' \'+m[1]+(m[2]||\'\');',
      '});',
      'if(!changed){console.error(\'idea-git: pick line not found for target commit\');process.exit(1);}',
      'fs.writeFileSync(todoPath,out.join(nl));',
    ].join('');
    await fs.promises.writeFile(scriptPath, script, 'utf8');
    const GIT_SEQUENCE_EDITOR = `${this.shQuoteForSequenceEditor(process.execPath)} ${this.shQuoteForSequenceEditor(scriptPath)}`;
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_SEQUENCE_EDITOR,
      IDEA_GIT_REPO: repoPath,
      IDEA_GIT_TARGET_OID: full,
      IDEA_GIT_SEQ_VERB: verb,
    };
    this.maybeLogGitCommand(repoPath, rebaseArgs);
    const gitArgv = verb === 'fixup'
      ? ['-c', 'core.quotepath=false', '-c', 'core.editor=true', ...rebaseArgs]
      : ['-c', 'core.quotepath=false', ...rebaseArgs];
    try {
      try {
        await execFileAsync('git', gitArgv, { cwd: repoPath, maxBuffer: 50 * 1024 * 1024, env: mergedEnv });
      } catch (e) {
        const msg = this.gitErrText(e).trim() || (e instanceof Error ? e.message : String(e));
        throw new Error(msg || 'git rebase 失败');
      }
    } finally {
      try { await fs.promises.unlink(scriptPath); } catch { /* ignore */ }
    }
  }

  async fixupCommitIntoParent(repoPath: string, commitOid: string): Promise<void> {
    await this.interactiveRebasePickAs(repoPath, commitOid, 'fixup');
  }

  /** 仅当存在「本地分支 + 已配置 upstream + 落后于 upstream」时视为有远端可拉更新（不含纯远端新分支等）。 */
  async repoHasRemoteUpdates(repoPath: string): Promise<boolean> {
    try {
      const out = await this.git(repoPath, ['for-each-ref', 'refs/heads', '--format=%(upstream:track)\t%(upstream)']);
      for (const line of out.trim().split('\n')) {
        if (!line) { continue; }
        const [track, upstream] = line.split('\t');
        if (!upstream || !upstream.trim()) { continue; }
        const t = track || '';
        if (/\bbehind\s+\d+/i.test(t) || /落后\s*\d+/.test(t)) { return true; }
      }
    } catch { /* ignore */ }
    return false;
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
