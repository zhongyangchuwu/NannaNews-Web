import { isCalendarDate } from './diary';
import type { DiaryDay } from './diary';

export interface CalendarMonth {
  year: number;
  month: number;
}

export interface CalendarCell {
  date: string;
  inMonth: boolean;
}

export interface CalendarDayAvailability {
  state: DiaryDay['state'];
  label: string;
  description: string;
}

const MIN_YEAR = 0;
const MAX_YEAR = 9999;
const MONTHS_PER_YEAR = 12;

function assertCalendarMonth({ year, month }: CalendarMonth): void {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR || !Number.isInteger(month) || month < 0 || month >= MONTHS_PER_YEAR) {
    throw new RangeError(`Invalid calendar month: ${year}-${month}`);
  }
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth({ year, month }: CalendarMonth): number {
  if (month === 1) {
    const isLeapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
    return isLeapYear ? 29 : 28;
  }
  return month === 3 || month === 5 || month === 8 || month === 10 ? 30 : 31;
}

export function calendarMonthForDate(date: string): CalendarMonth {
  if (!isCalendarDate(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) - 1 };
}

/** Shift a month without crossing the supported four-digit ISO calendar bounds. */
export function shiftCalendarMonth(month: CalendarMonth, amount: number): CalendarMonth | null {
  assertCalendarMonth(month);
  if (!Number.isSafeInteger(amount)) throw new RangeError('Month shift must be a safe integer');

  const index = month.year * MONTHS_PER_YEAR + month.month + amount;
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_YEAR * MONTHS_PER_YEAR + MONTHS_PER_YEAR - 1) return null;
  return { year: Math.floor(index / MONTHS_PER_YEAR), month: index % MONTHS_PER_YEAR };
}

/** Build six Monday-first calendar weeks; nulls are reserved for dates outside 0000..9999. */
export function calendarMonthGrid(month: CalendarMonth): (CalendarCell | null)[][] {
  assertCalendarMonth(month);
  const firstDay = formatCalendarDate(month.year, month.month, 1);
  const firstWeekday = (new Date(`${firstDay}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const currentMonthDays = daysInMonth(month);
  const previousMonth = shiftCalendarMonth(month, -1);
  const nextMonth = shiftCalendarMonth(month, 1);
  const previousMonthDays = previousMonth ? daysInMonth(previousMonth) : 0;

  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, weekday) => {
    const day = week * 7 + weekday - firstWeekday + 1;
    if (day >= 1 && day <= currentMonthDays) {
      return { date: formatCalendarDate(month.year, month.month, day), inMonth: true };
    }
    if (day < 1 && previousMonth) {
      return { date: formatCalendarDate(previousMonth.year, previousMonth.month, previousMonthDays + day), inMonth: false };
    }
    if (day > currentMonthDays && nextMonth) {
      return { date: formatCalendarDate(nextMonth.year, nextMonth.month, day - currentMonthDays), inMonth: false };
    }
    return null;
  }));
}

export function calendarDayAvailability(day: DiaryDay | undefined): CalendarDayAvailability {
  if (!day || day.state === 'unrecorded') {
    return { state: 'unrecorded', label: '未收录', description: '暂无已收录日报' };
  }
  if (day.state === 'no-new') {
    return { state: 'no-new', label: '无新增', description: '已收录，无新增说明' };
  }
  const count = day.details.length;
  return { state: 'new', label: `${count}条新增`, description: `${count} 条新增说明` };
}
