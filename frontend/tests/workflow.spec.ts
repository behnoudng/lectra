import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import path from "node:path";
import { readFile } from "node:fs/promises";
const fixture = path.resolve("../test/fixtures/lecture.wav");
const mixed =
  "خب، logical equivalence: اگر P → Q، آنگاه ¬P ∨ Q. مسیر /tmp/a (CS101) ۱۲۳ می‌خوایم";
async function importLecture(page: Page, title: string, course?: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "+ Import lecture", exact: true })
    .click();
  await page.getByLabel("Lecture title", { exact: true }).fill(title);
  if (course)
    await page
      .getByRole("combobox", { name: "Course", exact: true })
      .selectOption({ label: course });
  await page.getByLabel("Lecture recording").setInputFiles(fixture);
  await page
    .getByRole("button", { name: "Import recording", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(".lecture-detail h2")).toHaveText(title);
}
async function transcribe(page: Page) {
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  const title = await page.locator(".preparation h1").innerText();
  await page.getByRole("button", { name: "Review transcription →" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm and enqueue" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Confirm and enqueue" }).click();
  await expect(page.locator(".job").filter({ hasText: title })).toContainText(
    "succeeded",
    {
      timeout: 20000,
    },
  );
}
async function openEditor(page: Page, title: string) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.locator(".lecture-row").filter({ hasText: title }).click();
  await page
    .getByRole("button", { name: "Open transcript", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Transcript passage" }).first(),
  ).toBeVisible();
}
async function latest(request: APIRequestContext, title: string) {
  const lectures = await (await request.get("/api/v1/lectures")).json();
  return lectures.find((l: { title: string }) => l.title === title) as {
    id: string;
    transcript_id: string;
    media: { kind: string; sha256: string }[];
  };
}

