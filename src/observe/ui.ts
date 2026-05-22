export function observeHtml(intervalMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fleet Observer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101211;
      --panel: #181b1a;
      --panel-2: #202523;
      --ink: #f1f0ea;
      --muted: #a9afa8;
      --quiet: #70786f;
      --line: #303731;
      --green: #69e6a6;
      --green-2: #163a29;
      --amber: #f3b75f;
      --amber-2: #3d2c16;
      --red: #ff6d65;
      --red-2: #43201d;
      --blue: #8cc8ff;
      --blue-2: #162c3d;
      --shadow: 0 18px 60px rgba(0, 0, 0, 0.32);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
        linear-gradient(180deg, rgba(255,255,255,0.03) 1px, transparent 1px),
        var(--bg);
      background-size: 32px 32px;
      color: var(--ink);
      font-family: "IBM Plex Sans", "Aptos", "SF Pro Display", "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button, input { font: inherit; }

    .shell {
      width: min(1480px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 36px;
    }

    .topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .mark {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      background: linear-gradient(135deg, #1f2723, #141716);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), var(--shadow);
      color: var(--green);
      flex: 0 0 auto;
    }

    .brand h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.1;
      font-weight: 740;
    }

    .repo-line {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: min(900px, 70vw);
    }

    .live {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      border: 1px solid var(--line);
      background: rgba(24, 27, 26, 0.92);
      padding: 9px 12px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .pulse {
      width: 8px;
      height: 8px;
      background: var(--green);
      box-shadow: 0 0 0 0 rgba(105, 230, 166, 0.8);
      animation: pulse 1.7s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(105, 230, 166, 0.45); }
      70% { box-shadow: 0 0 0 8px rgba(105, 230, 166, 0); }
      100% { box-shadow: 0 0 0 0 rgba(105, 230, 166, 0); }
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(360px, 0.65fr);
      gap: 16px;
      margin-bottom: 16px;
    }

    .status-panel {
      min-height: 220px;
      border: 1px solid var(--line);
      background: linear-gradient(145deg, rgba(32,37,35,0.98), rgba(20,23,22,0.98));
      box-shadow: var(--shadow);
      padding: 22px;
      position: relative;
      overflow: hidden;
    }

    .status-panel:before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 5px;
      background: var(--accent, var(--green));
    }

    .section-kicker {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 720;
    }

    .headline {
      margin: 0;
      font-size: clamp(32px, 5vw, 66px);
      line-height: 0.94;
      max-width: 860px;
      letter-spacing: 0;
    }

    .detail {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.45;
      max-width: 760px;
    }

    .action-panel {
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 18px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 220px;
    }

    .next-action {
      margin: 0;
      font-size: 23px;
      line-height: 1.18;
      font-weight: 730;
    }

    .repo-meta {
      align-self: end;
      display: grid;
      gap: 8px;
      margin-top: 18px;
      color: var(--muted);
      font-size: 13px;
    }

    .meta-row {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr);
      gap: 10px;
      align-items: baseline;
      min-width: 0;
    }

    .meta-row b {
      color: var(--quiet);
      font-weight: 680;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.07em;
    }

    .mono {
      font-family: "SF Mono", "Cascadia Code", "IBM Plex Mono", ui-monospace, monospace;
      font-size: 0.94em;
      overflow-wrap: anywhere;
    }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }

    .metric {
      border: 1px solid var(--line);
      background: rgba(24,27,26,0.92);
      padding: 14px;
      min-height: 94px;
    }

    .metric strong {
      display: block;
      font-size: 30px;
      line-height: 1;
      margin-bottom: 9px;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      font-weight: 720;
    }

    .main-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
      gap: 16px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      background: rgba(24, 27, 26, 0.96);
      box-shadow: var(--shadow);
      padding: 18px;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 14px;
      margin-bottom: 14px;
    }

    .panel h2 {
      margin: 0;
      font-size: 17px;
      line-height: 1.2;
    }

    .panel-sub {
      color: var(--muted);
      font-size: 13px;
    }

    .checks {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .check {
      border: 1px solid var(--line);
      background: var(--panel-2);
      padding: 13px;
      min-width: 0;
    }

    .check-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 8px;
    }

    .check h3 {
      margin: 0;
      font-size: 14px;
      line-height: 1.2;
    }

    .check p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }

    .evidence {
      margin-top: 9px;
      color: var(--quiet);
      font-size: 12px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 62px;
      height: 24px;
      padding: 0 9px;
      border: 1px solid currentColor;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 800;
    }

    .ok { color: var(--green); background: var(--green-2); }
    .warn { color: var(--amber); background: var(--amber-2); }
    .bad { color: var(--red); background: var(--red-2); }
    .unknown { color: var(--blue); background: var(--blue-2); }

    .sessions {
      display: grid;
      gap: 10px;
    }

    .session {
      border: 1px solid var(--line);
      background: var(--panel-2);
      padding: 14px;
      min-width: 0;
    }

    .session-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }

    .session-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .session-title h3 {
      margin: 0;
      font-size: 16px;
      line-height: 1.2;
    }

    .session-path {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .session-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 13px;
    }

    .stat {
      background: rgba(16,18,17,0.72);
      border: 1px solid var(--line);
      padding: 10px;
      min-width: 0;
    }

    .stat strong {
      display: block;
      font-size: 18px;
      line-height: 1;
      margin-bottom: 5px;
    }

    .stat span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .file-list {
      margin: 12px 0 0;
      display: grid;
      gap: 6px;
    }

    .file-chip {
      display: block;
      border-left: 3px solid var(--blue);
      background: rgba(140, 200, 255, 0.08);
      padding: 7px 9px;
      color: var(--ink);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .file-chip.dirty { border-left-color: var(--amber); background: rgba(243, 183, 95, 0.08); }
    .file-chip.hot { border-left-color: var(--red); background: rgba(255, 109, 101, 0.08); }

    .coord-grid {
      display: grid;
      gap: 10px;
    }

    .coord-item {
      border: 1px solid var(--line);
      background: var(--panel-2);
      padding: 13px;
    }

    .coord-item h3 {
      margin: 0 0 8px;
      font-size: 14px;
    }

    .coord-item p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }

    .activity {
      display: grid;
      gap: 8px;
      max-height: 560px;
      overflow: auto;
      padding-right: 4px;
    }

    .activity-item {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 10px;
      border-left: 2px solid var(--line);
      padding: 7px 0 7px 11px;
    }

    .activity-time {
      color: var(--quiet);
      font-size: 12px;
    }

    .activity-kind {
      color: var(--blue);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 760;
    }

    .activity-summary {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      margin-top: 2px;
    }

    .empty {
      border: 1px dashed var(--line);
      color: var(--muted);
      padding: 18px;
      text-align: center;
      font-size: 14px;
    }

    @media (max-width: 1100px) {
      .hero, .main-grid { grid-template-columns: 1fr; }
      .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }

    @media (max-width: 720px) {
      .shell { width: min(100vw - 20px, 1480px); padding-top: 14px; }
      .topbar { grid-template-columns: 1fr; }
      .metric-grid, .checks, .session-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .headline { font-size: 34px; }
      .status-panel, .action-panel, .panel { padding: 14px; }
      .meta-row { grid-template-columns: 1fr; gap: 3px; }
    }
  </style>
