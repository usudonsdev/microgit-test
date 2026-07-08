import * as vscode from 'vscode';

export interface GraphCommit {
    hash: string;
    parents: string[];
    tags: string[];
    subject: string;
    timestamp: string;
}

export interface MicroGitUiSnapshot {
    enabled: boolean;
    targetBranch?: string;
    currentBranch?: string;
    onTarget: boolean;
    active: boolean;
    currentTag: string;
    currentHead?: string;
    commits: GraphCommit[];
    hasShadow: boolean;
    workspaceOpen: boolean;
}

/**
 * Activity Bar の専用ビューとグラフパネルを管理し、状態変更をリアルタイム反映する
 */
export class MicroGitUi implements vscode.WebviewViewProvider {
    public static readonly viewType = 'microgit.sidebar';

    private view?: vscode.WebviewView;
    private graphPanel?: vscode.WebviewPanel;
    private latest: MicroGitUiSnapshot = emptySnapshot();

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = getSidebarHtml();
        webviewView.webview.onDidReceiveMessage((message) => {
            void this.handleSidebarMessage(message);
        });
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
            }
        });
        this.postToSidebar();
    }

    update(snapshot: MicroGitUiSnapshot): void {
        this.latest = snapshot;
        this.postToSidebar();
        this.postToGraph();
    }

    showGraphPanel(): void {
        if (!this.latest.workspaceOpen) {
            vscode.window.showWarningMessage('ワークスペースを開いてからグラフを表示してください。');
            return;
        }
        if (!this.latest.active) {
            vscode.window.showWarningMessage('MicroGit が無効、または対象ブランチ以外のためグラフを表示できません。');
            return;
        }
        if (!this.latest.hasShadow) {
            vscode.window.showWarningMessage('シャドウリポジトリがまだ存在しません。ファイルを保存して履歴を作ってください。');
            return;
        }

        if (this.graphPanel) {
            this.graphPanel.reveal(vscode.ViewColumn.One);
            this.postToGraph();
            return;
        }

        this.graphPanel = vscode.window.createWebviewPanel(
            'microgitGraph',
            'MicroGit Graph',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.graphPanel.webview.html = getGraphHtml();
        this.graphPanel.webview.onDidReceiveMessage((message) => {
            void this.handleGraphMessage(message);
        });
        this.graphPanel.onDidDispose(() => {
            this.graphPanel = undefined;
        });
        this.postToGraph();
    }

    private postToSidebar(): void {
        this.view?.webview.postMessage({ type: 'update', payload: this.latest });
    }

    private postToGraph(): void {
        this.graphPanel?.webview.postMessage({
            type: 'update',
            payload: {
                commits: this.latest.commits,
                currentHead: this.latest.currentHead,
                currentTag: this.latest.currentTag,
                active: this.latest.active,
                hasShadow: this.latest.hasShadow,
            },
        });
    }

    private async handleSidebarMessage(message: { command?: string; hash?: string }): Promise<void> {
        switch (message.command) {
            case 'toggle':
                await vscode.commands.executeCommand('microgit.toggle');
                return;
            case 'showGraph':
                this.showGraphPanel();
                return;
            case 'jumpToCommit':
                if (typeof message.hash === 'string') {
                    await vscode.commands.executeCommand('microgit.jumpToCommit', message.hash);
                }
                return;
            case 'jumpPrompt':
                await vscode.commands.executeCommand('microgit.jumpToCommit');
                return;
            case 'exportLogs':
                await vscode.commands.executeCommand('microgit.exportLogs');
                return;
            case 'ready':
                this.postToSidebar();
                return;
        }
    }

    private async handleGraphMessage(message: { command?: string; hash?: string }): Promise<void> {
        if (message.command === 'jumpToCommit' && typeof message.hash === 'string') {
            await vscode.commands.executeCommand('microgit.jumpToCommit', message.hash);
            return;
        }
        if (message.command === 'ready') {
            this.postToGraph();
        }
    }
}

function emptySnapshot(): MicroGitUiSnapshot {
    return {
        enabled: false,
        onTarget: false,
        active: false,
        currentTag: 'mb-1',
        commits: [],
        hasShadow: false,
        workspaceOpen: false,
    };
}

