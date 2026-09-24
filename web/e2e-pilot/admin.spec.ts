import { expect, test, type Page } from "@playwright/test";

const FRONTEND = "http://127.0.0.1:5175";
const ADMIN_PASSWORD = "pilot-e2e-admin-password";
const ADMIN_TEMP_PASSWORD = "pilot-e2e-admin-password-temporary";
const WORKSPACES = ["Partner E2E Workspace", "Internal E2E Workspace"] as const;

type WorkspaceChoice = { id: string; name: string };
type LoginBody = { details?: { workspaces?: WorkspaceChoice[] } };

async function login(
  page: Page,
  username: string,
  password: string,
  workspace: string,
): Promise<void> {
  await page.goto("/");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("口令").fill(password);

  let responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /登录|进入所选工作区/ }).click();
  let response = await responsePromise;
  let body = (await response.json()) as LoginBody;
  if (response.status() === 409) {
    const choice = body.details?.workspaces?.find((item) => item.name === workspace);
    expect(choice, `missing workspace choice ${workspace}`).toBeTruthy();
    if (!choice) throw new Error(`missing workspace choice ${workspace}`);
    await page.getByLabel("工作区").selectOption(choice.id);
    responsePromise = page.waitForResponse((next) =>
      next.url().endsWith("/api/v1/auth/login") && next.request().method() === "POST",
    );
    await page.getByRole("button", { name: "进入所选工作区" }).click();
    response = await responsePromise;
    body = (await response.json()) as LoginBody;
  }
  expect(response.status(), JSON.stringify(body)).toBe(200);
}

async function attemptLogin(page: Page, username: string, password: string): Promise<number> {
  await page.goto("/");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("口令").fill(password);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录" }).click();
  return (await responsePromise).status();
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("heading", { name: "登录选品工作台" })).toBeVisible();
}

function workspaceMembership(page: Page, workspace: string) {
  return page.locator(".workspace-membership").filter({ hasText: workspace });
}