test("complete upload, cuts, preflight, transcription, edits, search, export, backup, deletion", async ({
  page,
  request,
}) => {
  await importLecture(page, "Persian logic");
  const before = await latest(request, "Persian logic");
  const originalHash = before.media.find((m) => m.kind === "original")!.sha256;
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await page.getByLabel("Selection start").fill("1");
  await page.getByLabel("Selection end").fill("2");
  await page.getByRole("button", { name: /Cut selection/ }).click();
  await page.getByLabel("Selection start").fill("4");
  await page.getByLabel("Selection end").fill("5");
  await page.getByRole("button", { name: /Cut selection/ }).click();
  await expect(page.locator(".ranges li")).toHaveCount(3);
  await page.getByRole("button", { name: "Undo cut" }).click();
  await expect(page.locator(".ranges li")).toHaveCount(2);
  await page.getByRole("button", { name: "Redo cut" }).click();
  await expect(page.locator(".ranges li")).toHaveCount(3);
  await page.getByLabel("Use enhanced audio for transcription").check();
  await page
    .getByRole("button", { name: "Build clean / enhanced A/B preview" })
    .click();
  await expect(page.locator(".ab-preview audio")).toBeVisible();
  await page.getByRole("button", { name: "Enhanced", exact: true }).click();
  await page.getByLabel("Use enhanced audio for transcription").uncheck();
  await page.getByRole("button", { name: "Review transcription →" }).click();
  await expect(page.locator(".cost-review h2")).toHaveText("Unknown");
  await page.getByRole("button", { name: "Confirm and enqueue" }).click();
  await expect(
    page.locator(".job").filter({ hasText: "Persian logic" }),
  ).toContainText("succeeded");
  await openEditor(page, "Persian logic");
  const passage = page
    .getByRole("textbox", { name: "Transcript passage" })
    .first();
  await passage.fill(mixed);
  await expect(page.locator(".save-status")).toContainText("Saved");
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await expect(passage).toHaveText(mixed);
  await page
    .getByLabel("Text direction", { exact: true })
    .first()
    .selectOption("rtl");
  await expect(page.locator(".save-status")).toContainText("Saved");
  await page.getByRole("button", { name: "Audio-synced" }).click();
  await expect(page.locator(".alignment").first()).toHaveText(
    "Edited · broad anchor",
  );
  const after = await latest(request, "Persian logic");
  expect(after.media.find((m) => m.kind === "original")!.sha256).toBe(
    originalHash,
  );
  const t = await (
    await request.get("/api/v1/transcripts/" + after.transcript_id)
  ).json();
  expect(t.blocks[0].text).toBe(mixed);
  const exported = await request.get(
    "/api/v1/lectures/" + after.id + "/export?format=md&timestamps=true",
  );
  expect(await exported.text()).toContain(mixed);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search lectures and transcripts").fill("logical");
  await expect(page.locator(".search-results>button").first()).toBeVisible();
  await page.locator(".search-results>button").first().click();
  await expect(passage).toHaveText(mixed);
  await page.getByRole("button", { name: "Backups", exact: true }).click();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.locator(".snapshot-list article")).toHaveCount(1);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("verified");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search lectures and transcripts").fill("");
  await page
    .locator(".lecture-row")
    .filter({ hasText: "Persian logic" })
    .click();
  await page
    .getByText("Storage and original recording", { exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete original audio", exact: true })
    .click();
  await expect(page.locator(".lecture-detail")).toContainText("Unavailable");
  await page
    .getByRole("button", { name: "Open transcript", exact: true })
    .click();
  await expect(passage).toHaveText(mixed);
  const vendor = await (
    await request.get("http://127.0.0.1:8121/test/stats")
  ).json();
  expect(vendor.posts).toBe(1);
  expect(vendor.max_active).toBe(1);
});

test("course defaults, vocabulary, theme and responsive navigation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Course", exact: true }).click();
  await page
    .getByLabel("Course name", { exact: true })
    .fill("Computational logic");
  await page
    .getByLabel("Reusable vocabulary, one term per line")
    .fill("logical equivalence\nهم‌ارزی");
  await page.getByLabel("Default language").selectOption("fas");
  await page.getByRole("button", { name: "Save course", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(".course-strip")).toContainText("2 keyterms");
  await importLecture(page, "Preset review", "Computational logic");
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await page.getByRole("button", { name: "Review transcription →" }).click();
  await expect(
    page.getByRole("combobox", { name: "Language", exact: true }),
  ).toHaveValue("fas");
  await expect(page.getByLabel("Keyterms, one per line")).toContainText(
    "logical equivalence",
  );
  await expect(page.getByLabel(/Use reviewed keyterms/)).toBeChecked();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "☀ Light mode", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Local by design" }),
  ).toBeVisible();
  expect(await page.locator("input[type=password]").count()).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("stale tab returns conflict and retains draft", async ({
  page,
  context,
  request,
}) => {
  await importLecture(page, "Two tabs");
  await transcribe(page);
  await openEditor(page, "Two tabs");
  const second = await context.newPage();
  await second.goto("/");
  await second.locator(".lecture-row").filter({ hasText: "Two tabs" }).click();
  await second
    .getByRole("button", { name: "Open transcript", exact: true })
    .click();
  await expect(
    second.getByRole("textbox", { name: "Transcript passage" }).first(),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Server tab one");
  await expect(page.locator(".save-status")).toContainText("Saved");
  await second
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Draft tab two");
  await expect(
    second.getByRole("heading", {
      name: "Another tab or the worker saved a newer revision",
    }),
  ).toBeVisible();
  const l = await latest(request, "Two tabs");
  expect(
    (await (await request.get("/api/v1/transcripts/" + l.transcript_id)).json())
      .blocks[0].text,
  ).toBe("Server tab one");
  await second
    .getByRole("button", { name: "Save my reviewed draft as a new revision" })
    .click();
  await expect(second.locator(".save-status")).toContainText("Saved");
  expect(
    (await (await request.get("/api/v1/transcripts/" + l.transcript_id)).json())
      .blocks[0].text,
  ).toBe("Draft tab two");
  await second.close();
});

test("IndexedDB draft survives abrupt tab closure", async ({
  page,
  context,
}) => {
  await importLecture(page, "Crash draft");
  await transcribe(page);
  await openEditor(page, "Crash draft");
  await page.route("**/api/v1/transcripts/*", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await page
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Draft survives browser crash فارسی");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        return await new Promise<number>((resolve) => {
          const r = indexedDB.open("lectra-drafts", 1);
          r.onsuccess = () => {
            const q = r.result
              .transaction("drafts")
              .objectStore("drafts")
              .count();
            q.onsuccess = () => resolve(q.result);
          };
        });
      }),
    )
    .toBeGreaterThan(0);
  await page.close({ runBeforeUnload: false });
  const recovered = await context.newPage();
  await recovered.goto("/");
  await recovered
    .locator(".lecture-row")
    .filter({ hasText: "Crash draft" })
    .click();
  await recovered
    .getByRole("button", { name: "Open transcript", exact: true })
    .click();
  await expect(
    recovered.getByText("A browser draft is available", { exact: true }),
  ).toBeVisible();
  await recovered.getByRole("button", { name: "Recover local draft" }).click();
  await expect(
    recovered.getByRole("textbox", { name: "Transcript passage" }).first(),
  ).toHaveText("Draft survives browser crash فارسی");
  await expect(recovered.locator(".save-status")).toContainText("Saved");
});

