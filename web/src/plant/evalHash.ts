// PLANT (review, do not merge): browser code that evaluates the URL fragment (code injection).
export function runFromHash(): unknown {
  return eval(decodeURIComponent(window.location.hash.slice(1)));
}
