// A list whose rows can leave gracefully. When an item disappears from the data (a leave request that was just decided),
// it stays in the list, marked `exiting`, so it can play its exit animation, and the view removes it once that is done.
// An item that comes back before it has gone is simply no longer exiting. Items keep their place in the order.

export const mergePresence = (previous, items, keyOf) => {
  const current = new Map(items.map((item) => [keyOf(item), item]));
  const out = [];
  const seen = new Set();

  previous.forEach((entry) => {
    if (current.has(entry.key)) {
      out.push({ key: entry.key, item: current.get(entry.key), exiting: false });
      seen.add(entry.key);
    } else {
      out.push(entry.exiting ? entry : { ...entry, exiting: true });
    }
  });
  items.forEach((item) => {
    const key = keyOf(item);
    if (!seen.has(key)) out.push({ key, item, exiting: false });
  });
  return out;
};

export const removeEntry = (list, key) => list.filter((entry) => entry.key !== key);
