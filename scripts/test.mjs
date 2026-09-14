import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'neuro-dj-test-'));
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'test_learning_loop.ts', 'test_track_analysis.ts', 'test_demonstration_learning.ts',
    '--outDir', directory, '--module', 'commonjs', '--target', 'ES2023',
    '--types', 'node', '--esModuleInterop', '--skipLibCheck', '--ignoreConfig', '--ignoreDeprecations', '6.0'], { stdio: 'inherit' });
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}');
  execFileSync(process.execPath, [join(directory, 'test_learning_loop.js')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(directory, 'test_track_analysis.js')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(directory, 'test_demonstration_learning.js')], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/test-worklet.mjs'], { stdio: 'inherit' });
} finally { rmSync(directory, { recursive: true, force: true }); }

// Module summary: This compiles the core and analysis regressions into an isolated temporary directory.
// Running emitted JavaScript avoids introducing another test runtime dependency.
// Browser audio and the Python analyzer require their separate integration suites.
