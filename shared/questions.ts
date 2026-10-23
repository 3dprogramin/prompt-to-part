// "Ask first": the questions Jig asks before it builds (ask_questions), shown as a card of clickable
// options under its reply, and the user's answers sent back as an ordinary message.

/** One question of Jig's: its options, the one Jig would pick (`pick`), and whether several may be chosen. */
export interface ChatQuestion {
  question: string;
  options: string[];
  /** Index into `options` of Jig's own choice: preselected on the card. */
  pick: number;
  multi?: boolean;
  /** Why Jig would pick it, very short. */
  why?: string;
}

export const MAX_QUESTIONS = 5;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;
export const MAX_QUESTION_CHARS = 160;
export const MAX_OPTION_CHARS = 60;
export const MAX_WHY_CHARS = 100;

/** Questions as Claude sent them, trimmed, or why they can't be shown (1-5 questions, 2-5 different options each, the pick one of them). */
export function checkQuestions(raw: ChatQuestion[]): { questions: ChatQuestion[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_QUESTIONS) return { error: `Ask 1 to ${MAX_QUESTIONS} questions (you sent ${Array.isArray(raw) ? raw.length : 'none'}).` };
  const questions: ChatQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    const n = `Question ${i + 1}`;
    const question = String(q?.question ?? '').trim();
    if (!question || question.length > MAX_QUESTION_CHARS) return { error: `${n}: the question must be 1 to ${MAX_QUESTION_CHARS} characters.` };
    const options = Array.isArray(q.options) ? q.options.map((o) => String(o ?? '').trim()) : [];
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return { error: `${n}: give ${MIN_OPTIONS} to ${MAX_OPTIONS} options (the card adds "Other" by itself).` };
    if (options.some((o) => !o || o.length > MAX_OPTION_CHARS)) return { error: `${n}: each option must be 1 to ${MAX_OPTION_CHARS} characters.` };
    if (new Set(options.map((o) => o.toLowerCase())).size < options.length) return { error: `${n}: the options must all be different.` };
    if (!Number.isInteger(q.pick) || q.pick < 0 || q.pick >= options.length) return { error: `${n}: pick must be the index of one of its options, 0 to ${options.length - 1}.` };
    const why = String(q.why ?? '').trim().slice(0, MAX_WHY_CHARS);
    questions.push({ question, options, pick: q.pick, ...(q.multi ? { multi: true } : {}), ...(why ? { why } : {}) });
  }
  return { questions };
}

/** What the user chose for one question: option indexes, and their own words ("Other…"). */
export interface QuestionChoice { chosen: number[]; other?: string }

/** The choices as they read: the options' words in their order, then the user's own; [] for none. */
export function choiceWords(q: ChatQuestion, c: QuestionChoice): string[] {
  const picked = q.options.filter((_, i) => c.chosen.includes(i)).slice(0, q.multi ? undefined : 1);
  const other = c.other?.trim();
  return q.multi ? [...picked, ...(other ? [other] : [])] : other ? [other] : picked;
}

/**
 * The answers as the user's message, one numbered line per question with the question for context:
 * "1. Which way is it held? Landscape". Several choices are joined with " + " (options may hold commas).
 */
export function answerText(questions: ChatQuestion[], answers: string[][]): string {
  return questions.map((q, i) => {
    const words = answers[i]?.length ? answers[i].join(' + ') : q.multi ? 'None of these' : 'No preference';
    const question = /[?:.]$/.test(q.question) ? q.question : `${q.question}:`;
    return `${i + 1}. ${question} ${words}`;
  }).join('\n');
}
