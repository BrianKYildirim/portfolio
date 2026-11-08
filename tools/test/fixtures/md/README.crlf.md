# Fixture README (CRLF)

A FastClock read took about <!-- claim:rl.fixture.clock_fast --> 10.2 ns per call, amortized.
A steady_clock read took about 16 ns.

| Keys | Bytes per key |
|---:|---:|
| 700,000 | ~97 |

An upload is capped at <!-- claim-waiver: --> 6 MB.

<!-- bench-methodology:begin -->
- Warm-up: none needed.
- Timer: steady_clock.
- Repetitions: 10 runs.
- Noise control: an idle machine.
<!-- bench-methodology:end -->

<!-- claim-waiver-begin: example output -->
took 31 ns
