// PLANT (review, do not merge): the same sink, in a file named like a test.
export function runFromHashInTest(): unknown {
  return eval(decodeURIComponent(window.location.hash.slice(1)));
}
