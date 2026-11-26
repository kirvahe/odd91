# Frozen core v1.1.0 (reference for tests)

An unmodified copy of `src/core` at tag `v1.1.0` (`git archive v1.1.0 src/core`).
The v1.1.1 tests compare the faster fine-kernel path against it: at most 1 code
on at most 1e-5 of the values (paired taps change the float summation order, so
a few dithered values may move to the neighbouring code). Never edit these files.
