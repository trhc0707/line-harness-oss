export const DELIVERY_WINDOW_START_HOUR = 9;
export const DELIVERY_WINDOW_END_HOUR = 21;

export function jstNowDate(): Date {
  return new Date(Date.now() + 9 * 60 * 60_000);
}

export function enforceDeliveryWindow(date: Date, preferredHour?: number): Date {
  const hours = date.getUTCHours();
  const startHour = preferredHour ?? DELIVERY_WINDOW_START_HOUR;
  const endHour = DELIVERY_WINDOW_END_HOUR;
  if (hours >= startHour && hours < endHour) return date;
  const result = new Date(date);
  if (hours >= endHour) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  result.setUTCHours(startHour, 0, 0, 0);
  return result;
}

export function isWithinDeliveryWindow(date: Date = jstNowDate()): boolean {
  const h = date.getUTCHours();
  return h >= DELIVERY_WINDOW_START_HOUR && h < DELIVERY_WINDOW_END_HOUR;
}

export function toJstIsoString(date: Date): string {
  return date.toISOString().slice(0, -1) + '+09:00';
}
