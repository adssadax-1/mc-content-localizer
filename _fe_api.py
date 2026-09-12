# -*- coding: utf-8 -*-
import re

p = "src/api.ts"
s = open(p, encoding="utf-8").read()

old = '''  /** 会话缓存：崩溃/关闭后恢复内容包列表 */
  saveSessionCache: (content: string) => invoke<void>("save_session_cache", { content }),
  loadSessionCache: () => invoke<string | null>("load_session_cache"),
  clearSessionCache: () => invoke<void>("clear_session_cache"),'''
new = '''  /** 会话缓存：崩溃/关闭后恢复内容包列表（name: free / gamedir 两种模式独立） */
  saveSessionCache: (name: string, content: string) =>
    invoke<void>("save_session_cache", { name, content }),
  loadSessionCache: (name: string) => invoke<string | null>("load_session_cache", { name }),
  clearSessionCache: (name: string) => invoke<void>("clear_session_cache", { name }),
  /** 游戏目录模式：扫描 .minecraft / versions（后台 + 进度事件，可取消） */
  scanGameDir: (root: string) => invoke<GameDirScan>("scan_game_dir", { root }),
  cancelGameScan: () => invoke<void>("cancel_game_scan"),'''
assert old in s, "cache"
s = s.replace(old, new)

m = re.search(r'import type \{[^}]*\} from "\./types";', s)
assert m, "types import"
if "GameDirScan" not in m.group(0):
    s = s[:m.end() - 1] + "\n  type GameDirScan," + s[m.end() - 1]

probe = "/** 监听翻译进度事件 */"
assert probe in s
s = s.replace(probe, '''/** 监听游戏目录扫描进度 */
export async function onGameScanProgress(
  handler: (p: { done: number; total: number; current: string }) => void,
): Promise<UnlistenFn> {
  return listen("game-scan-progress", (e) => handler(e.payload));
}

''' + probe, 1)

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("api done")
