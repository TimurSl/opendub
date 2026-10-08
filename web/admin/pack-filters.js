export function filterPacks(packs, { title = '', minimum = null, maximum = null } = {}) {
  const query = String(title).trim().toLocaleLowerCase();
  return packs.filter(pack => {
    const packTitle = String(pack.metadata?.title || pack.id).toLocaleLowerCase();
    const characterCount = pack.characterCount ?? pack.characters?.length ?? 0;
    return packTitle.includes(query)
      && (minimum === null || characterCount >= minimum)
      && (maximum === null || characterCount <= maximum);
  });
}
