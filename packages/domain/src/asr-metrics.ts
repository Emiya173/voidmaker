export function normalizeTranscript(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\p{C}]/gu, "");
}
export function characterErrors(
  reference: string,
  hypothesis: string,
): { errors: number; characters: number; cer: number | null } {
  const expected = Array.from(normalizeTranscript(reference));
  const actual = Array.from(normalizeTranscript(hypothesis));
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let row = 1; row <= expected.length; row++) {
    const current: number[] = [row];
    for (let column = 1; column <= actual.length; column++) {
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (expected[row - 1] === actual[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  const errors = previous[actual.length] ?? 0;
  return { errors, characters: expected.length, cer: expected.length ? errors / expected.length : null };
}
