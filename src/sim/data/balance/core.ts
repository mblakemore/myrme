/** Balance: orchestrator-owned basics used by the M0 skeleton (brain cadence, fixture). */
export const coreBalance = {
  /** Brain think interval range in ticks (0.2–0.5 s, §5.2). */
  thinkMinTicks: 6,
  thinkMaxTicks: 15,
  /** Default ant count of the wander fixture. */
  fixtureAnts: 200,
  /** Sprint multiplier while possessed (D14). */
  possessSprint: 1.8,
};
