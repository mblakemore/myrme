/**
 * All tuning numbers (§5.1). DECISION: to let parallel streams edit balance without touching a
 * shared file, each section lives in `data/balance/<stream>.ts`; this barrel only composes them.
 * Streams edit their own section file, never this one.
 */
import { a2aBalance } from './balance/a2a';
import { a2bBalance } from './balance/a2b';
import { b1Balance } from './balance/b1';
import { b2Balance } from './balance/b2';
import { b3Balance } from './balance/b3';
import { coreBalance } from './balance/core';

export const BALANCE = {
  core: coreBalance,
  a2a: a2aBalance,
  a2b: a2bBalance,
  b1: b1Balance,
  b2: b2Balance,
  b3: b3Balance,
} as const;
