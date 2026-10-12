import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Lecture } from "../src/types";

const fixture = path.resolve("../test/fixtures/lecture.wav");

async function prepare(page: Page, title: string, file = fixture) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "+ Import lecture", exact: true })
    .click();
  await page.getByLabel("Lecture title", { exact: true }).fill(title);
  await page.getByLabel("Lecture recording").setInputFiles(file);
  await page
    .getByRole("button", { name: "Import recording", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 90000 });
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play retained audio" }),
  ).toBeEnabled({ timeout: 30000 });
}

async function lecture(
  request: APIRequestContext,
  title: string,
): Promise<Lecture> {
  const response = await request.get("/api/v1/lectures");
  return (await response.json()).find((item: Lecture) => item.title === title);
}

async function jump(page: Page, at: string) {
  await page.getByLabel("Jump to time").fill(at);
  await page.getByRole("button", { name: "Go", exact: true }).click();
}

async function select(page: Page, start: string, end: string) {
  await page.getByLabel("Selection start").fill(start);
  await page.getByLabel("Selection end").fill(end);
}

async function save(page: Page) {
  await page
    .getByRole("button", { name: "Save preparation", exact: true })
    .click();
  await expect(
    page.getByText("Preparation saved", { exact: true }),
  ).toBeVisible();
}

const cut = (page: Page) => page.getByRole("button", { name: /Cut selection/ });
const selectionRegion = (page: Page) =>
  page.locator('.waveform [part~="selection"]');
const removedRegions = (page: Page) =>
  page.locator('.waveform [data-kind="removed"]');

test("exact playhead markers, preview, reversible cuts and saved recording times", async ({
  page,
  request,
}) => {
  const title = "Precise audio cuts";
  await prepare(page, title);
  const original = (await lecture(request, title)).media.find(
    (a) => a.kind === "original",
  )!;
  await expect(page.getByTestId("playhead-time")).toHaveText("00:00.000");
  await jump(page, "2.375");
  await expect(page.getByTestId("playhead-time")).toHaveText("00:02.375");
  await page.getByRole("button", { name: /Set start here/ }).click();
  await jump(page, "00:04.625");
  await page.getByRole("button", { name: /Set end here/ }).click();
  await expect(page.getByLabel("Selection start")).toHaveValue("00:02.375");
  await expect(page.getByLabel("Selection end")).toHaveValue("00:04.625");
  await expect(page.getByTestId("selection-duration")).toHaveText("00:02.250");
  await expect(selectionRegion(page)).toBeVisible();
  await page
    .getByRole("button", { name: "Preview selection", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Pause audio" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play retained audio" }),
  ).toBeVisible();
  await expect(page.getByTestId("playhead-time")).toHaveText("00:04.625");
  await cut(page).click();
  await expect(page.locator(".cut-list li")).toHaveCount(1);
  await expect(removedRegions(page)).toHaveCount(1);
  await expect(selectionRegion(page)).toHaveCount(0);
  await page.getByRole("button", { name: /Undo cut/ }).click();
  await expect(removedRegions(page)).toHaveCount(0);
  await page.getByRole("button", { name: /Redo cut/ }).click();
  await expect(removedRegions(page)).toHaveCount(1);
  await save(page);
  let current = await lecture(request, title);
  expect(current.edl).toEqual([
    { start_ms: 0, end_ms: 2375 },
    { start_ms: 4625, end_ms: 8000 },
  ]);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore cut 1", exact: true }),
  ).toBeVisible();
  await expect(removedRegions(page)).toHaveCount(1);
  await page
    .getByRole("button", { name: "Restore cut 1", exact: true })
    .click();
  await save(page);
  current = await lecture(request, title);
  expect(current.edl).toEqual([{ start_ms: 0, end_ms: 8000 }]);
  expect(current.media.find((a) => a.kind === "original")!.sha256).toBe(
    original.sha256,
  );
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(0);
});

