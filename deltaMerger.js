// ─────────────────────────────────────────────
// deltaMerger.js
//
// Handles chunk boundary issues cleanly:
//   1. Strips false end-of-chunk periods/commas
//   2. Removes duplicate words at chunk boundaries
//      (e.g. "science science" → "science" when the
//       word straddles the 3s cut point)
//   3. Lowercases first letter of mid-sentence chunks
//   4. Adds space separator between chunks
// ─────────────────────────────────────────────

const SENTENCE_ENDERS = new Set(['.', '!', '?']);

class DeltaMerger {
  constructor() {
    this.confirmedText = '';
    this.isFirst = true;
    this.prevEndsWithPunctuation = false;
  }

  _words(text) {
    return text.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
  }

  getDelta(newTranscript) {
    let text = newTranscript.trim();
    if (!text) return '';

    // ── 1. Strip trailing period/comma (Sarvam adds these artificially) ──
    if (text.endsWith('.') || text.endsWith(',')) {
      text = text.slice(0, -1).trimEnd();
    }
    if (!text) return '';

    // ── 2. Remove boundary duplicate words ────────────────────────────────
    // When a word straddles the chunk boundary, both chunks transcribe it.
    // Fix: check if first 1-3 words of this chunk match last 1-3 words of
    // previously confirmed text, and skip them if so.
    if (this.confirmedText) {
      const confirmedWords = this._words(this.confirmedText);
      const incomingWords = this._words(text);
      const originalWords = text.split(/\s+/).filter(w => w.length > 0);

      const maxCheck = Math.min(4, confirmedWords.length, incomingWords.length);
      let skipCount = 0;

      for (let len = maxCheck; len >= 1; len--) {
        const confirmedTail = confirmedWords.slice(-len).join(' ');
        const incomingPrefix = incomingWords.slice(0, len).join(' ');
        if (confirmedTail === incomingPrefix) {
          skipCount = len;
          break;
        }
      }

      if (skipCount > 0) {
        console.log(`[DeltaMerger] Removing ${skipCount} boundary-duplicate word(s)`);
        text = originalWords.slice(skipCount).join(' ').trim();
      }
    }

    if (!text) return '';

    // ── 3. Lowercase first letter for mid-sentence continuation ──────────
    if (!this.isFirst && !this.prevEndsWithPunctuation && text.length > 0) {
      text = text[0].toLowerCase() + text.slice(1);
    }

    console.log(`[DeltaMerger] Clean chunk: "${text}"`);

    // Track whether this chunk ends a sentence
    const lastChar = text[text.length - 1];
    this.prevEndsWithPunctuation = SENTENCE_ENDERS.has(lastChar);

    // Update confirmed text (for next boundary check)
    this.confirmedText = this.confirmedText
      ? this.confirmedText + ' ' + text
      : text;

    // Space separator before non-first chunks
    const delta = this.isFirst ? text : ' ' + text;
    this.isFirst = false;
    return delta;
  }

  reset() {
    this.confirmedText = '';
    this.isFirst = true;
    this.prevEndsWithPunctuation = false;
  }
}

module.exports = DeltaMerger;
