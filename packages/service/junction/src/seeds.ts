/**
 * Seeds that have previously reproduced a real/mock divergence in the Junction parity suite.
 *
 * Every seed here is replayed on each live parity run so that past bug fixes stay fixed. Add a
 * new seed whenever a parity run fails — the seed is printed on the `FC_SEED=<seed> to replay`
 * line of the failure output.
 */
export const PARITY_SEEDS: readonly number[] = [2058813869, 2061032686, 10416389]
