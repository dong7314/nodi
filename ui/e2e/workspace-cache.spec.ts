import { expect, test, type Page } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace } from "./workspace-fixture";

async function openCacheModulePage(page: Page) {
  await page.route("**/cache-quota-test", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>Workspace cache quota regression</title>",
  }));
  await page.goto("/cache-quota-test");
}

for (const existingBackup of [false, true]) {
  test(`workspace switch preserves unsaved data at storage quota (${existingBackup ? "existing backup" : "first backup"})`, async ({ page }) => {
    // Import only the cache module so application initialization cannot mutate
    // the storage fixture. The browser's actual quota supplies the failure.
    await openCacheModulePage(page);
    const result = await page.evaluate(async ({ existingBackup }) => {
      const { activateWorkspaceCache } = await import(/* @vite-ignore */ "/src/workspace-cache.ts");
      localStorage.clear();
      const ownerKey = "nodi:workspace-owner";
      const draftKey = "nodi:page-draft:alice:page";
      const backupKey = "nodi:workspace-cache:alice";
      const oldBackup = existingBackup ? JSON.stringify({ [draftKey]: "Old saved draft" }) : null;
      const latestDraft = `Unsaved latest edit ${"x".repeat(2 * 1024 * 1024)}`;
      const pages = JSON.stringify({
        "quick-note": { ownerId: "alice" },
        page: { title: "Private page", content: "p".repeat(1024 * 1024) },
      });
      localStorage.setItem(ownerKey, "alice");
      if (oldBackup) localStorage.setItem(backupKey, oldBackup);
      localStorage.setItem(draftKey, latestDraft);
      localStorage.setItem("nodi:pages", pages);
      let quotaReached = false;
      try {
        // The supported engines normally allow roughly 5–10 MiB. Bound the
        // loop so a browser with an unexpected quota cannot allocate forever.
        for (let index = 0; index < 512; index += 1) {
          localStorage.setItem(`quota-filler-${index}`, "f".repeat(64 * 1024));
        }
      } catch (error) {
        quotaReached = error instanceof DOMException && error.name === "QuotaExceededError";
      }
      let changedEvents = 0;
      window.addEventListener("nodi:pages-changed", () => { changedEvents += 1; });
      let switchRejected = false;
      try {
        activateWorkspaceCache(null);
      } catch {
        switchRejected = true;
      }
      return {
        quotaReached,
        switchRejected,
        draftPreserved: localStorage.getItem(draftKey) === latestDraft,
        pagesPreserved: localStorage.getItem("nodi:pages") === pages,
        owner: localStorage.getItem(ownerKey),
        oldBackupPreserved: localStorage.getItem(backupKey) === oldBackup,
        changedEvents,
      };
    }, { existingBackup });
    expect(result.quotaReached).toBe(true);
    expect(result.switchRejected).toBe(true);
    expect(result.draftPreserved).toBe(true);
    expect(result.pagesPreserved).toBe(true);
    expect(result.owner).toBe("alice");
    expect(result.oldBackupPreserved).toBe(true);
    expect(result.changedEvents).toBe(0);
  });
}

test("failed restore rolls back partial writes and preserves the archived account", async ({ page }) => {
  await openCacheModulePage(page);
  const result = await page.evaluate(async () => {
    const { activateWorkspaceCache } = await import(/* @vite-ignore */ "/src/workspace-cache.ts");
    localStorage.clear();
    const guestPages = JSON.stringify({ guest: { title: "Guest note", blocks: [] } });
    const guestDraft = "Guest unsaved draft";
    const archive = JSON.stringify({
      "nodi:pages": JSON.stringify({ alice: { title: "Alice private note", ownerId: "alice", blocks: [] } }),
      "nodi:page-draft:alice:page": "Alice unsaved draft",
    });
    localStorage.setItem("nodi:pages", guestPages);
    localStorage.setItem("nodi:page-draft:guest:page", guestDraft);
    localStorage.setItem("nodi:workspace-cache:alice", archive);
    localStorage.setItem("nodi:guest-workspace-migrated:alice:v1", "done");
    const setItem = Storage.prototype.setItem;
    let injectedFailure = false;
    let writtenBeforeFailure = 0;
    let changedEvents = 0;
    window.addEventListener("nodi:pages-changed", () => { changedEvents += 1; });
    // A deterministic one-shot storage error exercises the middle of the
    // restore, after old keys are removed and some new keys have been written.
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key === "nodi:page-draft:alice:page" && !injectedFailure) {
        injectedFailure = true;
        throw new DOMException("Restore interrupted", "QuotaExceededError");
      }
      if (!injectedFailure) writtenBeforeFailure += 1;
      return setItem.call(this, key, value);
    };
    let rejected = false;
    try { activateWorkspaceCache("alice"); } catch { rejected = true; }
    finally { Storage.prototype.setItem = setItem; }
    return {
      rejected, injectedFailure, writtenBeforeFailure, changedEvents,
      originalOwner: localStorage.getItem("nodi:workspace-owner"),
      guestPagesPreserved: localStorage.getItem("nodi:pages") === guestPages,
      guestDraftPreserved: localStorage.getItem("nodi:page-draft:guest:page") === guestDraft,
      archivePreserved: localStorage.getItem("nodi:workspace-cache:alice") === archive,
      aliceDraft: localStorage.getItem("nodi:page-draft:alice:page"),
      migrationFlag: localStorage.getItem("nodi:guest-workspace-migrated:alice:v1"),
    };
  });
  expect(result.rejected).toBe(true);
  expect(result.injectedFailure).toBe(true);
  expect(result.writtenBeforeFailure).toBeGreaterThan(0);
  expect(result.changedEvents).toBe(0);
  expect(result.originalOwner).toBeNull();
  expect(result.guestPagesPreserved).toBe(true);
  expect(result.guestDraftPreserved).toBe(true);
  expect(result.archivePreserved).toBe(true);
  expect(result.aliceDraft).toBeNull();
  expect(result.migrationFlag).toBe("done");
});

