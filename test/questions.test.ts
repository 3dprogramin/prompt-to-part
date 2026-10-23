import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerText, checkQuestions, choiceWords, type ChatQuestion } from '../shared/questions';
import { cadTools } from '../server/cadTools';
import type { AgentEvent } from '../shared/api';

const held: ChatQuestion = { question: 'Which way is the phone held?', options: ['Landscape', 'Portrait'], pick: 0 };
const holds: ChatQuestion = { question: 'What else does it hold', options: ['Keys', 'Pens', 'Cards'], pick: 1, multi: true };

test('ask_questions takes 1 to 5 questions of 2 to 5 different options, the pick one of them', () => {
  assert.deepEqual(checkQuestions([{ ...held, question: '  Which way is the phone held? ', why: ' fits more desks ' }]),
    { questions: [{ ...held, why: 'fits more desks' }] });
  assert.match((checkQuestions([]) as { error: string }).error, /1 to 5 questions/);
  assert.match((checkQuestions(Array(6).fill(held)) as { error: string }).error, /1 to 5 questions \(you sent 6\)/);
  assert.match((checkQuestions([{ ...held, options: ['Landscape'] }]) as { error: string }).error, /Question 1: give 2 to 5 options/);
  assert.match((checkQuestions([held, { ...held, options: ['a', 'b', 'c', 'd', 'e', 'f'] }]) as { error: string }).error, /Question 2: give 2 to 5/);
  assert.match((checkQuestions([{ ...held, options: ['Landscape', 'landscape '] }]) as { error: string }).error, /all be different/);
  assert.match((checkQuestions([{ ...held, options: ['Landscape', ' '] }]) as { error: string }).error, /1 to 60 characters/);
  assert.match((checkQuestions([{ ...held, pick: 2 }]) as { error: string }).error, /pick must be the index of one of its options, 0 to 1/);
  assert.match((checkQuestions([{ ...held, pick: -1 }]) as { error: string }).error, /pick must be/);
  assert.match((checkQuestions([{ ...held, question: '' }]) as { error: string }).error, /the question must be/);
});

test('the answers read as one numbered line per question, with the question', () => {
  assert.deepEqual(choiceWords(held, { chosen: [1] }), ['Portrait']);
  // A single choice: the user's own words win over the option.
  assert.deepEqual(choiceWords(held, { chosen: [0], other: ' On its side ' }), ['On its side']);
  // Several: in the options' order, then the user's own.
  assert.deepEqual(choiceWords(holds, { chosen: [2, 0], other: 'Sunglasses' }), ['Keys', 'Cards', 'Sunglasses']);
  assert.deepEqual(choiceWords(holds, { chosen: [], other: '  ' }), []);
  assert.equal(answerText([held, holds, { question: 'Name on it?', options: ['Yes', 'No'], pick: 1 }], [['Portrait'], ['Keys', 'Cards, small'], []]),
    '1. Which way is the phone held? Portrait\n2. What else does it hold: Keys + Cards, small\n3. Name on it? No preference');
  assert.equal(answerText([holds], [[]]), '1. What else does it hold: None of these');
});

test('ask_questions is there only with Ask first on, shows the card once per reply and tells Claude to stop', async () => {
  type Tools = Record<string, { handler: (a: unknown, x: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }> }>;
  const tools = (s: ReturnType<typeof cadTools>['server']) => (s.instance as unknown as { _registeredTools: Tools })._registeredTools;
  assert.equal(tools(cadTools('/nonexistent/model.js', () => {}).server).ask_questions, undefined);
  const events: AgentEvent[] = [];
  const { server, newUserMessage } = cadTools('/nonexistent/model.js', (e) => events.push(e), new Set(), {}, { askFirst: true });
  const ask = tools(server).ask_questions;
  const bad = await ask.handler({ questions: [{ ...held, pick: 5 }] }, {});
  assert.ok(bad.isError);
  assert.equal(events.length, 0, 'nothing shown');
  const ok = await ask.handler({ questions: [held, holds] }, {});
  assert.ok(!ok.isError);
  assert.match(ok.content[0].text!, /Build nothing now: end your reply/);
  assert.deepEqual(events[0], { type: 'questions', questions: [held, holds] });
  assert.equal(events[1].type === 'step' && events[1].step.text, 'Asked 2 questions before building');
  assert.match((await ask.handler({ questions: [held] }, {})).content[0].text!, /already asked/);
  // A message from the user mid-reply may raise new ones.
  newUserMessage();
  assert.ok(!(await ask.handler({ questions: [held] }, {})).isError);
});
