/**
 * System Maintenance API — Cross-platform disk health & auto-cleanup
 * Works on Linux, macOS, and Windows.
 */
import express from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────────

function getDirectorySize(dirPath) {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          total += fs.statSync(fullPath).size;
        }
      } catch { /* permission errors, symlink loops, etc */ }
    }
  } catch { /* inaccessible directories */ }
  return total;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function getDiskUsage() {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      // PowerShell: get disk info for the drive containing the project
      const drive = PROJECT_DIR.charAt(0).toUpperCase();
      const raw = execSync(
        `powershell -Command "Get-PSDrive ${drive} | Select-Object Used,Free | ConvertTo-Json"`,
        { encoding: 'utf8', timeout: 10000 }
      );
      const info = JSON.parse(raw);
      const used = Number(info.Used);
      const free = Number(info.Free);
      const total = used + free;
      return { total, used, free, percent: Math.round((used / total) * 100), drive: `${drive}:` };
    } else {
      // Linux / macOS: df command
      const raw = execSync(`df -B1 "${PROJECT_DIR}" | tail -1`, { encoding: 'utf8', timeout: 10000 });
      const parts = raw.trim().split(/\s+/);
      // df -B1 output: Filesystem 1B-blocks Used Available Use% Mounted
      const total = parseInt(parts[1]);
      const used = parseInt(parts[2]);
      const free = parseInt(parts[3]);
      const percent = parseInt(parts[4]);
      return { total, used, free, percent, mount: parts[5] };
    }
  } catch (e) {
    return { total: 0, used: 0, free: 0, percent: 0, error: e.message };
  }
}