test.describe.serial("pilot account administration", () => {
  test("admin creates, edits, disables, reenables, and resets a contributor account", async ({ page }) => {
    test.setTimeout(180_000);
    const username = `pilot-admin-${Date.now()}`;
    const initialDisplayName = "Pilot E2E Managed User";
    const editedDisplayName = "Pilot E2E Managed User (edited)";

    await login(page, "admin", ADMIN_PASSWORD, WORKSPACES[0]);
    await expect(page.getByRole("link", { name: "账号管理" })).toBeVisible();
    await page.goto("/admin/accounts");
    await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();

    await page.getByRole("button", { name: "新建账号" }).click();
    await page.getByLabel("登录账号").fill(username);
    await page.getByLabel("显示名称").fill(initialDisplayName);
    for (const workspace of WORKSPACES) {
      await workspaceMembership(page, workspace).getByRole("checkbox").check();
      await page.getByLabel(`${workspace}业务角色`).selectOption("contributor");
    }
    await page.getByRole("button", { name: "创建账号" }).click();

    const credentials = page.locator(".admin-credentials");
    await expect(credentials).toContainText("新口令只显示这一次");
    const credentialText = await credentials.locator("code").innerText();
    const separator = credentialText.lastIndexOf(" / ");
    expect(separator).toBeGreaterThan(0);
    const initialPassword = credentialText.slice(separator + 3).trim();
    expect(initialPassword.length).toBeGreaterThan(11);
    await credentials.getByRole("button", { name: "关闭" }).click();
    await expect(credentials).toHaveCount(0);

    // Edit the display name through the same form, then preserve a clean view
    // for the requested desktop and narrow mobile visual checks.
    await page.getByLabel("显示名称").fill(editedDisplayName);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.locator(".admin-account-row").filter({ hasText: editedDisplayName })).toBeVisible();
    await page.screenshot({ path: "/private/tmp/product-res-admin-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/private/tmp/product-res-admin-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    await logout(page);
    await login(page, username, initialPassword, WORKSPACES[0]);
    await expect(page.getByRole("link", { name: "账号管理" })).toHaveCount(0);
    const workspaceSelect = page.getByRole("combobox", { name: "工作区", exact: true });
    await expect(workspaceSelect.locator("option")).toHaveCount(2);
    for (const workspace of WORKSPACES) await expect(workspaceSelect.locator("option", { hasText: workspace })).toHaveCount(1);
    const forbidden = await page.request.get(`${FRONTEND}/api/v1/admin/accounts`);
    expect(forbidden.status(), await forbidden.text()).toBe(403);

    await logout(page);
    await login(page, "admin", ADMIN_PASSWORD, WORKSPACES[0]);
    await page.goto("/admin/accounts");
    const row = page.locator(".admin-account-row").filter({ hasText: username });
    await row.click();
    await page.getByLabel("显示名称").fill(`${editedDisplayName} / role updated`);
    await page.getByLabel(`${WORKSPACES[0]}业务角色`).selectOption("decision");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByLabel(`${WORKSPACES[0]}业务角色`)).toHaveValue("decision");

    await page.getByLabel("账号状态").selectOption("inactive");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(row).toContainText("已停用");
    await page.getByLabel("账号状态").selectOption("active");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(row).toContainText("启用");

    await page.getByRole("button", { name: "重置口令" }).click();
    await page.getByRole("button", { name: "确认重置口令" }).click();
    await expect(credentials).toContainText("新口令只显示这一次");
    const resetCredentialText = await credentials.locator("code").innerText();
    const resetSeparator = resetCredentialText.lastIndexOf(" / ");
    expect(resetSeparator).toBeGreaterThan(0);
    const resetPassword = resetCredentialText.slice(resetSeparator + 3).trim();
    expect(resetPassword).not.toBe(initialPassword);
    await credentials.getByRole("button", { name: "关闭" }).click();

    await logout(page);
    expect(await attemptLogin(page, username, initialPassword)).toBe(401);
    await login(page, username, resetPassword, WORKSPACES[0]);
    await expect(page.getByRole("link", { name: "账号管理" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "工作区", exact: true }).locator("option")).toHaveCount(2);
    await logout(page);

    // Exercise the administrator self-service flow last, then restore the
    // shared pilot fixture password so later specs remain independent.
    await login(page, "admin", ADMIN_PASSWORD, WORKSPACES[0]);
    await expect(page.getByRole("link", { name: "修改密码" })).toBeVisible();
    await page.goto("/admin/password");
    await page.getByLabel("当前密码", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByLabel("新密码", { exact: true }).fill(ADMIN_TEMP_PASSWORD);
    await page.getByLabel("确认新密码", { exact: true }).fill(`${ADMIN_TEMP_PASSWORD}x`);
    await page.getByRole("button", { name: "修改密码" }).click();
    await expect(page.getByRole("alert")).toContainText("两次输入的新密码不一致");
    await page.getByLabel("确认新密码", { exact: true }).fill(ADMIN_TEMP_PASSWORD);
    await page.getByLabel("当前密码", { exact: true }).fill("wrong-administrator-password");
    await page.getByRole("button", { name: "修改密码" }).click();
    await expect(page.getByRole("alert")).toContainText(/当前密码错误/);
    await page.getByLabel("当前密码", { exact: true }).fill(ADMIN_PASSWORD);
    const changeResponse = page.waitForResponse(response => response.url().endsWith("/api/v1/admin/change-password") && response.request().method() === "POST");
    await page.getByRole("button", { name: "修改密码" }).click();
    expect((await changeResponse).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "登录选品工作台" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("密码已修改，请使用新密码重新登录");
    expect(await attemptLogin(page, "admin", ADMIN_PASSWORD)).toBe(401);
    await login(page, "admin", ADMIN_TEMP_PASSWORD, WORKSPACES[0]);
    await page.goto("/admin/password");
    await page.getByLabel("当前密码", { exact: true }).fill(ADMIN_TEMP_PASSWORD);
    await page.getByLabel("新密码", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByLabel("确认新密码", { exact: true }).fill(ADMIN_PASSWORD);
    const restoreResponse = page.waitForResponse(response => response.url().endsWith("/api/v1/admin/change-password") && response.request().method() === "POST");
    await page.getByRole("button", { name: "修改密码" }).click();
    expect((await restoreResponse).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "登录选品工作台" })).toBeVisible();
  });
});