test("checked effects play in the main transport, with progress and recoverable preview errors", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    Object.defineProperty(window, "heardAudio", { value: [] });
    HTMLMediaElement.prototype.play = function () {
      (window as unknown as { heardAudio: string[] }).heardAudio.push(
        this.currentSrc || this.src,
      );
      return original.call(this);
    };
  });
  const title = "Main-player effects";
  await prepare(page, title);
  const before = await lecture(request, title);
  await select(page, "1", "2");
  await cut(page).click();
  await jump(page, "2.25");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/monitor-preview") && r.request().method() === "POST",
  );
  await page.getByLabel("Reduce noise", { exact: true }).check();
  await expect(page.locator(".effects-status")).toContainText(
    "Preparing audio",
  );
  const effectsId = (await (await response).json()).id;
  await expect(page.locator(".preparation")).toHaveAttribute(
    "data-monitor-state",
    "enhanced",
  );
  await expect(page.getByTestId("playhead-time")).toHaveText("00:02.250");
  await page.getByRole("button", { name: "Play retained audio" }).click();
  await expect(
    page.getByRole("button", { name: "Pause audio" }),
  ).toHaveAttribute("aria-pressed", "true");
  const played = await page.evaluate(
    () => (window as unknown as { heardAudio: string[] }).heardAudio,
  );
  expect(played.at(-1)).toContain("/api/v1/media/" + effectsId);
  await page.getByRole("button", { name: "Pause audio" }).click();
  await page.getByLabel("Reduce noise", { exact: true }).uncheck();
  await expect(page.locator(".preparation")).toHaveAttribute(
    "data-monitor-state",
    "original",
  );
  await page.route("**/monitor-preview", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { category: "local_media", message: "Test preview failure." },
      }),
    }),
  );
  await page.getByLabel("Remove low rumble", { exact: true }).check();
  await expect(page.locator(".preparation")).toHaveAttribute(
    "data-monitor-state",
    "failed",
  );
  await expect(
    page.getByRole("button", { name: "Play retained audio" }),
  ).toBeDisabled();
  await page.unroute("**/monitor-preview");
  await page
    .getByRole("button", { name: "Retry effects", exact: true })
    .click();
  await expect(page.locator(".preparation")).toHaveAttribute(
    "data-monitor-state",
    "enhanced",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();
  await select(page, "4.25", "5.75");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/lectra-refined-audio-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Light mode", exact: true }).click();
  await page.screenshot({
    path: "/tmp/lectra-refined-audio-light.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    (await lecture(request, title)).media.find((a) => a.kind === "original")!
      .sha256,
  ).toBe(before.media.find((a) => a.kind === "original")!.sha256);
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(0);
});

