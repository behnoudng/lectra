import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { chooseOption } from "./select";

async function course(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/courses", { data: { name } });
  expect(response.ok()).toBe(true);
  return (await response.json()).id as string;
}
async function lecture(
  request: APIRequestContext,
  title: string,
  course_id: string | null,
  tags: string[] = [],
) {
  const response = await request.post("/api/v1/lectures", {
    data: { title, course_id, tags, date: "2026-10-20" },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).id as string;
}

test("course chips, tags and Hide used filter both lectures and search", async ({
  page,
  request,
}) => {
  const alpha = await course(request, "Library Alpha");
  const beta = await course(request, "Library Beta");
  await course(request, "Library Empty");
  await lecture(request, "Library needle Alpha", alpha, ["shared"]);
  await lecture(request, "Library needle Beta", beta, ["shared"]);
  const used = await lecture(request, "Library needle Used", alpha, ["shared"]);
  await lecture(request, "Library needle Unfiled", null);
  await request.patch(`/api/v1/lectures/${used}/usage`, {
    data: { is_used: true },
  });
  await page.goto("/");
  const alphaChip = page
    .locator(".course-filter")
    .filter({ hasText: "Library Alpha" });
  const betaChip = page
    .locator(".course-filter")
    .filter({ hasText: "Library Beta" });
  await alphaChip.click();
  await expect(alphaChip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".lecture-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Edit course Library Alpha", exact: true })
    .click();
  await expect(page.getByLabel("Course name", { exact: true })).toHaveValue(
    "Library Alpha",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(alphaChip).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".lecture-select")
    .filter({ hasText: "Library needle Alpha" })
    .click();
  await expect(page.locator(".lecture-detail h2")).toHaveText(
    "Library needle Alpha",
  );
  await betaChip.click();
  await expect(page.locator(".lecture-detail")).not.toContainText(
    "Library needle Alpha",
  );
  await alphaChip.click();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Filter tag", exact: true }),
    "shared",
  );
  await page.getByLabel("Hide used", { exact: true }).check();
  await expect(page.locator(".lecture-row")).toHaveCount(1);
  await page
    .getByLabel("Search lectures and transcripts")
    .fill("Library needle");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await expect(page.locator(".search-result")).toContainText(
    "Library needle Alpha",
  );
  await betaChip.click();
  await expect(page.locator(".search-result")).toHaveCount(1);
  await expect(page.locator(".search-result")).toContainText(
    "Library needle Beta",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByLabel("Hide used", { exact: true })).toBeChecked();
  await expect(betaChip).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".course-filter")
    .filter({ hasText: "Library Empty" })
    .click();
  await expect(page.getByText(/No matching passages/)).toBeVisible();
  await page.getByLabel("Search lectures and transcripts").fill("");
  await expect(
    page.getByRole("heading", { name: "No matching lectures", exact: true }),
  ).toBeVisible();
  await page
    .locator(".empty")
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.locator(".course-filter").filter({ hasText: "Unfiled" }).click();
  await expect(page.locator(".lecture-row")).toHaveCount(1);
  await expect(page.locator(".lecture-row")).toContainText(
    "Library needle Unfiled",
  );
  await page.reload();
  await expect(page.getByLabel("Hide used", { exact: true })).not.toBeChecked();
  await expect(
    page.locator(".course-filter").filter({ hasText: "All courses" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Used marks are reversible, survive reload and polling, and keep failed saves unchanged", async ({
  page,
  request,
}) => {
  const title = "Usage menu recording";
  const id = await lecture(
    request,
    title,
    await course(request, "Usage menus"),
  );
  await page.goto("/");
  const row = page.locator(".lecture-row").filter({ hasText: title });
  const more = page.getByRole("button", {
    name: `More actions for ${title}`,
    exact: true,
  });
  await page.route(`**/api/v1/lectures/${id}/usage`, (route) =>
    route.fulfill({
      status: 500,
      json: {
        error: { category: "storage", message: "Mark could not be saved." },
      },
    }),
  );
  await row.locator(".lecture-select").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Mark as used", exact: true })
    .click();
  await expect(page.locator(".error-banner")).toContainText(
    "Mark could not be saved.",
  );
  await expect(row.locator(".used-badge")).toHaveCount(0);
  await page.unroute(`**/api/v1/lectures/${id}/usage`);

  // Hold an old poll response until after marking, to detect stale-state rewinds.
  const oldList = await (await request.get("/api/v1/lectures")).json();
  let beginPoll!: () => void, releasePoll!: () => void;
  const started = new Promise<void>((resolve) => {
    beginPoll = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let first = true;
  await page.route("**/api/v1/lectures", async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    beginPoll();
    await released;
    await route.fulfill({ json: oldList });
  });
  await started;
  await more.click();
  await page
    .getByRole("menuitem", { name: "Mark as used", exact: true })
    .click();
  await expect(row.locator(".used-badge")).toHaveText("Used");
  const staleResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/lectures") &&
      response.request().method() === "GET",
  );
  releasePoll();
  await staleResponse;
  await expect(row.locator(".used-badge")).toHaveText("Used");
  await page.unroute("**/api/v1/lectures");
  await page.reload();
  await expect(row.locator(".used-badge")).toHaveText("Used");
  await more.click();
  await page
    .getByRole("menuitem", { name: "Mark as unused", exact: true })
    .click();
  await expect(row.locator(".used-badge")).toHaveCount(0);
  await row.locator(".lecture-select").focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Mark as used", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(more).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await row.locator(".lecture-select").click();
  await page.getByLabel("Hide used", { exact: true }).check();
  await more.click();
  await page
    .getByRole("menuitem", { name: "Mark as used", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".lecture-detail")).not.toContainText(title);
  expect(
    (await (await request.get(`/api/v1/lectures/${id}`)).json()).is_used,
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("styled picker and themed selects work with keyboard inside dialogs and on mobile", async ({
  page,
  request,
}) => {
  await course(request, "Picker controls");
  await course(request, "Before import");
  await page.goto("/");
  await page
    .locator(".course-filter")
    .filter({ hasText: "Before import" })
    .click();
  const open = () =>
    page.getByRole("button", { name: "+ Import lecture", exact: true }).click();
  await open();
  const dialog = page.getByRole("dialog");
  const picker = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Choose recording", exact: true })
    .click();
  await (await picker).setFiles(path.resolve("../test/fixtures/lecture.wav"));
  await expect(page.getByLabel("Lecture title", { exact: true })).toHaveValue(
    "lecture",
  );
  await expect(dialog.locator(".file-drop strong")).toHaveText("lecture.wav");
  await expect(
    page.getByRole("button", { name: "Change recording", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove file", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Import recording", exact: true }),
  ).toBeDisabled();
  const control = page.getByRole("combobox", { name: "Course", exact: true });
  await control.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/lectra-library-import-dark.png",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(control).toBeFocused();
  await control.press("p");
  await expect(control).toHaveText("Picker controls");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Light mode", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await control.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  const bounds = await page.getByRole("listbox").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/lectra-library-import-light-mobile.png",
  });
  await page
    .getByRole("option", { name: "Picker controls", exact: true })
    .click();
  await page
    .getByLabel("Lecture recording", { exact: true })
    .setInputFiles(path.resolve("../test/fixtures/lecture.wav"));
  await page
    .getByLabel("Lecture title", { exact: true })
    .fill("Styled picker import");
  await page
    .getByRole("button", { name: "Import recording", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".lecture-detail h2")).toHaveText(
    "Styled picker import",
  );
  await expect(
    page.locator(".course-filter").filter({ hasText: "All courses" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".lecture-detail")).toContainText(
    "Picker controls",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/lectra-library-light-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/lectra-library-dark.png",
  });
});
