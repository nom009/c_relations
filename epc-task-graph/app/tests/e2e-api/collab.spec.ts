import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

// サーバー版の共同編集 E2E（playwright.api.config.ts）。
// 開発サーバーは x-ms-client-principal ヘッダーを信頼するので、ユーザーごとのコンテキストに付与する。
// 開発サーバーのメモリストアは実行全体で共有されるため、テストごとに一意なユーザー（=メール）を使う。

const BASE = "http://localhost:4174";
const CUR_KEY = "epc-current-project";

interface User {
  email: string;
  headers: Record<string, string>;
}

function makeUser(tag: string): User {
  const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const email = `${tag}-${uniq}@example.com`;
  const principal = {
    identityProvider: "aad",
    userId: `u-${tag}-${uniq}`,
    userDetails: email,
    userRoles: ["anonymous", "authenticated"],
    claims: [{ typ: "name", val: tag }],
  };
  return {
    email,
    headers: {
      "x-ms-client-principal": Buffer.from(JSON.stringify(principal)).toString(
        "base64",
      ),
    },
  };
}

interface Session {
  ctx: BrowserContext;
  page: Page;
  user: User;
}

async function openApp(
  browser: Browser,
  user: User,
  projectId?: string,
): Promise<Session> {
  const ctx = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: user.headers,
  });
  if (projectId)
    await ctx.addInitScript(
      ([k, v]) => localStorage.setItem(k, v),
      [CUR_KEY, projectId],
    );
  const page = await ctx.newPage();
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__APP);
  await expect(page.getByTestId("savebadge")).toHaveText(/保存済み/);
  return { ctx, page, user };
}

const projectIdOf = (page: Page) =>
  page.evaluate(() => (window as any).__APP.getState().project.id as string);

const taskNames = (page: Page) =>
  page.evaluate(() =>
    (window as any).__APP.getState().tasks.map((t: any) => t.name as string),
  );

const nameOfTask = (page: Page, id: string) =>
  page.evaluate(
    (tid) =>
      (window as any).__APP.getState().tasks.find((t: any) => t.id === tid)
        ?.name as string | undefined,
    id,
  );

async function serverTaskNames(s: Session, projectId: string) {
  const res = await s.ctx.request.get(`${BASE}/api/projects/${projectId}/graph`, {
    headers: s.user.headers,
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return (body.doc.tasks as { name: string }[]).map((t) => t.name);
}

async function invite(
  owner: Session,
  projectId: string,
  email: string,
  role: "editor" | "viewer",
) {
  const res = await owner.ctx.request.put(
    `${BASE}/api/projects/${projectId}/members`,
    { headers: owner.user.headers, data: { email, role } },
  );
  expect(res.ok()).toBe(true);
}

const rename = (page: Page, id: string, name: string) =>
  page.evaluate(
    ([tid, n]) => (window as any).__APP.getState().updateTask(tid, { name: n }),
    [id, name],
  );

/** alice がタスクを1つ持つプロジェクトを作り、bob（編集者）が同じプロジェクトを開いた状態にする。 */
async function sharedSetup(browser: Browser) {
  const bobUser = makeUser("bob");
  const alice = await openApp(browser, makeUser("alice"));
  const projectId = await projectIdOf(alice.page);
  const taskId = await alice.page.evaluate(
    () =>
      (window as any).__APP
        .getState()
        .addTask({ name: "共有タスク" }, { edit: false }).id as string,
  );
  await expect
    .poll(() => serverTaskNames(alice, projectId))
    .toContain("共有タスク");
  await expect(alice.page.getByTestId("savebadge")).toHaveText(/保存済み/);
  await invite(alice, projectId, bobUser.email, "editor");
  const bob = await openApp(browser, bobUser, projectId);
  expect(await projectIdOf(bob.page)).toBe(projectId);
  await expect.poll(() => nameOfTask(bob.page, taskId)).toBe("共有タスク");
  return { alice, bob, projectId, taskId };
}

test("初回起動で所有者のプロジェクトが作られ、追加したタスクが保存される", async ({
  browser,
}) => {
  const alice = await openApp(browser, makeUser("alice"));
  const projectId = await projectIdOf(alice.page);
  expect(
    await alice.page.evaluate(() => (window as any).__APP.getState().role),
  ).toBe("owner");

  const list = await (
    await alice.ctx.request.get(`${BASE}/api/projects`, {
      headers: alice.user.headers,
    })
  ).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: projectId, role: "owner" });

  await alice.page.evaluate(() =>
    (window as any).__APP
      .getState()
      .addTask({ name: "保存確認タスク" }, { edit: false }),
  );
  await expect(alice.page.getByTestId("savebadge")).toHaveText(/保存済み/);
  await expect
    .poll(() => serverTaskNames(alice, projectId))
    .toContain("保存確認タスク");

  // リロードしてもサーバーから復元される
  await alice.page.reload();
  await alice.page.waitForFunction(() => !!(window as any).__APP);
  await expect.poll(() => taskNames(alice.page)).toContain("保存確認タスク");
  await alice.ctx.close();
});

