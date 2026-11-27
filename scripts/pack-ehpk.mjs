import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const GLASSES_DIR = path.join(REPO, 'packages/glasses');
const MANIFEST_PATH = path.join(GLASSES_DIR, 'app.json');
const DIST_DIR = path.join(GLASSES_DIR, 'dist');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const outArg = args.find((a) => !a.startsWith('--'));
const outPath = path.resolve(REPO, process.env.EHPK_OUT ?? outArg ?? 'chainvision.ehpk');

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return res;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
for (const field of ['package_id', 'version', 'min_app_version', 'min_sdk_version', 'entrypoint']) {
  if (!manifest[field] || typeof manifest[field] !== 'string') {
    throw new Error(`packages/glasses/app.json is missing required string field "${field}"`);
  }
}

const networkPerm = Array.isArray(manifest.permissions)
  ? manifest.permissions.find((p) => p && p.name === 'network')
  : null;
if (!networkPerm || !Array.isArray(networkPerm.whitelist) || networkPerm.whitelist.length === 0) {
  throw new Error('packages/glasses/app.json must declare a network permission with at least one whitelist entry');
}

if (!skipBuild) {
  for (const ws of ['@chainvision/shared', '@chainvision/glasses']) {
    const build = run('npm', ['--workspace', ws, 'run', 'build'], { stdio: 'inherit' });
    if (build.status !== 0) {
      process.exit(build.status ?? 1);
    }
  }
}

const entrypointFile = path.join(DIST_DIR, manifest.entrypoint);
if (!fs.existsSync(entrypointFile)) {
  throw new Error(`Built entrypoint not found at ${entrypointFile}. Run npm run build first.`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const pack = run('npx', [
  '-y',
  '@evenrealities/evenhub-cli@0.2.0',
  'pack',
  MANIFEST_PATH,
  DIST_DIR,
  '-o',
  outPath,
  '--sdk-ver',
  manifest.min_sdk_version,
  '--json',
]);

if (pack.stderr) process.stderr.write(pack.stderr);
if (pack.status !== 0) {
  if (pack.stdout) process.stdout.write(pack.stdout);
  process.exit(pack.status ?? 1);
}

const jsonLine = (pack.stdout ?? '')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith('{') && l.endsWith('}'))
  .at(-1);

if (!jsonLine) {
  throw new Error(`evenhub pack did not emit a JSON result:\n${pack.stdout}`);
}

const result = JSON.parse(jsonLine);
const errors = [];
if (result.ok !== true) errors.push(`packer reported ok=${String(result.ok)}`);
if (Array.isArray(result.warnings) && result.warnings.length > 0) {
  errors.push(`packer reported warnings: ${result.warnings.join('; ')}`);
}
if (result.package_id !== manifest.package_id) {
  errors.push(`package_id mismatch: got ${result.package_id}, expected ${manifest.package_id}`);
}
if (result.version !== manifest.version) {
  errors.push(`version mismatch: got ${result.version}, expected ${manifest.version}`);
}
if (result.min_app_version !== manifest.min_app_version) {
  errors.push(`min_app_version mismatch: got ${result.min_app_version}, expected ${manifest.min_app_version}`);
}
if (!fs.existsSync(outPath)) {
  errors.push(`output package missing at ${outPath}`);
} else {
  const stat = fs.statSync(outPath);
  if (stat.size <= 0 || stat.size !== result.size) {
    errors.push(`output size mismatch: file=${stat.size}, reported=${result.size}`);
  }
}

if (errors.length > 0) {
  throw new Error(`chainvision.ehpk validation failed against app.json:\n- ${errors.join('\n- ')}`);
}

console.log(
  `Verified ${path.relative(REPO, outPath) || outPath}: package_id=${result.package_id} version=${result.version} min_app_version=${result.min_app_version} sdk=${manifest.min_sdk_version} size=${result.size} bytes`,
);
