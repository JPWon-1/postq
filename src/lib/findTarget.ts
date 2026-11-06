/** Candidates already belong to the visible, topmost modal scope (or document). */
export function selectFindTarget<T>(candidates: ReadonlyArray<{ value: T; top: number; interaction: number }>): T | undefined {
  return candidates.reduce<(typeof candidates)[number] | undefined>((best, candidate) => {
    if (!best || candidate.interaction > best.interaction ||
      (candidate.interaction === best.interaction && candidate.top < best.top)) return candidate
    return best
  }, undefined)?.value
}
