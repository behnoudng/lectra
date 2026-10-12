import { test, expect } from "@playwright/test";

test("numeric controls preserve bounds, decimal precision, optional values and saved settings", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const prior = await (await request.get("/api/v1/settings")).json();
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const backward = page.getByLabel("Skip backward (seconds)", {
      exact: true,
    });
    await backward.fill("11");
    await page
      .getByRole("button", {
        name: "Increase skip backward (seconds)",
        exact: true,
      })
      .click();
    await expect(backward).toHaveValue("12");
    await backward.focus();
    await page.keyboard.press("ArrowUp");
    await expect(backward).toHaveValue("13");
    await page
      .getByRole("button", {
        name: "Decrease skip backward (seconds)",
        exact: true,
      })
      .click();
    await expect(backward).toHaveValue("12");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/settings") &&
        response.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    expect(
      (await (await request.get("/api/v1/settings")).json()).skip_seconds,
    ).toBe(12);
    await backward.fill("1");
    await expect(
      page.getByRole("button", {
        name: "Decrease skip backward (seconds)",
        exact: true,
      }),
    ).toBeDisabled();
    await backward.fill("60");
    await expect(
      page.getByRole("button", {
        name: "Increase skip backward (seconds)",
        exact: true,
      }),
    ).toBeDisabled();
    await backward.fill("12");
    const monthly = page.getByLabel("Monthly budget (leave blank for none)", {
      exact: true,
    });
    await monthly.fill("0.29");
    await page
      .getByRole("button", {
        name: "Increase monthly budget (leave blank for none)",
        exact: true,
      })
      .click();
    expect(Number(await monthly.inputValue())).toBe(0.3);
    const rate = page.getByRole("spinbutton", {
      name: /Base .* per audio hour/,
    });
    await rate.fill("1.234567");
    await page
      .getByRole("button", { name: /Increase base .* per audio hour/ })
      .click();
    await expect(rate).toHaveValue("1.234568");

    const playback = page.locator(".settings > section").filter({
      has: page.getByRole("heading", {
        name: "Playback and automatic backups",
        exact: true,
      }),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await playback.screenshot({
      path: "/tmp/lectra-polish-fields-dark.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Light mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await playback.screenshot({
      path: "/tmp/lectra-polish-fields-light.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 850, height: 900 });
    await page.locator(".sidebar").screenshot({
      path: "/tmp/lectra-polish-header-light.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".sidebar").screenshot({
      path: "/tmp/lectra-polish-header-dark.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await playback.screenshot({
      path: "/tmp/lectra-polish-fields-mobile.png",
      animations: "disabled",
    });
    await page.locator(".sidebar").screenshot({
      path: "/tmp/lectra-polish-header-mobile.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("button", { name: "+ Course", exact: true }).click();
    await page.getByLabel("Default speaker labeling", { exact: true }).check();
    const speakers = page.getByLabel("Expected speakers", { exact: true });
    await expect(speakers).toHaveValue("");
    await page
      .getByRole("button", { name: "Increase expected speakers", exact: true })
      .click();
    await expect(speakers).toHaveValue("1");
    await expect(page.getByRole("dialog")).toBeVisible();
    await speakers.fill("32");
    await expect(
      page.getByRole("button", {
        name: "Increase expected speakers",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Decrease expected speakers", exact: true })
      .click();
    await expect(speakers).toHaveValue("31");
    await speakers.fill("");
    await expect(speakers).toHaveValue("");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await request.patch("/api/v1/settings", { data: prior });
  }
});
