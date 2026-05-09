import * as vscode from 'vscode';
import { GitService, GitRepo } from './gitService';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private currentRepo: GitRepo | undefined;

  constructor(private gitService: GitService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.command = 'ideaGit.switchBranch';
    this.item.tooltip = 'IDEA Git: Click to switch branch';
  }

  setRepo(repo: GitRepo) { this.currentRepo = repo; }

  async refresh(): Promise<void> {
    if (!this.currentRepo) { this.item.hide(); return; }
    try {
      const branch = await this.gitService.getCurrentBranch(this.currentRepo.rootPath);
      const repos = this.gitService.getRepos();
      const prefix = repos.length > 1 ? `${this.currentRepo.name}: ` : '';
      this.item.text = `$(git-branch) ${prefix}${branch}`;
      this.item.show();
    } catch { this.item.hide(); }
  }

  async switchBranch(): Promise<void> {
    if (!this.currentRepo) { return; }
    const branches = await this.gitService.getBranches(this.currentRepo.rootPath);
    const current = branches.find(b => b.current)?.name;
    const items: vscode.QuickPickItem[] = [
      { label: '$(add) 新建分支...', description: '', alwaysShow: true },
      { label: '$(edit) 重命名当前分支...', description: current, alwaysShow: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...branches.filter(b => !b.current).map(b => ({
        label: `${b.remote ? '$(cloud) ' : '$(git-branch) '}${b.name}`,
        description: b.tracking ? `→ ${b.tracking}` : '',
        detail: b.remote ? 'remote' : 'local'
      }))
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `当前分支: ${current}   选择要切换到的分支` });
    if (!pick) { return; }
    if (pick.label.includes('新建分支')) {
      await vscode.commands.executeCommand('ideaGit.createBranch');
    } else if (pick.label.includes('重命名')) {
      await vscode.commands.executeCommand('ideaGit.renameBranch');
    } else {
      const branchName = pick.label.replace(/^\$\([^)]+\)\s*/, '');
      try {
        const result = await this.gitService.smartCheckout(this.currentRepo.rootPath, branchName);
        if (result.shelved) {
          const restore = await vscode.window.showInformationMessage(`已 Shelve 改动并切换到 ${branchName}。需要恢复之前的改动吗？`, '恢复 (Unshelve)', '稍后');
          if (restore === '恢复 (Unshelve)') { await this.gitService.unshelve(this.currentRepo.rootPath); }
        } else if (result.forced) {
          vscode.window.showWarningMessage(`已强制切换到分支: ${branchName}（原工作区改动已丢弃）`);
        } else {
          vscode.window.showInformationMessage(`已切换到分支: ${branchName}`);
        }
      } catch (e: any) {
        if (!e.message?.includes('用户取消')) { vscode.window.showErrorMessage(`切换分支失败: ${e.message}`); }
      }
    }
    await this.refresh();
  }

  dispose() { this.item.dispose(); }
}
