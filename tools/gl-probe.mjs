// Probes which headless-Chromium GL backend works on this machine.
// Usage: node tools/gl-probe.mjs
import { chromium } from '@playwright/test';
import { GL_FLAG_SETS } from './browser.mjs';

const probe = () => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const test = (internal, format, type) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok;
  };
  const cbf = !!gl.getExtension('EXT_color_buffer_float');
  const cbhf = !!gl.getExtension('EXT_color_buffer_half_float');
  return {
    webgl2: true,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    extColorBufferFloat: cbf,
    extColorBufferHalfFloat: cbhf,
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    rgba16fTarget: test(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT),
    rgba32fTarget: test(gl.RGBA32F, gl.RGBA, gl.FLOAT),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
};

for (const set of GL_FLAG_SETS) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: set.args });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const t0 = Date.now();
    const res = await page.evaluate(probe);
    console.log(set.name, JSON.stringify(res), `${Date.now() - t0}ms`);
  } catch (e) {
    console.log(set.name, 'FAILED', String(e).split('\n')[0]);
  } finally {
    await browser?.close();
  }
}
