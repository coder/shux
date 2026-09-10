import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { connect } from "../src/api";

async function withinViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize()!;
  // Native sheets animate into place; assert settled geometry, not the first animation frame.
  await expect
    .poll(async () => {
      const bounds = await locator.boundingBox();
      return bounds != null && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height;
    })
    .toBe(true);
}

test("native stack preserves drafts and sheets keep their actions reachable", async ({
  page,
}, info) => {
  const endpoint = process.env.XUM_MOBILE_TEST_ENDPOINT!;
  const token = process.env.XUM_MOBILE_TEST_TOKEN!;
  const title = `Mobile UX check ${info.project.name} ${Date.now()}`;
  try {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Server URL" }).fill(endpoint);
    await page.getByRole("textbox", { name: "Server URL" }).press("Enter");
    await expect(page.getByRole("textbox", { name: "Bearer token", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Bearer token", exact: true }).fill(token);
    await page.getByRole("button", { name: /^Connect(?: without encryption)?$/ }).click();
    const workspaceSearch = page.getByRole("textbox", { name: "Search workspaces" });
    const newWorkspace = page.getByRole("button", { name: "New workspace", exact: true }).first();
    await expect(workspaceSearch).toBeVisible();
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => {
        const y = (await workspaceSearch.boundingBox())!.y;
        return viewport.width < 900 ? y > viewport.height - 130 : y < 180;
      })
      .toBe(true);
    await withinViewport(page, newWorkspace);
    const searchY = (await workspaceSearch.boundingBox())!.y;
    await page.getByTestId("workspace-list").evaluate((list) => {
      list.scrollTop = list.scrollHeight;
    });
    await expect.poll(async () => (await workspaceSearch.boundingBox())!.y).toBe(searchY);
    await workspaceSearch.fill("keep this query while resizing");
    await page.setViewportSize({
      width: viewport.width < 900 ? 1200 : 375,
      height: viewport.height,
    });
    await expect(workspaceSearch).toHaveValue("keep this query while resizing");
    await expect(workspaceSearch).toBeFocused();
    await page.setViewportSize(viewport);
    await workspaceSearch.fill("");

    await page.getByRole("button", { name: "New workspace", exact: true }).first().click();
    const create = page.getByRole("button", { name: "Create scratch chat", exact: true });
    await withinViewport(page, create);
    await page.getByRole("textbox", { name: "Title (optional)", exact: true }).fill(title);
    await create.click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(
      page.getByText(`Scratch chat · ${new URL(endpoint).host}`, { exact: true })
    ).toBeVisible();
    await expect.poll(async () => (await message.boundingBox())!.height).toBeLessThanOrEqual(50);
    const modeControl = page.getByRole("button", { name: "Choose mode", exact: true });
    const modelControl = page.getByRole("button", { name: "Choose model", exact: true });
    for (const control of [modeControl, modelControl]) {
      await expect
        .poll(async () => {
          const button = (await control.boundingBox())!;
          const input = (await message.boundingBox())!;
          return button.y + button.height <= input.y;
        })
        .toBe(true);
    }
    await message.focus();
    await expect(message).toBeFocused();
    await expect.poll(async () => (await message.boundingBox())!.height).toBeGreaterThan(60);
    // Pointer-down blurs the input before click: the toolbar must not shift below that press.
    const modelBounds = (await modelControl.boundingBox())!;
    await page.mouse.move(
      modelBounds.x + modelBounds.width / 2,
      modelBounds.y + modelBounds.height / 2
    );
    await page.mouse.down();
    await expect.poll(async () => (await message.boundingBox())!.height).toBeGreaterThan(60);
    await expect.poll(async () => (await modelControl.boundingBox())!.y).toBe(modelBounds.y);
    await expect(page.getByRole("textbox", { name: "Search models" })).toHaveCount(0);
    await page.mouse.up();
    await expect(page.getByRole("textbox", { name: "Search models" })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await message.focus();
    await page.getByRole("button", { name: "Choose mode", exact: true }).click();
    await expect(page.getByRole("radio", { name: /^Plan/ })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await modelControl.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Search models" })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await message.focus();
    await message.fill("A line of a longer draft\n".repeat(10));
    await expect.poll(async () => (await message.boundingBox())!.height).toBeGreaterThan(80);
    await message.fill("");
    await expect.poll(async () => (await message.boundingBox())!.height).toBeLessThanOrEqual(80);
    await page.getByRole("button", { name: "Connection settings", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(async () => (await message.boundingBox())!.height).toBeLessThanOrEqual(50);
    const draft = "Keep this unsent draft while navigating.";
    await message.fill(draft);
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await expect(send).toBeEnabled();
    await withinViewport(page, send);
    await page.getByRole("button", { name: "Back to workspaces", exact: true }).click();
    await page.getByRole("textbox", { name: "Search workspaces", exact: true }).fill(title);
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(draft);

    const chooseModel = page.getByRole("button", { name: "Choose model", exact: true });
    await chooseModel.click();
    const search = page.getByRole("textbox", { name: "Search models" });
    await withinViewport(page, search);
    await expect(page.getByRole("radio").first()).toBeVisible();
    await search.fill("no-match-model-query");
    await expect(page.getByRole("radio")).toHaveCount(0);
    await search.fill("");
    await expect(page.getByRole("radio").first()).toBeVisible();
    await page.getByRole("button", { name: /^Effort/ }).click();
    await page.getByRole("radio", { name: "High", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Effort/ })).toContainText("High");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const modelBeforeModeChange = await chooseModel.textContent();
    await page.getByRole("button", { name: "Choose mode", exact: true }).click();
    await page.getByRole("radio", { name: /^Plan/ }).click();
    await expect.poll(() => chooseModel.textContent()).toBe(modelBeforeModeChange);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "Choose mode", exact: true })).toContainText(
      "Plan"
    );
    await page.getByRole("button", { name: "Back to workspaces", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page.getByRole("button", { name: "Choose mode", exact: true })).toContainText(
      "Plan"
    );
    await chooseModel.click();
    await expect(page.getByRole("button", { name: /^Effort/ })).toContainText("High");
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await message.fill("");
    await message.blur();
    await page.setViewportSize({
      width: viewport.width === 1200 ? 375 : 1200,
      height: viewport.height,
    });
    await expect.poll(async () => (await message.boundingBox())!.height).toBeLessThanOrEqual(50);
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await message.boundingBox())!.height).toBeLessThanOrEqual(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    // Exercise the relocated send/stop targets through the real disposable server.
    await message.fill("[mock:tool:parallel-step]");
    await send.click();
    const interrupt = page.getByRole("button", { name: "Interrupt agent", exact: true });
    await expect(interrupt).toBeVisible();
    await withinViewport(page, interrupt);
    await interrupt.click();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect(message).toHaveValue("");
    expect(
      await page.evaluate(
        (secret) =>
          [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) =>
            value.includes(secret)
          ),
        token
      )
    ).toBe(false);
  } finally {
    // Cleanup only the uniquely named scratch chat created by this test, even on failure.
    const connection = await connect(endpoint, token);
    try {
      const workspace = (await connection.client.workspace.list()).find(
        (item) => item.title === title && item.kind === "scratch"
      );
      if (workspace) await connection.client.workspace.remove({ workspaceId: workspace.id });
    } finally {
      connection.close();
    }
  }
});