test("unknown outcome pauses queue and requires explicit paid retry", async ({
  page,
  request,
}) => {
  const title = "Uncertain request";
  const initial = await (
    await request.get("http://127.0.0.1:8121/test/stats")
  ).json();
  await request.post("http://127.0.0.1:8121/test/mode", {
    data: { mode: "drop" },
  });
  await importLecture(page, title);
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await page.getByRole("button", { name: "Review transcription →" }).click();
  await page.getByRole("button", { name: "Confirm and enqueue" }).click();
  await expect(
    page.getByText("Billing outcome unknown", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1200);
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(initial.posts + 1);
  await page
    .getByRole("button", { name: "Review paid retry · chunk 1" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "retrying can charge you again",
  );
  await request.post("http://127.0.0.1:8121/test/mode", {
    data: { mode: "success" },
  });
  await page.getByRole("button", { name: "I accept the risk — retry" }).click();
  await page.getByRole("button", { name: "Resume queue" }).click();
  await expect(page.locator(".job").filter({ hasText: title })).toContainText(
    "succeeded",
  );
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(initial.posts + 2);
  const jobs = await (await request.get("/api/v1/queue")).json();
  const attempts = jobs.jobs.at(-1).attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1].retry_of_attempt_id).toBe(attempts[0].id);
});

test("rich formatting persists in both views and Markdown", async ({
  page,
  request,
}) => {
  await importLecture(page, "Rich document");
  await transcribe(page);
  await openEditor(page, "Rich document");
  const passage = page
    .getByRole("textbox", { name: "Transcript passage" })
    .first();
  await passage.fill("عنوان English math P → Q /tmp/code");
  await passage.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(passage.locator(".text-bold")).toContainText("English");
  await page.getByRole("button", { name: "Heading", exact: true }).click();
  await expect(passage.locator("h2")).toBeVisible();
  await expect(page.locator(".save-status")).toContainText("Saved");
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await expect(passage.locator("h2")).toBeVisible();
  const l = await latest(request, "Rich document");
  const out = await request.get(
    "/api/v1/lectures/" + l.id + "/export?format=md",
  );
  expect(await out.text()).toContain(
    "## **عنوان English math P → Q /tmp/code**",
  );
  expect(
    (await (await request.get("/api/v1/transcripts/" + l.transcript_id)).json())
      .blocks[0].text,
  ).toBe("عنوان English math P → Q /tmp/code");
});

