import assert from "node:assert/strict";
import test from "node:test";
import { getCompanyTimezone } from "../src/config/env.js";
import { todayInTimeZone } from "../src/utils/companyDate.js";

// COMPANY_TIMEZONE is required with no default (D27): a missing or misspelled value must fail
// loudly instead of silently falling back to a zone that would wrongly accept or reject a
// day's attendance. env.js loads backend/.env on import, so every case sets or clears the
// variable explicitly and restores whatever was there.

function withTimezone(value, fn) {
  const previous = process.env.COMPANY_TIMEZONE;
  if (value === undefined) delete process.env.COMPANY_TIMEZONE;
  else process.env.COMPANY_TIMEZONE = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.COMPANY_TIMEZONE;
    else process.env.COMPANY_TIMEZONE = previous;
  }
}

test("getCompanyTimezone: a valid IANA name is returned as given", () => {
  assert.equal(withTimezone("Asia/Karachi", getCompanyTimezone), "Asia/Karachi");
  assert.equal(withTimezone("America/Los_Angeles", getCompanyTimezone), "America/Los_Angeles");
  assert.equal(withTimezone("UTC", getCompanyTimezone), "UTC");
});

test("getCompanyTimezone: surrounding whitespace is trimmed", () => {
  assert.equal(withTimezone("  Asia/Karachi  ", getCompanyTimezone), "Asia/Karachi");
});

test("getCompanyTimezone: unset fails loudly -- there is no default", () => {
  assert.throws(() => withTimezone(undefined, getCompanyTimezone), /COMPANY_TIMEZONE must be set/);
});

test("getCompanyTimezone: blank or whitespace-only fails loudly", () => {
  assert.throws(() => withTimezone("", getCompanyTimezone), /COMPANY_TIMEZONE must be set/);
  assert.throws(() => withTimezone("   ", getCompanyTimezone), /COMPANY_TIMEZONE must be set/);
});

test("getCompanyTimezone: a misspelled zone fails loudly and names the bad value", () => {
  assert.throws(() => withTimezone("Asia/Karchi", getCompanyTimezone), /"Asia\/Karchi" is not a valid IANA timezone/);
  assert.throws(() => withTimezone("Karachi", getCompanyTimezone), /not a valid IANA timezone/);
  assert.throws(() => withTimezone("Not/AZone", getCompanyTimezone), /not a valid IANA timezone/);
});

test("getCompanyTimezone: a UTC-offset form is rejected -- it is not an IANA name", () => {
  assert.throws(() => withTimezone("+05:00", getCompanyTimezone), /not a valid IANA timezone/);
  assert.throws(() => withTimezone("-08:00", getCompanyTimezone), /not a valid IANA timezone/);
});

test("todayInTimeZone: Karachi is UTC+5 and crosses midnight five hours before UTC does", () => {
  assert.equal(todayInTimeZone(new Date("2026-10-02T18:59:59Z"), "Asia/Karachi"), "2026-10-02");
  assert.equal(todayInTimeZone(new Date("2026-10-02T19:00:00Z"), "Asia/Karachi"), "2026-10-03");
  assert.equal(todayInTimeZone(new Date("2026-10-02T19:00:00Z"), "UTC"), "2026-10-02");
  assert.equal(todayInTimeZone(new Date("2026-10-03T00:00:00Z"), "UTC"), "2026-10-03");
});

test("todayInTimeZone: a zone behind UTC lags it", () => {
  // 2026-10-03T03:00Z is 20:00 on Oct 2 in Los Angeles (UTC-7 in October).
  assert.equal(todayInTimeZone(new Date("2026-10-03T03:00:00Z"), "America/Los_Angeles"), "2026-10-02");
});

test("todayInTimeZone: always YYYY-MM-DD, zero-padded, so string comparison orders dates", () => {
  const today = todayInTimeZone(new Date("2026-01-05T12:00:00Z"), "Asia/Karachi");
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(today, "2026-01-05");
  assert.ok("2026-01-05" < "2026-01-10" && "2026-01-10" < "2026-02-01");
});
