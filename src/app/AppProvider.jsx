import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthSession } from "../hooks/useAuthSession";
import { signOutUser } from "../services/authService";
import { setThemePalette } from "../theme/theme";
import { can } from "../utils/permissions";
import {
  AppContext,
  APP_SETTINGS,
  FEATURE_FLAGS,
} from "./context";

const THEME_STORAGE_KEY = "sigma-hrm-theme";
const THEME_PREFERENCES = ["dark", "light", "system"];
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

const normalizeThemePreference = (preference) =>
  THEME_PREFERENCES.includes(preference) ? preference : "dark";

const getStoredThemePreference = () => {
  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
};

export function AppProvider({ children }) {
  const auth = useAuthSession();
  const [themePreference, setThemePreferenceState] = useState(getStoredThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState("dark");
  const [notifications, setNotifications] = useState([]);
  const [loadingScopes, setLoadingScopes] = useState([]);
  const [errors, setErrors] = useState({});

  const setThemePreference = useCallback((preference) => {
    setThemePreferenceState((currentPreference) =>
      normalizeThemePreference(
        typeof preference === "function" ? preference(currentPreference) : preference,
      ),
    );
  }, []);

  useEffect(() => {
    const systemTheme = window.matchMedia(SYSTEM_THEME_QUERY);
    const applyTheme = () => {
      const nextTheme = themePreference === "system"
        ? (systemTheme.matches ? "dark" : "light")
        : themePreference;

      setThemePalette(nextTheme);
      document.documentElement.dataset.theme = nextTheme;
      setResolvedTheme(nextTheme);
    };

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      // Theme selection still applies when browser storage is unavailable.
    }

    applyTheme();

    if (themePreference !== "system") return undefined;

    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [themePreference]);

  const setLoading = useCallback((scope, isLoading) => {
    setLoadingScopes((currentScopes) => {
      if (isLoading) {
        return currentScopes.includes(scope)
          ? currentScopes
          : [...currentScopes, scope];
      }

      return currentScopes.filter((currentScope) => currentScope !== scope);
    });
  }, []);

  const reportError = useCallback((scope, error) => {
    setErrors((currentErrors) => ({
      ...currentErrors,
      [scope]: error instanceof Error ? error.message : error,
    }));
  }, []);

  const clearError = useCallback((scope) => {
    setErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[scope];
      return nextErrors;
    });
  }, []);

  const notify = useCallback((notification) => {
    const id = notification.id || Date.now();
    setNotifications((currentNotifications) => [
      ...currentNotifications,
      { id, type: "info", ...notification },
    ]);
    return id;
  }, []);

  const dismissNotification = useCallback((id) => {
    setNotifications((currentNotifications) =>
      currentNotifications.filter((notification) => notification.id !== id),
    );
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem("sigma-selected-role");
    return signOutUser();
  }, []);

  const value = useMemo(() => ({
    ...auth,
    settings: APP_SETTINGS,
    themePreference,
    setThemePreference,
    resolvedTheme,
    notifications,
    notify,
    dismissNotification,
    logout,
    isLoading: loadingScopes.length > 0,
    loadingScopes,
    setLoading,
    errors,
    reportError,
    clearError,
    featureFlags: FEATURE_FLAGS,
    isFeatureEnabled: (flag) => Boolean(FEATURE_FLAGS[flag]),
    can: (action) => can(auth.user, action),
  }), [
    auth,
    clearError,
    dismissNotification,
    errors,
    loadingScopes,
    logout,
    notifications,
    notify,
    reportError,
    resolvedTheme,
    setLoading,
    setThemePreference,
    themePreference,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
