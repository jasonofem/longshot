#!/usr/bin/env node
/**
 * bin/longshot.mjs — LONGSHOT command-line interface.
 *
 * Usage:
 *   node bin/longshot.mjs week --stake-max 500 --goal 3
 *   node bin/longshot.mjs scan --date 2026-10-15
 *   node bin/longshot.mjs status
 *   node bin/longshot.mjs settle 0 won
 */

import { parseArgs } from 'node:util';
import { createWeek, settleTicket, formatNaira, computeWeekStats } from '../lib/longshot.js';
import { scanForDay, scanDayLive } from '../lib/scan.js';
import { DEFAULT_STAKE_BANDS } from '../lib/builder.js';
import * as store from '../lib/store.js';

const HELP = `
LONGSHOT — weekly longshot-accumulator portfolio engine

Commands:
  week     Generate and print the 7-day longshot portfolio plan
           Options:
             --stake-max <n>   Max stake in Naira (default: 500)
             --goal <n>        Weekly win goal (default: 2 or 3)
             --date <YYYY-MM-DD> Reference date (default: today in Africa/Lagos)
             --provider <sim|oddsapi> Data provider (default: sim)

  status   Print active week portfolio and running P&L

  settle   Settle a ticket manually
           Usage: node bin/longshot.mjs settle <dayIndex 0-6> <won|lost>

  scan     Scan a single day's market pool
           Options:
             --date <YYYY-MM-DD> Date to scan (default: today)

  help     Show this help message
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === 'week') {
    const parsed = parseArgs({
      args: args.slice(1),
      options: {
        'stake-max': { type: 'string', default: '500' },
        goal: { type: 'string', default: '2' },
        date: { type: 'string' },
        provider: { type: 'string', default: 'sim' },
      },
    });

    const stakeMax = Number(parsed.values['stake-max']) || 500;
    const goal = Number(parsed.values.goal) || 2;
    const refDate = parsed.values.date || null;
    const provider = parsed.values.provider || 'sim';

    const stakeBands = {
      A: stakeMax,
      B: Math.round(stakeMax * 0.7),
      C: Math.round(stakeMax * 0.4),
      D: Math.round(stakeMax * 0.2),
    };

    console.log(`\n========================================================================`);
    console.log(`  LONGSHOT — WEEKLY PORTFOLIO ENGINE (Africa/Lagos)`);
    console.log(`========================================================================`);

    const week = createWeek({
      weekDate: refDate,
      goal,
      settings: {
        provider,
        stakeBands,
        goal,
      },
    });

    await store.saveWeek(week);

    console.log(`Week: ${week.mondayDate} to ${week.sundayDate}  [${week.id}]`);
    console.log(`Target Goal: ${week.goal} wins / week`);
    console.log(`Modelled Expected Wins: ${week.stats.expectedWins} wins (${week.stats.avgWinProbPct}% avg ticket win rate)`);
    console.log(`Total Staked (7 tickets): ${formatNaira(week.stats.totalStaked)}`);
    console.log(`------------------------------------------------------------------------`);

    if (week.stats.goalAssessment.isStructurallyBelow) {
      console.log(`\nHONEST MODELLED REALITY:`);
      console.log(`  ${week.stats.goalAssessment.analysis}`);
      console.log(`  ${week.stats.goalAssessment.explanation}\n`);
    }

    console.log(`========================================================================`);
    console.log(`  THE 7 TICKETS (COMBINED ODDS 20.0 – 1000.0)`);
    console.log(`========================================================================\n`);

    for (const t of week.tickets) {
      console.log(`[Day ${t.dayIndex + 1}] ${t.dayName.toUpperCase()} (${t.date}) ${t.isToday ? '★ TODAY' : ''}`);
      if (!t.issued || !t.slip) {
        console.log(`  Status: UNISSUED — ${t.message}`);
        console.log();
        continue;
      }

      const s = t.slip;
      console.log(`  ${s.legCount}-Leg Master Accumulator · ${s.avgLegProbPct}% avg modelled leg probability`);
      console.log(`  Combined Odds: ${s.odds.toFixed(2)}  |  Fair Odds: ${s.fairOdds.toFixed(2)}  |  Win Prob: ${s.winProbPct}% (1-in-${s.oneInX})`);
      console.log(`  Stake: ${formatNaira(s.stake)} [Band ${s.band}]  |  Total Edge: +${s.edgePct}%  |  EV: +${s.evPct}%`);
      console.log(`  Confidence Note: ${s.bandReason}`);
      console.log(`  Provider: ${t.provider.used.toUpperCase()} ${t.provider.fellBack ? `(SIMULATED fallback: ${t.provider.reason})` : ''}`);
      console.log(`  Legs (${s.legCount}):`);

      for (const l of s.legs) {
        console.log(`    • [${l.sport.toUpperCase()}] ${l.home} vs ${l.away} (${l.league})`);
        console.log(`      Pick: ${l.pick} @ ${l.odds.toFixed(2)} [Book: ${l.book}]  |  Model: ${l.modelProbPct}%  |  Edge: +${l.edgePct}pp  |  Conf: ${l.band}`);
      }
      console.log();
    }

    console.log(`========================================================================`);
    console.log(`  Summary: ${week.stats.issuedCount} of 7 tickets issued. Total at risk: ${formatNaira(week.stats.totalStaked)}.`);
    console.log(`========================================================================\n`);
    return;
  }

  if (command === 'status') {
    const active = await store.getActiveWeek();
    if (!active) {
      console.log('No active week found. Run `node bin/longshot.mjs week` to create one.');
      return;
    }

    console.log(`\nActive Week: ${active.id} (${active.mondayDate} to ${active.sundayDate})`);
    console.log(`Status: ${active.status.toUpperCase()}`);
    console.log(`Goal: ${active.goal} wins | Expected: ${active.stats.expectedWins} wins`);
    console.log(`Staked: ${formatNaira(active.stats.totalStaked)} | Returned: ${formatNaira(active.stats.totalReturned)} | Net P&L: ${formatNaira(active.stats.netPnl)}`);
    console.log(`Landed: ${active.stats.wonCount} won, ${active.stats.lostCount} lost, ${active.stats.pendingCount} pending`);
    if (active.stats.verdict) {
      console.log(`Verdict: "${active.stats.verdict}"`);
    }
    console.log();
    return;
  }

  if (command === 'settle') {
    const dayIndex = Number(args[1]);
    const outcome = args[2];
    if (Number.isNaN(dayIndex) || (outcome !== 'won' && outcome !== 'lost')) {
      console.error('Usage: node bin/longshot.mjs settle <dayIndex 0-6> <won|lost>');
      process.exit(1);
    }

    const active = await store.getActiveWeek();
    if (!active) {
      console.error('No active week found.');
      process.exit(1);
    }

    settleTicket(active, dayIndex, outcome);
    await store.saveWeek(active);
    console.log(`Ticket ${dayIndex} (${active.tickets[dayIndex].dayName}) settled as ${outcome.toUpperCase()}.`);
    console.log(`Running P&L: ${formatNaira(active.stats.netPnl)} (${active.stats.wonCount} of 7 won).`);
    if (active.stats.verdict) {
      console.log(`Verdict: "${active.stats.verdict}"`);
    }
    return;
  }

  if (command === 'scan') {
    const parsed = parseArgs({
      args: args.slice(1),
      options: {
        date: { type: 'string' },
        provider: { type: 'string', default: 'sim' },
      },
    });

    const date = parsed.values.date || new Date().toISOString().slice(0, 10);
    const result = scanForDay(date, { provider: parsed.values.provider });
    console.log(`\nScanned date: ${date}`);
    console.log(`Events: ${result.scan.events.length} | Legs: ${result.legs.length}`);
    if (result.builder.ok) {
      console.log(`Longshot Ticket Odds: ${result.builder.best.odds} | Win Prob: ${result.builder.best.winProbPct}% | EV: +${result.builder.best.evPct}%`);
    } else {
      console.log(`Builder refusal: ${result.builder.message}`);
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