function findCleanableItems() {
  const items = [];
  const homeDir = os.homedir();
  const platform = os.platform();

  // 1. Project logs
  const logsDir = path.join(PROJECT_DIR, 'logs');
  if (fs.existsSync(logsDir)) {
    const size = getDirectorySize(logsDir);
    if (size > 1024) {
      items.push({ id: 'project-logs', label: 'Server logs', path: logsDir, size, category: 'logs', safe: true });
    }
  }

  // 2. npm cache (_npx, _logs, _cacache)
  const npmDir = path.join(homeDir, '.npm');
  for (const sub of ['_npx', '_logs', '_cacache']) {
    const p = path.join(npmDir, sub);
    if (fs.existsSync(p)) {
      const size = getDirectorySize(p);
      if (size > 10240) {
        items.push({ id: `npm-${sub}`, label: `npm ${sub} cache`, path: p, size, category: 'cache', safe: true });
      }
    }
  }

  // 3. Temp files
  const tmpDir = os.tmpdir();
  try {
    const tmpEntries = fs.readdirSync(tmpDir, { withFileTypes: true });
    let tmpCleanable = 0;
    for (const entry of tmpEntries) {
      try {
        const fp = path.join(tmpDir, entry.name);
        const stat = fs.statSync(fp);
        // Only count files/dirs older than 24h
        if (Date.now() - stat.mtimeMs > 86400000) {
          tmpCleanable += entry.isDirectory() ? getDirectorySize(fp) : stat.size;
        }
      } catch { /* permission issues */ }
    }
    if (tmpCleanable > 10240) {
      items.push({ id: 'temp-files', label: 'Temp files (>24h old)', path: tmpDir, size: tmpCleanable, category: 'temp', safe: true });
    }
  } catch { /* tmpdir inaccessible */ }

  // 4. Platform-specific caches
  if (platform === 'darwin') {
    // macOS: ~/Library/Caches
    const macCache = path.join(homeDir, 'Library', 'Caches');
    if (fs.existsSync(macCache)) {
      items.push({ id: 'mac-caches', label: 'macOS Library/Caches', path: macCache, size: -1, category: 'cache', safe: false, note: 'Scan only — manual review recommended' });
    }
  }

  // 5. node_modules/.cache
  const nmCache = path.join(PROJECT_DIR, 'node_modules', '.cache');
  if (fs.existsSync(nmCache)) {
    const size = getDirectorySize(nmCache);
    if (size > 10240) {
      items.push({ id: 'nm-cache', label: 'node_modules/.cache', path: nmCache, size, category: 'cache', safe: true });
    }
  }

  // 6. VS Code Server logs (Linux remote dev)
  if (platform === 'linux') {
    const vscodeLogs = path.join(homeDir, '.vscode-server', 'data', 'logs');
    if (fs.existsSync(vscodeLogs)) {
      const size = getDirectorySize(vscodeLogs);
      if (size > 10240) {
        items.push({ id: 'vscode-logs', label: 'VS Code Server logs', path: vscodeLogs, size, category: 'logs', safe: true });
      }
    }
  }

  // 7. VS Code workspace storage (can grow to hundreds of MB)
  if (platform === 'linux') {
    const wsStorage = path.join(homeDir, '.vscode-server', 'data', 'User', 'workspaceStorage');
    if (fs.existsSync(wsStorage)) {
      const size = getDirectorySize(wsStorage);
      if (size > 50 * 1024 * 1024) { // > 50MB
        items.push({ id: 'vscode-wsstorage', label: 'VS Code workspace storage', path: wsStorage, size, category: 'cache', safe: true });
      }
    }
  }

  // 8. VS Code CachedData
  const vscodeCached = path.join(homeDir, '.vscode-server', 'data', 'CachedData');
  if (fs.existsSync(vscodeCached)) {
    const size = getDirectorySize(vscodeCached);
    if (size > 10 * 1024 * 1024) { // > 10MB
      items.push({ id: 'vscode-cacheddata', label: 'VS Code CachedData', path: vscodeCached, size, category: 'cache', safe: true });
    }
  }

  // 9. Git garbage collection (compacts .git objects)
  const gitDir = path.join(PROJECT_DIR, '.git');
  if (fs.existsSync(gitDir)) {
    const size = getDirectorySize(gitDir);
    if (size > 20 * 1024 * 1024) { // > 20MB
      items.push({ id: 'git-gc', label: 'Git repo compaction', path: gitDir, size, category: 'cache', safe: true, note: 'Runs git gc --aggressive' });
    }
  }

  // 10. Docker unused images/containers (if docker available)
  try {
    const dockerCheck = execSync('which docker 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    if (dockerCheck) {
      try {
        const raw = execSync('docker system df --format "{{.Reclaimable}}" 2>/dev/null | head -1', { encoding: 'utf8', timeout: 10000 }).trim();
        if (raw && raw !== '0B') {
          items.push({ id: 'docker-prune', label: `Docker reclaimable: ${raw}`, path: 'docker', size: -1, category: 'cache', safe: true, note: 'Removes unused images, containers, networks' });
        }
      } catch { /* docker not running or no permission */ }
    }
  } catch { /* no docker */ }

  // 11. System journal/audit logs (Linux only)
  if (platform === 'linux') {
    for (const logPath of ['/var/log/journal', '/var/log/audit']) {
      if (fs.existsSync(logPath)) {
        try {
          const size = getDirectorySize(logPath);
          if (size > 10 * 1024 * 1024) { // > 10MB
            items.push({ id: `sys-${path.basename(logPath)}`, label: `System ${path.basename(logPath)} logs`, path: logPath, size, category: 'system-logs', safe: true, note: 'Requires elevated permissions' });
          }
        } catch { /* permission denied is expected */ }
      }
    }
  }

  return items;
}