function getSidebarHtml(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, #444);
    --btn: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn2: var(--vscode-button-secondaryBackground);
    --btn2-fg: var(--vscode-button-secondaryForeground);
    --active: var(--vscode-charts-green, #3fb950);
    --warn: var(--vscode-charts-orange, #d29922);
    --card: var(--vscode-editor-background);
  }
  body {
    margin: 0;
    padding: 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
  }
  h1 { font-size: 13px; margin: 0 0 10px; font-weight: 600; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 10px;
  }
  .row { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0; }
  .label { color: var(--muted); }
  .value { font-weight: 600; text-align: right; word-break: break-all; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
  }
  .badge.on { background: rgba(63, 185, 80, 0.2); color: var(--active); }
  .badge.off { background: rgba(128, 128, 128, 0.2); color: var(--muted); }
  .badge.warn { background: rgba(210, 153, 34, 0.2); color: var(--warn); }
  .actions { display: grid; gap: 6px; margin-bottom: 10px; }
  button {
    border: none;
    border-radius: 4px;
    padding: 7px 10px;
    cursor: pointer;
    font: inherit;
  }
  button.primary { background: var(--btn); color: var(--btn-fg); }
  button.secondary { background: var(--btn2); color: var(--btn2-fg); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .list { display: grid; gap: 6px; max-height: 50vh; overflow: auto; }
  .item {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    cursor: pointer;
    background: transparent;
    text-align: left;
    color: inherit;
  }
  .item:hover { outline: 1px solid var(--btn); }
  .item.active { border-color: var(--active); }
  .hash { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--muted); }
  .subject { margin-top: 2px; }
  .tags { margin-top: 4px; color: var(--btn); font-size: 11px; font-weight: 700; }
  .empty { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
  <h1>MicroGit Control</h1>
  <div class="card" id="status-card">
    <div class="row"><span class="label">状態</span><span id="status-badge" class="badge off">OFF</span></div>
    <div class="row"><span class="label">対象ブランチ</span><span class="value" id="target-branch">-</span></div>
    <div class="row"><span class="label">現在ブランチ</span><span class="value" id="current-branch">-</span></div>
    <div class="row"><span class="label">マイクロタグ</span><span class="value" id="current-tag">-</span></div>
    <div class="row"><span class="label">HEAD</span><span class="value" id="current-head">-</span></div>
  </div>

  <div class="actions">
    <button class="primary" id="btn-toggle">有効化 / 無効化</button>
    <button class="secondary" id="btn-graph">グラフを開く</button>
    <button class="secondary" id="btn-jump">タグ / ハッシュへジャンプ</button>
    <button class="secondary" id="btn-export">ログをエクスポート</button>
  </div>

  <h1>最近のマイクロ履歴</h1>
  <div class="list" id="commit-list"><div class="empty">履歴はまだありません</div></div>

  <script>
    const vscode = acquireVsCodeApi();
    const statusBadge = document.getElementById('status-badge');
    const targetBranch = document.getElementById('target-branch');
    const currentBranch = document.getElementById('current-branch');
    const currentTag = document.getElementById('current-tag');
    const currentHead = document.getElementById('current-head');
    const commitList = document.getElementById('commit-list');
    const btnGraph = document.getElementById('btn-graph');
    const btnJump = document.getElementById('btn-jump');
    const btnExport = document.getElementById('btn-export');

    document.getElementById('btn-toggle').onclick = () => vscode.postMessage({ command: 'toggle' });
    btnGraph.onclick = () => vscode.postMessage({ command: 'showGraph' });
    btnJump.onclick = () => vscode.postMessage({ command: 'jumpPrompt' });
    btnExport.onclick = () => vscode.postMessage({ command: 'exportLogs' });

    function short(hash) {
      return hash ? hash.substring(0, 7) : '-';
    }

    function render(payload) {
      const active = !!payload.active;
      const enabled = !!payload.enabled;
      statusBadge.className = 'badge ' + (active ? 'on' : (enabled ? 'warn' : 'off'));
      statusBadge.textContent = active ? 'ACTIVE' : (enabled ? '待機中' : 'OFF');
      targetBranch.textContent = payload.targetBranch || '-';
      currentBranch.textContent = payload.currentBranch || '-';
      currentTag.textContent = payload.currentTag || '-';
      currentHead.textContent = short(payload.currentHead);

      btnGraph.disabled = !active || !payload.hasShadow;
      btnJump.disabled = !active || !payload.hasShadow;
      btnExport.disabled = !payload.onTarget;

      const commits = Array.isArray(payload.commits) ? payload.commits.slice(0, 30) : [];
      if (!commits.length) {
        commitList.innerHTML = '<div class="empty">' +
          (payload.workspaceOpen ? '履歴はまだありません。ファイルを保存してください。' : 'ワークスペースを開いてください。') +
          '</div>';
        return;
      }

      commitList.innerHTML = '';
      commits.forEach((c) => {
        const btn = document.createElement('button');
        btn.className = 'item' + (c.hash === payload.currentHead ? ' active' : '');
        btn.disabled = !active;
        btn.innerHTML =
          '<div class="hash">' + short(c.hash) + ' · ' + (c.timestamp || '') + '</div>' +
          '<div class="subject"></div>' +
          (c.tags && c.tags.length ? '<div class="tags"></div>' : '');
        btn.querySelector('.subject').textContent = c.subject || '(no message)';
        const tagsEl = btn.querySelector('.tags');
        if (tagsEl) { tagsEl.textContent = '[' + c.tags.join(', ') + ']'; }
        btn.onclick = () => vscode.postMessage({ command: 'jumpToCommit', hash: c.hash });
        commitList.appendChild(btn);
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        render(msg.payload || {});
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function getGraphHtml(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<style>
  body {
    margin: 0;
    padding: 16px;
    font-family: var(--vscode-font-family, sans-serif);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #fff);
  }
  .header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  h3 { margin: 0; color: var(--vscode-descriptionForeground, #888); font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
  #empty { padding: 20px; color: var(--vscode-descriptionForeground, #888); }
  .node { cursor: pointer; fill: #007acc; transition: 0.15s; }
  .node:hover { fill: #fff; }
  .node.current { fill: #3fb950; stroke: #fff; stroke-width: 2px; }
  .line { stroke: #555; stroke-width: 3px; fill: none; }
  .text { fill: var(--vscode-editor-foreground, #ccc); font-size: 13px; pointer-events: none; }
  .tag-text { fill: #007acc; font-size: 11px; font-weight: bold; }
</style>
</head>
<body>
  <div class="header">
    <h3>MicroGit タイムライン</h3>
    <div class="meta" id="meta"></div>
  </div>
  <div id="empty" hidden>履歴がまだありません。</div>
  <svg id="graph-area" width="100%" height="80px"></svg>
  <script>
    const vscode = acquireVsCodeApi();
    const svg = document.getElementById('graph-area');
    const empty = document.getElementById('empty');
    const meta = document.getElementById('meta');

    function render(payload) {
      const commitsAsc = Array.isArray(payload.commits) ? payload.commits.slice().reverse() : [];
      meta.textContent = 'tag: ' + (payload.currentTag || '-') + ' / HEAD: ' +
        (payload.currentHead ? payload.currentHead.substring(0, 7) : '-');

      while (svg.firstChild) { svg.removeChild(svg.firstChild); }

      if (!commitsAsc.length) {
        empty.hidden = false;
        svg.setAttribute('height', '40px');
        return;
      }
      empty.hidden = true;

      const nodeMap = new Map();
      const yInterval = 60;
      const branchLanes = new Map();
      let currentMaxLane = 0;

      commitsAsc.forEach((c, i) => {
        let lane = 0;
        if (i > 0) {
          const prevCommit = commitsAsc[i - 1];
          if (!c.parents.includes(prevCommit.hash)) {
            currentMaxLane++;
            lane = currentMaxLane;
          } else {
            lane = branchLanes.get(prevCommit.hash) || 0;
          }
        }
        branchLanes.set(c.hash, lane);
        nodeMap.set(c.hash, { x: 40 + (lane * 35), y: i * yInterval + 30 });
      });

      svg.setAttribute('height', (commitsAsc.length * yInterval + 50) + 'px');

      commitsAsc.forEach((c) => {
        const childPos = nodeMap.get(c.hash);
        c.parents.forEach((pHash) => {
          const parentPos = nodeMap.get(pHash);
          if (!parentPos) { return; }
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', childPos.x);
          line.setAttribute('y1', childPos.y);
          line.setAttribute('x2', parentPos.x);
          line.setAttribute('y2', parentPos.y);
          line.setAttribute('class', 'line');
          svg.appendChild(line);
        });
      });

      commitsAsc.forEach((commit) => {
        const pos = nodeMap.get(commit.hash);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', pos.x);
        circle.setAttribute('cy', pos.y);
        circle.setAttribute('r', commit.hash === payload.currentHead ? '9' : '8');
        circle.setAttribute('class', 'node' + (commit.hash === payload.currentHead ? ' current' : ''));
        circle.onclick = () => vscode.postMessage({ command: 'jumpToCommit', hash: commit.hash });
        svg.appendChild(circle);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', pos.x + 20);
        text.setAttribute('y', pos.y + 5);
        text.setAttribute('class', 'text');
        text.textContent = commit.hash.substring(0, 7) + ' - ' + commit.subject;
        svg.appendChild(text);

        if (commit.tags && commit.tags.length) {
          const tagText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          tagText.setAttribute('x', pos.x + 20);
          tagText.setAttribute('y', pos.y + 20);
          tagText.setAttribute('class', 'tag-text');
          tagText.textContent = '[' + commit.tags.join(', ') + ']';
          svg.appendChild(tagText);
        }
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        render(msg.payload || {});
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}
