import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { localVncPort } from './local-vnc.js';

/** Displays the desk already names: default :99, screen-100 :100, screen-101 :101. */
export const LOCAL_DISPLAYS = [99, 100, 101];

const LOG = '/opt/hq/logs';

function displayUp(n: number): boolean {
  const r = spawnSync('xdpyinfo', ['-display', `:${n}`], { timeout: 2000, encoding: 'utf8' });
  return r.status === 0;
}

function portUp(port: number): boolean {
  const r = spawnSync('bash', ['-c', `timeout 1 bash -c 'echo >/dev/tcp/127.0.0.1/${port}'`], { timeout: 3000 });
  return r.status === 0;
}

function spawnDetached(bin: string, args: string[], logName: string, extraEnv: NodeJS.ProcessEnv = {}): void {
  fs.mkdirSync(LOG, { recursive: true });
  const out = fs.openSync(`${LOG}/${logName}.log`, 'a');
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
}

/** Start Xvfb + a window manager + localhost VNC for each local screen. Idempotent. */
export function ensureLocalDisplays(): { up: number[]; started: string[]; errors: string[] } {
  const started: string[] = [];
  const errors: string[] = [];
  const up: number[] = [];
  if (!fs.existsSync('/usr/bin/Xvfb')) {
    errors.push('Xvfb is not installed');
    return { up, started, errors };
  }
  for (const n of LOCAL_DISPLAYS) {
    if (!displayUp(n)) {
      spawnDetached('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-ac', '-nolisten', 'tcp'], `xvfb-${n}`);
      started.push(`Xvfb:${n}`);
    }
    const deadline = Date.now() + 4000;
    while (!displayUp(n) && Date.now() < deadline) {
      spawnSync('sleep', ['0.2']);
    }
    if (!displayUp(n)) {
      errors.push(`display :${n} did not answer`);
      continue;
    }
    up.push(n);
    const port = localVncPort(n === 99 ? 'default' : `screen-${n}`);
    if (fs.existsSync('/usr/bin/x11vnc') && !portUp(port)) {
      spawnDetached('x11vnc', [
        '-display', `:${n}`,
        '-rfbport', String(port),
        '-localhost',
        '-nopw',
        '-shared',
        '-forever',
        '-noxdamage',
        '-wait', '100',
        '-defer', '30',
        ], `x11vnc-${n}`);
      started.push(`x11vnc:${port}`);
    } else if (!fs.existsSync('/usr/bin/x11vnc')) {
      errors.push('x11vnc is not installed');
    }
    if (fs.existsSync('/usr/bin/openbox')) {
      spawnDetached('openbox', ['--sm-disable'], `openbox-${n}`, { DISPLAY: `:${n}` });
    }
  }
  return { up, started, errors };
}
