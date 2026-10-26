import { useCallback, useState } from "react";
import { mergePresence, removeEntry } from "../utils/presence";

// Renders `items` but lets removed ones linger, marked `exiting`, until the view calls `remove(key)` after their exit.
// Returns { entries: [{ key, item, exiting }], remove }. The merge happens while rendering (React's recommended way to
// derive state from changing input), keyed on the list of keys so ordinary data refreshes do not reshuffle anything.
export const usePresenceList = (items, keyOf) => {
  const signature = items.map(keyOf).join("|");
  const [state, setState] = useState(() => ({ signature, list: mergePresence([], items, keyOf) }));

  let list = state.list;
  if (state.signature !== signature) {
    list = mergePresence(state.list, items, keyOf);
    setState({ signature, list });
  }

  const remove = useCallback((key) => setState((current) => ({ ...current, list: removeEntry(current.list, key) })), []);
  const latest = new Map(items.map((item) => [keyOf(item), item]));
  const entries = list.map((entry) => (entry.exiting ? entry : { ...entry, item: latest.get(entry.key) ?? entry.item }));

  return { entries, remove };
};