function cleanItem(item) {
  const results = { id: item.id, success: false, freed: 0, message: '' };
  try {
    switch (item.id) {
      case 'project-logs': {
        // Truncate log files to 0, don't delete the directory
        const entries = fs.readdirSync(item.path);
        let freed = 0;
        for (const f of entries) {
          const fp = path.join(item.path, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.isFile()) {
              freed += stat.size;
              fs.writeFileSync(fp, '');
            }
          } catch { /* skip */ }
        }
        results.freed = freed;
        results.success = true;
        results.message = `Truncated log files (${formatBytes(freed)})`;
        break;
      }
      case 'npm-_npx':
      case 'npm-_logs':
      case 'npm-_cacache': {
        const size = getDirectorySize(item.path);
        fs.rmSync(item.path, { recursive: true, force: true });
        results.freed = size;
        results.success = true;
        results.message = `Removed ${item.label} (${formatBytes(size)})`;
        break;
      }
      case 'nm-cache': {
        const size = getDirectorySize(item.path);
        fs.rmSync(item.path, { recursive: true, force: true });
        results.freed = size;
        results.success = true;
        results.message = `Removed node_modules/.cache (${formatBytes(size)})`;
        break;
      }
      case 'vscode-logs': {
        const size = getDirectorySize(item.path);
        fs.rmSync(item.path, { recursive: true, force: true });
        results.freed = size;
        results.success = true;
        results.message = `Removed VS Code logs (${formatBytes(size)})`;
        break;
      }
      case 'vscode-wsstorage': {
        // Remove workspace storage entries older than 7 days
        let freed = 0;
        try {
          for (const entry of fs.readdirSync(item.path, { withFileTypes: true })) {
            const fp = path.join(item.path, entry.name);
            try {
              const stat = fs.statSync(fp);
              if (entry.isDirectory() && Date.now() - stat.mtimeMs > 7 * 86400000) {
                const size = getDirectorySize(fp);
                fs.rmSync(fp, { recursive: true, force: true });
                freed += size;
              }
            } catch { /* in-use */ }
          }
        } catch { /* permission */ }
        results.freed = freed;
        results.success = true;
        results.message = `Cleaned workspace storage (${formatBytes(freed)})`;
        break;
      }
      case 'vscode-cacheddata': {
        const size = getDirectorySize(item.path);
        fs.rmSync(item.path, { recursive: true, force: true });
        results.freed = size;
        results.success = true;
        results.message = `Removed VS Code CachedData (${formatBytes(size)})`;
        break;
      }
      case 'git-gc': {
        try {
          execSync('git gc --aggressive --prune=now 2>&1', { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 60000 });
          const sizeAfter = getDirectorySize(item.path);
          results.freed = Math.max(0, item.size - sizeAfter);
          results.success = true;
          results.message = `Git compacted (.git now ${formatBytes(sizeAfter)}, freed ${formatBytes(results.freed)})`;
        } catch (e) {
          results.message = `Git gc failed: ${e.message}`;
        }
        break;
      }
      case 'docker-prune': {
        try {
          const output = execSync('docker system prune -f 2>&1', { encoding: 'utf8', timeout: 60000 });
          results.success = true;
          results.message = `Docker pruned: ${output.trim().split('\n').pop()}`;
        } catch (e) {
          results.message = `Docker prune failed: ${e.message}`;
        }
        break;
      }

      case 'temp-files': {
        let freed = 0;
        try {
          for (const entry of fs.readdirSync(item.path, { withFileTypes: true })) {
            const fp = path.join(item.path, entry.name);
            try {
              const stat = fs.statSync(fp);
              if (Date.now() - stat.mtimeMs > 86400000) {
                const size = entry.isDirectory() ? getDirectorySize(fp) : stat.size;
                fs.rmSync(fp, { recursive: true, force: true });
                freed += size;
              }
            } catch { /* permission/in-use */ }
          }
        } catch { /* tmpdir inaccessible */ }
        results.freed = freed;
        results.success = true;
        results.message = `Cleaned temp files (${formatBytes(freed)})`;
        break;
      }
      case 'sys-journal': {
        try {
          execSync('journalctl --vacuum-size=10M 2>&1', { timeout: 15000 });
          results.success = true;
          results.message = 'Vacuumed journal logs to 10MB';
          results.freed = item.size - 10 * 1024 * 1024;
        } catch (e) {
          results.message = `Journal cleanup requires sudo: ${e.message}`;
        }
        break;
      }
      case 'sys-audit': {
        try {
          // Truncate audit.log if accessible
          const auditLog = '/var/log/audit/audit.log';
          if (fs.existsSync(auditLog)) {
            const stat = fs.statSync(auditLog);
            fs.writeFileSync(auditLog, '');
            results.freed = stat.size;
            results.success = true;
            results.message = `Truncated audit.log (${formatBytes(stat.size)})`;
          }
        } catch (e) {
          results.message = `Audit cleanup requires sudo: ${e.message}`;
        }
        break;
      }
      default:
        results.message = `No cleanup handler for ${item.id}`;
    }
  } catch (e) {
    results.message = `Cleanup failed: ${e.message}`;
  }
  return results;
}

