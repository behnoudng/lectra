import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chooseOption } from "./select";

async function prepare(page: Page, title: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "+ Import lecture", exact: true })
    .click();
  await page.getByLabel("Lecture title", { exact: true }).fill(title);
  await page
    .getByLabel("Lecture recording")
    .setInputFiles(path.resolve("../test/fixtures/lecture.wav"));
  await page
    .getByRole("button", { name: "Import recording", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page
    .getByRole("button", { name: "Prepare audio →", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play retained audio", exact: true }),
  ).toBeEnabled();
}

test("review selects Scribe v3 and the confirmed job retains that model", async ({
  page,
  request,
}) => {
  await prepare(page, "Model selection test");
  await page
    .getByRole("button", { name: "Review transcription →", exact: true })
    .click();
  const control = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(control).toHaveText("Scribe v2");
  await chooseOption(page, control, "Scribe v3");
  await expect(control).toHaveText("Scribe v3");
  await expect(
    page.getByRole("button", { name: "Confirm and enqueue", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "/tmp/lectra-model-selector.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Confirm and enqueue", exact: true })
    .click();
  const job = page.locator(".job").filter({ hasText: "Model selection test" });
  await expect(job).toContainText("succeeded", { timeout: 20000 });
  await expect(job).toContainText("Scribe v3");
  const queue = await (await request.get("/api/v1/queue")).json();
  expect(
    queue.jobs.find(
      (item: { title: string }) => item.title === "Model selection test",
    ).settings.model_id,
  ).toBe("scribe_v3");
});

test("MP3 downloads reflect unsaved cuts and intersect the active selection with retained audio", async ({
  page,
  request,
}, info) => {
  await prepare(page, "Audio export test");
  const select = async (start: string, end: string) => {
    await page.getByLabel("Selection start").fill(start);
    await page.getByLabel("Selection end").fill(end);
  };
  await select("0", "1");
  await page.getByRole("button", { name: /Cut selection/ }).click();
  await select("6", "8");
  await page.getByRole("button", { name: /Cut selection/ }).click();
  await select("0", "3");
  const before = (await (await request.get("/api/v1/lectures")).json()).find(
    (item: { title: string }) => item.title === "Audio export test",
  );
  expect(before.edl).toEqual([{ start_ms: 0, end_ms: 8000 }]);
  await page
    .locator(".page-actions")
    .last()
    .screenshot({ path: "/tmp/lectra-mp3-export.png", animations: "disabled" });
  for (const [button, seconds] of [
    ["Download edited MP3", 5],
    ["Download selection MP3", 2],
  ] as const) {
    const ready = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    const download = await ready;
    expect(download.suggestedFilename()).toMatch(/\.mp3$/);
    const file = info.outputPath(button + ".mp3");
    await download.saveAs(file);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
        { encoding: "utf8" },
      ),
    );
    expect(probe.streams[0].codec_name).toBe("mp3");
    expect(Math.abs(Number(probe.format.duration) - seconds)).toBeLessThan(0.2);
  }
  await expect(
    page.getByText("Unsaved preparation", { exact: true }),
  ).toBeVisible();
  const after = await (
    await request.get(`/api/v1/lectures/${before.id}`)
  ).json();
  expect(after.edl).toEqual(before.edl);
  await select("0", "1");
  await expect(
    page.getByRole("button", { name: "Download selection MP3", exact: true }),
  ).toBeDisabled();
});
