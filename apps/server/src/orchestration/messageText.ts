export function applyMessageTextUpdate(input: {
  readonly previous: string | undefined;
  readonly text: string;
  readonly streaming: boolean;
  readonly replace?: boolean;
}): string {
  if (input.previous === undefined || input.replace) return input.text;
  if (input.streaming) return `${input.previous}${input.text}`;
  return input.text.length > 0 ? input.text : input.previous;
}
