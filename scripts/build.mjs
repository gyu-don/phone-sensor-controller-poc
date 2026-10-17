import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/client/display.js', 'src/client/controller.js'], outdir: 'dist', bundle: true, format: 'esm', target: ['safari15', 'chrome100'], minify: true });
for (const name of ['index.html', 'controller.html', 'style.css', '_headers']) {
  await copyFile(`public/${name}`, `dist/${name}`);
}
console.log('Built display, controller, and local QR encoder → dist/');
