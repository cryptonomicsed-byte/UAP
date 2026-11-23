#!/usr/bin/env node
// G-23 operator tool: bind an issued SID to an agent so its conversations are
// threaded under that identity (V6-07-07).
//
// Without --apply nothing is written: the command reports the thread it would use
// and any refusal, using the same checks the write path runs. Refusals are exit 1
// with their code, never a repaired guess: a SID already on another agent, or a
// generation that already has transcript rows (open a new chat first).
import { parseArgs } from 'node:util';
import { AdapterIdentityError, bindConversationSid } from '../server/src/agent/hermes-adapter.ts';

const { values } = parseArgs({ options: {
  bot: { type: 'string' },
  sid: { type: 'string' },
  apply: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
} });

if (values.help || !values.bot || !values.sid) {
  process.stdout.write(
    'Usage: npm run agents:bind-sid -- --bot <botId> --sid <sid_slug> [--apply]\n\n' +
    'Reports the engine-side conversation thread the agent would use. --apply writes\n' +
    'bots.sid; without it the database is unchanged and the same refusals are reported.\n',
  );
  process.exit(values.help ? 0 : 2);
}

try {
  const result = bindConversationSid(values.bot, values.sid, { apply: values.apply });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.applied) process.stdout.write('dry run: pass --apply to write bots.sid\n');
} catch (error) {
  if (error instanceof AdapterIdentityError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
