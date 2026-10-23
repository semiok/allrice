import css from './recurring-weekdays.module.css';

export function RecurringWeekdays({
  days,
  disabled,
  onChange,
}: {
  days: readonly number[];
  disabled: boolean;
  onChange: (days: number[]) => void;
}) {
  return (
    <fieldset className={css.weekdays} disabled={disabled}>
      <legend>每周执行日</legend>
      {[1, 2, 3, 4, 5, 6, 7].map((day) => (
        <label key={day}>
          <input
            type="checkbox"
            checked={days.includes(day)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...days, day].sort((a, b) => a - b)
                  : days.filter((value) => value !== day),
              )
            }
          />
          周{'一二三四五六日'[day - 1]}
        </label>
      ))}
    </fieldset>
  );
}
