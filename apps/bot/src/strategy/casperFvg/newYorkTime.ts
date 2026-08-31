const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface NewYorkTimeParts {
  tradingDay: string;
  hour: number;
  minute: number;
  second: number;
}

export function getNewYorkTimeParts(timestampMs: number): NewYorkTimeParts | null {
  if (!Number.isFinite(timestampMs)) return null;
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs)).map(({ type, value }) => [type, value]),
  );
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null;
  return {
    tradingDay: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour,
    minute,
    second,
  };
}

export function minuteOfDay(parts: NewYorkTimeParts): number {
  return parts.hour * 60 + parts.minute;
}
