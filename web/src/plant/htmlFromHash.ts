// PLANT (review, do not merge): DOM-based XSS, URL fragment into innerHTML.
export function showHash(): void {
  const el = document.getElementById('plant');
  if (el) el.innerHTML = decodeURIComponent(window.location.hash.slice(1));
}
