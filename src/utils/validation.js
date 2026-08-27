export const required = (message = "This field is required.") => (value) =>
  value === undefined || value === null || String(value).trim() === "" ? message : "";

export const email = (message = "Enter a valid email address.") => (value) =>
  value && !/^\S+@\S+\.\S+$/.test(value) ? message : "";

export const minLength = (length, message) => (value) =>
  value && String(value).length < length
    ? message || `Enter at least ${length} characters.`
    : "";

export function validateFields(values, rules) {
  return Object.entries(rules).reduce((errors, [field, validators]) => {
    const validationList = Array.isArray(validators) ? validators : [validators];
    const message = validationList
      .map((validator) => validator(values[field], values))
      .find(Boolean);

    if (message) errors[field] = message;
    return errors;
  }, {});
}
