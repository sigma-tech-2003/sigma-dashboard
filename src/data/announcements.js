// src/data/announcements.js
// Lightweight static announcements feed. There's no `announcements` Firestore
// collection yet — when that module is built, swap this out for a
// useAnnouncements() hook following the same pattern as useDepartments().
export const ANNOUNCEMENTS = [
  { id: 1, title: "Q1 Performance Reviews Starting", date: "2025-04-01", body: "Quarterly performance reviews begin next week — make sure your KPIs are up to date before then." },
  { id: 2, title: "Public Holiday Notice", date: "2025-03-31", body: "Offices will remain closed for the public holiday. Normal operations resume the next working day." },
  { id: 3, title: "Updated Leave Policy", date: "2025-03-15", body: "The leave policy has been refreshed for this year — reach out to HR if you have questions." },
];
