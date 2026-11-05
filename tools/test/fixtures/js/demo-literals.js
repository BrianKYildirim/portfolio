// Fixture for scanJsLines: user-visible demo string literals (read by tests, never loaded by a page).
const RUNS = [
  { label: '10 s' }, // claim-waiver: run-length option label, not a measurement
  { label: '30 s' },
  { label: '60 s' }, // claim-waiver: TBD
];
const LINK = 'https://x//10 ms';
// A comment that mentions 99 ms is not shown to visitors.
const TIP = 'up to 6 MB'; /* 7 ms in a block comment */
const HTML = `<p class="demo-small">Last <b>10</b> s · 1024 bytes per recv()</p>`;
const X = 5; // 12 ms in a trailing comment
const PLAIN = 'no figures here';
