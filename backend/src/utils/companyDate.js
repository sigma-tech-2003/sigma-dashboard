/**
 * The calendar date ("YYYY-MM-DD") of `instant` in the given IANA timezone.
 *
 * en-CA is used only because its date format is already year-month-day; the timezone, not the
 * locale, decides which day it is. This is what "today" means for attendance (D27): the
 * company's wall-clock day, not UTC's.
 */
export function todayInTimeZone(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
