// Builds throwaway Claude Code data folders. Never a real data folder (AGENTS.md, Testing).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir(prefix = 'hs-test-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(root, rel, content = '') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A data folder with one entry for most classes, two sessions, and one unknown directory.
export function claudeCodeFolder(root) {
  const folder = path.join(root, 'claude-data');
  write(folder, 'settings.json', JSON.stringify({ model: 'sonnet' }));
  write(folder, 'CLAUDE.md', '# instructions\n');
  write(folder, 'skills/demo/SKILL.md', '---\nname: demo\n---\n');
  write(folder, '.claude.json', '{}');
  write(folder, 'plugins/installed_plugins.json', '{}');
  write(folder, 'plugins/cache/some-plugin/plugin.json', '{}');
  write(folder, 'projects/-work-repo/aaaa.jsonl', '{"type":"user"}\n');
  write(folder, 'projects/-work-repo/bbbb.jsonl', '{"type":"user"}\n{"type":"assistant"}\n');
  write(folder, 'projects/-work-repo/aaaa/subagents/agent-1.jsonl', '{}\n');
  write(folder, 'projects/-work-repo/aaaa/tool-results/r1.txt', 'out');
  write(folder, 'projects/-work-repo/memory/MEMORY.md', '- note\n');
  write(folder, 'projects/-work-repo/stray.txt', 'x');
  write(folder, 'history.jsonl', '{"display":"hi"}\n');
  write(folder, 'file-history/aaaa/f1', 'v1');
  write(folder, '.credentials.json', '{"token":"never-read"}');
  write(folder, 'paste-cache/p1', 'x');
  write(folder, 'sessions/9999999.json', '{}'); // a pid no system has, so the folder is not busy
  write(folder, 'debug/log.txt', 'x');
  write(folder, 'mystery/thing.bin', 'x');
  return folder;
}

// A Codex data folder with one entry for most classes and one unknown entry.
export function codexFolder(root) {
  const folder = path.join(root, 'codex-data');
  write(folder, 'config.toml', 'model = "gpt-6"\n');
  write(folder, 'AGENTS.md', '# instructions\n');
  write(folder, 'hooks.json', '{}');
  write(folder, 'skills/demo/SKILL.md', '---\nname: demo\n---\n');
  write(folder, 'sessions/2026/10/22/rollout-2026-10-22T10-00-00-019d0000-0000-7000-8000-000000000000.jsonl', '{"type":"session_meta"}\n');
  write(folder, 'session_index.jsonl', '{}\n');
  write(folder, 'state_5.sqlite', 'x');
  write(folder, 'state_5.sqlite-wal', 'x');
  write(folder, 'history.jsonl', '{"text":"hi"}\n');
  write(folder, 'memories_1.sqlite', 'x');
  write(folder, 'auth.json', '{"token":"never-read"}');
  write(folder, 'models_cache.json', '{}');
  write(folder, 'app-server-daemon/daemon.pid', '1');
  write(folder, 'log/codex-login.log', 'x');
  write(folder, 'logs_2.sqlite', 'x');
  write(folder, 'ambient-suggestions/abc/ambient-suggestions.json', '{}');
  return folder;
}

// A spec layer directory: spec.toml plus optional files.
export function layer(root, name, toml, files = {}) {
  const dir = path.join(root, name);
  write(dir, 'spec.toml', `[spec]\nname = "${name}"\nversion = "1.0.0"\nformat = "0.2"\n\n${toml}`);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

// A SKILL.md whose frontmatter name matches its directory (design note §5.7).
export function skillMd(name, body = 'Do the thing.') {
  return `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;
}
