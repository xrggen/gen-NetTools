import { diffArrays } from 'diff';
import type { ConfigRow } from '../shared/contracts';

function lines(text: string) { return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? []; }

export function compareConfig(before: string, after: string) {
  const left = lines(before);
  const right = lines(after);
  const changes = diffArrays(left, right, { timeout: 4000, maxEditLength: 3000 });
  const rows: ConfigRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  function emit(removed: number, added: number, positionOnly = false) {
    for (let i = 0; i < Math.max(removed, added); i++) {
      const hasLeft = i < removed;
      const hasRight = i < added;
      if (positionOnly && hasLeft && hasRight && left[leftIndex + i] === right[rightIndex + i]) continue;
      rows.push({ change: hasLeft && hasRight ? 'modified' : hasLeft ? 'removed' : 'added',
        beforeLine: hasLeft ? leftIndex + i + 1 : undefined, afterLine: hasRight ? rightIndex + i + 1 : undefined,
        before: hasLeft ? left[leftIndex + i] : undefined, after: hasRight ? right[rightIndex + i] : undefined });
    }
    leftIndex += removed;
    rightIndex += added;
  }
  if (changes) {
    let removed = 0;
    let added = 0;
    for (const change of changes) {
      if (change.removed) removed += change.count;
      else if (change.added) added += change.count;
      else { emit(removed, added); removed = added = 0; leftIndex += change.count; rightIndex += change.count; }
    }
    emit(removed, added);
  } else {
    while (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) { leftIndex++; rightIndex++; }
    let leftEnd = left.length;
    let rightEnd = right.length;
    while (leftEnd > leftIndex && rightEnd > rightIndex && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; }
    // Keep all differing lines available even when aligning them would take too long.
    emit(leftEnd - leftIndex, rightEnd - rightIndex, true);
  }
  return { rows, alignmentLimited: !changes };
}