test("restore reclaims the archived copy and succeeds without double storage capacity", async ({ page }) => {
  await openCacheModulePage(page);
  const result = await page.evaluate(async () => {
    const { activateWorkspaceCache } = await import(/* @vite-ignore */ "/src/workspace-cache.ts");
    localStorage.clear();
    const pages = JSON.stringify({ alice: { title: "Alice private note", ownerId: "alice", blocks: [] } });
    const draft = `Archived unsaved draft ${"x".repeat(2 * 1024 * 1024)}`;
    localStorage.setItem("nodi:workspace-owner", "guest");
    localStorage.setItem("nodi:workspace-cache:alice", JSON.stringify({
      "nodi:pages": pages,
      "nodi:page-draft:alice:page": draft,
    }));
    let quotaReached = false;
    try {
      for (let index = 0; index < 512; index += 1) localStorage.setItem(`quota-filler-${index}`, "f".repeat(64 * 1024));
    } catch (error) { quotaReached = error instanceof DOMException && error.name === "QuotaExceededError"; }
    const usedCharacters = () => Object.keys(localStorage).reduce((sum, key) => sum + key.length + localStorage.getItem(key)!.length, 0);
    const before = usedCharacters();
    activateWorkspaceCache("alice");
    return {
      quotaReached,
      owner: localStorage.getItem("nodi:workspace-owner"),
      draftRestored: localStorage.getItem("nodi:page-draft:alice:page") === draft,
      pagesRestored: localStorage.getItem("nodi:pages") === pages,
      backup: localStorage.getItem("nodi:workspace-cache:alice"),
      reclaimedSpace: usedCharacters() < before,
    };
  });
  expect(result.quotaReached).toBe(true);
  expect(result.owner).toBe("alice");
  expect(result.draftRestored).toBe(true);
  expect(result.pagesRestored).toBe(true);
  expect(result.backup).toBeNull();
  expect(result.reclaimedSpace).toBe(true);
});

test("logout does not revoke the server session when its cache preflight fails", async ({ page }) => {
  await openCacheModulePage(page);
  const logoutRequests: string[] = [];
  await page.route("**/api/auth/logout", async (route) => {
    logoutRequests.push(route.request().method());
    await route.fulfill({ status: 204 });
  });
  const result = await page.evaluate(async () => {
    const { logoutLocalAccount } = await import(/* @vite-ignore */ "/src/account-store.ts");
    localStorage.clear();
    const session = JSON.stringify({ userId: "alice" });
    const draft = `Unsaved latest edit ${"x".repeat(3 * 1024 * 1024)}`;
    localStorage.setItem("nodi:workspace-owner", "alice");
    localStorage.setItem("nodi:auth:session", session);
    localStorage.setItem("nodi:page-draft:alice:page", draft);
    let quotaReached = false;
    try {
      for (let index = 0; index < 512; index += 1) localStorage.setItem(`quota-filler-${index}`, "f".repeat(64 * 1024));
    } catch (error) { quotaReached = error instanceof DOMException && error.name === "QuotaExceededError"; }
    let rejected = false;
    try { await logoutLocalAccount(); } catch { rejected = true; }
    return {
      quotaReached, rejected,
      owner: localStorage.getItem("nodi:workspace-owner"),
      sessionPreserved: localStorage.getItem("nodi:auth:session") === session,
      draftPreserved: localStorage.getItem("nodi:page-draft:alice:page") === draft,
      signedOut: localStorage.getItem("nodi:auth:signed-out"),
    };
  });
  expect(result.quotaReached).toBe(true);
  expect(result.rejected).toBe(true);
  expect(logoutRequests).toEqual([]);
  expect(result.owner).toBe("alice");
  expect(result.sessionPreserved).toBe(true);
  expect(result.draftPreserved).toBe(true);
  expect(result.signedOut).toBeNull();
});

