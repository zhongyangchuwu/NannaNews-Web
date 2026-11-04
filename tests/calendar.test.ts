import { describe, expect, it } from 'vitest';
import { calendarDayAvailability, calendarMonthForDate, calendarMonthGrid, shiftCalendarMonth } from '../src/calendar';
import type { CalendarCell } from '../src/calendar';
import type { DiaryDay, PrintedMessage } from '../src/diary';
import type { BulletinIssue, DetailSource } from '../src/types';

const issue: BulletinIssue = {
  id: 'issue', date: '2024-02-29', number: 1, title: 'issue', filename: 'issue.pdf', sha256: '0'.repeat(64), extraction_version: 'test',
};
const detail: DetailSource = {
  id: 'detail', issue_id: issue.id, category: '活动', order: 0, title: 'detail', text: 'detail', fields: [], source_urls: [], other_urls: [], page: 1,
};
const printedMessage: PrintedMessage = { activityId: 'activity', issue, detail };
const diaryDay = (state: DiaryDay['state'], details: PrintedMessage[] = []): DiaryDay => ({
  date: '2024-02-29', issues: [issue], publications: [], details, state,
});

function inMonthDates(year: number, month: number): string[] {
  return calendarMonthGrid({ year, month }).flatMap(week => week.filter((cell): cell is CalendarCell => cell !== null && cell.inMonth).map(cell => cell.date));
}

describe('diary calendar', () => {
  it('builds six Monday-first weeks and includes the leap day and adjacent dates', () => {
    const weeks = calendarMonthGrid({ year: 2024, month: 1 });
    expect(weeks).toHaveLength(6);
    expect(weeks.every(week => week.length === 7)).toBe(true);
    expect(weeks[0].map(cell => cell?.date ?? null)).toEqual([
      '2024-01-29', '2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02', '2024-02-03', '2024-02-04',
    ]);
    expect(weeks.flat().filter(cell => cell?.inMonth)).toHaveLength(29);
    expect(weeks.flat().some(cell => cell?.date === '2024-02-29' && cell.inMonth)).toBe(true);
    expect(weeks.flat().some(cell => cell?.date === '2024-03-01' && !cell.inMonth)).toBe(true);
  });

  it('uses Gregorian leap-year rules and preserves valid four-digit dates at both bounds', () => {
    expect(inMonthDates(1900, 1)).toHaveLength(28);
    expect(inMonthDates(2000, 1)).toHaveLength(29);
    expect(inMonthDates(0, 1)).toHaveLength(29);
    expect(inMonthDates(9999, 1)).toHaveLength(28);

    const firstMonth = calendarMonthGrid({ year: 0, month: 0 }).flat();
    const lastMonth = calendarMonthGrid({ year: 9999, month: 11 }).flat();
    expect(firstMonth.some(cell => cell === null)).toBe(true);
    expect(lastMonth.some(cell => cell === null)).toBe(true);
    expect(firstMonth.filter((cell): cell is CalendarCell => cell !== null).every(cell => /^\d{4}-\d{2}-\d{2}$/.test(cell.date))).toBe(true);
    expect(lastMonth.filter((cell): cell is CalendarCell => cell !== null).every(cell => /^\d{4}-\d{2}-\d{2}$/.test(cell.date))).toBe(true);
    expect(calendarMonthForDate('0000-01-01')).toEqual({ year: 0, month: 0 });
    expect(calendarMonthForDate('9999-12-31')).toEqual({ year: 9999, month: 11 });
    expect(() => calendarMonthForDate('1900-02-29')).toThrow(RangeError);
  });

  it('jumps across December and January without leaving supported month bounds', () => {
    expect(shiftCalendarMonth({ year: 2024, month: 11 }, 1)).toEqual({ year: 2025, month: 0 });
    expect(shiftCalendarMonth({ year: 2025, month: 0 }, -1)).toEqual({ year: 2024, month: 11 });
    expect(shiftCalendarMonth({ year: 0, month: 0 }, -1)).toBeNull();
    expect(shiftCalendarMonth({ year: 9999, month: 11 }, 1)).toBeNull();
    expect(() => shiftCalendarMonth({ year: 2024, month: 12 }, 1)).toThrow(RangeError);
    expect(() => shiftCalendarMonth({ year: 2024, month: 0 }, 1.5)).toThrow(RangeError);
  });

  it('keeps new, recorded-without-new, and unrecorded availability distinct and counts source details', () => {
    const withDetails = calendarDayAvailability(diaryDay('new', [printedMessage, { ...printedMessage, detail: { ...detail, id: 'detail-2' } }]));
    expect(withDetails).toEqual({ state: 'new', label: '2条新增', description: '2 条新增说明' });
    expect(calendarDayAvailability(diaryDay('no-new'))).toEqual({ state: 'no-new', label: '无新增', description: '已收录，无新增说明' });
    expect(calendarDayAvailability(undefined)).toEqual({ state: 'unrecorded', label: '未收录', description: '暂无已收录日报' });
    expect(calendarDayAvailability(diaryDay('unrecorded'))).toEqual({ state: 'unrecorded', label: '未收录', description: '暂无已收录日报' });
  });
});
