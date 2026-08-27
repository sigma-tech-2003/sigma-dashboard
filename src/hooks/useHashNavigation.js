import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_ROUTE_ID,
  getRouteById,
  getRouteByPath,
} from "../config/routes";

const getRouteIdFromHash = () => {
  const path = window.location.hash.slice(1);
  return getRouteByPath(path)?.id || DEFAULT_ROUTE_ID;
};

export function useHashNavigation() {
  const [routeId, setRouteId] = useState(getRouteIdFromHash);

  useEffect(() => {
    const handleHashChange = () => setRouteId(getRouteIdFromHash());
    window.addEventListener("hashchange", handleHashChange);

    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = useCallback((nextRouteId) => {
    const { path } = getRouteById(nextRouteId) || {};
    if (!path) return;

    if (window.location.hash.slice(1) === path) {
      setRouteId(nextRouteId);
    } else {
      window.location.hash = path;
    }
  }, []);

  return { routeId, navigate };
}
