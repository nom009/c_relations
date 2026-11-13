import { useEffect, useState } from "react";
import { useApp } from "../../store/store";
import {
  AuthRequiredError,
  ForbiddenError,
  ServerValidationError,
  getApiRepository,
  redirectToLogin,
} from "../../storage/ApiRepository";
import type { Member, ProjectRole } from "../../storage/apiContract";
import { Dialog } from "./Dialog";

const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "所有者",
  editor: "編集者",
  viewer: "閲覧者",
};
const ROLES: ProjectRole[] = ["editor", "viewer", "owner"];

function messageOf(e: unknown): string {
  if (e instanceof AuthRequiredError) {
    redirectToLogin();
    return "ログインが必要です";
  }
  if (e instanceof ServerValidationError) return e.details[0] ?? e.message;
  if (e instanceof ForbiddenError) return "メンバーを管理できるのは所有者のみです";
  return "サーバーに接続できませんでした。時間をおいてやり直してください";
}

// サーバー版のみ: プロジェクトのメンバー一覧。所有者だけが追加・権限変更・削除できる。
export function MembersDialog({ onClose }: { onClose: () => void }) {
  const projectId = useApp((s) => s.project.id);
  const role = useApp((s) => s.role);
  const myEmail = useApp((s) => s.account?.email);
  const isOwner = role === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<ProjectRole>("editor");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getApiRepository()
      .listMembers(projectId)
      .then((m) => {
        if (!cancelled) setMembers(m);
      })
      .catch((e) => {
        if (!cancelled) setError(messageOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const run = async (op: () => Promise<Member[]>) => {
    setBusy(true);
    setError(null);
    try {
      setMembers(await op());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="メンバー"
      subtitle={
        isOwner
          ? "メールアドレスで招待します。招待された人はログイン後にこのプロジェクトを開けます。"
          : "このプロジェクトのメンバーです（管理できるのは所有者のみ）。"
      }
      onClose={onClose}
      className="members-dialog"
    >
      <div className="dialog-body" data-testid="members-dialog">
        {error && (
          <div className="form-error" role="alert" data-testid="members-error">
            {error}
          </div>
        )}
        {members === null && !error ? (
          <p>読み込み中…</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>メール</th>
                <th>名前</th>
                <th>権限</th>
                {isOwner && <th />}
              </tr>
            </thead>
            <tbody>
              {(members ?? []).map((m) => (
                <tr key={m.email} data-testid="member-row">
                  <td>{m.email}</td>
                  <td>{m.name ?? "（未ログイン）"}</td>
                  <td>
                    {isOwner ? (
                      <select
                        aria-label={m.email + " の権限"}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          void run(() =>
                            getApiRepository().upsertMember(projectId, {
                              email: m.email,
                              role: e.target.value as ProjectRole,
                            }),
                          )
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABEL[m.role]
                    )}
                  </td>
                  {isOwner && (
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          const self = m.email === myEmail;
                          if (
                            confirm(
                              self
                                ? "自分自身をメンバーから外しますか？"
                                : m.email + " をメンバーから外しますか？",
                            )
                          )
                            void run(() =>
                              getApiRepository().removeMember(projectId, m.email),
                            );
                        }}
                      >
                        外す
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {isOwner && (
          <form
            className="members-add"
            onSubmit={(e) => {
              e.preventDefault();
              const target = email.trim().toLowerCase();
              if (!target) return;
              void run(async () => {
                const list = await getApiRepository().upsertMember(projectId, {
                  email: target,
                  role: newRole,
                });
                setEmail("");
                return list;
              });
            }}
          >
            <input
              type="email"
              required
              data-autofocus
              data-testid="member-email"
              aria-label="招待するメールアドレス"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              aria-label="付与する権限"
              data-testid="member-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as ProjectRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="btn primary"
              data-testid="member-add"
              disabled={busy || !email.trim()}
            >
              追加
            </button>
          </form>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Dialog>
  );
}
