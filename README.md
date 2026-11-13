# C-Relations — 工程管理ワークスペース

EPC工程（プラント・建設）の**タスク依存関係をノードグラフで直感的に可視化・編集**するツール。
ノード＝タスク、エッジ＝依存（先行/後続）。**4,000+ノード規模**でも軽快に扱えることを最優先に設計しています。

**🔗 ライブデモ（`main` への push で自動デプロイ）**: https://nomhck.github.io/c_relations/

> ブラウザ内（IndexedDB）で完結。ヘッダの「4,000ノードdemo生成」ですぐ体感できます。サーバー不要。

---

## インタフェース再設計版

工程の全体像から、次に確認・編集するタスクへ進むワークスペース。

- 概要：進捗、計算上の完了日、重要工程、保留、工種別タイムライン、マイルストーン
- 編集：タスク追加ダイアログ、基本情報・つながり・日程の詳細パネル、工期変更の影響プレビュー
- 操作：常設ナビゲーション、検索（Cmd/Ctrl+K）、表示階層、必要なときに開く絞り込み
- 安定性：保存の直列化、取り消し／やり直しの永続化、切替前の保存、読込完了後に編集を許可

設計判断・検証範囲は [再設計ノート](docs/product-redesign.md) を参照。以下は既存機能と開発履歴です。

## 何ができるか（現状）

### 多ビュー（`G` グラフ／`T` テーブル／`Y` ガント・状態は全ビュー共有）
- **グラフ** — ノード編集。俯瞰は集約カード＋WBSグリッド整列で判読可能
- **テーブル** — 仮想スクロール・インライン編集・多重ソート・**複数行選択＋一括操作**（削除/ステータス/工種/担当）・WBS日付集計・`Tab`後続作成
- **ガント** — 時間軸バー（CPM es/ef）・WBSサマリバー・工種色分け・CP赤・進捗・月目盛り／基準日ライン

### グラフ編集
- タスクの作成／編集／削除（ダブルクリック作成・インライン編集・Tab連続作成）
- 依存（先行→後続）の接続／削除。**循環依存は自動で拒否**し経路をトースト表示
- WBS階層の**折り畳み／展開**（集約ノード化）

### 大規模ナビゲーション（設計思想「4,000を一度に描かない」）
- **フィルタ**（部署／工種／ステータス）＋ DIM/ISOLATE 切替 → 常時表示を数百ノードに制御
- **近傍フォーカス（`H`）** — 選択タスクの先行/後続だけを表示
- 自動レイアウト（dagre、全体整列は Web Worker）／ミニマップ／ズームLOD

### クリティカルパス（CPM Step1）
- 前進/後退計算で **ES/EF/LS/LF・トータルフロート・クリティカルパス**を算出（暦日・FS依存）
- **CP強調トグル**／**「CPのみ表示」ビュー**／プロジェクト完了日サマリ

### 永続化・プロジェクト
- **IndexedDB（Dexie）** に行単位・差分保存、保存履歴5世代
- 複数プロジェクト（新規／複製／切替／削除）
- JSON エクスポート／インポート

---

## 動かす

### ライブ（インストール不要）
https://nomhck.github.io/c_relations/ を開くだけ。

### ローカル開発
```sh
cd epc-task-graph/app
npm install
npm run dev          # http://localhost:5173/
npm run build        # 本番ビルド
npm test             # 単体テスト
npm run test:e2e     # ブラウザテスト（別途ブラウザのインストールが必要）
```

### ゼロ設定モック（ビルド不要・Phase 0 の参考実装）
`epc-task-graph/mock/index.html` をブラウザで開くだけ（単一HTML・CDN依存）。

---

## 構成
```
docs/epc-task-graph-design.md      設計書 v2.0（最終設計・source of truth）
docs/design-principles.md          デザイン原則（新UI前に必読）
epc-task-graph/
  mock/index.html                  Phase 0 ゼロ設定モック（単一HTML）
  app/                             Vite + React18 + TypeScript 本体
    src/domain/                    React非依存の純関数（グラフ/フィルタ/CPM/表示パイプライン）
    src/store/  src/storage/       zustand + immer + zundo / Dexie（差分永続化）
    src/adapters/  src/components/  React Flow v12 隔離レイヤ + UI
    tests/                         vitest（単体）＋ playwright（e2e / e2e-api）
  api/                             サーバー版 API（Azure Functions + Azure SQL）
  infra/  swa/                     Azure リソース定義（Bicep）/ SWA 設定
```

## ロードマップ
- [x] **Phase 0** — ゼロ設定モック
- [x] **Phase 1 PR1–2** — Vite化・domain層（テスト付き）・モック移植
- [x] **Phase 1 PR3** — Dexie永続化・複数プロジェクト
- [x] **Phase 1 PR4** — CPM Step1・クリティカルパス表示
- [x] **PR-T1／PR-T2（全完了）** — 多ビュー器＋テーブル（仮想スクロール・多重ソート・複数行選択＋一括操作・WBS日付集計・wbsCode編集・Tab後続作成・保存ビュー）
- [x] **保存ビュー** — フィルタ/表示/折り畳み＋テーブルのソート/列を名前付きで保存・適用（左パネル）
- [x] **PR-G（Phase 3）** — ガントビュー（CPM連動バー・WBSサマリ・工種色分け・CP強調）
- [x] **俯瞰デザイン刷新** — 集約カード＋WBSグリッド整列
- [x] **関係ハイライト＋世代フィルタ** — 近傍フォーカス刷新（世代バッジ・ハイライト/抽出）／右パネルからGUI依存接続
- [x] **Phase 2 — CPM完成** — 依存タイプ **FS/SS/FF/SF＋lag**・日付制約 **SNET/FNLT/ASAP**・**稼働カレンダー**（稼働曜日＋祝日・土日も稼働に設定可）。すべて右パネル/左パネルで編集
- [x] **Phase 1 PR5–8（主要完了）** — フィルタ/保存ビュー/**検索(Cmd+K)**/キーボード/俯瞰(集約グリッド＋CP色MiniMap)/**WBSツリーパネル**
- [~] **MSPDI連携（下ごしらえ）** — MS Project XML の出力/取込で往復（タスク・WBS・所要・マイルストーン・依存タイプ/ラグ）。残: リソース(担当)・カレンダー
- [x] **Phase 4** — サーバー版（Azure SWA + Functions + Azure SQL・Entra ID ログイン・プロジェクト単位のメンバー権限・行単位衝突検知＋ポーリング同期）。GitHub Pages のローカル版はそのまま。手順: [docs/azure-deployment.md](docs/azure-deployment.md)
- [ ] Phase 5 — MS Project（MSPDI）連携

詳細は [`docs/epc-task-graph-design.md`](docs/epc-task-graph-design.md) を参照。

## 技術スタック
React 18 / TypeScript / Vite / @xyflow/react v12 / zustand + immer + zundo / Dexie(IndexedDB) / dagre / Zod。
設計＝Fable、実装＝Opus・Sonnet。
