import { expect, test, type Page } from '@playwright/test';
import type { ShellDebug } from '../../src/core';

declare global {
  interface Window {
    __myrmeShell?: ShellDebug;
    __failGL?: number;
    __lateFail?: boolean;
  }
}

// Regression: a colony that fails to start used to leave the "Founding…" loading screen covering
// the menu, so the only way to try another seed / size was reloading the page. A failure late in
// construction also leaked the WebGL context and canvas, making later attempts fail too.

const screen = (page: Page): Promise<string | undefined> => page.evaluate(() => window.__myrmeShell?.screen);
const canvases = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll('#app > canvas').length);

/** Next `n` WebGL context requests return null, as on a lost / exhausted GPU. */
async function failNextContexts(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    window.__failGL = count;
    const proto = HTMLCanvasElement.prototype as unknown as { __orig?: typeof HTMLCanvasElement.prototype.getContext; getContext: unknown };
    if (!proto.__orig) {
      proto.__orig = HTMLCanvasElement.prototype.getContext;
      proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if ((type === 'webgl2' || type === 'webgl') && (window.__failGL ?? 0) > 0) {
          window.__failGL = (window.__failGL ?? 0) - 1;
          return null;
        }
        return (proto.__orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      };
    }
  }, n);
}

/** The next shader compile throws: a failure after the GL context already exists. */
async function failLateOnce(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__lateFail = true;
    const proto = WebGL2RenderingContext.prototype as unknown as { __origShader?: (...a: unknown[]) => unknown; createShader: (...a: unknown[]) => unknown };
    if (!proto.__origShader) {
      proto.__origShader = proto.createShader;
      proto.createShader = function (this: WebGL2RenderingContext, ...a: unknown[]) {
        if (window.__lateFail) {
          window.__lateFail = false;
          throw new Error('injected late failure');
        }
        return proto.__origShader!.apply(this, a);
      };
    }
  });
}

test('a failed start returns to colony setup and can be retried from the UI', async ({ page }) => {
  await page.goto('/?attract=0');
  await expect(page.getByTestId('menu-new')).toBeVisible();
  await page.getByTestId('menu-new').click();
  await page.evaluate(() => window.__myrmeShell!.showMenu('setup'));
  await expect(page.getByTestId('ng-start')).toBeVisible();

  await failNextContexts(page, 1);
  await page.getByTestId('ng-start').click();
  await expect(page.getByTestId('shell-toast').last()).toContainText('could not be founded');
  await expect(page.getByTestId('loading')).toBeHidden();
  expect(await screen(page)).toBe('newGame');
  expect(await canvases(page)).toBe(0);

  // the same button works straight away — no reload needed
  await page.getByTestId('ng-start').click();
  await page.waitForFunction(() => window.__myrme?.ready === true && window.__myrmeShell?.screen === 'playing', null, { timeout: 90_000 });
  await expect(page.getByTestId('loading')).toBeHidden({ timeout: 10_000 });
  expect(await canvases(page)).toBe(1);
});

test('repeated late failures leak no canvases or contexts', async ({ page }) => {
  await page.goto('/?attract=0');
  await expect(page.getByTestId('menu-new')).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await failLateOnce(page);
    await page.evaluate(() => window.__myrmeShell!.startGame({ map: 'gelFarm', faction: 'gardenAnt', seed: 3, size: 'small' }));
    expect(await screen(page)).toBe('newGame');
    expect(await canvases(page)).toBe(0);
  }
  await expect(page.getByTestId('loading')).toBeHidden();
  // more than the ~16 live contexts a browser allows: a leak would make this start fail
  await page.evaluate(() => window.__myrmeShell!.startGame({ map: 'gelFarm', faction: 'gardenAnt', seed: 3, size: 'small' }));
  expect(await screen(page)).toBe('playing');
  expect(await canvases(page)).toBe(1);
});