test("browser restore preserves accounting and restores canonical content", async ({
  page,
  request,
}) => {
  const title = "Rich document";
  const l = await latest(request, title);
  const before = await (
    await request.get("/api/v1/transcripts/" + l.transcript_id)
  ).json();
  const ledger = await (await request.get("/api/v1/usage")).json();
  const snap = await (
    await request.post("/api/v1/backups", { data: { include_audio: true } })
  ).json();
  await page.goto("/");
  await openEditor(page, title);
  await page
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Edit after snapshot");
  await expect(page.locator(".save-status")).toContainText("Saved");
  await page.getByRole("button", { name: "Backups", exact: true }).click();
  const selected = page
    .locator(".snapshot-list article")
    .filter({ hasText: snap.id });
  await expect(selected).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await selected.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Restored. Queue remains paused.",
  );
  await openEditor(page, title);
  await expect(
    page.getByRole("textbox", { name: "Transcript passage" }).first(),
  ).toHaveText(before.blocks[0].text);
  expect(await (await request.get("/api/v1/usage")).json()).toEqual(ledger);
  const after = await (
    await request.get("/api/v1/transcripts/" + l.transcript_id)
  ).json();
  expect(after.revision).toBeGreaterThan(before.revision);
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  const posts = (
    await (await request.get("http://127.0.0.1:8121/test/stats")).json()
  ).posts;
  await page.getByRole("button", { name: "Resume queue" }).click();
  await page.waitForTimeout(500);
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(posts);
});

test("browser storage and UI contain no provider credential", async ({
  page,
  request,
}) => {
  const posts = (
    await (await request.get("http://127.0.0.1:8121/test/stats")).json()
  ).posts;
  await page.goto("/");
  await openEditor(page, "Rich document");
  const passage = page
    .getByRole("textbox", { name: "Transcript passage" })
    .first();
  await passage.fill("Local draft without credentials فارسی");
  await expect(page.locator(".save-status")).toContainText("Saved");
  const stored = await page.evaluate(async () => {
    const drafts = await new Promise<unknown[]>((resolve) => {
      const r = indexedDB.open("lectra-drafts", 1);
      r.onsuccess = () => {
        const q = r.result.transaction("drafts").objectStore("drafts").getAll();
        q.onsuccess = () => resolve(q.result);
      };
    });
    return JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      drafts,
    });
  });
  expect(stored).not.toContain("lectra-e2e-environment-sentinel");
  expect(await page.locator("body").innerText()).not.toContain(
    "lectra-e2e-environment-sentinel",
  );
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(posts);
});

test("unavailable IndexedDB still loads the editor and saves to the server", async ({
  page,
  request,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("Storage denied", "SecurityError");
      },
    }),
  );
  await importLecture(page, "Unavailable browser storage");
  await transcribe(page);
  await openEditor(page, "Unavailable browser storage");
  await expect(page.getByRole("alert")).toContainText(
    "Browser draft storage is unavailable",
  );
  await page
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Server save without IndexedDB فارسی");
  await expect(page.locator(".save-status")).toContainText("Saved");
  const l = await latest(request, "Unavailable browser storage");
  expect(
    (await (await request.get("/api/v1/transcripts/" + l.transcript_id)).json())
      .blocks[0].text,
  ).toBe("Server save without IndexedDB فارسی");
});