// ── GET /api/system/health — Disk usage + cleanable items scan ──
router.get('/health', async (req, res) => {
  try {
    const disk = getDiskUsage();
    const cleanable = findCleanableItems();
    const totalCleanable = cleanable.filter(i => i.safe && i.size > 0).reduce((sum, i) => sum + i.size, 0);

    res.json({
      success: true,
      platform: os.platform(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        usedPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
      },
      disk,
      cleanable,
      totalCleanable,
      totalCleanableFormatted: formatBytes(totalCleanable),
      criticalThreshold: disk.percent >= 95,
      warningThreshold: disk.percent >= 85,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/system/cleanup — Run cleanup on selected items ──
router.post('/cleanup', async (req, res) => {
  try {
    const { itemIds } = req.body || {};
    // If no specific IDs, clean all safe items
    const allCleanable = findCleanableItems();
    const toClean = itemIds
      ? allCleanable.filter(i => itemIds.includes(i.id) && i.safe)
      : allCleanable.filter(i => i.safe && i.size > 0);

    const results = toClean.map(item => cleanItem(item));
    const totalFreed = results.reduce((sum, r) => sum + (r.freed || 0), 0);

    // Re-check disk after cleanup
    const diskAfter = getDiskUsage();

    res.json({
      success: true,
      cleaned: results,
      totalFreed,
      totalFreedFormatted: formatBytes(totalFreed),
      diskAfter,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/system/auto-cleanup — Called on server startup ──
// Runs safe cleanup if disk > 90% full. Called from server.js on boot.
router.autoCleanupOnBoot = async function () {
  const disk = getDiskUsage();
  if (disk.percent >= 90) {
    console.log(`[system-maintenance] ⚠️ Disk at ${disk.percent}% — running auto-cleanup...`);
    const cleanable = findCleanableItems().filter(i => i.safe && i.size > 0);
    let totalFreed = 0;
    for (const item of cleanable) {
      const result = cleanItem(item);
      if (result.success && result.freed > 0) {
        console.log(`[system-maintenance]   ${result.message}`);
        totalFreed += result.freed;
      }
    }
    const diskAfter = getDiskUsage();
    console.log(`[system-maintenance] ✅ Auto-cleanup freed ${formatBytes(totalFreed)} — disk now ${diskAfter.percent}%`);
    return { freed: totalFreed, diskBefore: disk, diskAfter };
  } else {
    console.log(`[system-maintenance] Disk at ${disk.percent}% — no auto-cleanup needed`);
    return null;
  }
};

// ── Scheduled cleanup — runs every hour, acts if disk > 85% ──
router.startScheduledCleanup = function () {
  const INTERVAL = 60 * 60 * 1000; // 1 hour
  const THRESHOLD = 85;
  const timer = setInterval(() => {
    try {
      const disk = getDiskUsage();
      if (disk.percent >= THRESHOLD) {
        console.log(`[system-maintenance] ⚠️ Scheduled check: disk at ${disk.percent}% (>${THRESHOLD}%) — cleaning...`);
        const cleanable = findCleanableItems().filter(i => i.safe && i.size > 0);
        let totalFreed = 0;
        for (const item of cleanable) {
          const result = cleanItem(item);
          if (result.success && result.freed > 0) {
            console.log(`[system-maintenance]   ${result.message}`);
            totalFreed += result.freed;
          }
        }
        const diskAfter = getDiskUsage();
        console.log(`[system-maintenance] ✅ Scheduled cleanup freed ${formatBytes(totalFreed)} — disk now ${diskAfter.percent}%`);
      }
    } catch (e) {
      console.error('[system-maintenance] Scheduled cleanup error:', e.message);
    }
  }, INTERVAL);
  timer.unref(); // Don't prevent process exit
  console.log(`[system-maintenance] ⏰ Scheduled disk cleanup: every 60 min (threshold: ${THRESHOLD}%)`);
  return timer;
};

export default router;
