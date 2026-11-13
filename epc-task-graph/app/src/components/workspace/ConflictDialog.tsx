import { useApp } from "../../store/store";
import { chooseConflict } from "../../store/apiSync";
import { Dialog } from "./Dialog";

// サーバー版のみ: 保存時に他のメンバーと同じ行を変更していた場合の解決ダイアログ。
// 閉じて保留にはできない（保存が止まったままになるため、必ずどちらかを選ぶ）。
export function ConflictDialog() {
  const conflict = useApp((s) => s.conflict);
  if (!conflict) return null;
  return (
    <Dialog
      title="他のメンバーが同じタスク/依存関係を変更しました"
      subtitle="どちらの内容を残すか選んでください。"
      onClose={() => undefined}
      className="conflict-dialog"
    >
      <div className="dialog-body" data-testid="conflict-dialog">
        <ul className="conflict-list">
          {conflict.names.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>
      <div className="dialog-footer">
        <button
          type="button"
          className="btn"
          data-testid="conflict-mine"
          onClick={() => chooseConflict("mine")}
        >
          自分の変更で上書き
        </button>
        <button
          type="button"
          className="btn primary"
          data-autofocus
          data-testid="conflict-theirs"
          onClick={() => chooseConflict("theirs")}
        >
          相手の変更を採用
        </button>
      </div>
    </Dialog>
  );
}