test("the app keeps an unauthenticated private workspace hidden when isolation hits quota", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    const pages = JSON.stringify({
      "quick-note": { ownerId: "alice", title: "PRIVATE QUOTA HOME", blocks: [] },
      secret: { ownerId: "alice", title: "PRIVATE QUOTA DOCUMENT", blocks: [{ type: "paragraph", content: "PRIVATE QUOTA CONTENT" }] },
    });
    const draft = `Unsaved latest edit ${"x".repeat(3 * 1024 * 1024)}`;
    localStorage.setItem("nodi:workspace-owner", "alice");
    localStorage.setItem("nodi:pages", pages);
    localStorage.setItem("nodi:page-draft:alice:secret", draft);
    // The local session is absent, as after expiration or external logout.
    // Bootstrap must isolate the old owner's data before mounting any editor.
    let quotaReached = false;
    try {
      for (let index = 0; index < 512; index += 1) localStorage.setItem(`quota-filler-${index}`, "f".repeat(64 * 1024));
    } catch (error) { quotaReached = error instanceof DOMException && error.name === "QuotaExceededError"; }
    (window as unknown as { quotaFixture: unknown }).quotaFixture = { pages, draft, quotaReached };
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: { code: "INVALID_SESSION", message: "Expired" } } }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("작업 공간을 안전하게 전환하지 못했어요");
  await expect(page.getByRole("alert")).toContainText("저장 공간이 부족");
  await expect(page.locator(".bn-editor")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("PRIVATE QUOTA");
  const preserved = await page.evaluate(() => {
    const fixture = (window as unknown as { quotaFixture: { pages: string; draft: string; quotaReached: boolean } }).quotaFixture;
    return {
      quotaReached: fixture.quotaReached,
      pages: localStorage.getItem("nodi:pages") === fixture.pages,
      draft: localStorage.getItem("nodi:page-draft:alice:secret") === fixture.draft,
      owner: localStorage.getItem("nodi:workspace-owner"),
      archive: localStorage.getItem("nodi:workspace-cache:alice"),
    };
  });
  expect(preserved.quotaReached).toBe(true);
  expect(preserved.pages).toBe(true);
  expect(preserved.draft).toBe(true);
  expect(preserved.owner).toBe("alice");
  expect(preserved.archive).toBeNull();
});

test("logout keeps the latest editor content when only the page cache cannot be written", async ({ page }) => {
  const server = await mockWorkspace(page);
  const logoutRequests: string[] = [];
  await page.route("**/api/auth/logout", async (route) => {
    logoutRequests.push(route.request().method());
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/pages/page-1", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({ status: 503, json: { error: { code: "SERVER_BUSY", message: "Server save temporarily unavailable" } } });
  });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key === "nodi:pages") {
        throw new DOMException("페이지 캐시 저장 공간 부족", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  const latest = "LATEST MEMORY EDIT BEFORE LOGOUT";
  await editDocument(page, latest);
  await expect(documentEditor(page)).toContainText(latest);
  // The active document is newer than the disk cache. Other keys, including
  // account backups, remain writable so this specifically tests the final
  // page-cache persistence guard rather than the backup quota guard.
  const cacheBefore = await page.evaluate(() => localStorage.getItem("nodi:pages"));
  expect(cacheBefore).not.toContain(latest);
  expect(JSON.stringify(server.pages["page-1"].blocks)).not.toContain(latest);
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
  // The pending 503 save may replace the temporary quota toast. Verify the
  // completed logout attempt and persistent failure state instead of timing
  // an exact toast; the editable document and account must remain intact.
  await expect(page.getByRole("dialog", { name: "로그아웃", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("저장 실패");
  expect(logoutRequests).toEqual([]);
  await expect(documentEditor(page)).toContainText(latest);
  const stored = await page.evaluate(() => ({
    session: localStorage.getItem("nodi:auth:session"),
    signedOut: localStorage.getItem("nodi:auth:signed-out"),
    pages: localStorage.getItem("nodi:pages"),
  }));
  expect(stored.session).not.toBeNull();
  expect(stored.signedOut).not.toBe("true");
  expect(stored.pages).toBe(cacheBefore);
  expect(server.failures).toEqual([]);
});
