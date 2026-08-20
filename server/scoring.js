/**
 * Server-authoritative scoring formula.
 *
 * Scoring Principles:
 * - Base points for finishing: 500
 * - Time bonus (max 250 points): Proportional to remaining time relative to the time limit.
 * - Click bonus (max 250 points): Proportional to path efficiency (expected optimal / actual clicks).
 * - Maximum total score for a round: 1000
 * - Time out: 0 points
 * - Give up: 0 points
 * - Scores are deterministic, calculated server-side, and non-negative.
 *
 * @param {number} t Time taken in seconds.
 * @param {number} T_max Round time limit in seconds.
 * @param {number} c Number of navigation clicks.
 * @param {number} c_min Expected/optimal path length (default: 2 since we validate a 2-hop path).
 * @returns {number} Integer score between 0 and 1000.
 */
function calculateScore(t, T_max, c, c_min = 2) {
  if (t === null || t === undefined || t >= T_max || c <= 0) {
    return 0;
  }

  // Base completion score
  const base = 500;

  // Time contribution (0 to 250 points)
  // Closer to 0s = higher score, closer to T_max = lower score
  const timeFactor = Math.max(0, Math.min(1, 1 - (t / T_max)));
  const timeBonus = 250 * timeFactor;

  // Click efficiency contribution (0 to 250 points)
  // c_min is the target clicks. If player takes more clicks, factor decreases (e.g. 2/3, 2/4).
  // Math.min(1, ...) handles the edge case where the player takes fewer clicks than c_min.
  const clickFactor = Math.max(0, Math.min(1, c_min / c));
  const clickBonus = 250 * clickFactor;

  const score = Math.round(base + timeBonus + clickBonus);

  // Return score capped between 0 and 1000
  return Math.max(0, Math.min(1000, score));
}

module.exports = {
  calculateScore
};
