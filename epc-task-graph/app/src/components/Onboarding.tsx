// ============================================================================
// 初回オンボーディング: 「まず絞る→それから見る」の入口を最初から辿れるようにする。
// 初回のみ表示（localStorage フラグ）。自動テスト(navigator.webdriver)では出さない。
// 担当を選ぶと自分のスライス（担当＋前後）で開く＝理想の運用スタイルに直行できる。
// ============================================================================
import { useState } from 'react';
import { useApp } from '../store/store';
import { useAssigneeOptions } from '../store/hooks';

const LS_ONBOARDED = 'epc-app-onboarded';

export function Onboarding() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      if (navigator.webdriver) return true; // 自動テストでは出さない
      return localStorage.getItem(LS_ONBOARDED) === '1';
    } catch {
      return true;
    }
  });
  const me = useApp((s) => s.me);
  const [dept, setDept] = useState('');
  const assignees = useAssigneeOptions();

  if (dismissed) return null;

  const close = () => {
    try {
      localStorage.setItem(LS_ONBOARDED, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };
  const startWithDept = () => {
    const d = (dept || me).trim();
    if (d) useApp.getState().setMe(d);
    useApp.getState().quickMyTasks(); // 担当ISOLATE＋前後1（自分のスライス）
    close();
  };

  return (
    <div className="onboard-backdrop" data-testid="onboarding">
      <div className="onboard-card">
        <div className="onboard-brand">
          <svg width="26" height="26" viewBox="0 0 22 22" aria-hidden="true" className="brand-mark">
            <line x1="5" y1="7" x2="11" y2="15" />
            <line x1="11" y1="15" x2="17" y2="7" />
            <line x1="5" y1="7" x2="17" y2="7" />
            <circle cx="5" cy="7" r="2.4" />
            <circle cx="11" cy="15" r="2.4" />
            <circle cx="17" cy="7" r="2.4" />
          </svg>
          <b>ようこそ C-Relations へ</b>
        </div>
        <p className="onboard-lead">
          数千のタスクを一度に見るのではなく、<b>自分の担当とその前後（受け渡し）に絞って</b>使うのが
          基本です。まず担当を選んでみましょう。
        </p>

        <label className="onboard-label">あなたの担当（部署）</label>
        <div className="onboard-row">
          <input
            className="onboard-input"
            list="onboard-depts"
            placeholder="例: 設計1課"
            value={dept}
            data-testid="onboard-dept"
            onChange={(e) => setDept(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') startWithDept();
            }}
          />
          <datalist id="onboard-depts">
            {assignees.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <button className="btn primary" data-testid="onboard-start" onClick={startWithDept}>
            この担当で始める
          </button>
        </div>

        <div className="onboard-guide">
          <div>
            <span className="onboard-badge">絞る</span>「自分のタスク」「CPのみ」やWBSツリーで見たい範囲へ
          </div>
          <div>
            <span className="onboard-badge">見る</span>グラフ（G）／テーブル（T）／ガント（Y）を切り替え
          </div>
          <div>
            <span className="onboard-badge">迷ったら</span>右上の「？使い方」にワークフローとキー操作
          </div>
        </div>

        <button className="onboard-skip" data-testid="onboard-skip" onClick={close}>
          あとで（全体を見る）
        </button>
      </div>
    </div>
  );
}