</head>
<body data-interval-ms="${intervalMs}">
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true">WF</div>
        <div>
          <h1>Fleet Observer</h1>
          <div class="repo-line mono" id="repo-line">Loading fleet state...</div>
        </div>
      </div>
      <div class="live"><span class="pulse" aria-hidden="true"></span><span id="live-label">Live</span></div>
    </header>

    <section class="hero">
      <div class="status-panel" id="status-panel">
        <p class="section-kicker">Working Status</p>
        <h2 class="headline" id="headline">Checking fleet...</h2>
        <p class="detail" id="working-detail">Reading local session, hook, and integration state.</p>
      </div>
      <aside class="action-panel">
        <p class="section-kicker">Next Action</p>
        <p class="next-action" id="next-action">Loading...</p>
        <div class="repo-meta" id="repo-meta"></div>
      </aside>
    </section>

    <section class="metric-grid" id="metrics"></section>

    <section class="main-grid">
      <div class="left-stack">
        <section class="panel">
          <div class="panel-header">
            <h2>Health Evidence</h2>
            <span class="panel-sub" id="generated-at"></span>
          </div>
          <div class="checks" id="checks"></div>
        </section>

        <section class="panel" style="margin-top: 16px;">
          <div class="panel-header">
            <h2>Agent Health</h2>
            <span class="panel-sub" id="agent-count"></span>
          </div>
          <div class="sessions" id="sessions"></div>
        </section>
      </div>

      <div class="right-stack">
        <section class="panel">
          <div class="panel-header">
            <h2>Coordination Health</h2>
            <span class="panel-sub" id="coord-status"></span>
          </div>
          <div class="coord-grid" id="coordination"></div>
        </section>

        <section class="panel" style="margin-top: 16px;">
          <div class="panel-header">
            <h2>Activity Feed</h2>
            <span class="panel-sub">Recent local events</span>
          </div>
          <div class="activity" id="activity"></div>
        </section>
      </div>
    </section>
  </main>

  <script>
    const intervalMs = Number(document.body.dataset.intervalMs || '2000');
    const statusAccent = {
      working: 'var(--green)',
      attention: 'var(--amber)',
      blocked: 'var(--red)',
      unknown: 'var(--blue)'
    };
    const checkClass = {
      ok: 'ok',
      warn: 'warn',
      bad: 'bad',
      unknown: 'unknown',
      active: 'ok',
      idle: 'warn',
      stale: 'warn',
      offline: 'bad'
    };

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, function (char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }

    function statusPill(status, label) {
      const cls = checkClass[status] || 'unknown';
      return '<span class="pill ' + cls + '">' + esc(label || status) + '</span>';
    }

    function render(snapshot) {
      document.getElementById('repo-line').textContent = snapshot.repo.root || 'No git repo detected';
      document.getElementById('live-label').textContent = 'Live - refreshed ' + new Date(snapshot.generated_at).toLocaleTimeString();
      const statusPanel = document.getElementById('status-panel');
      statusPanel.style.setProperty('--accent', statusAccent[snapshot.working.status] || 'var(--blue)');
      document.getElementById('headline').textContent = snapshot.working.label;
      document.getElementById('working-detail').textContent = snapshot.working.detail;
      document.getElementById('next-action').textContent = snapshot.summary.next_action;
      document.getElementById('generated-at').textContent = 'Snapshot ' + new Date(snapshot.generated_at).toLocaleTimeString();

      renderRepoMeta(snapshot);
      renderMetrics(snapshot);
      renderChecks(snapshot.checks);
      renderSessions(snapshot.sessions);
      renderCoordination(snapshot);
      renderActivity(snapshot.activity);
    }

    function renderRepoMeta(snapshot) {
      const repo = snapshot.repo;
      document.getElementById('repo-meta').innerHTML = [
        meta('Branch', repo.branch || '-'),
        meta('Integration', repo.integration_branch || '-'),
        meta('Remote ref', repo.integration_remote_ref || '-'),
        meta('Hooks', repo.hooks),
        meta('State', repo.state_root)
      ].join('');
    }

    function meta(label, value) {
      return '<div class="meta-row"><b>' + esc(label) + '</b><span class="mono">' + esc(value) + '</span></div>';
    }

    function renderMetrics(snapshot) {
      const items = [
        ['Active', snapshot.summary.active_sessions, 'heartbeating sessions'],
        ['At Risk', snapshot.summary.at_risk_sessions, 'stale or offline'],
        ['Dirty', snapshot.summary.dirty_files, 'visible changed files'],
        ['Pending', snapshot.summary.pending_sessions, 'main catch-ups'],
        ['Contention', snapshot.summary.contended_sessions, 'overlapping sessions'],
        ['Blocked', snapshot.summary.blocked_sessions + snapshot.summary.divergent_sessions, 'sync decisions']
      ];
      document.getElementById('metrics').innerHTML = items.map(function (item) {
        return '<div class="metric"><strong>' + esc(item[1]) + '</strong><span>' + esc(item[0]) + '</span><div class="evidence">' + esc(item[2]) + '</div></div>';
      }).join('');
    }

    function renderChecks(checks) {
      document.getElementById('checks').innerHTML = checks.map(function (check) {
        return '<article class="check">' +
          '<div class="check-top"><h3>' + esc(check.label) + '</h3>' + statusPill(check.status) + '</div>' +
          '<p>' + esc(check.detail) + '</p>' +
          '<div class="evidence mono">' + esc(check.evidence) + '</div>' +
        '</article>';
      }).join('');
    }

    function renderSessions(sessions) {
      document.getElementById('agent-count').textContent = sessions.length + ' visible';
      if (!sessions.length) {
        document.getElementById('sessions').innerHTML = '<div class="empty">No active fleet sessions are visible yet.</div>';
        return;
      }
      document.getElementById('sessions').innerHTML = sessions.map(renderSession).join('');
    }

    function renderSession(session) {
      const files = []
        .concat(session.contended_files.map(function (file) { return fileChip(file, 'hot', 'contended'); }))
        .concat(session.dirty_files.slice(0, 8).map(function (file) { return fileChip(file, 'dirty', 'dirty'); }))
        .concat(session.upcoming_files.slice(0, 5).map(function (file) { return fileChip(file, '', 'upcoming'); }));
      const moreCount = Math.max(0, session.dirty_files.length + session.upcoming_files.length + session.contended_files.length - files.length);
      if (moreCount) files.push('<span class="file-chip mono">+' + moreCount + ' more paths</span>');
      return '<article class="session">' +
        '<div class="session-head">' +
          '<div><div class="session-title"><h3 class="mono">' + esc(session.short_id) + '</h3>' + statusPill(session.lifecycle.status, session.lifecycle.label) + '<span class="pill unknown">' + esc(session.adapter_label) + '</span></div>' +
          '<div class="session-path mono">' + esc(session.worktree_path) + '</div></div>' +
          '<div class="mono" style="color: var(--muted); text-align: right;">pid ' + esc(session.pid) + '</div>' +
        '</div>' +
        '<div class="session-stats">' +
          stat(session.branch, 'branch') +
          stat(session.heartbeat_age_label, 'heartbeat') +
          stat(session.dirty_count, 'dirty') +
          stat(session.upcoming_count + session.touched_count, 'intent') +
        '</div>' +
        '<div class="detail" style="font-size: 13px; margin-top: 10px;">' + esc(session.lifecycle.detail) + renderIntegrationNote(session) + '</div>' +
        '<div class="file-list">' + files.join('') + '</div>' +
      '</article>';
    }

    function stat(value, label) {
      return '<div class="stat"><strong class="mono">' + esc(value) + '</strong><span>' + esc(label) + '</span></div>';
    }

    function fileChip(file, tone, label) {
      return '<span class="file-chip ' + tone + ' mono">' + esc(label) + ' / ' + esc(file) + '</span>';
    }

    function renderIntegrationNote(session) {
      if (session.integration.blocked) return ' Sync blocked: ' + esc(session.integration.blocked_reason || 'blocked') + '.';
      if (session.integration.divergent_targets.length) return ' Divergent main target visible.';
      if (session.integration.pending_sha) return ' Pending main update ' + esc(session.integration.pending_sha.slice(0, 12)) + '.';
      return '';
    }

    function renderCoordination(snapshot) {
      const coord = snapshot.coordination;
      document.getElementById('coord-status').textContent = coord.latest_main_event ? 'latest ' + coord.latest_main_event.short_sha : 'no main events';
      const rows = [
        coordItem('Latest main event', coord.latest_main_event ? coord.latest_main_event.short_sha + ' from ' + coord.latest_main_event.source + ' ' + coord.latest_main_event.age_label + ' ago' : 'No main movement recorded for this repo yet.'),
        coordItem('Pending catch-up', coord.pending_sessions.length ? coord.pending_sessions.join(', ') : 'No sessions are waiting on a main update.'),
        coordItem('Blocked or divergent', coord.blocked_sessions.concat(coord.divergent_sessions).length ? coord.blocked_sessions.concat(coord.divergent_sessions).join(', ') : 'No sync block or divergent main target visible.'),
        coordItem('Path contention', coord.contended_files.length ? coord.contended_files.join(', ') : 'No overlapping dirty, touched, or upcoming paths.')
      ];
      document.getElementById('coordination').innerHTML = rows.join('');
    }

    function coordItem(title, body) {
      return '<article class="coord-item"><h3>' + esc(title) + '</h3><p class="mono">' + esc(body) + '</p></article>';
    }

    function renderActivity(activity) {
      if (!activity.length) {
        document.getElementById('activity').innerHTML = '<div class="empty">No activity events recorded yet.</div>';
        return;
      }
      document.getElementById('activity').innerHTML = activity.map(function (event) {
        return '<div class="activity-item">' +
          '<div class="activity-time mono">' + esc(event.age_label) + ' ago</div>' +
          '<div><div class="activity-kind">' + esc(event.kind) + (event.short_session_id ? ' / ' + esc(event.short_session_id) : '') + '</div>' +
          '<div class="activity-summary">' + esc(event.summary) + '</div></div>' +
        '</div>';
      }).join('');
    }

    async function refresh() {
      try {
        const response = await fetch('/api/snapshot', { cache: 'no-store' });
        if (!response.ok) throw new Error('snapshot request failed: ' + response.status);
        render(await response.json());
      } catch (error) {
        document.getElementById('headline').textContent = 'Observer disconnected';
        document.getElementById('working-detail').textContent = error.message || String(error);
      }
    }

    refresh();
    setInterval(refresh, intervalMs);
  </script>
</body>
</html>`;
}
