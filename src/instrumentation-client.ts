// React's development RSC profiler can leave an aborted/errored component's
// end time at -Infinity (or below zero after translating the server clock).
// Remove when Next.js includes https://github.com/react/react/issues/37561.
if (process.env.NODE_ENV === "development") {
  const measure = performance.measure.bind(performance);

  performance.measure = (name, startOrOptions, endMark) => {
    if (
      name.startsWith("\u200b") &&
      typeof startOrOptions === "object" &&
      startOrOptions !== null &&
      startOrOptions.detail?.devtools?.trackGroup === "Server Components ⚛" &&
      typeof startOrOptions.end === "number" &&
      startOrOptions.end < 0
    ) {
      // Record an empty span when React has no usable end time. Keep native
      // validation for all other measurements and preserve profiler metadata.
      return measure(name, {
        ...startOrOptions,
        end: typeof startOrOptions.start === "number" ? Math.max(0, startOrOptions.start) : 0,
      });
    }

    return measure(name, startOrOptions, endMark);
  };
}
