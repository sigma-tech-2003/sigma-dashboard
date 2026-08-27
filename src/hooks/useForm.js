import { useCallback, useState } from "react";

export function useForm({ initialValues = {}, validate } = {}) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle");
  const [submitError, setSubmitError] = useState("");

  const setFieldValue = useCallback((name, value) => {
    setValues((currentValues) => ({ ...currentValues, [name]: value }));
    setErrors((currentErrors) => {
      if (!currentErrors[name]) return currentErrors;

      const remainingErrors = { ...currentErrors };
      delete remainingErrors[name];
      return remainingErrors;
    });
  }, []);

  const reset = useCallback((nextValues = initialValues) => {
    setValues(nextValues);
    setErrors({});
    setStatus("idle");
    setSubmitError("");
  }, [initialValues]);

  const validateForm = useCallback(() => {
    const nextErrors = validate ? validate(values) : {};
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }, [validate, values]);

  const submit = useCallback(async (onSubmit) => {
    setSubmitError("");
    if (!validateForm()) return false;

    setStatus("submitting");
    try {
      await onSubmit(values);
      setStatus("success");
      return true;
    } catch (error) {
      setStatus("error");
      setSubmitError(error?.message || "Unable to submit this form. Please try again.");
      return false;
    }
  }, [validateForm, values]);

  return {
    values,
    errors,
    status,
    isSubmitting: status === "submitting",
    isSuccess: status === "success",
    submitError,
    setFieldValue,
    setValues,
    setErrors,
    reset,
    validateForm,
    submit,
  };
}
