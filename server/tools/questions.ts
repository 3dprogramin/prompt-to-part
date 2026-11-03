// The CAD tool for Ask first (ask_questions): a few questions before building, shown as a card of options.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkQuestions, MAX_OPTION_CHARS, MAX_OPTIONS, MAX_QUESTION_CHARS, MAX_QUESTIONS, MAX_WHY_CHARS, MIN_OPTIONS } from '../../shared/questions';
import type { ToolContext } from './context';

/** ask_questions, with Ask first on. */
export function questionTools({ emit, state }: ToolContext) {
  return [
    tool('ask_questions', `Ask the user the few questions you can't settle yourself before you build, or (rarely, one or two at most) a decision you reach while building that changes the result drastically (Ask first is on). They see them under your reply as a card: each question with its options as buttons, the one you would pick already selected and marked, and "Other" for their own words; they click and send, and their answers come as their next message. Only for choices left open that change the result a lot (which way a phone is held, with or without a case, what it hangs on, the size or the wall it is for, the words on it, the style, and whether bolts, screws and nuts it needs are printed or metal); never what you can look up (real product dimensions) or decide yourself (clearances, walls, parameters, print settings, how a mechanism locks or holds its position: you choose that, combining clamps, detents and teeth where it helps). Not for a clear request, a small change, or right after the user answered. At most ${MAX_QUESTIONS}, as few as needed. If nobody answers within a minute your picks are sent, so pick the safe option. Then stop building: end your reply.`, {
      questions: z.array(z.object({
        question: z.string().max(MAX_QUESTION_CHARS).describe('Short and plain, e.g. "Which way is the phone held?"'),
        options: z.array(z.string().max(MAX_OPTION_CHARS)).min(MIN_OPTIONS).max(MAX_OPTIONS).describe(`${MIN_OPTIONS} to ${MAX_OPTIONS} likely answers, a few words each (e.g. "Landscape", "Portrait"); no "Other" (the card has one)`),
        pick: z.number().int().min(0).max(MAX_OPTIONS - 1).describe('Index (0-based) of the option you would choose: it is preselected'),
        multi: z.boolean().optional().describe('Several options may be chosen together (e.g. which tools it holds)'),
        why: z.string().max(MAX_WHY_CHARS).optional().describe('Why you would pick it, a few words (optional)'),
      })).min(1).max(MAX_QUESTIONS),
    }, async (a) => {
      if (state.asked) return { content: [{ type: 'text' as const, text: 'You have already asked your questions in this reply: end your reply now and wait for the answers.' }], isError: true };
      const checked = checkQuestions(a.questions);
      if ('error' in checked) return { content: [{ type: 'text' as const, text: `Not shown - ${checked.error} Fix it and call ask_questions again.` }], isError: true };
      state.asked = true;
      const n = checked.questions.length;
      emit({ type: 'questions', questions: checked.questions });
      emit({ type: 'step', step: { kind: 'tool', ok: true, text: `Asked ${n} question${n > 1 ? 's' : ''}` } });
      return { content: [{ type: 'text' as const, text: `The user sees your ${n} question${n > 1 ? 's' : ''} as a card with your picks preselected. Stop building now: end your reply with one short line (e.g. "A few quick questions before I build."), without repeating the questions or their options. Their answers (or your picks, if they don't answer within a minute) come as their next message: then carry on with them, without asking again.` }] };
    }),
  ];
}
