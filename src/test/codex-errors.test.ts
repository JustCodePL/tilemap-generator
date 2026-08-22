import { describe, expect, it } from 'vitest';
import { extractCodexErrorMessage } from '../main/codex/codex-service';

describe('błędy Codex App Servera', () => {
  it('wydobywa właściwy komunikat z zagnieżdżonego błędu turnu', () => {
    expect(extractCodexErrorMessage({
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.6-sol' model requires a newer version of Codex.",
      },
    })).toBe("The 'gpt-5.6-sol' model requires a newer version of Codex.");
  });

  it('używa ostatniego komunikatu error, gdy turn/completed nie zawiera szczegółów', () => {
    expect(extractCodexErrorMessage(undefined, null, 'Połączenie z modelem zostało odrzucone.'))
      .toBe('Połączenie z modelem zostało odrzucone.');
  });
});
