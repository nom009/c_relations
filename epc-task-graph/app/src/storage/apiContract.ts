// ============================================================================
// サーバー版（Azure: Static Web Apps + Functions + Azure SQL + Entra ID）の API 契約。
// クライアント（ApiRepository）とサーバー（epc-task-graph/api）が共有する唯一の型定義。
// 型のみ（実行時コードなし）。変更する場合は両側を同時に更新すること。
//
// 共通: ベースパス /api、JSON。認証は SWA が付与する x-ms-client-principal ヘッダー。
// エラーは HTTP ステータス + ApiError。401=未ログイン / 403=権限なし / 404=なし（非メンバーにも404）
// / 409=行の競合（PatchConflictResponse）/ 422=検証エラー（ApiError.details に理由）。
//
// エンドポイント（権限: V=閲覧者以上 / E=編集者以上 / O=所有者）
//   GET    /api/me                                        → MeResponse
//   GET    /api/projects                                  → ProjectSummary[]（自分がメンバーのもの）
//   GET    /api/projects/{id}/graph                  V    → GraphResponse
//   PUT    /api/projects/{id}/graph                  E*   ← GraphDoc（全量置換） → SaveGraphResponse
//            * 未存在なら新規作成し、呼び出し者が owner になる
//   POST   /api/projects/{id}/patch                  E    ← GraphPatch → PatchOkResponse | 409 PatchConflictResponse
//   GET    /api/projects/{id}/changes?since={ver}    V    → ChangesResponse
//   DELETE /api/projects/{id}                        O    → 204
//   POST   /api/projects/{id}/duplicate              V    ← DuplicateRequest → GraphResponse（新規・呼び出し者が owner）
//   GET    /api/projects/{id}/snapshots              V    → SnapshotMeta[]
//   POST   /api/projects/{id}/snapshots/{seq}/restore E   → GraphResponse
//   GET    /api/projects/{id}/members                V    → Member[]
//   PUT    /api/projects/{id}/members                O    ← MemberUpsertRequest → Member[]
//   DELETE /api/projects/{id}/members/{email}        O    → Member[]（最後の owner は削除/降格不可=422）
//
// 楽観ロック（§7.2 L1）: GraphPatch の各行 baseRev は「最後にサーバーと同期した時点の rev」。
//   新規行は baseRev=0。サーバーは現 rev と一致しない行を全て conflicts で返し、パッチ全体を適用しない。
//   成功時、変更行の rev はサーバーが採番（現 rev + 1、新規は 1）し newRevs で返す。
//   updatedBy はサーバーが認証ユーザーの email で上書きする。
//   適用後の全体を validateDoc（スキーマ＋DAG・参照整合）で検証し、不正なら 422（適用しない）。
// 共有範囲: tasks / dependencies / project(name, description, dataDate, calendarId) / calendars / savedViews。
//   project・calendars・savedViews は変更があった時だけ送る（後勝ち）。viewState はユーザー個人ごとに保存。
// 変更通知（§7.2 L2）: クライアントは changes?since=version をポーリングし、他者の変更を取り込む。
// ============================================================================
import type { Calendar, Dependency, GraphDoc, ProjectMeta, SavedView, Task } from '../domain';

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface ApiError {
  error: { code: string; message: string; details?: string[] };
}

export interface MeResponse {
  userId: string;
  email: string; // 小文字化済み。メンバー招待の照合キー
  name: string;
}

export interface ProjectSummary extends ProjectMeta {
  role: ProjectRole;
  taskCount: number;
}

export interface GraphResponse {
  doc: GraphDoc; // 各行の rev はサーバー rev。viewState は呼び出しユーザー個人のもの
  role: ProjectRole;
}

export interface SaveGraphResponse {
  version: number;
  role: ProjectRole;
}

export interface PatchOkResponse {
  ok: true;
  version: number;
  newRevs: Record<string, number>; // 行ID → 新 rev（task/dep 共通。ID は UUID で衝突しない）
}

export interface PatchConflict {
  entity: 'task' | 'dep';
  id: string;
  baseRev: number;
  serverRev: number; // サーバー側で削除済みなら 0
  serverRow: Task | Dependency | null; // サーバー側で削除済みなら null
}

export interface PatchConflictResponse {
  ok: false;
  conflicts: PatchConflict[];
}

export interface ChangesResponse {
  version: number; // 現在のプロジェクト版数（次回の since に使う）
  tasks: Task[]; // since より後に変更された行（作成含む）
  dependencies: Dependency[];
  deletedTaskIds: string[];
  deletedDepIds: string[];
  project?: ProjectMeta; // since より後に変更があった時だけ
  calendars?: Calendar[];
  savedViews?: SavedView[];
}

export interface DuplicateRequest {
  newName: string;
}

export interface Member {
  email: string;
  role: ProjectRole;
  name: string | null; // 一度もログインしていない招待者は null
  addedAt: string;
}

export interface MemberUpsertRequest {
  email: string;
  role: ProjectRole;
}