test("メンバー画面から招待し、編集者の変更がポーリングで相手に届く", async ({
  browser,
}) => {
  const bobUser = makeUser("bob");
  const alice = await openApp(browser, makeUser("alice"));
  const projectId = await projectIdOf(alice.page);
  const taskId = await alice.page.evaluate(
    () =>
      (window as any).__APP
        .getState()
        .addTask({ name: "元の名前" }, { edit: false }).id as string,
  );
  await expect.poll(() => serverTaskNames(alice, projectId)).toContain("元の名前");

  await alice.page.getByTestId("actions-menu").click();
  await alice.page.getByRole("button", { name: "メンバー…" }).click();
  const dialog = alice.page.getByTestId("members-dialog");
  await dialog.getByTestId("member-email").fill(bobUser.email);
  await dialog.getByTestId("member-role").selectOption("editor");
  await dialog.getByTestId("member-add").click();
  await expect(
    dialog.getByTestId("member-row").filter({ hasText: bobUser.email }),
  ).toBeVisible();
  await alice.page.getByRole("button", { name: "閉じる", exact: true }).last().click();

  const bob = await openApp(browser, bobUser, projectId);
  await expect.poll(() => nameOfTask(bob.page, taskId)).toBe("元の名前");
  expect(
    await bob.page.evaluate(() => (window as any).__APP.getState().role),
  ).toBe("editor");

  await rename(bob.page, taskId, "bobが改名");
  await expect(bob.page.getByTestId("savebadge")).toHaveText(/保存済み/);

  // alice 側はポーリング（10秒間隔）で受け取る。
  await expect
    .poll(() => nameOfTask(alice.page, taskId), { timeout: 25_000 })
    .toBe("bobが改名");
  await expect(alice.page.getByTestId("savebadge")).toHaveText(/保存済み/);
  await alice.ctx.close();
  await bob.ctx.close();
});

test("同じタスクを同時に編集すると競合ダイアログが出て、相手の変更を採用できる", async ({
  browser,
}) => {
  const { alice, bob, projectId, taskId } = await sharedSetup(browser);
  // bob のポーリングを止め、alice の変更を知らないまま編集させる
  await bob.page.evaluate(() => (window as any).__SYNC.pause());

  await rename(alice.page, taskId, "aliceの変更");
  await expect
    .poll(() => serverTaskNames(alice, projectId))
    .toContain("aliceの変更");

  await rename(bob.page, taskId, "bobの変更");
  const dialog = bob.page.getByTestId("conflict-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(
    bob.page.getByText("他のメンバーが同じタスク/依存関係を変更しました"),
  ).toBeVisible();
  await expect(bob.page.getByTestId("savebadge")).toHaveText(/競合/);

  await bob.page.getByRole("button", { name: "相手の変更を採用" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => nameOfTask(bob.page, taskId)).toBe("aliceの変更");
  await expect(bob.page.getByTestId("savebadge")).toHaveText(/保存済み/);
  await alice.ctx.close();
  await bob.ctx.close();
});

test("競合で「自分の変更で上書き」を選ぶとサーバーに反映される", async ({
  browser,
}) => {
  const { alice, bob, projectId, taskId } = await sharedSetup(browser);
  await bob.page.evaluate(() => (window as any).__SYNC.pause());

  await rename(alice.page, taskId, "aliceの変更");
  await expect
    .poll(() => serverTaskNames(alice, projectId))
    .toContain("aliceの変更");

  await rename(bob.page, taskId, "bobの変更");
  await expect(bob.page.getByTestId("conflict-dialog")).toBeVisible({
    timeout: 15_000,
  });
  await bob.page.getByRole("button", { name: "自分の変更で上書き" }).click();
  await expect(bob.page.getByTestId("savebadge")).toHaveText(/保存済み/);
  await expect
    .poll(() => serverTaskNames(alice, projectId))
    .toContain("bobの変更");
  await alice.ctx.close();
  await bob.ctx.close();
});

test("閲覧者は「閲覧のみ」表示になり、編集してもサーバーに保存されない", async ({
  browser,
}) => {
  const alice = await openApp(browser, makeUser("alice"));
  const projectId = await projectIdOf(alice.page);
  await alice.page.evaluate(() =>
    (window as any).__APP
      .getState()
      .addTask({ name: "閲覧テスト" }, { edit: false }),
  );
  await expect
    .poll(() => serverTaskNames(alice, projectId))
    .toContain("閲覧テスト");

  const carolUser = makeUser("carol");
  await invite(alice, projectId, carolUser.email, "viewer");
  const carol = await openApp(browser, carolUser, projectId);

  await expect(carol.page.getByTestId("readonly-badge")).toHaveText("閲覧のみ");
  await expect.poll(() => taskNames(carol.page)).toContain("閲覧テスト");
  await expect(
    carol.page.getByRole("button", { name: "タスクを追加", exact: true }),
  ).toHaveCount(0);

  const before = (await taskNames(carol.page)).length;
  await carol.page.evaluate(() =>
    (window as any).__APP
      .getState()
      .addTask({ name: "閲覧者の追加" }, { edit: false }),
  );
  expect((await taskNames(carol.page)).length).toBe(before);
  await expect(carol.page.getByText("閲覧のみの権限です")).toBeVisible();

  // 少し待っても保存は走らず、サーバーにも反映されない
  await carol.page.waitForTimeout(1500);
  await expect(carol.page.getByTestId("savebadge")).toHaveText(/保存済み/);
  expect(await serverTaskNames(alice, projectId)).not.toContain("閲覧者の追加");
  await alice.ctx.close();
  await carol.ctx.close();
});