test("graphical drag and resize stay synchronized with precise fields and zoom", async ({
  page,
}) => {
  await prepare(page, "Graphical audio editing");
  const wrapper = page.locator('.waveform [part="wrapper"]');
  const bounds = (await wrapper.boundingBox())!;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, y, { steps: 15 });
  await page.mouse.up();
  await expect(selectionRegion(page)).toBeVisible();
  const oldStart = await page.getByLabel("Selection start").inputValue();
  const oldEnd = await page.getByLabel("Selection end").inputValue();
  const handle = (await page
    .locator('.waveform [part~="region-handle-right"]')
    .boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + bounds.width * 0.1,
    handle.y + handle.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(page.getByLabel("Selection end")).not.toHaveValue(oldEnd);
  await expect(page.getByLabel("Selection start")).toHaveValue(oldStart);
  await page
    .getByRole("button", { name: "Clear waveform selection", exact: true })
    .click();
  await expect(selectionRegion(page)).toHaveCount(0);
  await expect(page.getByLabel("Selection start")).toHaveValue("");
  await select(page, "00:01.125", "00:02.875");
  await expect(page.getByTestId("selection-duration")).toHaveText("00:01.750");
  const exact = (await selectionRegion(page).boundingBox())!;
  expect(
    Math.abs(exact.x - bounds.x - (1125 / 8000) * bounds.width),
  ).toBeLessThan(2);
  expect(Math.abs(exact.width - (1750 / 8000) * bounds.width)).toBeLessThan(2);
  await page
    .getByRole("button", { name: "Zoom to selection", exact: true })
    .click();
  await expect
    .poll(async () => (await selectionRegion(page).boundingBox())!.width)
    .toBeGreaterThan(exact.width);
  await expect
    .poll(async () =>
      Number(await page.getByLabel("Waveform zoom").inputValue()),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Fit recording", exact: true })
    .click();
  await expect(page.getByLabel("Waveform zoom")).toHaveValue("0");
  await expect
    .poll(async () => (await selectionRegion(page).boundingBox())!.width)
    .toBeCloseTo(exact.width, 0);
});

test("kept playback skips cuts, while preview can listen to removed audio", async ({
  page,
}) => {
  await prepare(page, "Audition removed audio");
  await select(page, "1", "3");
  await cut(page).click();
  await select(page, "5", "7");
  await cut(page).click();
  await jump(page, "0.95");
  await page.getByRole("button", { name: "Play retained audio" }).click();
  await expect
    .poll(async () => {
      const current = await page.getByTestId("playhead-time").innerText();
      return Number(current.slice(3));
    })
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Pause audio" }).click();
  await page.getByRole("button", { name: "Preview removed section 1" }).click();
  await expect(page.locator(".audio-clock")).toContainText(
    "Previewing removed audio",
  );
  await expect
    .poll(async () => {
      const current = await page.getByTestId("playhead-time").innerText();
      return Number(current.slice(3));
    })
    .toBeGreaterThan(1.1);
  expect(
    Number((await page.getByTestId("playhead-time").innerText()).slice(3)),
  ).toBeLessThan(3);
  await page.getByRole("button", { name: "Preview removed section 2" }).click();
  await expect(page.locator(".audio-clock")).toContainText(
    "Previewing removed audio",
  );
  await expect
    .poll(async () =>
      Number((await page.getByTestId("playhead-time").innerText()).slice(3)),
    )
    .toBeGreaterThanOrEqual(5);
  await expect(
    page.getByRole("button", { name: "Play retained audio" }),
  ).toBeVisible();
  await expect(page.getByTestId("playhead-time")).toHaveText("00:07.000");
});

test("invalid cuts are blocked; keyboard controls and small screens remain usable", async ({
  page,
}) => {
  await prepare(page, "Safe and responsive cutting");
  await select(page, "00:99", "3");
  await expect(page.getByLabel("Selection start")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(cut(page)).toBeDisabled();
  await select(page, "4", "2");
  await expect(page.getByText("End must be after start.")).toBeVisible();
  await expect(cut(page)).toBeDisabled();
  await select(page, "0", "8");
  await expect(
    page.getByText("Keep at least one part of the recording."),
  ).toBeVisible();
  await expect(cut(page)).toBeDisabled();
  await jump(page, "2");
  await page.getByRole("group", { name: /Audio waveform/ }).focus();
  await page.keyboard.press("i");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("o");
  await expect(page.getByLabel("Selection start")).toHaveValue("00:02.000");
  await expect(page.getByLabel("Selection end")).toHaveValue("00:02.100");
  await page.keyboard.press("Delete");
  await expect(page.locator(".cut-list li")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".cut-list li")).toHaveCount(0);
  await select(page, "1.25", "2.75");
  await cut(page).click();
  await select(page, "4.5", "5.625");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/lectra-audio-preparation-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Light mode", exact: true }).click();
  await page.screenshot({
    path: "/tmp/lectra-audio-preparation-light.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cut(page)).toBeEnabled();
  await expect(page.getByLabel("Selection start")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/lectra-audio-preparation-mobile.png",
    fullPage: true,
  });
  await cut(page).click();
  await expect(page.locator(".cut-list li")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Restore all audio", exact: true })
    .click();
  await expect(removedRegions(page)).toHaveCount(0);
});

test("hour-long recordings have precise source times, usable zoom and bounded waveform detail", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const file = "/tmp/lectra-hour-waveform.flac";
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=8000",
    "-t",
    "3602",
    "-c:a",
    "flac",
    file,
  ]);
  const title = "Hour-long graphical editing";
  await prepare(page, title, file);
  const before = await lecture(request, title);
  await jump(page, "1:00:00.125");
  await expect(page.getByTestId("playhead-time")).toHaveText("01:00:00.125");
  await select(page, "1:00:00.125", "3601.875");
  await expect(page.getByTestId("selection-duration")).toHaveText("00:01.750");
  await page
    .getByRole("button", { name: "Zoom to selection", exact: true })
    .click();
  await expect
    .poll(async () => (await selectionRegion(page).boundingBox())!.width)
    .toBeGreaterThan(150);
  await expect(page.getByLabel("Selection end")).toHaveValue("01:00:01.875");
  await cut(page).click();
  await save(page);
  const after = await lecture(request, title);
  expect(after.edl).toEqual([
    { start_ms: 0, end_ms: 3600125 },
    { start_ms: 3601875, end_ms: 3602000 },
  ]);
  expect(after.media.find((a) => a.kind === "original")!.sha256).toBe(
    before.media.find((a) => a.kind === "original")!.sha256,
  );
  const waveform = await (
    await request.get(
      "/api/v1/media/" +
        before.media.find((a) => a.kind === "proxy")!.id +
        "/peaks",
    )
  ).json();
  expect(waveform.peaks.length).toBeGreaterThan(49000);
  expect(waveform.peaks.length).toBeLessThanOrEqual(50000);
  expect(
    (await (await request.get("http://127.0.0.1:8121/test/stats")).json())
      .posts,
  ).toBe(0);
});