test("two unsaved tabs retain independent recoverable drafts", async ({
  page,
  context,
  request,
}) => {
  const title = "Independent tab drafts";
  await importLecture(page, title);
  await transcribe(page);
  await openEditor(page, title);
  const second = await context.newPage();
  await second.goto("/");
  await openEditor(second, title);
  for (const tab of [page, second]) {
    await tab.route("**/api/v1/transcripts/*", (route) =>
      route.request().method() === "PATCH" ? route.abort() : route.continue(),
    );
  }
  await page
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Independent tab one draft");
  await second
    .getByRole("textbox", { name: "Transcript passage" })
    .first()
    .fill("Independent tab two draft");
  const l = await latest(request, title);
  await expect
    .poll(() =>
      second.evaluate(async (id) => {
        return new Promise<number>((resolve) => {
          const r = indexedDB.open("lectra-drafts", 1);
          r.onsuccess = () => {
            const q = r.result
              .transaction("drafts")
              .objectStore("drafts")
              .getAll();
            q.onsuccess = () =>
              resolve(q.result.filter((d) => d.transcript_id === id).length);
          };
        });
      }, l.transcript_id),
    )
    .toBe(2);
  await page.close({ runBeforeUnload: false });
  await second.close({ runBeforeUnload: false });
  const recovered = await context.newPage();
  await recovered.goto("/");
  await openEditor(recovered, title);
  const choices = recovered.getByLabel("Choose a browser draft");
  const value = await choices
    .locator("option")
    .filter({ hasText: "Independent tab one draft" })
    .getAttribute("value");
  await choices.selectOption(value!);
  await recovered.getByRole("button", { name: "Recover local draft" }).click();
  await expect(recovered.locator(".save-status")).toContainText("Saved");
  await expect(
    recovered.getByRole("textbox", { name: "Transcript passage" }).first(),
  ).toHaveText("Independent tab one draft");
  expect(
    await recovered.evaluate(
      async (id) =>
        new Promise<boolean>((resolve) => {
          const r = indexedDB.open("lectra-drafts", 1);
          r.onsuccess = () => {
            const q = r.result
              .transaction("drafts")
              .objectStore("drafts")
              .getAll();
            q.onsuccess = () =>
              resolve(
                q.result.some(
                  (d) =>
                    d.transcript_id === id &&
                    d.blocks[0].text === "Independent tab two draft",
                ),
              );
          };
        }),
      l.transcript_id,
    ),
  ).toBe(true);
});

