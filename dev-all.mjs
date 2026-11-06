// 一条命令同时启动前端（Vite）和后端（server.js），零依赖。
// 终端里按 Ctrl+C 会同时关闭两个进程（Windows 下用 taskkill /T 杀整棵树）。
import { spawn, spawnSync } from 'node:child_process';

const procs = [
  { name: 'web', cmd: 'npm', args: ['run', 'dev'], color: '\x1b[34m' },
  { name: 'api', cmd: 'npm', args: ['run', 'server'], color: '\x1b[35m' },
];

const children = procs.map((p) => {
  const c = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  const tag = `${p.color}[${p.name}]\x1b[0m `;
  c.stdout.on('data', (d) => process.stdout.write(tag + d.toString()));
  c.stderr.on('data', (d) => process.stderr.write(tag + d.toString()));
  return c;
});

// 关键：Windows 下 child.kill() 只杀到中间的 cmd.exe，杀不到真正的 node。
// 用 taskkill /T 连整棵子树一起杀，才是真的关干净。
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    }
  }
}

function shutdown() {
  console.log('\n收到退出信号，正在关闭所有进程…');
  children.forEach(killTree);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown); // Windows 上另一个中断信号

