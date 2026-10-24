import { useEffect, useId, useRef, useState } from 'react';
import { choiceWords, type ChatQuestion } from '../../shared/questions';
import { Icon } from './Icon';

/** Seconds an untouched card waits before it sends Jig's picks by itself. */
export const QUESTION_SECONDS = 60;

/** One question's state on the card: the options chosen, and the user's own words ("Other…"). */
interface Choice { chosen: number[]; otherOn: boolean; other: string }

/**
 * "Ask first": Jig's questions under its reply, each option a chip to click, Jig's pick preselected
 * and marked, plus "Other…" for the user's own words. With `onSend` (the newest reply, not answered
 * yet) it can be answered; otherwise it is read-only, showing the `answers` sent from it, if any.
 * With `countdown` (a card that just arrived in this window), nobody touching it for
 * QUESTION_SECONDS sends Jig's picks; any click on it, Keep waiting, or typing in the chat (`hold`)
 * stops that.
 */
export function QuestionCard({ questions, answers, onSend, disabled, countdown, hold }: {
  questions: ChatQuestion[];
  answers?: string[][];
  onSend?: (answers: string[][]) => void;
  /** Sending can't happen now (another tab works on the design, Claude can't run). */
  disabled?: boolean;
  countdown?: boolean;
  hold?: boolean;
}) {
  const id = useId();
  const active = !!onSend;
  const [choices, setChoices] = useState<Choice[]>(() => questions.map((q) => ({ chosen: [q.pick], otherOn: false, other: '' })));
  const others = useRef<(HTMLInputElement | null)[]>([]);
  // When the picks go out by themselves (null: the card waits for the user).
  const [until, setUntil] = useState<number | null>(() => (onSend && countdown ? Date.now() + QUESTION_SECONDS * 1000 : null));
  const [now, setNow] = useState(() => Date.now());
  // Read-only: what was sent from the card (an answer that is no option was the user's own words), or nothing.
  const shown: Choice[] = active ? choices : questions.map((q, i) => {
    const a = answers?.[i] ?? [];
    const own = a.filter((w) => !q.options.includes(w));
    return { chosen: q.options.flatMap((o, j) => (a.includes(o) ? [j] : [])), otherOn: own.length > 0, other: own.join(' + ') };
  });
  const words = (i: number) => choiceWords(questions[i], { chosen: shown[i].chosen, other: shown[i].otherOn ? shown[i].other : undefined });
  // A single-choice question needs an answer (Other… with nothing typed has none); a multiple-choice one may have none.
  const ready = questions.every((q, i) => q.multi || words(i).length > 0);

  const touch = () => setUntil(null);
  const set = (i: number, next: Partial<Choice>) => setChoices((cs) => cs.map((c, j) => (j === i ? { ...c, ...next } : c)));
  const choose = (i: number, option: number) => {
    touch();
    const c = choices[i];
    if (questions[i].multi) set(i, { chosen: c.chosen.includes(option) ? c.chosen.filter((x) => x !== option) : [...c.chosen, option] });
    else set(i, { chosen: [option], otherOn: false });
  };
  const chooseOther = (i: number) => {
    touch();
    const on = questions[i].multi ? !choices[i].otherOn : true;
    set(i, questions[i].multi ? { otherOn: on } : { chosen: [], otherOn: true });
    if (on) requestAnimationFrame(() => others.current[i]?.focus());
  };
  const send = () => { if (active && ready && !disabled) onSend(questions.map((_, i) => words(i))); };

  useEffect(() => { if (hold) setUntil(null); }, [hold]);
  useEffect(() => {
    if (until == null || !active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [until, active]);
  // Time's up: Jig's picks go out, unless sending is blocked just now (then the card simply waits).
  useEffect(() => {
    if (until == null || now < until) return;
    setUntil(null);
    send();
  }, [now, until]);
  const left = until == null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));

  const n = questions.length;
  return (
    <form
      className={`questions ${active ? '' : 'done'}`}
      aria-label="Jig's questions"
      onSubmit={(e) => { e.preventDefault(); send(); }}
      // Enter sends from any chip or the Other box (not from the buttons, which do their own thing).
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || (e.target as HTMLElement).tagName === 'BUTTON') return;
        e.preventDefault();
        send();
      }}
    >
      <div className="questions-head">
        <Icon name="ask" size={14} />
        <span>{active ? `${n === 1 ? 'A question' : `${n} questions`} before Jig builds` : answers ? 'Your answers' : `Jig's question${n > 1 ? 's' : ''}`}</span>
        {!active && !answers && <span className="dim small">answered in the chat</span>}
      </div>
      {questions.map((q, i) => (
        <fieldset key={i} className="question" disabled={!active}>
          <legend>{n > 1 && <span className="q-num">{i + 1}.</span>} {q.question}{q.multi && <span className="dim small"> (any)</span>}</legend>
          <div className="q-options" role={q.multi ? 'group' : 'radiogroup'} aria-label={q.question}>
            {q.options.map((o, j) => {
              const on = shown[i].chosen.includes(j);
              return (
                <label key={j} className={`q-chip ${on ? 'on' : ''} ${j === q.pick ? 'pick' : ''}`} title={j === q.pick ? `Jig's pick${q.why ? `: ${q.why}` : ''}` : undefined}>
                  <input className="sr-only" type={q.multi ? 'checkbox' : 'radio'} name={`${id}-${i}`} checked={on} onChange={() => choose(i, j)} />
                  {q.multi && <span className="q-box" aria-hidden>{on && <Icon name="check" size={10} />}</span>}
                  <span>{o}</span>
                  {j === q.pick && <span className="q-pick"><Icon name="star" size={9} /> Jig's pick</span>}
                </label>
              );
            })}
            {(active || shown[i].otherOn) && (
              <label className={`q-chip other ${shown[i].otherOn ? 'on' : ''}`}>
                <input className="sr-only" type={q.multi ? 'checkbox' : 'radio'} name={`${id}-${i}`} checked={shown[i].otherOn} onChange={() => chooseOther(i)} />
                {q.multi && <span className="q-box" aria-hidden>{shown[i].otherOn && <Icon name="check" size={10} />}</span>}
                <span>{active ? 'Other…' : shown[i].other}</span>
              </label>
            )}
          </div>
          {active && choices[i].otherOn && (
            <input
              ref={(el) => { others.current[i] = el; }}
              className="q-other"
              value={choices[i].other}
              maxLength={200}
              placeholder="Your answer"
              aria-label={`Your own answer: ${q.question}`}
              onChange={(e) => { touch(); set(i, { other: e.target.value }); }}
            />
          )}
          {q.why && active && <div className="q-why">Jig's pick: {q.why}</div>}
        </fieldset>
      ))}
      {active && until != null && (
        <div className="q-countdown" role="timer" aria-live="off">
          <div className="auto-build-bar" aria-hidden><i style={{ animationDuration: `${QUESTION_SECONDS}s` }} /></div>
          <span className="dim small">Sending Jig's picks in {left} s unless you change something</span>
          <button type="button" className="link" onClick={touch}>Keep waiting</button>
        </div>
      )}
      {active && (
        <div className="questions-actions">
          <button type="submit" className="btn primary" disabled={!ready || disabled}
            title={ready ? 'Send these answers to Jig (Enter)' : 'Pick an answer for every question (or type your own under Other…)'}>
            <Icon name="send" size={13} /> Send answers
          </button>
          <span className="dim small">or type a reply below</span>
        </div>
      )}
    </form>
  );
}
