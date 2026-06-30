/**
 * [INPUT]: 依赖原文字符串、目标文本与粗略 offset
 * [OUTPUT]: 对外提供 findBestFuzzyMatch，用于轻微改动后的文本锚点恢复
 * [POS]: anchor 模块的容错匹配器，被 textAnchor 调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export interface FuzzyMatchResult {
  startOffset: number;
  endOffset: number;
  confidence: number;
}

export function findBestFuzzyMatch(
  source: string,
  target: string,
  expectedStart: number,
): FuzzyMatchResult | null {
  const needle = normalize(target);
  if (!needle) {
    return null;
  }

  const exact = source.indexOf(target);
  if (exact >= 0) {
    return {
      startOffset: exact,
      endOffset: exact + target.length,
      confidence: 1,
    };
  }

  const radius = Math.max(300, target.length * 8);
  const windowStart = Math.max(0, expectedStart - radius);
  const windowEnd = Math.min(source.length, expectedStart + radius + target.length);
  const local = scanWindow(source, target, windowStart, windowEnd);
  if (local && local.confidence >= 0.6) {
    return local;
  }

  return scanWindow(source, target, 0, source.length);
}

function scanWindow(
  source: string,
  target: string,
  windowStart: number,
  windowEnd: number,
): FuzzyMatchResult | null {
  const targetLength = target.length;
  const minLength = Math.max(1, Math.floor(targetLength * 0.75));
  const maxLength = Math.max(minLength, Math.ceil(targetLength * 1.35));
  let best: FuzzyMatchResult | null = null;

  for (let start = windowStart; start < windowEnd; start += Math.max(1, Math.floor(targetLength / 8))) {
    for (let length = minLength; length <= maxLength; length += Math.max(1, Math.floor(targetLength / 6))) {
      const end = Math.min(source.length, start + length);
      if (end <= start) {
        continue;
      }

      const candidate = source.slice(start, end);
      const confidence = similarity(target, candidate);
      if (!best || confidence > best.confidence) {
        best = { startOffset: start, endOffset: end, confidence };
      }
    }
  }

  return best && best.confidence >= 0.55 ? best : null;
}

function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) {
    return 0;
  }

  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}
