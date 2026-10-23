// Skills management on the global skills directory:
// ~/.config/opencode/skills/<name>/SKILL.md (frontmatter:name,description)
import fs from 'node:fs';
import path from 'node:path';
import { ocConfigDir } from './opencode.js';

const skillsRoot = () => path.join(ocConfigDir(), 'skills');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,48}$/;

export function listSkills() {
  const root = skillsRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const md = path.join(root, dir.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    const { front, body } = splitFrontmatter(fs.readFileSync(md, 'utf8'));
    out.push({
      id: dir.name,
      name: front.name || dir.name,
      description: front.description || '',
      dir: path.join(root, dir.name),
      file: md,
      body,
      lines: body.split('\n').length,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function splitFrontmatter(text) {
  const m = text.match(/^\uFEFF?---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) front[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { front, body: text.slice(m[0].length).replace(/^\n*/, '') };
}

export function readSkill(id) {
  const file = path.join(skillsRoot(), path.basename(id), 'SKILL.md');
  if (!fs.existsSync(file)) throw Object.assign(new Error('skill not found'), { code: 'ENOENT' });
  return { id: path.basename(id), file, content: fs.readFileSync(file, 'utf8') };
}

export function writeSkill(id, content) {
  if (!NAME_RE.test(id)) throw Object.assign(new Error(`skill id must match ${NAME_RE}`), { code: 'EINVAL' });
  const dir = path.join(skillsRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content.endsWith('\n') ? content : content + '\n', 'utf8');
  return { id, file: path.join(dir, 'SKILL.md') };
}

export function createSkill(id, { description = '', body = '' } = {}) {
  if (!NAME_RE.test(id)) throw Object.assign(new Error(`skill id must match ${NAME_RE}`), { code: 'EINVAL' });
  const dir = path.join(skillsRoot(), id);
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) throw Object.assign(new Error('skill already exists'), { code: 'EEXIST' });
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${id}\ndescription: ${description || `Skill ${id}`}\n---\n\n${body || '# ' + id + '\n\nInstructions for the agent.'}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return { id, file: path.join(dir, 'SKILL.md') };
}

export function deleteSkill(id) {
  if (!NAME_RE.test(id)) throw Object.assign(new Error(`skill id must match ${NAME_RE}`), { code: 'EINVAL' });
  const dir = path.join(skillsRoot(), id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('skill not found'), { code: 'ENOENT' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { id, deleted: true };
}
