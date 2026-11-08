import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shared by the explicit native build and every Windows electron-builder entry point.
export function prepareSoloistCapture({ root = process.cwd(), arch = 'x64' } = {}) {
    if (arch !== 'x64') throw new Error(`Soloist capture is only built for Windows x64 (requested ${arch})`);
    const source = path.join(root, 'native', 'soloist-audio-capture');
    const output = path.join(root, 'build', '.soloist-capture-cmake');
    function run(...args) {
        const result = spawnSync('cmake', args, { cwd: root, shell: false, stdio: 'inherit' });
        if (result.error || result.status !== 0) {
            throw new Error(`Soloist audio helper build failed: ${result.error?.message || `exit ${result.status}`}`);
        }
    }
    run('-S', source, '-B', output, '-G', 'Visual Studio 17 2022', '-A', 'x64');
    run('--build', output, '--config', 'Release', '--parallel');
    const binary = path.join(root, 'build', 'soloist-capture', 'folia-soloist-capture.exe');
    if (!fs.existsSync(binary)) throw new Error(`CMake succeeded but did not generate ${binary}`);
    console.log(`[Soloist capture] Built ${binary}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.platform === 'win32') prepareSoloistCapture();
    else console.log('[Soloist capture] Windows-only; skipped');
}
