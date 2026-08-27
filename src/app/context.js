import { createContext } from "react";

export const AppContext = createContext(null);

export const APP_SETTINGS = Object.freeze({
  appName: "SIGMA HRM Portal",
  locale: "en-PK",
  currency: "PKR",
  dateFormat: "en-GB",
});

export const FEATURE_FLAGS = Object.freeze({});
