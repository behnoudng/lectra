import { type Page, type Locator } from "@playwright/test";

export async function chooseOption(
  page: Page,
  control: Locator,
  label: string | RegExp,
) {
  await control.click();
  await page
    .getByRole("option", { name: label, exact: typeof label === "string" })
    .click();
}
