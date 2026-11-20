// Shared headless-Chromium launch settings for tools/shots.mjs, tools/gl-probe.mjs and the
// Playwright e2e config. Order = preference. See README "Rendering in headless".
//
// Findings (M0, AMD Radeon / RADV, Chromium 1228 headless shell):
//  - `--use-angle=vulkan` WITHOUT `--enable-features=Vulkan` gives hardware WebGL2 through
//    ANGLE→Vulkan→RADV with correct output. This is the default.
//  - Adding `--enable-features=Vulkan` (Skia/compositor on Vulkan) corrupts every frame into
//    128 px tiles — in page screenshots AND canvas.toDataURL. Never add it.
//  - `--use-angle=gl` silently falls back to SwiftShader (no EGL display in headless).
//  - SwiftShader renders correctly, ~3-4x slower per shot. It is the fallback, and Chromium
//    also falls back to it by itself thanks to `--enable-unsafe-swiftshader`.
export const GL_FLAG_SETS = [
  {
    name: 'hardware-angle-vulkan',
    args: ['--use-angle=vulkan', '--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  },
  {
    name: 'swiftshader',
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
];

/** Launches Chromium with the first flag set that yields a WebGL2 context. */
export async function launchWithGL(chromium, { log = () => {} } = {}) {
  let lastErr;
  // MYRME_GL=<set name> forces one configuration (e.g. MYRME_GL=swiftshader for A/B checks).
  const forced = process.env.MYRME_GL;
  const sets = forced ? GL_FLAG_SETS.filter((s) => s.name === forced) : GL_FLAG_SETS;
  for (const set of sets) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: set.args });
      const page = await browser.newPage();
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return null;
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      });
      await page.close();
      if (renderer) {
        log(`[browser] ${set.name}: ${renderer}`);
        return { browser, set, renderer };
      }
      await browser.close();
    } catch (e) {
      lastErr = e;
      await browser?.close().catch(() => {});
    }
  }
  throw lastErr ?? new Error('no working WebGL2 configuration found');
}
