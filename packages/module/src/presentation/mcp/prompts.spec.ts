import { PROMPTS } from './prompts.js';

/**
 * A prompt is the only part of this surface a person never reads and a model
 * always does. What it must never lose: the money rules (a stamp is
 * immutable, a pending price is not zero, a closed month is final, a current
 * month is partial), the two-step discipline for writes, and the vendor
 * blindness the whole package is held to.
 */
const bodies = PROMPTS.map((prompt) => ({
  name: prompt.name,
  text: prompt.build({ year: '2026', month: '6', model: 'openai/gpt-5-mini' }),
}));

describe('prompt playbooks', () => {
  it('MUST give every playbook a title, a description and arguments that are strings', () => {
    for (const prompt of PROMPTS) {
      expect(prompt.title.length).toBeGreaterThan(0);
      expect(prompt.description.length).toBeGreaterThan(20);
      for (const schema of Object.values(prompt.argsSchema)) {
        expect(schema.safeParse('6').success).toBe(true);
      }
    }
  });

  it.each(bodies.map(({ name }) => name))(
    '%s MUST carry the money rules a model cannot infer',
    (name) => {
      const text = bodies.find((body) => body.name === name)?.text ?? '';

      expect(text).toContain('R$');
      expect(text).toContain('pending_price');
      expect(text).toMatch(/partial|closed/);
    },
  );

  it.each(['register-price', 'close-month'])(
    '%s MUST spell out the preview → show → confirm discipline',
    (name) => {
      const text = bodies.find((body) => body.name === name)?.text ?? '';

      expect(text).toContain('preview');
      expect(text).toMatch(/approv/);
      expect(text).toContain('confirmation_token');
    },
  );

  it('register-price MUST insist on a decimal string and refuse the zero trap', () => {
    const text =
      bodies.find((body) => body.name === 'register-price')?.text ?? '';

    expect(text).toContain('decimal STRING');
    expect(text).toContain('never zero');
  });

  it('close-month MUST say that reopening is the exception and needs a reason', () => {
    const text = bodies.find((body) => body.name === 'close-month')?.text ?? '';

    expect(text).toMatch(/oldest first/);
    expect(text).toMatch(/written reason/);
  });

  it('MUST interpolate the arguments it was given', () => {
    for (const { name, text } of bodies) {
      if (name === 'register-price') {
        expect(text).toContain('openai/gpt-5-mini');
        continue;
      }
      expect(text).toContain('2026-6');
    }
  });

  it('MUST stay vendor-blind (assembled words: this file is scanned too)', () => {
    const forbidden = new RegExp(
      [['lang', 'watch'].join(''), ['click', 'house'].join('')].join('|'),
    );

    for (const { text } of bodies) {
      expect(text.toLowerCase()).not.toMatch(forbidden);
    }
  });
});
