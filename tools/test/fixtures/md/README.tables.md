# Fixture README (tables)

**Clock.** A FastClock read took about <!-- claim:rl.fixture.clock_fast --> 10.2 ns per call, amortized, over <!-- claim:rl.fixture.clock_fast#n --> 10 runs.

**An example run.** Calls per second, the median of 10 runs with the lowest and highest in parentheses.

<!-- claims-table:begin id=rl.fixture.example_run -->
| Scenario | 1 thread |
|---|---:|
| One hot key, every call allowed (`Hot_Allowed`) | 36.3M (31.0–37.3M) |
| One hot key, almost every call denied (`Hot_Denied`) | 44.5M (41.5–45.2M) |
<!-- claims-table:end -->

A test image is <!-- claim-waiver: dimension of a test input, not a measurement --> 12000 × 12000 pixels, and uploads are capped at <!-- claim-waiver: configuration limit, not a measurement --> 6 MB.

<!-- claim-waiver-begin: example trace output, not a result -->
```text
allow key_1 -> allowed, took 31 ns
```
<!-- claim-waiver-end -->

## Methodology

<!-- bench-methodology:begin -->
- **Warm-up:** Google Benchmark runs each scenario until its timing is stable before it records anything.
- **Timer:** `FastClock`, checked against `std::chrono::steady_clock` on the same machine.
- **Repetitions:** 10 runs per scenario, interleaved; each figure is the median with the lowest and highest run.
- **Outliers:** none removed; every run is kept.
- **Noise control:** the machine was otherwise idle, on AC power, with the Balanced power plan.
<!-- bench-methodology:end -->
