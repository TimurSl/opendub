// Packs (the clips you download from the Workshop) that players voted for come first: most votes on
// top, ties and unvoted packs keep their original order. Pure, so the host's grid, the players' list
// and the tests share one rule. `votes` is { packId: { count } }.
export function rankPacks(packs, votes = {}) {
  return packs
    .map((pack, index) => ({ pack, index, count: votes[pack.id]?.count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
}
