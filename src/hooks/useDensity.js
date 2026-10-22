import { useCallback, useEffect, useState } from "react";
import { applyDensity, readDensity, writeDensity } from "../utils/density";

export const useDensity = () => {
  const [density, setDensityState] = useState(() => readDensity(window.localStorage));

  useEffect(() => {
    applyDensity(document.documentElement, density);
  }, [density]);

  const setDensity = useCallback((next) => {
    writeDensity(window.localStorage, next);
    setDensityState(readDensity(window.localStorage));
  }, []);

  return [density, setDensity];
};
