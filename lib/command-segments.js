import { resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * v0.7.28：命令正文的**分段器**（保留分隔符）。
 *
 * 为什么单独一个文件、且不复用 `lib/dangerous-commands.js` 的 `splitSubCommands`：
 * 那个函数只给「段文本」，**丢掉分隔符**；而工作区档的新判据需要知道「这一段是不是
 * 管道右侧」（`curl x | sh` 的 `sh` 必须转人工，`echo a | head` 则不必）。
 * 两份实现的分段口径**必须**一致，故这里逐字复刻它的扫描规则：
 *   · `;` `|` `||` `&` `&&` 与换行切段；
 *   · 单/双引号内部不切 `;` `|` `&`（反斜杠转义按"前一个字符不是 `\`"粗略处理）；
 *   · **换行一律切段并重置引号状态**（与那边 v0.7.14 的裁定逐字一致：
 *     `bash -c "true` ⏎ `rm -rf /tmp/x"` 的第二行必须独立判定）。
 * 与那边的唯一差别是返回值：`[{ text, sep }]`，`sep` 是**本段之前**的那个分隔符
 * （首段为 `'start'`），供调用方判"管道右侧"。
 *
 * 纯词法、无 IO（除家目录展开外）—— 可被 `permission-rules.js` 直接单测。
 *
 * @param {string} text 命令正文
 * @returns {{text: string, sep: 'start'|';'|'|'|'||'|'&'|'&&'|'\n'}[]}
 */
export function splitCommandSegments(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  let buffer = ''
  let quote = ''
  let pending = 'start'
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    // 换行是 shell 的命令分隔符，**引号里也切**并重置引号状态（见文件头）。
    if (ch === '\n') {
      out.push({ text: buffer, sep: pending })
      buffer = ''
      quote = ''
      pending = '\n'
      continue
    }
    if (quote) {
      buffer += ch
      if (ch === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      let sep = ch
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) {
        sep = ch + ch
        i += 1
      }
      out.push({ text: buffer, sep: pending })
      buffer = ''
      pending = sep
      continue
    }
    buffer += ch
  }
  out.push({ text: buffer, sep: pending })
  return out
}

/**
 * v0.7.28：`cd <target>` 的**单一折算口径**（`executeScopeOf` 与
 * `segmentScopeOf` 共用，避免两处各写一份在引号/`~`/`-` 上漂移）。
 *
 * 与 v0.7.23 起 `executeScopeOf` 的既有语义逐字一致：
 *   · 空目标（`cd` 回家目录）与 `cd -`（OLDPWD）⇒ `null`（判不出）；
 *   · `~` / `~/x` / `~\x` 按家目录展开，其余原样；
 *   · 以 `resolve` 折算，非法字节 ⇒ `null`。
 *
 * @param {string|null} cwd 折算基准（上一段的生效目录）
 * @param {string} raw `cd` 的目标 token（可带成对引号）
 * @returns {string|null} 绝对路径；判不出时 null
 */
export function foldCdTarget(cwd, raw) {
  const target = typeof raw === 'string' ? raw.replace(/^["']|["']$/g, '') : ''
  if (!target || target === '-') return null
  if (typeof cwd !== 'string' || !cwd) return null
  const expanded = target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    ? homedir() + target.slice(1)
    : target
  try {
    return resolve(cwd, expanded)
  } catch {
    return null
  }
}
