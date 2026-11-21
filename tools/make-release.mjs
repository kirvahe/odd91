// Builds the release archive for the end user: dist/odd91-halation.zip
//   dev.halation.photoshop/      ready plugin folder (manifest.json directly inside)
//   install-guide-ru.html        step-by-step guide (opens offline)
// No top-level folder inside the zip: macOS Archive Utility and Windows "Extract all" both
// create one folder named after the archive, which is what the guide describes.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pluginDir = join(dist, 'dev.halation.photoshop');
const staging = join(dist, 'release-staging');
const zipPath = join(dist, 'odd91-halation.zip');

execFileSync(process.execPath, [join(root, 'tools', 'build-ccx.mjs')], { stdio: 'inherit' });
if (!existsSync(join(pluginDir, 'manifest.json'))) throw new Error('build did not produce the plugin folder');

rmSync(staging, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(staging, { recursive: true });
cpSync(pluginDir, join(staging, 'dev.halation.photoshop'), { recursive: true });
cpSync(join(root, 'docs', 'install-guide-ru.html'), join(staging, 'install-guide-ru.html'));

execFileSync('zip', ['-r', '-X', '-9', zipPath, '.', '-x', '*.DS_Store', '-x', '__MACOSX/*'], { cwd: staging, stdio: 'ignore' });
rmSync(staging, { recursive: true, force: true });

const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const need of ['dev.halation.photoshop/manifest.json', 'dev.halation.photoshop/halation-core.js', 'install-guide-ru.html']) {
  if (!listing.includes(need)) throw new Error('release zip misses ' + need);
}
console.log(`make-release: ${zipPath} (${listing.length} entries)`);
