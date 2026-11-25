import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createTicket, listTickets, updateTicket, commentTicket, TICKET_STATUSES } from '../server/src/lib/ticket-board.ts';

function db() { const d = new Database(':memory:'); return d; }

test('a ticket starts in todo and is scoped to its user', () => {
  const d = db();
  const t = createTicket(d, 'usr_a', { title: 'Fix the thing' });
  assert.equal(t.status, 'todo');
  assert.equal(listTickets(d, 'usr_a').length, 1);
  assert.equal(listTickets(d, 'usr_b').length, 0);
});

test('an unknown status is rejected, not silently stored', () => {
  const d = db();
  const t = createTicket(d, 'usr_a', { title: 'x' });
  assert.throws(() => updateTicket(d, 'usr_a', t.id, { status: 'archived' }));
});

test('every real status in the taxonomy round-trips', () => {
  const d = db();
  const t = createTicket(d, 'usr_a', { title: 'x' });
  for (const s of TICKET_STATUSES) {
    const updated = updateTicket(d, 'usr_a', t.id, { status: s });
    assert.equal(updated?.status, s);
  }
});

test('comments append and keep author + text', () => {
  const d = db();
  const t = createTicket(d, 'usr_a', { title: 'x' });
  const after = commentTicket(d, 'usr_a', t.id, 'bot_7Qmj4Wrk47BG', 'Needs your input on the API key.');
  assert.equal(after?.comments.length, 1);
  assert.equal(after?.comments[0].author, 'bot_7Qmj4Wrk47BG');
});

test('another user cannot update or comment on a ticket that is not theirs', () => {
  const d = db();
  const t = createTicket(d, 'usr_a', { title: 'x' });
  assert.equal(updateTicket(d, 'usr_b', t.id, { status: 'done' }), null);
  assert.equal(commentTicket(d, 'usr_b', t.id, 'bot', 'hi'), null);
});