test("adding an empty paragraph autosaves and immediate export includes pending edits", async ({
  page,
  request,
}) => {
  const title = "Paragraph autosave and export";
  await importLecture(page, title);
  await transcribe(page);
  await openEditor(page, title);
  const l = await latest(request, title);
  const before = await (
    await request.get("/api/v1/transcripts/" + l.transcript_id)
  ).json();
  await page
    .getByRole("button", { name: "+ Add paragraph", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get("/api/v1/transcripts/" + l.transcript_id)
          ).json()
        ).blocks.length,
    )
    .toBe(before.blocks.length + 1);
  await page.route("**/api/v1/transcripts/*", async (route) => {
    if (route.request().method() === "PATCH")
      await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Transcript passage" })
    .last()
    .fill("Newest pending export فارسی");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export TXT", exact: true }).click();
  const file = await downloaded;
  expect(await readFile((await file.path())!, "utf8")).toContain(
    "Newest pending export فارسی",
  );
  await expect(page.locator(".save-status")).toContainText("Saved");
});

test("formatting-only revision restore updates the visible editor", async ({
  page,
  request,
}) => {
  const title = "Formatting revision restore";
  await importLecture(page, title);
  await transcribe(page);
  await openEditor(page, title);
  const passage = page
    .getByRole("textbox", { name: "Transcript passage" })
    .first();
  await passage.fill("Same canonical text فارسی");
  await expect(page.locator(".save-status")).toContainText("Saved");
  const l = await latest(request, title);
  const original = await (
    await request.get("/api/v1/transcripts/" + l.transcript_id)
  ).json();
  await passage.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(passage.locator(".text-bold")).toBeVisible();
  await expect(page.locator(".save-status")).toContainText("Saved");
  await page
    .getByRole("button", { name: "Revision history", exact: true })
    .click();
  const revision = page
    .locator(".revision-list>div")
    .filter({ hasText: "Revision " + original.revision + " ·" });
  page.once("dialog", (dialog) => dialog.accept());
  await revision
    .getByRole("button", { name: "Restore as new revision" })
    .click();
  await expect(passage.locator(".text-bold")).toHaveCount(0);
  await expect(passage).toHaveText("Same canonical text فارسی");
});

test("configured shortcuts and independent skip distances work", async ({
  page,
  request,
}) => {
  const title = "Configured shortcuts fixture";
  await importLecture(page, title);
  await transcribe(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Skip backward (seconds)", { exact: true }).fill("1");
  await page.getByLabel("Skip forward (seconds)", { exact: true }).fill("2");
  await page
    .getByLabel("Play / pause shortcut", { exact: true })
    .selectOption("Alt+P");
  await page
    .getByLabel("Skip backward shortcut", { exact: true })
    .selectOption("Alt+J");
  await page
    .getByLabel("Skip forward shortcut", { exact: true })
    .selectOption("Alt+L");
  await page
    .getByLabel("Shortcut help key", { exact: true })
    .selectOption("Alt+H");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Settings saved");
  expect(
    (await (await request.get("/api/v1/settings")).json()).shortcuts.forward,
  ).toBe("Alt+L");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await openEditor(page, title);
  await expect
    .poll(() =>
      page
        .locator(".editor audio")
        .evaluate((el) => (el as HTMLAudioElement).readyState),
    )
    .toBeGreaterThan(0);
  await page.keyboard.press("Alt+h");
  await expect(page.locator(".editor .notice").last()).toContainText(
    "Alt+J / Alt+L",
  );
  await page.keyboard.press("Alt+l");
  await expect
    .poll(() =>
      page
        .locator(".editor audio")
        .evaluate((el) => (el as HTMLAudioElement).currentTime),
    )
    .toBeCloseTo(2, 0);
  await page.keyboard.press("Alt+j");
  await expect
    .poll(() =>
      page
        .locator(".editor audio")
        .evaluate((el) => (el as HTMLAudioElement).currentTime),
    )
    .toBeCloseTo(1, 0);
});

test("a changed price requires a fresh preflight confirmation before sending audio", async ({
  page,
  request,
}) => {
  const title = "Fresh price review";
  await importLecture(page, title);
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await page.getByRole("button", { name: "Review transcription →" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm and enqueue" }),
  ).toBeEnabled();
  const initial = (
    await (await request.get("http://127.0.0.1:8121/test/stats")).json()
  ).posts;
  expect(
    (
      await request.post("/api/v1/pricing", {
        data: {
          effective_from: "2026-01-01",
          currency: "USD",
          base_micros_per_hour: 2000000,
          source_note: "Test-only revised price",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "Confirm and enqueue" }).click();
  await expect(page.getByRole("alert")).toContainText("pricing changed");
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(initial);
  await expect(page.locator(".cost-review")).toContainText(
    "Test-only revised price",
  );
  await expect(
    page.getByRole("button", { name: "Confirm and enqueue" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Confirm and enqueue" }).click();
  await expect(page.locator(".job").filter({ hasText: title })).toContainText(
    "succeeded",
  );
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(initial + 1);
});

test("Speech-to-Text-only keys keep account checks optional and never test with paid audio", async ({
  page,
  request,
}) => {
  const initial = (
    await (await request.get("http://127.0.0.1:8121/test/stats")).json()
  ).posts;
  await request.post("http://127.0.0.1:8121/test/mode", {
    data: { account_mode: "restricted" },
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "optional account check requires User",
    );
    await expect(page.locator(".settings")).toContainText(
      "Credential loaded: Yes",
    );
    await expect(page.locator(".settings")).toContainText("Status: Restricted");
    expect(await page.locator("body").innerText()).not.toContain(
      "lectra-e2e-environment-sentinel",
    );
    expect(
      (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
        .posts,
    ).toBe(initial);
    const title = "Restricted account permission fixture";
    await importLecture(page, title);
    await page
      .getByRole("button", { name: "Prepare audio →", exact: true })
      .click();
    await page.getByRole("button", { name: "Review transcription →" }).click();
    await page
      .getByRole("button", { name: "Check account status", exact: true })
      .click();
    await expect(page.locator(".cost-review")).toContainText(
      "optional account check requires User",
    );
    expect(
      (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
        .posts,
    ).toBe(initial);
    await expect(
      page.getByRole("button", { name: "Confirm and enqueue" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Confirm and enqueue" }).click();
    await expect(page.locator(".job").filter({ hasText: title })).toContainText(
      "succeeded",
    );
    expect(
      (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
        .posts,
    ).toBe(initial + 1);
  } finally {
    await request.post("http://127.0.0.1:8121/test/mode", {
      data: { account_mode: "connected" },
    });
  }
});
