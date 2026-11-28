import { useMemo } from 'react';
import type { Bot, Row, ToolCallBody } from '@shared/types';
import { dividerLabel } from '../../lib/time';

// Display only fixed phrases. Tool names, labels, payloads and notice text can
// contain provider details or data from a private conversation.
const TOOL_LABELS = new Map([
  ['read_file', 'Read files'], ['search_files', 'Search files'],
  ['write_file', 'Write a file'], ['patch', 'Edit a file'],
  ['web_search', 'Search the web'], ['web_extract', 'Read a web page'],
  ['computer_use', 'Use the computer'], ['terminal', 'Run a command'],
]);
const TOOL_STATUS: Record<ToolCallBody['status'], string> = {
  running: 'Running', done: 'Completed', error: 'Failed',
  'awaiting-approval': 'Awaiting approval', denied: 'Denied',
};
const NOTICES = new Map([
  ['engine_unreachable', 'Agent gateway unavailable'],
  ['engine_auth', 'Agent gateway authentication failed'],
  ['provider_auth', 'Provider authentication failed'],
  ['provider_rate_limited', 'Provider rate limit'],
  ['provider_billing', 'Provider billing issue'],
  ['provider_unavailable', 'Provider unavailable'],
  ['model_unavailable', 'Model unavailable'],
  ['context_length', 'Conversation too long'],
  ['timeout', 'Run timed out'],
  ['run_failed', 'Agent run failed'],
  ['channel_rate_limited', 'Agent rate limit'],
]);

export function activityEntries(botId: string, rows: readonly Row[]) {
  return rows.filter((row) => row.botId === botId).flatMap((row) => {
    const { body } = row;
    const base = { key: `${row.generation}:${row.seq}`, at: row.createdAt, seq: row.seq };
    if (body.type === 'tool-call' && Object.hasOwn(TOOL_STATUS, body.status)) {
      return [{ ...base, label: TOOL_LABELS.get(body.name) ?? 'Tool step', status: TOOL_STATUS[body.status] }];
    }
    if (body.type === 'notice') {
      return [{ ...base, label: NOTICES.get(body.code ?? '') ?? 'Agent notice', status: body.tone === 'error' ? 'Error' : body.tone === 'warn' ? 'Warning' : 'Info' }];
    }
    if (body.type === 'event' && body.event === 'routine-run') {
      // The server records this when dispatching the request, not on completion.
      return [{ ...base, label: 'Automation run', status: 'Requested' }];
    }
    return [];
  }).sort((a, b) => b.at - a.at || b.seq - a.seq);
}

export function AgentActivity({ bot, rows }: { bot: Bot; rows: Row[] }) {
  const entries = useMemo(() => activityEntries(bot.id, rows), [bot.id, rows]);
  return (
    <section className="studio-facet" aria-label="Activity">
      <header className="studio-facet__head">
        <p>Workspace / Activity</p>
        <h1>Activity</h1>
        <span>Recent tool steps, notices, and automation requests from this conversation.</span>
      </header>
      {entries.length === 0 ? <p>No recent activity.</p> : (
        <ul className="studio-list">
          {entries.map(({ key, label, status, at }) => (
            <li className="studio-list__item" key={key}>
              <div>
                <strong>{label}</strong>
                <p><time dateTime={new Date(at).toISOString()}>{dividerLabel(at)}</time></p>
              </div>
              <span>{status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
