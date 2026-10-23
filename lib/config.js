// Global opencode.json editor with timestamped backups.
// The OpenCode config PATCH endpoint only covers `shell`, so all other config
// mutations are applied by editing the file and triggering /api/location/reload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocConfigDir } from './opencode.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = path.join(here, '..', 'data');
export const backupsDir = path.join(dataDir, 'backups');
export const artifactsDir = path.join(dataDir, 'artifacts');

export function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
}

export function configPath() {
  return path.join(ocConfigDir(), 'opencode.json');
}

export function readConfig() {
  const p = configPath();
  const exists = fs.existsSync(p);
  const text = exists ? fs.readFileSync(p, 'utf8') : '{}';
  return { path: p, exists, text, jsonc: text !== stripJsonc(text) };
}

// tolerant JSONC handling — comments + trailing commas are valid in opencode configs
export function stripJsonc(text) {
  return String(text)
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
    .replace(/,(\s*[}\]])/g, '$1');
}

export function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonc(text));
    } catch (e2) {
      const err = new Error('Config is not valid JSON/JSONC: ' + e2.message);
      err.code = 'CONFIG_PARSE';
      throw err;
    }
  }
}

export function backupConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `opencode.${stamp}.json`);
  fs.copyFileSync(p, dest);
  // keep newest 30
  const list = fs.readdirSync(backupsDir).sort().reverse();
  for (const stale of list.slice(30)) {
    try { fs.unlinkSync(path.join(backupsDir, stale)); } catch { /* ignore */ }
  }
  return dest;
}

export function writeConfig(newText) {
  parseConfig(newText); // validate before touching disk
  const backup = backupConfig();
  fs.writeFileSync(configPath(), newText.endsWith('\n') ? newText : newText + '\n', 'utf8');
  return { path: configPath(), backup };
}

export function listBackups() {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter(f => f.endsWith('.json')).sort().reverse();
}

export function restoreBackup(file /* basename only */) {
  const safe = path.basename(String(file || ''));
  if (!/^opencode\..+\.json$/.test(safe)) throw Object.assign(new Error('bad backup name'), { code: 'EINVAL' });
  const full = path.join(backupsDir, safe);
  if (!fs.existsSync(full)) throw Object.assign(new Error('backup not found'), { code: 'ENOENT' });
  const safetyBackup = backupConfig();
  const text = fs.readFileSync(full, 'utf8');
  fs.writeFileSync(configPath(), text.endsWith('\n') ? text : text + '\n', 'utf8');
  return { path: configPath(), restoredFrom: full, safetyBackup };
}
