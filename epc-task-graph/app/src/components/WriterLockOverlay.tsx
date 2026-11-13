/** 別タブが編集権（書込ロック）を持つ間、このタブの操作を止める全画面の案内。 */
export function WriterLockOverlay() {
  return (
    <div className="writer-lock-overlay" role="alertdialog" aria-modal="true" aria-labelledby="writer-lock-title">
      <div className="writer-lock-card">
        <h1 id="writer-lock-title">このアプリは別のタブで開かれています</h1>
        <p>
          データ保護のため、同時に編集できるのは1つのタブだけです。もう一方のタブを閉じると、このタブで自動的に使えるようになります。
        </p>
      </div>
    </div>
  );
}
