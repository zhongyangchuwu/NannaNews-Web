import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiaryDay } from './diary';
import { calendarDayAvailability, calendarMonthForDate, calendarMonthGrid, shiftCalendarMonth } from './calendar';
import './calendar.css';

export interface DiaryCalendarProps {
  index: ReadonlyMap<string, DiaryDay>;
  selectedDate: string;
  today: string;
  followToday: boolean;
  onSelect: (date: string | null) => void;
}

const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function formatYear(year: number): string {
  return String(year).padStart(4, '0');
}

export function DiaryCalendar({ index, selectedDate, today, followToday, onSelect }: DiaryCalendarProps) {
  const [viewMonth, setViewMonth] = useState(() => calendarMonthForDate(selectedDate));
  const [yearDraft, setYearDraft] = useState(() => formatYear(calendarMonthForDate(selectedDate).year));
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setViewMonth(calendarMonthForDate(selectedDate));
  }, [selectedDate]);

  useEffect(() => {
    setYearDraft(formatYear(viewMonth.year));
  }, [viewMonth.year]);

  const weeks = useMemo(() => calendarMonthGrid(viewMonth), [viewMonth.year, viewMonth.month]);
  const previousMonth = shiftCalendarMonth(viewMonth, -1);
  const nextMonth = shiftCalendarMonth(viewMonth, 1);
  const todayMonth = calendarMonthForDate(today);

  function commitYear() {
    if (!/^\d{1,4}$/.test(yearDraft)) {
      setYearDraft(formatYear(viewMonth.year));
      return;
    }
    const year = Number(yearDraft);
    if (year < 0 || year > 9999) {
      setYearDraft(formatYear(viewMonth.year));
      return;
    }
    setViewMonth(current => ({ ...current, year }));
  }
  function collapseCalendar() {
    if (!expanded) return;
    setExpanded(false);
    toggleRef.current?.focus({ preventScroll: true });
  }


  function selectDate(date: string) {
    setViewMonth(calendarMonthForDate(date));
    collapseCalendar();
    onSelect(date);
  }

  function returnToToday() {
    setViewMonth(todayMonth);
    setYearDraft(formatYear(todayMonth.year));
    collapseCalendar();
    onSelect(null);
  }


  return <section className="diary-calendar" aria-label="日报日期选择" data-expanded={expanded}>
    <div className="diary-calendar__heading">
      <h2>日期导航</h2>
      <button className="diary-calendar__today" type="button" aria-pressed={followToday} onClick={returnToToday}>
        {followToday ? '正在跟随今天' : '回到今天'}
      </button>
      <button className="diary-calendar__toggle" ref={toggleRef} type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '选择日期'}</button>
    </div>
    <div className="diary-calendar__body">

    <div className="diary-calendar__controls" aria-label="月份与年份导航">
      <button className="diary-calendar__step" type="button" aria-label="上一个月" disabled={!previousMonth} onClick={() => { if (previousMonth) setViewMonth(previousMonth); }}>←</button>
      <label className="diary-calendar__month">
        <select aria-label="显示月份" value={viewMonth.month} onChange={event => setViewMonth(current => ({ ...current, month: Number(event.target.value) }))}>
          {MONTH_NAMES.map((name, month) => <option key={month} value={month}>{name}</option>)}
        </select>
      </label>
      <label className="diary-calendar__year">
        <input aria-label="显示年份" type="number" min={0} max={9999} step={1} inputMode="numeric" value={yearDraft}
          onChange={event => setYearDraft(event.target.value)} onBlur={commitYear}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitYear(); } }} />
      </label>
      <button className="diary-calendar__step" type="button" aria-label="下一个月" disabled={!nextMonth} onClick={() => { if (nextMonth) setViewMonth(nextMonth); }}>→</button>
    </div>

    <table className="diary-calendar__grid">
      <caption className="diary-calendar__caption">{formatYear(viewMonth.year)}年{viewMonth.month + 1}月，周一至周日</caption>
      <thead><tr>{WEEKDAYS.map(weekday => <th key={weekday} scope="col"><abbr title={`星期${weekday}`}>{weekday}</abbr></th>)}</tr></thead>
      <tbody>{weeks.map((week, weekIndex) => <tr key={weekIndex}>{week.map((cell, dayIndex) => {
        if (!cell) return <td className="diary-calendar__cell" key={dayIndex} aria-hidden="true" />;
        const day = index.get(cell.date);
        const availability = calendarDayAvailability(day);
        const selected = cell.date === selectedDate;
        const isToday = cell.date === today;
        const classes = [
          'diary-calendar__day',
          !cell.inMonth && 'is-adjacent',
          selected && 'is-selected',
          isToday && 'is-today',
        ].filter(Boolean).join(' ');
        const accessibleLabel = `${cell.date}，${availability.description}${isToday ? '，今天' : ''}${selected ? '，当前选择' : ''}`;
        return <td className="diary-calendar__cell" key={dayIndex}>
          <button className={classes} type="button" data-state={availability.state} aria-label={accessibleLabel}
            aria-current={isToday ? 'date' : undefined} aria-pressed={selected} title={accessibleLabel} onClick={() => selectDate(cell.date)}>
            <span className="diary-calendar__day-number"><time dateTime={cell.date}>{Number(cell.date.slice(8, 10))}</time>{isToday && <span className="diary-calendar__today-mark">今</span>}</span>
            <span className="diary-calendar__availability">{day && availability.state === 'new' ? `${day.details.length}条` : availability.label}</span>
          </button>
        </td>;
      })}</tr>)}</tbody>
    </table>

    <div className="diary-calendar__legend" aria-label="日报收录状态说明">
      <span><i data-state="new" aria-hidden="true" />有新增</span>
      <span><i data-state="no-new" aria-hidden="true" />无新增</span>
      <span><i data-state="unrecorded" aria-hidden="true" />未收录</span>
    </div>
    </div>
  </section>;
}
