import type { CsvMergePlan } from "../../domain";
import { Dialog } from "./Dialog";

const MAX_REMOVED_SHOWN = 10;

// CSV で現在のプロジェクトを更新する前の確認ダイアログ（件数と削除対象を示す）。
export function CsvMergeDialog({
  fileName,
  plan,
  hasIds,
  warningCount,
  onApply,
  onClose,
}: {
  fileName: string;
  plan: CsvMergePlan;
  hasIds: boolean;
  warningCount: number;
  onApply: () => void;
  onClose: () => void;
}) {
  const s = plan.summary;
  const matched = s.updated + s.unchanged;
  const shown = plan.removedTasks.slice(0, MAX_REMOVED_SHOWN);
  return (
    <Dialog
      title="CSVで現在のプロジェクトを更新"
      subtitle={`「${fileName}」の内容を反映します。ID が一致するタスクを更新し、ID の無い行は追加します。`}
      onClose={onClose}
      className="csv-merge-dialog"
    >
      <div className="dialog-body" data-testid="csv-merge-dialog">
        <dl className="csv-merge-summary">
          <div>
            <dt>追加</dt>
            <dd data-testid="csv-merge-added">{s.added}</dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd data-testid="csv-merge-updated">{s.updated}</dd>
          </div>
          <div>
            <dt>変更なし</dt>
            <dd>{s.unchanged}</dd>
          </div>
          <div className={s.removed ? "is-danger" : undefined}>
            <dt>削除</dt>
            <dd data-testid="csv-merge-removed">{s.removed}</dd>
          </div>
        </dl>
        <p className="csv-merge-deps">
          依存関係: 追加 {s.depsAdded}・削除 {s.depsRemoved}・種類/ラグ変更 {s.depsUpdated}・そのまま {s.depsKept - s.depsUpdated}
        </p>
        {!hasIds ? (
          <p className="csv-merge-warn" role="alert">
            CSVに「ID」列が無いため、既存のタスクと突き合わせできません。すべての行が新しいタスクとして追加され、既存のタスクはすべて削除されます。
          </p>
        ) : matched === 0 && s.removed > 0 ? (
          <p className="csv-merge-warn" role="alert">
            CSVの ID が現在のプロジェクトのタスクと1件も一致しません（別のプロジェクトのCSVの可能性があります）。
          </p>
        ) : null}
        {s.removed ? (
          <div className="csv-merge-warn" role="alert">
            <p>CSVに無い次の {s.removed} 件のタスクと、その依存関係は削除されます（「戻す」で取り消せます）。</p>
            <ul>
              {shown.map((t) => (
                <li key={t.id}>
                  {t.wbsCode ? `${t.wbsCode} ` : ""}
                  {t.name}
                </li>
              ))}
            </ul>
            {s.removed > shown.length ? <p>…ほか {s.removed - shown.length} 件</p> : null}
          </div>
        ) : null}
        {s.added ? <p className="csv-merge-note">タスクを追加するため、反映後に全体整列を行います。</p> : null}
        {warningCount ? (
          <p className="csv-merge-note">取込時の注意が {warningCount} 件あります（反映後に一覧を表示します）。</p>
        ) : null}
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" data-autofocus onClick={onClose}>
          キャンセル
        </button>
        <button type="button" className="btn primary" data-testid="csv-merge-apply" onClick={onApply}>
          反映する
        </button>
      </div>
    </Dialog>
  );
}
